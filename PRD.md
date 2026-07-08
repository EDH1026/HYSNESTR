# 전략팀 대시보드 — 제품 요구사항 정의서 (PRD)

| 항목 | 내용 |
|---|---|
| 문서 버전 | v2.10 |
| 프로그램명 | **전략팀 대시보드** |
| 화면 표기 | 헤더·타이틀·푸터·코드 어디에도 **EY / EYP / EY-Parthenon 등 브랜드 표기·로고를 노출하지 않는다**(§9.0). 프로그램명은 "전략팀 대시보드"로만 표기. 로고는 `assets/logo.png`(정사각형 아이콘) 사용(§9.0). |
| 아키텍처 | React + Supabase(Auth · Postgres · RLS) |
| 권한 | admin/editor = 전체 편집 / viewer = 동일 화면 **전면 읽기 전용**(CV·Leave는 본인만, Pipeline 비노출, Confidential 마스킹) |
| 계정↔인력 매칭 | `profiles.person_id` = `people.id` (관리자 수동 설정, LPN 미사용) |
| 회계연도 | 7월 시작 / 6월 마감. FY26 = 2025-07-01 ~ 2026-06-30 |
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
| **E-5** | **Workitem 기간 자동 확장**: 소속 인력의 투입 **종료일이 workitem 종료일(end_date)보다 늦어지면 workitem의 종료일을 그 인력의 종료일로 자동 연장**한다. 반대로 인력의 투입 **시작일이 workitem 시작일(start)보다 앞서면 workitem의 시작일을 그 인력의 시작일로 자동 앞당긴다**(본 프로젝트 시작 main_start는 그대로 두되 start보다 앞설 수 없다는 무결성 유지). 배정 생성·이동·리사이즈·일괄 조작 어느 경로로든 동일 적용. Closed 작업은 잠금 규칙상 배정 변경 자체가 불가하므로 해당 없음. |
| E-4 | viewer는 모든 편집 컨트롤 비활성(서버 RLS로도 차단). |

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
- Utilization 4종 도넛, 금주 복귀 예정자, 업무지정 필요대상(향후 7일 내 미배정 영업일 1개↑), FY/기간 선택. viewer도 동일 열람(읽기 전용).
- **프로젝트 Kick-off 목록**: 지난주·이번주·다음주에 **시작(본 프로젝트 시작 기준)** 하는 프로젝트 목록(주차 구분 표기).
- **프로젝트 종료 목록**: 지난주·이번주·다음주에 **종료(end_date 기준)** 되는 프로젝트 목록(주차 구분 표기).
- Kick-off·종료 목록은 project 유형 기준이며, viewer에게는 Confidential 마스킹·Pipeline 비노출 규칙을 동일 적용한다.
- **드릴다운(D-6)**: 대시보드의 목록 항목은 클릭 시 해당 화면으로 이동한다. ① 업무지정 필요대상·복귀 예정자의 **이름 클릭 → 타임라인의 해당 인력 행으로 이동(스크롤·하이라이트)**, ② Kick-off·종료 목록의 **프로젝트 클릭 → 작업항목 상세 페이지로 이동**. viewer에게도 열람 범위 내에서 동일 동작(마스킹 유지).

### 5.11a 전역 검색 (Cmd/Ctrl+K)
| ID | 요구사항 |
|---|---|
| G-1 | 어느 화면에서든 **Ctrl+K(Mac은 Cmd+K)** 로 전역 검색 팔레트를 연다(헤더의 검색 아이콘으로도 열기 가능). |
| G-2 | 검색 대상: **인력(이름·LPN), 작업항목(이름·고객사·Engagement No.·해시태그·Description)**. 입력 즉시(debounce) 결과 표시. |
| G-3 | 결과 선택 시 해당 위치로 점프: 인력 → 타임라인 해당 행(하이라이트), 작업항목 → 작업 상세 페이지. |
| G-4 | 권한 준수: viewer에게 Pipeline 비노출·Confidential 마스킹 적용(마스킹된 항목은 검색 결과에서 식별 정보로 매칭되지 않음). |

### 5.11b 일괄 업로드 (CSV)
| ID | 요구사항 |
|---|---|
| B-1 | **admin 전용**으로 인력·작업항목을 CSV 파일로 일괄 등록/갱신하는 화면을 제공한다. |
| B-2 | 템플릿 CSV 다운로드 제공: 인력(LPN, 이름, 직급, 역할, 입사일, 퇴사일), 작업항목(유형, 이름, 전체 시작, 본 프로젝트 시작, 종료, 상태, Engagement No., Client, Description, 해시태그, Confidential). |
| B-3 | 업로드 시 **미리보기 + 검증**(필수값·형식(E-00000000/LPN 5자리)·날짜·중복 LPN/Engagement No. 등) 후 확정 반영. 오류 행은 사유와 함께 표시하고 정상 행만 선택 반영 가능. |
| B-4 | 반영 결과(성공/실패 건수)를 요약하고 audit_log에 기록한다. |
| **B-5** | **작업항목 업로드도 인력과 동일한 UX**: 인력 업로드처럼 별도 팝업 없이 같은 화면 흐름(업로드→미리보기→반영)으로 동작한다. |
| **B-6** | **Engagement Code 기반 갱신(upsert)**: 인력의 LPN처럼, 작업항목은 **Engagement No.를 매칭 키**로 사용한다. 업로드 행의 Engagement No.가 기존 작업항목과 일치하면 **새 행을 만들지 않고 해당 작업항목을 제자리 갱신(update)** 하여, 기존 배정(인력과의 연결)이 끊어지지 않도록 한다. Engagement No.가 없거나 미일치인 행만 신규 생성. 갱신/신규 여부를 미리보기에 표시한다. |

### 5.11c Migration/백업 통합
| ID | 요구사항 |
|---|---|
| M-1 | **Migration 탭과 Admin 탭의 백업/복원 기능이 중복이면 Admin 탭의 백업/복원으로 통합**하고 Migration 탭(또는 그 안의 중복 기능)은 제거한다. 통합 후에도 admin 전용 접근은 유지. 초기 데이터 이관 등 Migration 고유 기능이 남아 있으면 그 부분만 Admin 하위 메뉴로 이동한다. |

### 5.12 백업/복원
- 전체 JSON 다운로드/복원(admin). Migration 중복 기능은 Admin으로 통합(§5.11c).

### 5.13 연차 관리 (Annual Leave, editor/admin 전용 탭)

전략팀 자체 휴가 제도(§5.10 Leave)는 실제 휴가 운영의 기준이다. 연차 관리 탭은 그와 별개로 **회사의 공식 휴가 제도(법정연차·신입사원 휴가) 및 회사 타임시트 시스템과의 정합**을 위해 존재하며, 목적은 두 가지다: **(A) 퇴사 정산** — 총 부여된 권리 대비 초과 사용분만 차감하고, 법정연차 미달 사용분은 보상. **(B) 타임시트 코드 안내** — 각 휴가일에 회사 타임시트에 무엇을 입력해야 하는지 안내.

| ID | 요구사항 |
|---|---|
| AL-1 | **viewer 접근 불가**(메뉴 비노출 + 서버 RLS 차단). editor/admin만 열람·편집. |
| AL-2 | **법정연차 적립(리필)**: FY와 무관하게 **매년 1월 1일 기준 역년(calendar year) 단위**. 사람마다 다르므로 **인력×연도별 적립량(법정연차/신입사원 휴가)을 수동 입력**한다. 자동 리필 계산 없음. 수동 보정(+/-, 사유 기재)도 제공. |

**(A) 퇴사 정산 로직**

| ID | 요구사항 |
|---|---|
| AL-3 | **정당 부여 권리(Entitlement)** = 법정연차 적립 합(AL-2, 보정 포함) + 팀 제도상 정당 적립 휴가(프로젝트휴가·주말/휴일대체·포상·특별·지연보상 등 Leave 탭의 모든 적립분). 이 권리 범위 내 사용은 퇴사 시 불이익이 없다. |
| AL-4 | **초과 사용분(차감 대상)** = 유급 휴가 총 사용량 중 **정당 적립(팀 적립분)과 법정연차를 모두 소진하고도 초과한 일수**. 개념적으로: 초과분 = max(0, 총 유급 사용일수 − 팀 정당 적립 합 − 법정연차 적립 합). 이 초과분만 퇴사 시 차감(정산)한다. |
| AL-5 | **미달 보상분** = max(0, 법정연차 적립 합 − 법정연차로 소진 처리된 사용일수(AL-7의 타임시트 '연차' 매핑 일수)). 법정연차보다 적게 썼으면 그 잔여만큼 퇴사 시 보상한다. 팀 적립 휴가(프로젝트휴가 등)를 많이 썼다는 이유로 보상이 줄지 않는다 — 팀 적립분 사용은 권리 행사이므로 법정연차 잔여와 별개로 계산한다. |
| AL-6 | **퇴사 정산 뷰**: 인력·기준일(퇴사일) 선택 시 ① 법정연차 적립·보정 내역, ② 팀 정당 적립 합(유형별), ③ 총 유급 사용, ④ 법정연차 소진 일수(AL-7 매핑 기준), ⑤ 초과 사용분(AL-4), ⑥ 미달 보상분(AL-5), ⑦ 최종 정산(보상 − 차감)을 표로 표시. 퇴사자(termination_date 보유) 조회 가능. |

**(B) 타임시트 코드 매핑 로직**

| ID | 요구사항 |
|---|---|
| AL-7 | 각 휴가 배정일(영업일)마다 회사 타임시트 입력 코드를 다음 규칙으로 산출·안내한다. ① **프로젝트휴가(및 지정휴가 중 프로젝트휴가 차감분)**: 해당 연도 법정연차(신입사원 휴가 포함) 잔여가 **0이 되기 전까지는 '연차'** 로 입력 → 그 시점부터 법정연차 잔여를 순차 소진. ② 법정연차 잔여가 **0이 된 이후의 프로젝트휴가**: **'프로젝트 코드 또는 Unassigned'** 로 입력(실제로는 휴가 사용). ③ **주말/휴일대체 휴가**: 항상 **'프로젝트 코드'**(발생 원천 프로젝트의 Engagement No. 표시). ④ 그 외 유형(포상·특별 등)의 매핑 규칙은 기본값을 두되 설정 가능하게 한다(기본: 연차 잔여 있으면 '연차', 없으면 'Unassigned'). |
| AL-8 | **타임시트 안내 뷰**: 인력·기간 선택 시 그 기간의 휴가일 목록을 날짜순으로 표시하고, 각 일자에 [휴가 유형, 타임시트 입력 코드('연차' / 프로젝트 Engagement No. / 'Unassigned'), 그 시점 법정연차 잔여]를 표로 안내한다. 법정연차 소진 시점(연차→프로젝트코드 전환일)을 시각적으로 구분 표시한다. |
| AL-9 | 법정연차 소진 순서는 **휴가일 날짜순(FIFO)** 으로 적용하며, 역년 경계(1/1 리필)에서 잔여가 갱신된다(이월 없음이 기본, 필요 시 수동 보정으로 처리). |
| AL-10 | 데이터: `annual_leave_grants`(person_id, year, days, note), `annual_leave_adjustments`(person_id, direction, days(+/-), date, note). 매핑·정산은 Leave 탭의 배정/적립/FIFO 결과를 읽어 계산(별도 중복 저장 없음). audit_log 기록. |

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

---

## 7. 휴가 산정 규칙
1. 프로젝트휴가: **인력×프로젝트 단위 합산 적립** — 한 인력이 같은 프로젝트에 둘 이상의 분리된 배정으로 투입된 경우, 배정별로 각각 round 적립하지 않고 **해당 프로젝트 내 모든 투입 구간(각각 본 프로젝트 구간과의 교집합)의 달력일수 합**을 먼저 구한 뒤 **round(합계 투입일수/10)** 로 1회 적립한다. Pre-study 제외. (예: 12일+9일로 나뉜 투입 → round(21/10)=2일. 배정별 계산 round(12/10)+round(9/10)=1+1과 다름에 유의.)
2. 주말/휴일대체: 실근무일만 주말 0.5·공휴일 1.0(pipeline 제외).
3. **지연보상(수동 전환)**: 지연보상은 **자동 산정하지 않는다**(기존 자동 판정 로직 제거). 프로젝트 종료 후 휴가 사용 지연이 자의인지 회사 사정인지는 시스템이 판단할 수 없으므로, **관리자가 휴가 패널의 수동 적립으로 '지연보상' 유형을 직접 부여**한다(권장 기준 참고치: 적립분 ≤1:0 / 1.5~3:1 / 3.5~5:2 / 5.5↑:3 — UI 도움말로만 안내). |
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

---

## 10. 아키텍처/비기능
- React + Supabase. 인증 필수, 권한·기밀·Closed RLS/뷰/트리거 강제, service-role 미노출, audit_log, 날짜 UTC 일 단위. 타임라인 헤더/본문 스크롤 동기화(§5.2 T-8).

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
| **v2.7** | 타임라인 렌더 윈도우 제한, 로고 assets/logo.png, 대시보드 Kick-off·종료 목록, 보안 점검·강화(§12) |
| **v2.8** | 기간 프리셋(T-11), 우클릭 메뉴(T-12), 드래그 미리보기(T-13), 다중 선택 이동(T-14), 대시보드 드릴다운(D-6), 전역 검색(§5.11a), CSV 일괄 업로드(§5.11b) |
| **v2.9** | Workitem 탭 인력 더블클릭 칩 연동(T-15), 드릴다운 오늘 스크롤(T-16), workitem 기간 자동 확장(E-5), 다중 선택 일괄 리사이즈(T-14 확장), CV 분할 투입 반영(V-4), 프로젝트휴가 합산 적립(§7.1) |
| **v2.10 (본 개정)** | **T-16 미동작 버그 재수정 지시(렌더 완료 후 스크롤)**, **Migration↔Admin 백업/복원 통합(§5.11c)**, **작업항목 일괄 업로드 UX 통일 + Engagement Code 기반 upsert로 기존 배정 연결 보존(B-5·B-6)**, **지연보상 자동 산정 폐지 → 수동 부여로 전환(§7.3)**, **연차 관리 탭 신설(§5.13: 퇴사 정산=총 권리를 max(법정연차 누적, 팀 정당 적립 누적)으로 산정해 초과 사용분만 차감·미달분 보상 / 타임시트는 코드 자동 매핑 없이 판단용 수치 안내[법정연차 누적치, 프로젝트휴가 기 사용분, 지정휴가 중 프로젝트휴가 차감분, 지정휴가 선사용분] / 1/1 역년 리필·인력별 수동 적립·보정 / viewer 차단)** |

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
