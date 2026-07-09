-- PRD v2.31 AL-2b③ — 가산일수 계산 버그 소급 정정
--
-- 버그: 이전 Edge Function 이 'elapsed = n + 1' 을 사용해 가산일수를 계산했는데,
--       1~6월 입사자(firstFiscalYear = hireYear)의 경우 elapsed 가 실제 근속연수보다
--       1 높아, 짝수 근속연수(2, 4, 6…년차)에서 1일씩 더 계산됐음.
--       올바른 공식: floor((만근속연수 - 1) / 2)
--       만근속연수 = yearsOfEmployment(hire_date, make_date(grant_year, 7, 1))
--
-- 예시 오류 (2022-01-01 입사):
--   2024-07-01 기준: elapsed=3 → 가산1 → 16일  (실제 근속 2년 → 가산0 → 15일)
--   2026-07-01 기준: elapsed=5 → 가산2 → 17일  (실제 근속 4년 → 가산1 → 16일)
--
-- 조치:
--   1. note LIKE '근로기준법 자동계산%' AND grant_type = 'annual' 행만 대상
--   2. 비례연차(year = firstFiscalYear) 는 제외
--   3. 잘못된 days 를 correct_days 로 직접 UPDATE
--   4. note 에 정정 이력 추가, audit_log 에도 기록 (best-effort)

DO $$
DECLARE
  rec           RECORD;
  hire_date     DATE;
  hire_year     INT;
  hire_month    INT;
  hire_day      INT;
  first_fy      INT;
  years_elapsed INT;
  correct_days  NUMERIC(5,1);
  orig_days     NUMERIC(5,1);
  fixed_count   INT := 0;
BEGIN
  FOR rec IN
    SELECT
      alg.id,
      alg.person_id,
      alg.year   AS grant_year,
      alg.days,
      alg.note,
      p.hire_date AS hdate
    FROM  public.annual_leave_grants alg
    JOIN  public.people              p  ON p.id = alg.person_id
    WHERE alg.note       LIKE '근로기준법 자동계산%'
      AND alg.grant_type = 'annual'
      AND p.hire_date    IS NOT NULL
    ORDER BY alg.person_id, alg.year
  LOOP
    hire_date  := rec.hdate::DATE;
    hire_year  := EXTRACT(YEAR  FROM hire_date)::INT;
    hire_month := EXTRACT(MONTH FROM hire_date)::INT;
    hire_day   := EXTRACT(DAY   FROM hire_date)::INT;
    first_fy   := CASE WHEN hire_month < 7 THEN hire_year ELSE hire_year + 1 END;

    -- 비례연차(첫 회계연도) 는 가산 대상 아님 → 건너뜀
    IF rec.grant_year = first_fy THEN CONTINUE; END IF;

    -- 만 근속연수: yearsOfEmployment(hire_date, make_date(grant_year, 7, 1))
    years_elapsed := rec.grant_year - hire_year;
    IF 7 < hire_month OR (7 = hire_month AND 1 < hire_day) THEN
      years_elapsed := years_elapsed - 1;
    END IF;
    IF years_elapsed < 1 THEN CONTINUE; END IF;

    -- 정확한 가산: floor((만근속연수 - 1) / 2), 최대 10일 가산(25일 한도)
    correct_days := LEAST(25, 15 + FLOOR((years_elapsed - 1) / 2.0));
    orig_days    := rec.days;

    -- 0.05일 이상 차이 날 때만 보정 (부동소수점 허용 오차)
    IF ABS(orig_days - correct_days) >= 0.05 THEN
      UPDATE public.annual_leave_grants
      SET
        days = correct_days,
        note = COALESCE(rec.note, '')
               || ' | 가산 계산 버그 소급 정정(원래 값: '
               || orig_days::TEXT
               || '일 → 정정 값: '
               || correct_days::TEXT
               || '일)'
      WHERE id = rec.id;

      -- audit_log: user_id 가 NOT NULL 이면 INSERT 실패 → 무시
      BEGIN
        INSERT INTO public.audit_log (action, target_type, target_id, at)
        VALUES ('fix_bug', 'annual_leave_grants', rec.id::TEXT, NOW());
      EXCEPTION WHEN OTHERS THEN NULL;
      END;

      fixed_count := fixed_count + 1;
      RAISE NOTICE 'Fixed: person=% year=% %일→%일 (근속%년)',
        rec.person_id, rec.grant_year, orig_days, correct_days, years_elapsed;
    END IF;
  END LOOP;

  RAISE NOTICE '소급 정정 완료: 총 %건 수정', fixed_count;
END;
$$;

SELECT
  'migration 0026 (v2.31 seniority bonus fix) done' AS result,
  count(*) FILTER (WHERE note LIKE '%소급 정정%') AS fixed_rows
FROM public.annual_leave_grants;
