/**
 * SecurityChecklist — admin-visible checklist
 *
 * Items are classified as:
 *   auto  — verified at runtime from the browser
 *   manual — requires DB/dashboard access; shows step-by-step instructions
 */
import { useState } from 'react'
import { CheckCircle2, AlertTriangle, Info, ChevronDown, ChevronRight } from 'lucide-react'

// ── Runtime checks ────────────────────────────────────────────

function noServiceRoleInBundle(): boolean {
  // service_role key must never be set as a VITE_ env var
  const suspect = (import.meta.env as Record<string, string | undefined>)
  return !Object.entries(suspect).some(
    ([k, v]) =>
      k.toLowerCase().includes('service_role') ||
      (typeof v === 'string' && v.length > 30 && v.startsWith('eyJ') && k.startsWith('VITE_')),
  )
}

// ── Types ─────────────────────────────────────────────────────

type ItemStatus = 'pass' | 'fail' | 'manual'

interface CheckItem {
  id:           string
  label:        string
  status:       ItemStatus
  description?: string
  steps?:       string[]
}

// ── Component ─────────────────────────────────────────────────

export default function SecurityChecklist() {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const items: CheckItem[] = [
    {
      id:     'no-service-role',
      label:  'service_role 키가 클라이언트 번들에 없음',
      status: noServiceRoleInBundle() ? 'pass' : 'fail',
      description:
        'VITE_ 접두사 환경 변수에 service_role 키가 포함되면 번들에 노출됩니다. ' +
        'anon 키만 VITE_SUPABASE_ANON_KEY로 설정해야 합니다.',
      steps: [
        '.env.local 파일에 VITE_SUPABASE_SERVICE_ROLE_KEY 등 service_role 관련 변수가 없는지 확인',
        '빌드 결과물 dist/assets/index-*.js 에서 service_role 또는 eyJhbGc... 패턴이 없는지 grep으로 확인',
      ],
    },
    {
      id:     'rls-all-tables',
      label:  '모든 테이블에 RLS 활성화',
      status: 'manual',
      description:
        'Supabase 대시보드 또는 SQL로 모든 테이블의 RLS 활성화를 확인합니다.',
      steps: [
        'Supabase 대시보드 → Database → Tables → 각 테이블 → RLS "Enabled" 표시 확인',
        '또는 SQL: SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname=\'public\' AND rowsecurity=false; → 결과 0건이어야 함',
        '확인 대상: people, work_items, assignments, accruals, holidays, grants, profiles, audit_log',
      ],
    },
    {
      id:     'viewer-blocked',
      label:  'viewer 계정에서 권한 밖 데이터 차단 확인',
      status: 'manual',
      description:
        'viewer 역할 계정으로 로그인하여 다른 인력의 데이터나 grant가 없는 work_item이 조회되지 않는지 확인합니다.',
      steps: [
        'viewer 계정으로 로그인 후 /people 이동 → 자신의 person만 보여야 함 (또는 canView 게이팅에 의해 숨겨짐)',
        '브라우저 콘솔: supabase.from("people").select("*") 실행 → RLS에 의해 제한된 결과만 반환',
        '권한 없는 people.id로 직접 쿼리: supabase.from("people").select("*").eq("id","<other_id>") → 0건이어야 함',
      ],
    },
    {
      id:     'pipeline-viewer-blocked',
      label:  'viewer/view 권한자에게 pipeline 미노출 확인',
      status: 'manual',
      description:
        'pipeline type의 work_item은 edit 이상의 권한이 없으면 RLS에서 차단됩니다. ' +
        '이 규칙은 카테고리 RLS이며 리소스별 view grant로는 우회할 수 없습니다.',
      steps: [
        'viewer 계정으로 로그인 후 브라우저 콘솔에서 supabase.from("work_items").select("*").eq("type","pipeline") 실행',
        '결과: 0건이어야 함',
        'viewer에게 특정 pipeline work_item에 view grant를 부여한 후에도 동일하게 0건인지 확인',
        'is_pipeline_work_item() 함수가 SECURITY DEFINER로 설정되어 있는지 확인 (migration 0005 참고)',
      ],
    },
    {
      id:     'non-admin-admin-blocked',
      label:  '비-admin의 /admin 화면 접근 차단',
      status: 'pass',
      description:
        'AdminPage.tsx는 isAdmin() false이면 /timeline으로 redirect합니다. ' +
        '사이드바도 adminOnly: true로 숨깁니다.',
    },
    {
      id:     'auth-guard',
      label:  'AuthGuard가 미인증 접근 차단',
      status: 'pass',
      description:
        '모든 보호 라우트는 AuthGuard > AppLayout으로 wrapping 되어 있어 ' +
        '세션 없이는 /login으로 리다이렉트됩니다.',
    },
    {
      id:     'audit-log-insert-blocked',
      label:  'audit_log 직접 INSERT 차단 확인',
      status: 'manual',
      description:
        'audit_log는 트리거나 서버 함수에서만 기록해야 합니다. ' +
        '클라이언트에서 직접 INSERT를 시도하면 RLS (WITH CHECK(false))가 차단해야 합니다.',
      steps: [
        '임의 계정으로 콘솔에서 supabase.from("audit_log").insert({action:"test",target_type:"people",target_id:"x",user_id:"x"}) 시도',
        '결과: RLS 오류가 발생해야 함 (new row violates row-level security policy)',
      ],
    },
    {
      id:     'profile-role-self-escalation',
      label:  '자기 자신의 global_role 자가 승격 차단',
      status: 'manual',
      description:
        'viewer/editor가 자신의 global_role을 admin으로 UPDATE하려는 시도를 RLS가 차단해야 합니다.',
      steps: [
        'viewer 계정 콘솔: supabase.from("profiles").update({global_role:"admin"}).eq("id", "<self_id>")',
        '결과: RLS WITH CHECK 위반 오류가 발생해야 함',
      ],
    },
    {
      id:     'no-grants-client',
      label:  '비-admin의 grants 테이블 INSERT 차단',
      status: 'manual',
      description:
        'admin 이외의 사용자가 grants 테이블에 직접 INSERT를 시도하면 RLS가 차단해야 합니다.',
      steps: [
        'editor 계정 콘솔: supabase.from("grants").insert({user_id:"x",scope:"global",resource_id:null,level:"admin"})',
        '결과: RLS 오류가 발생해야 함',
      ],
    },
    {
      id:     'env-vars-set',
      label:  '배포 환경 변수 설정 (Vercel / Netlify)',
      status: 'manual',
      description:
        '정적 빌드 배포 시 VITE_ 환경 변수가 빌드 시점에 번들에 포함됩니다. ' +
        '플랫폼 환경 변수로 주입해야 합니다.',
      steps: [
        'Vercel: Project Settings → Environment Variables → VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY 추가',
        'Netlify: Site Settings → Build & Deploy → Environment Variables 동일',
        'VITE_SUPABASE_SERVICE_ROLE_KEY는 절대 추가하지 않음',
        'Edge Function이 필요한 경우 Supabase Edge Function Secrets에만 service_role 설정',
      ],
    },
  ]

  function toggle(id: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const passCnt   = items.filter(i => i.status === 'pass').length
  const failCnt   = items.filter(i => i.status === 'fail').length
  const manualCnt = items.filter(i => i.status === 'manual').length

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex gap-4 text-sm">
        <span className="flex items-center gap-1.5 text-emerald-700">
          <CheckCircle2 size={15} /> {passCnt} 자동 통과
        </span>
        <span className="flex items-center gap-1.5 text-amber-700">
          <Info size={15} /> {manualCnt} 수동 확인 필요
        </span>
        {failCnt > 0 && (
          <span className="flex items-center gap-1.5 text-red-600 font-semibold">
            <AlertTriangle size={15} /> {failCnt} 실패
          </span>
        )}
      </div>

      {/* Items */}
      <div className="space-y-2">
        {items.map(item => {
          const open = expanded.has(item.id)
          return (
            <div
              key={item.id}
              className={`card p-0 overflow-hidden border-l-4 ${
                item.status === 'pass'   ? 'border-l-emerald-500' :
                item.status === 'fail'   ? 'border-l-red-500'     :
                                           'border-l-amber-400'
              }`}
            >
              <button
                onClick={() => toggle(item.id)}
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-50 transition-colors"
              >
                {item.status === 'pass' ? (
                  <CheckCircle2 size={16} className="text-emerald-600 flex-shrink-0" />
                ) : item.status === 'fail' ? (
                  <AlertTriangle size={16} className="text-red-500 flex-shrink-0" />
                ) : (
                  <Info size={16} className="text-amber-600 flex-shrink-0" />
                )}

                <span className="flex-1 text-sm font-medium text-gray-900">{item.label}</span>

                <span className={`pill text-[10px] ${
                  item.status === 'pass'   ? 'bg-emerald-100 text-emerald-700' :
                  item.status === 'fail'   ? 'bg-red-100 text-red-700'         :
                                             'bg-amber-100 text-amber-700'
                }`}>
                  {item.status === 'pass' ? '통과' : item.status === 'fail' ? '실패' : '수동 확인'}
                </span>

                {(item.description || item.steps) && (
                  open ? <ChevronDown size={14} className="text-muted" />
                       : <ChevronRight size={14} className="text-muted" />
                )}
              </button>

              {open && (item.description || item.steps) && (
                <div className="px-4 pb-4 space-y-2 border-t border-border bg-surface-50">
                  {item.description && (
                    <p className="pt-3 text-xs text-gray-700">{item.description}</p>
                  )}
                  {item.steps && (
                    <ol className="list-decimal list-inside space-y-1 text-xs text-muted pl-2">
                      {item.steps.map((step, i) => (
                        <li key={i}>{step}</li>
                      ))}
                    </ol>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
