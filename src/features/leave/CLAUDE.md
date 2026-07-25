# Leave business rules (PRD §7)

- **Project leave**: `round(calendar days in (assignment ∩ main_phase) / 10, 0)` — `main_start` to `end_date` only.
- **Weekend sub**: 0.5 days per Saturday worked, 1.0 day per Sunday/holiday worked. Only dates listed in `assignment.weekend_dates[]`.
- **Delay compensation**: if accrued leave sits unused ≥ 15 days after project end (not pre-scheduled): ≤1 day → +0; 1.5–3 → +1; 3.5–5 → +2; ≥5.5 → +3.
- **Paid leave deduction**: working days only (`workdayCount`). FIFO across accrual records.
