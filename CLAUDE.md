# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture

Single-page app. All data lives in **Supabase Postgres** with **RLS enforced on every table**. The client holds only the `anon` key; `service_role` must never appear in this codebase.

### Folder layout

```
src/
├── lib/
│   ├── supabase.ts     # createClient with anon key from import.meta.env
│   └── date.ts         # UTC day-index utils (see below)
├── types/
│   ├── index.ts        # All domain types (Person, WorkItem, Assignment …)
│   └── database.ts     # Supabase-generated DB types (regenerate after schema changes)
├── hooks/
│   └── useAuth.ts      # Session via supabase.auth.onAuthStateChange
├── features/           # Feature-scoped: each dir owns its components, hooks, queries
│   ├── timeline/       # Gantt chart (F-1.* F-2.*)
│   ├── people/         # People CRUD (F-3.*)
│   ├── workitems/      # Project/proposal CRUD (F-4.*)
│   ├── leave/          # Leave balance, accruals (§7)
│   ├── cv/             # CV generator (F-8.*)
│   └── admin/          # User mgmt, grants, backup (§6.7, F-7.*)
├── components/         # Shared UI: AppLayout, AuthGuard, PlaceholderPage, …
├── pages/              # Thin route-level wrappers that render feature components
└── App.tsx             # BrowserRouter → AuthGuard → AppLayout → <Outlet>
```

### Auth flow

`AuthGuard` reads `useAuth()` (Supabase session). No session → `/login`. All protected routes nest inside `AuthGuard > AppLayout`.

### Date handling (critical — PRD §N-8)

`src/lib/date.ts` works exclusively with **UTC day numbers** (integer days since 1970-01-01). Never use `new Date()` arithmetic directly for calendar dates — always go through these helpers:

| Function | Purpose |
|---|---|
| `dateToNum(s)` | "YYYY-MM-DD" or Date → day number |
| `numToDate(n)` | day number → Date (midnight UTC) |
| `numToStr(n)` | day number → "YYYY-MM-DD" |
| `today()` | current local calendar day as day number |
| `weekday(n)` | 0=Mon … 5=Sat … 6=Sun |
| `isWeekend(n)` | Sat or Sun |
| `weekStart(n)` | Monday of the week |
| `monthStart(n)` / `nextMonthStart(n)` | month boundaries |
| `monthBoundaries(s,e)` / `weekBoundaries(s,e)` | arrays of boundary day numbers (used by Gantt header) |
| `workdayCount(s,e,holidays)` | count working days excluding weekends + holiday set |

Wire format for Supabase: `"YYYY-MM-DD"` strings (use `numToStr` / `dateToNum`).

### Data model summary (Supabase tables)

| Table | Key columns |
|---|---|
| `profiles` | `id` (= auth.users.id), `global_role`, `person_id`, `status` |
| `people` | `id`, `name`, `rank` (Partner/SM/M/Senior/Staff/Intern), `role` |
| `work_items` | `id`, `type` (project/proposal), `start`, `main_start`, `end_date`, `color`, `hashtags[]` |
| `assignments` | `id`, `person_id`, `kind` (work/leave), `work_item_id`, `weekend_dates[]`, `leave_type`, `start`, `end_date` |
| `accruals` | `id`, `person_id`, `type`, `days`, `date`, `source` (work_item_id) |
| `holidays` | `id`, `name`, `date`, `recurring` |
| `grants` | `id`, `user_id`, `scope` (global/person/work_item), `resource_id`, `level` (view/edit/admin) |
| `audit_log` | `id`, `user_id`, `action`, `target_type`, `target_id`, `at` |

Types for all of the above live in `src/types/index.ts`.

### Supabase RLS pattern

Every table must have RLS enabled. Use the `app_can(scope, resource_id, need)` helper function (PRD appendix B) for policy conditions. Never rely on client-side checks alone for security.

### Regenerating DB types

```bash
npx supabase gen types typescript --project-id <id> > src/types/database.ts
```
