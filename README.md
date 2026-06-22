# Workforce Management Dashboard

Gantt-based team resource management dashboard built with React + Vite + TypeScript + Supabase.

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- A [Supabase](https://supabase.com/) project (free tier is sufficient)

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Copy the placeholder file and fill in your Supabase credentials:

```bash
# .env.local is already in .gitignore — never commit it
```

Edit `.env.local`:

```
VITE_SUPABASE_URL=https://<your-project-id>.supabase.co
VITE_SUPABASE_ANON_KEY=<your-anon-key>
```

Find these values in your Supabase dashboard → **Project Settings → API**.

> **Security**: only the `anon` (public) key goes here. The `service_role` key
> must never appear in client code or this repository. Data security is
> enforced by Postgres RLS policies on the Supabase side.

### 3. Start the development server

```bash
npm run dev
```

The app will be available at `http://localhost:5173`.

## Other commands

| Command | Description |
|---|---|
| `npm run dev` | Start Vite dev server with HMR |
| `npm run build` | Type-check and build for production (`dist/`) |
| `npm run preview` | Serve the production build locally |

## Project structure

```
src/
├── lib/
│   ├── supabase.ts      # Supabase client (anon key only)
│   └── date.ts          # UTC day-index utilities (dateToNum, numToDate, weekday, …)
├── types/
│   ├── index.ts         # Domain types (Person, WorkItem, Assignment, …)
│   └── database.ts      # Supabase generated types (regenerate after schema changes)
├── hooks/
│   └── useAuth.ts       # Session state via Supabase Auth
├── features/            # Feature-scoped components and hooks
│   ├── timeline/
│   ├── people/
│   ├── workitems/
│   ├── leave/
│   ├── cv/
│   └── admin/
├── components/          # Shared UI components
│   ├── AppLayout.tsx    # Sidebar + outlet
│   ├── AuthGuard.tsx    # Redirects to /login if no session
│   └── PlaceholderPage.tsx
├── pages/               # Route-level page components
└── App.tsx              # BrowserRouter + QueryClient + route tree
```

## Database setup (Supabase migrations)

### Apply migrations

```bash
# Supabase CLI 사용 시 (로컬 개발)
supabase db push

# 또는 Supabase Dashboard > SQL Editor 에서
# 아래 파일을 번호 순서대로 실행한다
supabase/migrations/20260620000001_tables.sql
supabase/migrations/20260620000002_functions.sql
supabase/migrations/20260620000003_triggers.sql
supabase/migrations/20260620000004_rls.sql
```

### 초기 관리자 계정 승격

1. Supabase Dashboard → **Authentication → Users → Invite user** 로 첫 번째 관리자 계정을 생성한다.
2. `supabase/seed.sql` 상단의 이메일 주소를 실제 값으로 교체한다.
3. SQL Editor 에서 `seed.sql` 을 실행한다.

```sql
-- seed.sql 핵심 내용 (직접 실행도 가능)
UPDATE public.profiles
SET    global_role = 'admin'
WHERE  id = (SELECT id FROM auth.users WHERE email = 'admin@yourcompany.com');
```

### 공개 회원가입 비활성화 (A-2)

Supabase Dashboard → **Authentication → Settings → Email Auth**

- **"Enable email signup"** 토글을 **Off** 로 설정한다.
- 이후에는 관리자가 Dashboard 또는 `supabase.auth.admin.inviteUserByEmail()` 으로만 계정을 발급할 수 있다.

> **CLI 방법 (supabase/config.toml)**
> ```toml
> [auth.email]
> enable_signup = false
> ```

### 회사 도메인 제한 (선택, A-2 보조)

공개 회원가입을 완전히 막더라도 초대 이메일 도메인을 애플리케이션 레벨에서 제한하려면 Supabase Edge Function 또는 `auth.on_new_user` 훅을 활용한다.

```sql
-- 예시: auth.users 생성 직전 도메인 검증 훅
-- Supabase Dashboard > Database > Hooks > auth.on_new_user
CREATE OR REPLACE FUNCTION public.check_email_domain()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.email NOT LIKE '%@yourcompany.com' THEN
    RAISE EXCEPTION 'Unauthorized email domain';
  END IF;
  RETURN NEW;
END;
$$;
```

---

## Security model & RLS policy test scenarios

모든 테이블에 RLS가 활성화되어 있다. 클라이언트는 `anon` 키만 보유하며, 권한은 전적으로 Postgres RLS 정책이 강제한다 (A-5, N-3).

### 권한 함수

| 함수 | 역할 |
|---|---|
| `is_admin()` | 현재 사용자가 admin 인지 판정 (profiles/grants 전용 정책에서 사용; 재귀 방지) |
| `app_can(scope, resource_id, need)` | MAX(전역 역할, 리소스 grant, 전역 grant) 로 권한 판정 |

### 테스트 시나리오

아래 시나리오는 Supabase Dashboard → SQL Editor 에서 `SET LOCAL role = authenticated; SET LOCAL request.jwt.claim.sub = '<user_uuid>';` 로 사용자를 가장하여 검증할 수 있다.

#### T-1. viewer 가 타인 people 행 조회 시도 → 차단

```sql
-- viewer 이고 person grant 없는 사용자로 실행
SELECT * FROM public.people;
-- 기대: 본인 people 행(profiles.person_id)만 반환, 나머지 0건
```

#### T-2. editor 가 people 행 생성 → 허용

```sql
-- global_role = 'editor' 사용자로 실행
INSERT INTO public.people (name, rank) VALUES ('홍길동', 'Staff');
-- 기대: 성공
```

#### T-3. viewer 가 people INSERT 시도 → 차단

```sql
-- global_role = 'viewer' 사용자로 실행
INSERT INTO public.people (name, rank) VALUES ('공격자', 'Intern');
-- 기대: RLS 오류 (new row violates row-level security policy)
```

#### T-4. 본인 profile 에서 global_role 변경 시도 → 차단

```sql
-- 본인 user_id로 실행
UPDATE public.profiles SET global_role = 'admin' WHERE id = auth.uid();
-- 기대: RLS 오류 (WITH CHECK 위반)
```

#### T-5. admin 이 grants 부여 → 허용

```sql
-- global_role = 'admin' 사용자로 실행
INSERT INTO public.grants (user_id, scope, resource_id, level)
VALUES ('<viewer_uuid>', 'person', '<person_uuid>', 'edit');
-- 기대: 성공; viewer가 해당 person에 대해 수정 권한 획득
```

#### T-6. 일반 사용자가 grants INSERT 시도 → 차단

```sql
-- global_role = 'editor' 사용자로 실행
INSERT INTO public.grants (user_id, scope, resource_id, level)
VALUES ('<any_uuid>', 'person', '<person_uuid>', 'admin');
-- 기대: RLS 오류
```

#### T-7. person grant 보유자가 해당 인력 assignments 조회 → 허용

```sql
-- grants (scope='person', resource_id='<person_uuid>', level='view') 를 보유한 사용자
SELECT * FROM public.assignments WHERE person_id = '<person_uuid>';
-- 기대: 해당 인력의 배정 반환
```

#### T-8. audit_log 직접 INSERT 시도 → 차단

```sql
-- 어떤 사용자든
INSERT INTO public.audit_log (action, target_type) VALUES ('HACK', 'people');
-- 기대: RLS 오류 (WITH CHECK (false))
```

#### T-9. 비활성 계정(status='inactive') 접근 → 차단

```sql
-- 관리자가 먼저 비활성화
UPDATE public.profiles SET status = 'inactive' WHERE id = '<user_uuid>';
-- 이후 해당 사용자 세션으로 임의 쿼리 실행
SELECT * FROM public.people;
-- 기대: app_can() 내 status='active' 체크 → 전부 0건 반환
```

### Pipeline work_item 가시성 테스트 시나리오 (migration 0005)

`pipeline` type의 work_item·assignment는 **edit 권한 이상**의 사용자에게만 노출된다.
`view` 권한이나 자기 자신의 배정(self-view)이라도 pipeline이면 차단된다.

#### T-10. 전역 viewer — pipeline work_item·assignment 전혀 안 보임 (a)

```sql
-- 사전 조건
--   work_item P_ID : type='pipeline'
--   assignment A_ID : person_id=<person_uuid>, work_item_id=P_ID
--   user U  : global_role='viewer', profiles.person_id=<person_uuid>
--             (즉, 자기 자신의 배정이기도 함)

-- U 세션으로 실행
SELECT * FROM public.work_items  WHERE id = '<P_ID>';
-- 기대: 0건 (pipeline은 edit 권한 필요, viewer는 view 수준)

SELECT * FROM public.assignments WHERE work_item_id = '<P_ID>';
-- 기대: 0건 (is_pipeline_work_item()=true → app_can(edit) 필요)

SELECT * FROM public.assignments WHERE person_id = '<person_uuid>';
-- 기대: pipeline 배정은 제외, 비-pipeline 배정만 반환
--       (self-view 경로가 pipeline 배정에는 적용되지 않음)
```

#### T-11. pipeline 항목에 view-only grant — 여전히 안 보임 (b)

```sql
-- 사전 조건
--   grants: user_id=U, scope='work_item', resource_id=P_ID, level='view'

-- U 세션으로 실행
SELECT * FROM public.work_items  WHERE id = '<P_ID>';
-- 기대: 0건 (level='view'는 pipeline SELECT 조건 app_can(edit) 미충족)

SELECT * FROM public.assignments WHERE work_item_id = '<P_ID>';
-- 기대: 0건 (동일 이유)
```

#### T-12. edit grant / 전역 editor / admin — pipeline 조회 가능 (c)

```sql
-- 시나리오 A: pipeline 항목에 edit grant 보유 (level='edit')
--   grants: user_id=U2, scope='work_item', resource_id=P_ID, level='edit'
SELECT * FROM public.work_items  WHERE id = '<P_ID>';
-- 기대: 1건 반환

SELECT * FROM public.assignments WHERE work_item_id = '<P_ID>';
-- 기대: 해당 pipeline 배정 반환

-- 시나리오 B: 전역 editor (global_role='editor')
--   editor는 app_can(edit)이 항상 true → pipeline 포함 전체 조회
SELECT * FROM public.work_items WHERE type = 'pipeline';
-- 기대: 전체 pipeline 행 반환

-- 시나리오 C: admin
SELECT * FROM public.work_items WHERE type = 'pipeline';
-- 기대: 전체 pipeline 행 반환 (app_can이 admin → 항상 true)
```

#### T-13. is_pipeline_work_item() 취약점 방어 확인

```sql
-- 취약점 시나리오 (방어가 제대로 됐는지 검증)
-- viewer U의 person_id 와 연결된 pipeline 배정이 존재할 때:
--
-- 만약 일반 서브쿼리를 썼다면 → work_items RLS가 pipeline을 숨김
--   → EXISTS=false → ELSE(self-view) 경로 → 배정 노출 (취약)
--
-- is_pipeline_work_item()은 SECURITY DEFINER이므로 work_items RLS를
-- 우회해 실제 type='pipeline'을 읽음 → THEN 분기 → app_can(edit) 실패
-- → 0건 반환 (안전)

-- viewer U 세션으로 본인 배정 전체 조회
SELECT * FROM public.assignments WHERE person_id = '<own_person_uuid>';
-- 기대: pipeline work_item에 연결된 배정은 0건; 일반 배정만 반환
```

---

## Deployment

### Vercel

```bash
npm i -g vercel
vercel --prod
```

Set **Environment Variables** in the Vercel dashboard (or `vercel env add`):

| Variable | Value |
|---|---|
| `VITE_SUPABASE_URL` | `https://<project>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | `<anon key from Supabase API settings>` |

`vercel.json` at the repo root redirects all requests to `/index.html` for SPA routing.

> **Never** add `VITE_SUPABASE_SERVICE_ROLE_KEY` or any secret key as a build-time env var — it ends up in the client bundle. service_role is only for Edge Functions (set as a Supabase secret).

### Netlify

```bash
npm i -g netlify-cli
netlify deploy --prod --dir dist
```

Set the same variables in **Site Settings → Build & Deploy → Environment Variables**. `netlify.toml` handles the SPA redirect.

### Edge Functions (for server-side operations)

If you add Supabase Edge Functions (e.g., user invite, scheduled jobs), set `SUPABASE_SERVICE_ROLE_KEY` only via:

```bash
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<value>
```

This is isolated to the Edge Function runtime and never reaches the browser.

---

## Backup & restore

### Application-level JSON backup (Admin panel)

An **Admin → Backup/Restore** panel is available to users with `global_role = 'admin'`.

- **Download**: exports `people`, `work_items`, `assignments`, `accruals`, `holidays`, `grants` as a dated JSON file.
- **Restore (upsert)**: uploads a backup file and upserts all records back into the database via the normal Supabase client (admin JWT, anon key — RLS fully enforced, no `service_role` bypass). Records **not present** in the backup file are **not deleted**.

This is suitable for ad-hoc data migration and quick recovery of accidentally deleted rows.

### Operational backup — Supabase DB-level (recommended for production)

For point-in-time recovery and full schema-level restores, use **Supabase's built-in database backup**:

1. Open the Supabase dashboard → **Database → Backups**.
2. Pro/Team plans include daily automated backups with 7-day retention. Upgrade if needed.
3. To restore: select a backup point and click **Restore**. This replaces the entire database with the snapshot — test in a staging project first.
4. For self-hosted Supabase: configure `pg_dump` / WAL archiving via your infrastructure.

> The application-level JSON backup does **not** include `profiles` or `audit_log` rows, and cannot restore auth users. Use Supabase DB-level backup for full disaster recovery.

---

## Regenerating Supabase types

After updating the database schema run:

```bash
npx supabase gen types typescript --project-id <your-project-id> > src/types/database.ts
```

## Design tokens

All design tokens live in `tailwind.config.ts` under `theme.extend`:

| Token | Usage |
|---|---|
| `brand.*` | Indigo accent — buttons, active states, focus rings |
| `surface.*` | Off-white backgrounds and card layers |
| `border.*` | Subtle borders and dividers |
| `muted.*` | Secondary text and icons |
| `shadow-card` | Soft Astra-style card shadow |
