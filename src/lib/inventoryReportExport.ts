import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import { getCachedSettings } from './appSettings';

export interface ReportColumn { key: string; label: string; type: 'text' | 'int' | 'money' | 'date' | 'datetime' | 'pct'; sum?: boolean }
export interface ReportResult {
  id: string; title: string; description: string; generated_at: string; scope: string;
  filters: Record<string, string | number | null>; columns: ReportColumn[]; rows: Record<string, any>[]; row_count: number; truncated: boolean;
  totals: Record<string, number>; summary: { label: string; value: string | number; money?: boolean }[]; breakdown: { label: string; units?: number; value?: number; share?: number }[]; notes: string[];
}

const iso = (v: unknown) => String(v ?? '');
/** Plain text for a cell, used by the table, CSV, Excel text and PDF. Numbers are not localised here so exports stay machine readable. */
export function cellText(c: ReportColumn, v: any): string {
  if (v === null || v === undefined || v === '') return '';
  if (c.type === 'datetime') return iso(v).slice(0, 16).replace('T', ' ');
  if (c.type === 'date') return iso(v).slice(0, 10);
  return String(v);
}
export function cellDisplay(c: ReportColumn, v: any): string {
  if (v === null || v === undefined || v === '') return '';
  if (c.type === 'money') return Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (c.type === 'int') return Number(v).toLocaleString();
  if (c.type === 'pct') return Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
  return cellText(c, v);
}

const filterLine = (r: ReportResult) => {
  const f = r.filters, bits = [`${f.from} to ${f.to}`];
  if (f.q) bits.push(`search "${f.q}"`);
  bits.push(r.scope === 'organisation' ? 'all branches' : 'this branch');
  return bits.join(' · ');
};

const stamp = () => new Date().toISOString().slice(0, 10);

export function exportXlsx(r: ReportResult) {
  const head = r.columns.map(c => c.label);
  const body = r.rows.map(row => r.columns.map(c => ((c.type === 'int' || c.type === 'money' || c.type === 'pct') && row[c.key] !== null && row[c.key] !== '' && row[c.key] !== undefined ? Number(row[c.key]) : cellText(c, row[c.key]))));
  const total = Object.keys(r.totals).length ? [r.columns.map((c, i) => (i === 0 ? 'Total' : r.totals[c.key] ?? ''))] : [];
  const ws = XLSX.utils.aoa_to_sheet([[r.title], [filterLine(r)], [], head, ...body, ...total]);
  ws['!cols'] = r.columns.map(c => ({ wch: Math.min(40, Math.max(10, c.label.length + 2)) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, r.title.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
  XLSX.writeFile(wb, `${r.id}-${stamp()}.xlsx`);
}

export function exportPdf(r: ReportResult) {
  const doc = new jsPDF({ orientation: r.columns.length > 7 ? 'landscape' : 'portrait' });
  const s = getCachedSettings();
  const w = doc.internal.pageSize.getWidth();
  doc.setFillColor(13, 148, 136); doc.rect(0, 0, w, 12, 'F');
  doc.setFontSize(8); doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold');
  doc.text(`${String(s.company_name || '').toUpperCase()} — INVENTORY REPORT`, 14, 8);
  doc.text(new Date(r.generated_at).toLocaleString(), w - 14, 8, { align: 'right' });
  doc.setFontSize(15); doc.setTextColor(15, 23, 42); doc.text(r.title, 14, 22);
  doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(100, 116, 139); doc.text(filterLine(r), 14, 27);
  let y = 32;
  if (r.summary.length) { doc.text(r.summary.map(x => `${x.label}: ${x.money ? Number(x.value).toLocaleString(undefined, { minimumFractionDigits: 2 }) : x.value}`).join('   |   '), 14, y, { maxWidth: w - 28 }); y += 6; }
  const foot = Object.keys(r.totals).length ? [r.columns.map((c, i) => (i === 0 ? 'Total' : r.totals[c.key] !== undefined ? cellDisplay(c, r.totals[c.key]) : ''))] : undefined;
  autoTable(doc, {
    startY: y, head: [r.columns.map(c => c.label)], body: r.rows.map(row => r.columns.map(c => cellDisplay(c, row[c.key]))), foot,
    styles: { fontSize: 6.5, cellPadding: 1.8, textColor: [15, 23, 42] }, headStyles: { fillColor: [13, 148, 136], textColor: 255, fontSize: 6.5 },
    footStyles: { fillColor: [241, 245, 249], textColor: [15, 23, 42], fontStyle: 'bold' }, alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: Object.fromEntries(r.columns.map((c, i) => [i, { halign: c.type === 'text' || c.type === 'date' || c.type === 'datetime' ? 'left' : 'right' }])),
    didDrawPage: () => { doc.setFontSize(7); doc.setTextColor(148, 163, 184); doc.text(`Page ${doc.getNumberOfPages()}`, w - 14, doc.internal.pageSize.getHeight() - 6, { align: 'right' }); },
  });
  doc.save(`${r.id}-${stamp()}.pdf`);
}

const CSS = 'body{font:12px system-ui,sans-serif;margin:20px;color:#0f172a}h1{font-size:18px;margin:0}p{color:#64748b;margin:2px 0 12px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #e2e8f0;padding:3px 6px;font-size:10px}th{background:#0d9488;color:#fff;text-align:left}td.n{text-align:right}tfoot td{font-weight:700;background:#f1f5f9}';

/** Opens the browser print dialog for a clean table. Built with DOM calls and textContent, so cell values are never parsed as HTML. */
export function printReport(r: ReportResult) {
  const win = window.open('', '_blank', 'width=1000,height=700');
  if (!win) return;
  const d = win.document;
  d.title = r.title;
  const style = d.createElement('style'); style.textContent = CSS; d.head.appendChild(style);
  const h1 = d.createElement('h1'); h1.textContent = r.title; d.body.appendChild(h1);
  const p = d.createElement('p'); p.textContent = `${filterLine(r)} · ${new Date(r.generated_at).toLocaleString()}`; d.body.appendChild(p);
  const table = d.createElement('table');
  const row = (parent: HTMLElement, cells: { text: string; num: boolean }[], tag: 'th' | 'td') => {
    const tr = d.createElement('tr');
    for (const c of cells) { const td = d.createElement(tag); td.textContent = c.text; if (c.num && tag === 'td') td.className = 'n'; tr.appendChild(td); }
    parent.appendChild(tr);
  };
  const isNum = (c: ReportColumn) => !(c.type === 'text' || c.type === 'date' || c.type === 'datetime');
  const thead = d.createElement('thead'); row(thead, r.columns.map(c => ({ text: c.label, num: false })), 'th'); table.appendChild(thead);
  const tbody = d.createElement('tbody'); for (const x of r.rows) row(tbody, r.columns.map(c => ({ text: cellDisplay(c, x[c.key]), num: isNum(c) })), 'td'); table.appendChild(tbody);
  if (Object.keys(r.totals).length) { const tfoot = d.createElement('tfoot'); row(tfoot, r.columns.map((c, i) => ({ text: i === 0 ? 'Total' : r.totals[c.key] !== undefined ? cellDisplay(c, r.totals[c.key]) : '', num: true })), 'td'); table.appendChild(tfoot); }
  d.body.appendChild(table);
  win.focus(); win.print();
}
