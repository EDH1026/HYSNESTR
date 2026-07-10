/** Shared HTML-export utilities (used by LeavePanel, AnnualLeavePanel, CvPanel). */

export function escHtml(v: unknown): string {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function triggerDownload(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/html;charset=utf-8' })
  const url  = URL.createObjectURL(blob)
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename })
  document.body.appendChild(a); a.click(); document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** Shared CSS for all printable HTML exports. */
export const HTML_EXPORT_CSS = `
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans KR",sans-serif;
    font-size:13px;line-height:1.6;color:#111827;max-width:920px;margin:0 auto;padding:48px 40px}
  header{border-bottom:2px solid #2563eb;padding-bottom:18px;margin-bottom:32px}
  h1{font-size:22px;font-weight:700;color:#111827}
  .pi{margin-top:6px;color:#374151;font-size:14px;font-weight:500}
  .meta{margin-top:3px;color:#6b7280;font-size:12px}
  section{margin-bottom:28px}
  h2{font-size:13px;font-weight:600;color:#1e40af;margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid #e5e7eb}
  .two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .col-box{border:1px solid #e5e7eb;border-radius:8px;padding:12px}
  .col-title{font-size:12px;font-weight:600;margin-bottom:8px}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th{background:#f9fafb;text-align:left;padding:7px 10px;font-weight:500;color:#6b7280;border:1px solid #e5e7eb;white-space:nowrap}
  td{padding:6px 10px;border:1px solid #e5e7eb;color:#374151;vertical-align:top}
  tfoot td{background:#f9fafb;font-weight:600;border-top:2px solid #d1d5db}
  td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  td.mono{font-family:ui-monospace,monospace;font-size:11px;white-space:nowrap}
  td.empty{text-align:center;color:#9ca3af;padding:12px}
  .pos{color:#065f46}.neg{color:#b91c1c}
  .pill{display:inline-block;padding:2px 7px;border-radius:999px;font-size:11px;font-weight:500}
  .pill-blue{background:#eef2ff;color:#4338ca}
  .pill-gray{background:#f3f4f6;color:#374151}
  .pill-green{background:#ecfdf5;color:#065f46}
  .pill-red{background:#fef2f2;color:#b91c1c}
  .pill-purple{background:#f5f3ff;color:#7c3aed}
  .pill-amber{background:#fffbeb;color:#b45309}
  .pill-violet{background:#ede9fe;color:#6d28d9}
  .sb{border:1px solid #e5e7eb;border-radius:8px;overflow:hidden}
  .summary-row{display:flex;align-items:center;justify-content:space-between;
    padding:10px 14px;border-bottom:1px solid #e5e7eb;font-size:12px;font-weight:500}
  .summary-row:last-child{border-bottom:none}
  .summary-row.total{background:#1e40af;color:white;font-size:14px;font-weight:700;padding:14px}
  .summary-row.ok{background:#ecfdf5;color:#065f46}
  .summary-row.err{background:#fef2f2;color:#b91c1c}
  .summary-row.muted{color:#9ca3af;font-weight:400}
  .sv{font-variant-numeric:tabular-nums;font-size:15px;font-weight:700}
  .sv-sm{font-variant-numeric:tabular-nums;font-size:13px;font-weight:700}
  .chosen-a{color:#1d4ed8}.chosen-b{color:#7c3aed}.unchosen{color:#9ca3af}
  .cand{display:flex;align-items:center;justify-content:space-between;font-size:12px;padding:8px 14px;border-bottom:1px solid #e5e7eb}
  .badge{display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:500;margin-left:5px}
  .badge-a{background:#dbeafe;color:#1e40af}.badge-b{background:#ede9fe;color:#6d28d9}
  .hint{font-size:11px;color:#9ca3af;margin-left:5px}
  .mono{font-family:ui-monospace,monospace;font-size:11px}
  .fy-hdr td{background:#f1f5f9;font-size:11px;font-weight:600;color:#64748b;padding:4px 10px;border-color:#e2e8f0}
  .fy-sub td{background:#f9fafb;font-size:11px;color:#6b7280;font-weight:500;border-top:1px dashed #d1d5db}
  @media print{body{padding:20px;max-width:none}@page{margin:20mm;size:A4}section{break-inside:avoid}}
`
