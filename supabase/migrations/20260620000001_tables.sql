-- =============================================================
-- Migration 0001: Core tables  (PRD §4.1, 부록 B.1)
-- =============================================================
-- Run order matters: people → work_items → profiles → assignments
--                    → accruals → holidays → grants → audit_log
-- =============================================================

-- ── people: 인력 목록 ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.people (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL,
  rank       text        NOT NULL
               CHECK (rank IN ('Partner','SM','M','Senior','Staff','Intern')),
  role       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.people      IS '인력 목록 (§4.1)';
COMMENT ON COLUMN public.people.rank IS 'Partner|SM|M|Senior|Staff|Intern';

-- ── work_items: 프로젝트·제안서 ──────────────────────────────

CREATE TABLE IF NOT EXISTS public.work_items (
  id                uuid     PRIMARY KEY DEFAULT gen_random_uuid(),
  type              text     NOT NULL CHECK (type IN ('project','proposal')),
  name              text     NOT NULL,
  color             text,
  start             date     NOT NULL,
  main_start        date,                   -- 본 프로젝트 시작 (project only)
  end_date          date     NOT NULL,
  engagement_number text,
  client            text,
  hashtags          text[]   NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  -- 날짜 정합성
  CONSTRAINT wi_dates_order       CHECK (start <= end_date),
  CONSTRAINT wi_main_in_range     CHECK (
    main_start IS NULL
    OR (main_start >= start AND main_start <= end_date)
  ),
  -- proposal에는 main_start 없음 (§4.2)
  CONSTRAINT wi_proposal_no_main  CHECK (type = 'project' OR main_start IS NULL)
);

COMMENT ON TABLE  public.work_items            IS '프로젝트·제안서 작업 항목 (§4.1, §4.2)';
COMMENT ON COLUMN public.work_items.main_start IS 'project: pre-study 종료 직후 본 프로젝트 시작일. proposal은 NULL.';

-- ── profiles: auth.users 와 1:1 계정 프로필 ──────────────────

CREATE TABLE IF NOT EXISTS public.profiles (
  id          uuid  PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
  name        text,
  global_role text  NOT NULL DEFAULT 'viewer'
                    CHECK (global_role IN ('admin','editor','viewer')),
  person_id   uuid  REFERENCES public.people(id) ON DELETE SET NULL,
  status      text  NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','inactive')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.profiles             IS '로그인 계정 프로필; person_id 로 본인 인력 레코드 연결 (§4.1, §6)';
COMMENT ON COLUMN public.profiles.global_role IS 'admin: 전권 | editor: 전체 수정 | viewer: 전체 열람';
COMMENT ON COLUMN public.profiles.person_id   IS 'profiles → people 본인 연결. NULL 허용(관리 전용 계정 등)';
COMMENT ON COLUMN public.profiles.status      IS 'inactive: 로그인 차단 대상 (퇴사 등)';

-- ── assignments: 인력 배정 (work·leave) ──────────────────────

CREATE TABLE IF NOT EXISTS public.assignments (
  id            uuid   PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id     uuid   NOT NULL REFERENCES public.people(id)     ON DELETE CASCADE,
  kind          text   NOT NULL CHECK (kind IN ('work','leave')),
  work_item_id  uuid   REFERENCES public.work_items(id)          ON DELETE CASCADE,
  weekend_dates date[] NOT NULL DEFAULT '{}',
  leave_type    text   CHECK (leave_type IN (
                  '리프레시','지정휴가','프로젝트휴가',
                  '주말/휴일대체','포상휴가','특별휴가','지연보상','휴직'
                )),
  start         date   NOT NULL,
  end_date      date   NOT NULL,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT asgn_dates_order       CHECK (start <= end_date),
  -- kind = work 이면 work_item 필수 (§4.3)
  CONSTRAINT asgn_work_needs_item   CHECK (kind <> 'work'  OR work_item_id IS NOT NULL),
  -- kind = leave 이면 leave_type 필수
  CONSTRAINT asgn_leave_needs_type  CHECK (kind <> 'leave' OR leave_type   IS NOT NULL)
);

COMMENT ON TABLE  public.assignments              IS '인력 배정 단위 (§4.1, §4.3)';
COMMENT ON COLUMN public.assignments.weekend_dates IS '실 근무한 주말·공휴일 날짜 목록 (§7.2, F-1.8)';

-- ── accruals: 휴가 적립 내역 ──────────────────────────────────

CREATE TABLE IF NOT EXISTS public.accruals (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id   uuid         NOT NULL REFERENCES public.people(id)    ON DELETE CASCADE,
  type        text         NOT NULL,      -- 적립 유형 레이블 (자유 문자열)
  days        numeric(5,1) NOT NULL,      -- 0.5 단위 허용
  date        date         NOT NULL,      -- 적립 기준일
  source      uuid         REFERENCES public.work_items(id)         ON DELETE SET NULL,
  note        text,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.accruals        IS '휴가 적립 내역 (§4.1, §7)';
COMMENT ON COLUMN public.accruals.source IS '자동 적립 원천 프로젝트 (§7.1, §7.2)';

-- ── holidays: 공휴일 ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.holidays (
  id         uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text    NOT NULL,
  date       date    NOT NULL,
  recurring  boolean NOT NULL DEFAULT false,  -- true: 매년 반복 (월/일 기준)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.holidays           IS '공휴일 (§4.1, §5.6)';
COMMENT ON COLUMN public.holidays.recurring IS 'true = 매년 같은 월/일 반복 (창립기념일 등)';

-- ── grants: 리소스 단위 권한 ──────────────────────────────────
-- scope = global: 전역 추가 권한 (resource_id NULL)
-- scope = person / work_item: 특정 리소스 단위 권한

CREATE TABLE IF NOT EXISTS public.grants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users  ON DELETE CASCADE,
  scope       text NOT NULL CHECK (scope IN ('global','person','work_item')),
  resource_id uuid,                               -- global 이면 NULL
  level       text NOT NULL CHECK (level IN ('view','edit','admin')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- (user_id, scope, resource_id) 조합 중복 방지; NULL = NULL 동등 처리 (PG 15+)
  CONSTRAINT grants_unique UNIQUE NULLS NOT DISTINCT (user_id, scope, resource_id),

  -- global scope 이면 resource_id 는 반드시 NULL
  CONSTRAINT grants_global_no_resource    CHECK (scope <> 'global' OR resource_id IS NULL),
  -- person/work_item scope 이면 resource_id 필수
  CONSTRAINT grants_scoped_needs_resource CHECK (scope  = 'global' OR resource_id IS NOT NULL)
);

COMMENT ON TABLE public.grants IS '사람/프로젝트 단위 리소스 권한 (§4.1, §6.3, 부록 B.1)';

-- ── audit_log: 변경·권한 이력 (append-only) ──────────────────

CREATE TABLE IF NOT EXISTS public.audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES auth.users ON DELETE SET NULL,
  action      text NOT NULL,          -- INSERT | UPDATE | DELETE
  target_type text NOT NULL,          -- 테이블 이름
  target_id   uuid,
  payload     jsonb,                  -- INSERT: new row / UPDATE: {old,new} / DELETE: old row
  at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.audit_log IS '변경·권한 이력 append-only (§4.1, N-5, F-RBAC-3)';

-- ── Indexes ───────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_profiles_person_id        ON public.profiles(person_id)       WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_assignments_person_id     ON public.assignments(person_id);
CREATE INDEX IF NOT EXISTS idx_assignments_work_item_id  ON public.assignments(work_item_id);
CREATE INDEX IF NOT EXISTS idx_accruals_person_id        ON public.accruals(person_id);
CREATE INDEX IF NOT EXISTS idx_accruals_source           ON public.accruals(source)           WHERE source IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_holidays_date             ON public.holidays(date);
CREATE INDEX IF NOT EXISTS idx_grants_user_id            ON public.grants(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_at              ON public.audit_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_id         ON public.audit_log(user_id)         WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_log_target          ON public.audit_log(target_type, target_id);
