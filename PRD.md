# 전략팀 대시보드 — 제품 요구사항 정의서 (PRD)

| 항목 | 내용 |
|---|---|
| 문서 버전 | v2.8 |
| 프로그램명 | **전략팀 대시보드** |
| 화면 표기 | 헤더·타이틀·푸터·코드 어디에도 **EY / EYP / EY-Parthenon 등 브랜드 표기·로고를 노출하지 않는다**(§9.0). 프로그램명은 "전략팀 대시보드"로만 표기. 로고는 `assets/logo.png`(정사각형 아이콘) 사용(§9.0). |
| 아키텍처 | React + Supabase(Auth · Postgres · RLS) |
| 권한 | admin/editor = 전체 편집 / viewer = 동일 화면 **전면 읽기 전용**(CV·Leave는 본인만, Pipeline 비노출, Confidential 마스킹) |
| 계정↔인력 매칭 | `profiles.person_id` = `people.id` (관리자 수동 설정, LPN 미사용) |
| 회계연도 | 7월 시작 / 6월 마감. FY26 = 2025-07-01 ~ 2026-06-30 |
| 모바일 정책 | 화면 너비 768px 미만은 **모바일**로 판단. 계정 역할과 무관하게 **전면 읽기 전용**. (§6.6, §9.2) |
| 색상 체계 | project=파랑 / proposal=노랑 / pipeline=회색 / Leave=녹색 (유형 파생, 수동지정 없음) |
| 직급 순서 | Partner > SM > M > Senior > Staff > Intern |

---

## 1. 개요

전략팀 대시보드는 프로젝트 기반 조직의 인력·일정·휴가·가동률을 통합 관리한다. 간트 타임라인, 휴가 자동/수동 산정, Utilization 대시보드, 개인 CV, Engagement 검색을 제공하며 권한을 RLS로 강제한다.

## 2. 역할

| 역할 | 접근 |
|---|---|
| admin | 전체 편집 + 계정·권한·설정·백업 + Admin·Migration 메뉴(admin 전용) |
| editor | 전체 데이터 열람·편집 |
| viewer | editor와 동일 화면을 보되 **전면 읽기 전용**. CV Generator·Leave는 **본인 정보만**, **Pipeline 비노출**, **Confidential 마스킹**, Admin·Migration 비노출 (§6.3) |

---

## 3. 데이터 모델 (요지)

| 테이블 | 주요 컬럼 |
|---|---|
| profiles | id, name, global_role, person_id(→people.id, 매칭키), lpn, status |
| people | id, lpn(unique), name, rank, role, hire_date, termination_date |
| work_items | id, type(project/proposal/pipeline), name, start, main_start, end_date, status(open/closed) — 전 유형, engagement_number, client, hashtags[], description, confidential(bool) (color 미사용, 유형 파생) |
| assignments | id, person_id, kind(work/leave), work_item_id, weekend_dates[], leave_type, start, end_date, note |
| accruals | id, person_id, direction(accrual/usage), type, days(+/-), date, source, note |
| leave_types | name, active(bool), sort_order |
| holidays | id, name, date, recurring |
| settings | key, value (fiscal_year_start_month=7) |
| audit_log | id, user_id, action, target_type, target_id, at |

> 입력 형식: Engagement Code `E-00000000`(E- + 숫자 8자리), LPN 숫자 5자리 `00000`. 계정↔인력 매칭은 `profiles.person_id`=`people.id`로만(LPN 미사용).

---

## 4. 색상 체계
- project=파랑, proposal=노랑, pipeline=회색, Leave=녹색. 각 계열 내 자동 음영. 수동 지정 없음. 유형 변경 시 색 자동 전환.

---

## 5. 기능 요구사항

### 5.1 실행취소 / 재실행
- Ctrl+Z=실행취소, Ctrl+Y(및 Ctrl+Shift+Z)=재실행. 최대 10단계. 대상: 배정·작업항목·인력·휴가 수동조정. 서버 역연산, 불가 시 안전 실패. editor/admin만. Undo/Redo 버튼.

### 5.2 타임라인 시각화
| ID | 요구사항 |
|---|---|
| T-1 | 인력별/작업별 뷰. 월→주→일 자동 전환. 모든 날짜 MM/DD. 반응형. 막대 라벨 폭 확장 + 호버 툴팁(작업명·고객사·기간, 인력별 뷰는 인력명). |
| T-2 | 색상: project 파랑 / proposal 노랑 / pipeline 회색 / Leave 녹색. 범례 구분. |
| T-3 | 작업 행은 그 작업 자체의 일정(span)만 표시(인원 막대 미중첩). 인원별 일정은 드롭다운으로. |
| T-4 | 작업 행·'휴가(전체)' 행 드롭다운 펼침/접힘. 작업 내 인원 직급순·이름순. |
| T-5 | 작업항목 더블클릭 → 상세 페이지(§5.7). |
| T-6 | Pre-study 구간 별도 분류·시각 구분(적립·CV 수행기간 제외). |
| T-7 | 인력 칩 드래그 배정(직급 그룹·이름순). 주말·공휴일 음영, 오늘 세로선/버튼, 주말 실근무 마커 날짜 고정, 정렬·필터·FY/기간 필터, 중복 배정 경고, sticky 헤더/라벨. |
| **T-8** | **헤더·본문 스크롤 동기화(버그 수정)**: 날짜 캘린더 헤더(상단)와 작업/인력 타임라인 본문(하단)이 **항상 동일한 가로 오프셋으로 함께 스크롤**되어야 한다. 특히 FY 필터로 조회 범위가 바뀌거나 좌우로 스크롤할 때 상·하단이 따로 움직여 날짜와 막대가 어긋나는 문제를 해결한다(공통 스크롤 컨테이너 또는 스크롤 위치 동기화). |
| **T-9** | **FY 다중 걸침 처리**: 한 작업/배정의 기간이 둘 이상의 FY에 걸쳐 있어도, FY 필터·좌우 스크롤 시 헤더 날짜와 막대 위치가 어긋나지 않게 한다(좌표 계산 기준을 단일 viewport 원점으로 통일). |

### 5.3 일정 편집
| ID | 요구사항 |
|---|---|
| E-1 | 빈 칸 드래그/더블클릭/칩 드롭으로 생성. 인력별 뷰 빈 칸 클릭 시 해당 인력 자동 선택. |
| E-2 | 작업 선택: status=open 만(전 유형). 인력: 재직 인원만. 휴가 유형: active 만. |
| E-3 | 휴가 영업일 스냅. 드래그 겹침 방지 푸시(같은 인력 비중첩). |
| E-4 | viewer는 모든 편집 컨트롤 비활성(서버 RLS로도 차단). |
| **E-5** | **모바일(너비 768px 미만)에서는 역할과 무관하게 모든 편집 컨트롤 비활성.** 빈 칸 클릭·드래그·드롭으로 인한 생성/이동 입력이 동작하지 않아야 한다(§6.6). |

### 5.4 인력 관리
- 추가/편집/삭제. 필드: LPN, 이름, 직급, 역할, 입사일, 퇴사일. 재직 여부 날짜 파생. 화면 필터·정렬.

### 5.5 작업항목 관리 & 상태(Open/Closed)
| ID | 요구사항 |
|---|---|
| W-1 | 유형 project/proposal/pipeline. 색상 선택 UI 없음(유형 파생·자동 전환). |
| W-2 | Open/Closed 상태를 전 유형에서 설정. Closed 작업은 타임라인·CV 표시되나 신규 배정 선택 제외. |
| W-3 | 필드: 유형, 이름, 전체 시작, 본 프로젝트 시작, 종료, 상태, Main Engagement No., Client, Description, 해시태그, Confidential. 목록 화면 필터·정렬(상태 포함). |
| **W-3a** | **목록 표에 Confidential 표시**: work items 목록(표)에서 confidential 처리된 항목은 **잠금/표식(예: 자물쇠 아이콘 또는 "Confidential" 배지)으로 기밀임을 한눈에 식별**할 수 있게 표기한다. |
| W-4 | Closed 전환 시 편집 잠금(전 역할): admin·editor에게도 읽기 전용. |
| W-5 | 편집하려면 Open으로 되돌려야 함. Open/Closed 전환은 editor/admin만. |
| W-6 | Closed 잠금은 서버(정책/트리거)에서도 강제(status를 open으로 되돌리는 전환만 허용). |

### 5.6 휴가 유형 관리
- leave_types.active 토글. 비활성 유형은 신규 휴가 배정 선택 제외(기존 이력 유지).

### 5.7 작업항목 상세 페이지
- 더블클릭 시 상세(유형·상태, 이름, 고객사, Engagement No., 기간(pre-study/본), Description, 해시태그, Confidential, 참여 인력 직급순·본 프로젝트 수행기간). editor/admin 편집·상태 전환(Closed는 W-4). viewer 마스킹.

### 5.8 Engagement 검색
- 작업명·고객사명·Description·해시태그 검색 → 참여 인력·해시태그 상세. confidential 마스킹. viewer도 동일(읽기 전용, Pipeline 비노출, 마스킹).

### 5.9 개인 CV (CV Generator)
- 인력별 수행 작업항목(Engagement No., Client, 본인 수행기간=본 프로젝트 한정, 해시태그). Open/Closed 무관. 수행 프로젝트만 필터(기본). Pipeline 제외. **이름 검색·필터 제공.** confidential 마스킹.
- viewer는 본인 CV만 조회·다운로드.

### 5.10 휴가 패널 (Leave)
| ID | 요구사항 |
|---|---|
| LV-1 | 적립/사용/잔여, 유형별 소계, 이력(차감 원천), 무급 내역. 사용·잔여 총량 정합(FIFO 원천 표시용). 수동 적립·사용 +/-. 자동 잔여 배정(가장 가까운 빈 영업일, 순서 ①주말대체→②프로젝트휴가→③포상, 유형 구분). |
| **LV-2** | **사람 검색·필터 제공(CV Generator와 동일)**: Leave 탭 상단에 인력 이름 검색 및 직급·재직상태 등 필터를 두어 대상 인력을 선택해 휴가 상세를 본다. |
| **LV-3** | **viewer 자동 상세창 잠김 버그 수정**: viewer가 Leave 탭에 들어가면 본인 휴가 상세가 자동 표시되되, **상세 창이 모달처럼 화면을 점유하거나 강제로 다시 열려 다른 탭 이동을 막는 일이 없어야 한다.** 닫기/탭 이동이 정상 동작해야 하며, viewer의 Leave는 본인 데이터를 **인라인(탭 본문)으로 표시**하고 강제 모달·자동 재오픈을 하지 않는다. |
| LV-4 | viewer는 Leave에서 본인 데이터만 열람, 편집 기능 비활성. |

### 5.11 대시보드
표시 순서:
1. Utilization 4종 도넛 (FY/기간 선택 포함)
2. **프로젝트 Kick-off 목록**: 지난주·이번주·다음주에 **시작(main_start, 없으면 start 기준)** 하는 프로젝트 목록(주차 구분 표기).
3. **프로젝트 종료 목록**: 지난주·이번주·다음주에 **종료(end_date 기준)** 되는 프로젝트 목록(주차 구분 표기).
4. 금주 복귀 예정자
5. 업무지정 필요대상 (향후 7일 내 미배정 영업일 1개↑)

- Kick-off·종료 목록은 project 유형 기준이며, viewer에게는 Confidential 마스킹·Pipeline 비노출 규칙을 동일 적용한다.
- viewer도 전체 대시보드 동일 열람(읽기 전용).

### 5.12 백업/복원
- 전체 JSON 다운로드/복원(admin).

---

## 6. 인증·권한

### 6.1 인증
- Supabase Auth(이메일/비밀번호). 공개가입 비활성·관리자 발급. service-role 키 미노출.

### 6.2 계정↔인력 매칭
- `profiles.person_id` = `people.id`로만 매칭(관리자 수동 설정). LPN 매칭 미사용. `my_person_id()` = `profiles.person_id`.

### 6.3 역할별 접근
| 역할 | 접근 |
|---|---|
| admin | 전체 편집 + 계정·권한·설정·백업 + Admin·Migration |
| editor | 전체 데이터 열람·편집 |
| viewer | editor와 동일 화면 **전면 읽기 전용**. ① 모든 편집 비활성(서버 RLS 차단), ② CV·Leave는 본인(person_id)만, ③ Pipeline 비노출, ④ Confidential 마스킹, ⑤ Admin·Migration 비노출 |

### 6.4 Closed 잠금(전 역할)
- Closed 작업/배정은 admin·editor에게도 편집 비활성. Open 전환 후 편집(§5.5). 서버 강제.

### 6.5 RLS 요지
- people: 인증 전 역할 SELECT 전체(쓰기 editor/admin). work_items: viewer는 type≠pipeline만(마스킹 work_items_safe). assignments: viewer는 pipeline 연결분 제외. accruals: viewer는 본인만. 전 테이블 쓰기 editor/admin + Closed 잠금. (부록 B)

### 6.6 모바일 읽기 전용 (신규)
| ID | 요구사항 |
|---|---|
| MOB-1 | **화면 너비 768px 미만은 모바일로 판단**한다. `useMobile()` 훅으로 `window.innerWidth`를 감지하며, resize 이벤트도 구독해 창 크기 변경 시 실시간 반영한다. |
| MOB-2 | 모바일에서는 **계정 역할(admin/editor/viewer)과 무관하게** 모든 편집·생성·삭제·상태변경 컨트롤이 **비활성(hidden 또는 disabled)** 처리된다. 데이터 조회·열람은 정상 동작한다. |
| MOB-3 | 모바일 접속 시 화면 상단에 **"모바일에서는 읽기 전용으로 제공됩니다"** 안내 배너를 표시한다. |
| MOB-4 | 모바일 읽기 전용은 **프런트엔드 전용 제한**이다(서버 RLS 추가 변경 불필요). admin·editor가 PC로 전환하면 즉시 편집권 복원된다. |

---

## 7. 휴가 산정 규칙
1. 프로젝트휴가: (배정 ∩ 본 프로젝트 구간) 달력일수 → round(투입일수/10). Pre-study 제외.
2. 주말/휴일대체: 실근무일만 주말 0.5·공휴일 1.0(pipeline 제외).
3. 지연보상: 종료 후 지정휴가 아닌데 15일+ 지연 시 ≤1:0/1.5~3:1/3.5~5:2/5.5↑:3.
4. 사용·잔여 총량 정합(FIFO 원천 표시용, 음수 허용). 수동 +/-.
5. 자동 잔여 배정: §5.10.
6. 휴가 영업일 스냅.

## 8. Utilization & FY
- Partner 제외, 재직 기간 내. 분자=project 본 프로젝트 영업일수, 분모=주말·공휴일·휴가·휴직 제외 영업일수. 분모 0이면 ―. 도넛. FY 7월 시작(fiscal_year=month≥7?year+1:year). FY26=2025-07-01~2026-06-30.

## 9. UI/UX

### 9.0 브랜딩 비노출 (중요)
- **EY / EYP / EY-Parthenon 등 어떤 브랜드 명칭·로고·약어도 화면·문서 타이틀·이미지·파일명·코드(변수/주석/자산 경로) 어디에도 노출하지 않는다.**
- 기존에 삽입된 EY-Parthenon 로고 자산과 'EYP'/'EY' 텍스트를 모두 제거한다.
- **헤더 로고는 `assets/logo.png`(정사각형 비율의 아이콘형 이미지)를 사용**한다. 헤더에 어울리는 적당한 크기(예: 높이 28~36px, 정사각형)로 표시한다. 기존의 '전' 글자/이니셜 마크는 제거하고 logo.png로 대체한다.
- 프로그램명은 **"전략팀 대시보드"** 로만 표기(헤더·document title·로그인·푸터). 푸터 "Created by Eudong Hwang" 유지.

### 9.1 색상/표기/레이아웃
- 색상 파생(§4). MM/DD. 반응형. Admin·Migration admin 전용. Undo/Redo 버튼. 호버 툴팁, 중복 배정 경고, sticky 헤더/라벨, 즉시 필터+필터칩, 모달 Esc/Enter, 빈 상태 안내. viewer 편집 컨트롤 전면 비활성.

### 9.2 모바일 UX (신규)
- 너비 768px 미만에서는 상단에 읽기 전용 안내 배너 표시(§6.6 MOB-3).
- 편집 버튼·폼·드래그 입력 비활성(MOB-2). 조회·열람·필터·검색은 정상 동작.
- 반응형 레이아웃으로 타임라인·대시보드·목록 화면이 모바일에서도 열람 가능해야 한다.

---

## 10. 아키텍처/비기능
- React + Supabase. 인증 필수, 권한·기밀·Closed RLS/뷰/트리거 강제, service-role 미노출, audit_log, 날짜 UTC 일 단위. 타임라인 헤더/본문 스크롤 동기화(§5.2 T-8). **모바일(768px 미만) 읽기 전용 프런트엔드 제한(§6.6).**

## 11. 제약/한계
- 보안은 RLS·마스킹 뷰·Closed 트리거 정확성 의존. Undo 다중 사용자 동시 변경 시 실패 가능. SSO 미사용.

## 12. 보안 점검 및 강화 (필수)
명백히 위험한 보안 위협을 점검·개선한다. 최소 다음을 충족한다:
| ID | 요구사항 |
|---|---|
| SEC-1 | **service-role 키 / 비밀값이 클라이언트 번들·리포지토리에 포함되지 않음.** anon key만 클라이언트 사용. 관리자 권한 작업은 Edge Function(서버) + service-role 환경변수로만. |
| SEC-2 | **모든 데이터 테이블 RLS 활성화 및 정책 검증.** RLS 미적용 테이블이 없어야 한다. 권한별(admin/editor/viewer) 정책이 의도대로 동작(특히 viewer 읽기전용·본인만·Pipeline 비노출·Confidential 마스킹·Closed 잠금). |
| SEC-3 | **기밀·민감 데이터가 네트워크 응답에 평문 유출되지 않음.** Confidential 마스킹은 서버(work_items_safe 뷰/RPC)에서 수행하고, viewer 응답에 타인 accruals·pipeline·기밀 원문이 포함되지 않는지 확인. |
| SEC-4 | **권한 상승·우회 차단.** 클라이언트 입력(역할·person_id 등)을 신뢰하지 않고 서버에서 auth.uid() 기반으로만 판단. global_role·person_id 변경은 admin 정책으로만 허용. |
| SEC-5 | **인증·세션 안전.** 비밀번호는 Supabase Auth가 해시 관리, 공개 회원가입 비활성, 세션 토큰 안전 보관(로컬스토리지 노출 최소화), 로그아웃·만료 처리. 가능 시 비밀번호 정책/속도제한 검토. |
| SEC-6 | **입력 검증·인젝션·XSS 방지.** 사용자 입력(텍스트/검색어/해시태그/Description 등) 렌더 시 XSS 방지(이스케이프), 검색은 파라미터 바인딩으로 SQL 인젝션 차단. CV HTML 다운로드 시 사용자 입력 이스케이프. |
| SEC-7 | **의존성/구성 점검.** 알려진 취약 의존성 점검(npm audit 등), CORS·도메인 제한, 디버그/소스맵·콘솔 민감정보 노출 제거, 오류 메시지에 민감정보 비노출. |
| SEC-8 | **감사·복구.** 데이터·권한 변경 audit_log 기록, 백업/복원은 admin 한정. |

---

## 부록 A. 변경 이력
| 버전 | 내용 |
|---|---|
| v2.0~v2.6 | 대시보드/Utilization, 생애주기, 권한 모델, FY(7월), 색상 고정, Pre-study 분리, Engagement 검색, Confidential, 휴가 +/-·자동배정, Undo/Redo, 작업 상세, 전 유형 Open/Closed·편집잠금, viewer 재설계, person_id 매칭, 스크롤 동기화, 브랜딩 제거 |
| **v2.7 (이전 개정)** | **타임라인 렌더 윈도우 제한**(지정 시 기간 ±1개월, 미지정 시 당일 ±7개월만 표시, T-10), **로고를 assets/logo.png(정사각 아이콘)로 사용**(§9.0), **대시보드 프로젝트 Kick-off·종료 목록 추가**(지난주·이번주·다음주), **보안 점검·강화 섹션 추가(§12)** |
| **v2.8 (본 개정)** | **모바일(768px 미만) 전면 읽기 전용 정책 추가**(§6.6, §9.2): 역할 무관 편집 비활성, 상단 안내 배너, useMobile() 훅 기반 실시간 감지. E-5 추가(§5.3). |

---

## 부록 B. 구현 가이드 (참고)

### B.1 색상 파생
```
TYPE_FAMILY = { project: BLUE[], proposal: YELLOW[], pipeline: GRAY[] }
LEAVE_GREEN = { 지정휴가:#10b981, 프로젝트휴가:#059669, 주말/휴일대체:#14b8a6,
                포상휴가:#84cc16, 특별휴가:#22c55e, 지연보상:#0d9488, 리프레시:#34d399, 휴직:#84a98c }
```

### B.2 헬퍼 (person_id 매칭)
```sql
create or replace function my_role() returns text language sql stable as $$
  select global_role from profiles where id=auth.uid() $$;
create or replace function my_person_id() returns uuid language sql stable as $$
  select person_id from profiles where id=auth.uid() $$;
```

### B.3 viewer RLS / 마스킹 / Closed
- people SELECT: 인증 전 역할 / 쓰기 editor·admin.
- work_items SELECT: editor·admin 전체, viewer는 type<>'pipeline'. 읽기는 work_items_safe(기밀 마스킹) 경유.
- assignments SELECT: viewer는 pipeline 연결분 제외. accruals SELECT: viewer는 person_id=my_person_id().
- 전 테이블 쓰기 editor·admin. Closed: work_items UPDATE 시 status 외 변경 거부 + Closed 작업 연결 assignments 쓰기 거부 트리거.

### B.4 타임라인 스크롤 동기화(개념)
```
// 헤더(날짜)와 본문(막대)을 하나의 가로 스크롤 컨테이너에 두거나,
// 분리 시 onScroll로 scrollLeft를 상호 동기화. 막대/날짜 좌표는
// 동일 viewportStart 원점 + pxPerDay로 계산(FY 필터로 원점이 바뀌어도 양쪽 동일 적용).
```
