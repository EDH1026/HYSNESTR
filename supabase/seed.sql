-- =============================================================
-- seed.sql — 초기 데이터 및 첫 번째 관리자 승격
-- =============================================================
-- 사용 방법:
--   1. Supabase Dashboard > Authentication > Users 에서
--      관리자 계정을 먼저 생성(초대)한다.
--   2. 아래 이메일 주소를 실제 관리자 이메일로 교체한다.
--   3. Supabase Dashboard > SQL Editor 에서 이 파일을 실행한다.
--      (또는: supabase db execute --file supabase/seed.sql)
-- =============================================================

-- ── 첫 번째 관리자 승격 ───────────────────────────────────────
-- TODO: 'admin@yourcompany.com' 을 실제 관리자 이메일로 교체

UPDATE public.profiles
SET    global_role = 'admin'
WHERE  id = (
  SELECT id
  FROM   auth.users
  WHERE  email = 'admin@yourcompany.com'
);

-- 적용 확인
SELECT
  u.email,
  p.global_role,
  p.status
FROM   auth.users    u
JOIN   public.profiles p ON p.id = u.id
WHERE  u.email = 'admin@yourcompany.com';

-- =============================================================
-- 한국 공휴일 초기 데이터 (2025 기준; 음력·대체공휴일 별도 추가 필요)
-- =============================================================
-- recurring = true  : 매년 같은 날 (양력 고정 공휴일)
-- recurring = false : 단일 일자 (대체공휴일, 임시공휴일, 음력)

INSERT INTO public.holidays (name, date, recurring) VALUES
  -- 양력 고정 공휴일 (매년 반복)
  ('신정',          '2025-01-01', true),
  ('삼일절',        '2025-03-01', true),
  ('어린이날',      '2025-05-05', true),
  ('현충일',        '2025-06-06', true),
  ('광복절',        '2025-08-15', true),
  ('개천절',        '2025-10-03', true),
  ('한글날',        '2025-10-09', true),
  ('성탄절',        '2025-12-25', true),

  -- 2025년 음력 공휴일 (단일 일자; 매년 날짜 변동)
  ('설날 연휴',     '2025-01-28', false),
  ('설날',          '2025-01-29', false),
  ('설날 연휴',     '2025-01-30', false),
  ('석가탄신일',    '2025-05-05', false),  -- 2025년은 어린이날과 겹침
  ('추석 연휴',     '2025-10-05', false),
  ('추석',          '2025-10-06', false),
  ('추석 연휴',     '2025-10-07', false)
ON CONFLICT DO NOTHING;
