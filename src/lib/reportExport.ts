import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import { formatCurrency, formatDate } from './utils';
import { getCachedSettings } from './appSettings';

const primary: [number, number, number] = [13, 148, 136];   // teal-600
const dark:    [number, number, number] = [15, 23, 42];      // slate-900
const muted:   [number, number, number] = [100, 116, 139];   // slate-500

function makePDFHeader(doc: jsPDF, title: string, subtitle: string) {
  const s = getCachedSettings();
  const pageW = doc.internal.pageSize.getWidth();
  doc.setFillColor(...primary);
  doc.rect(0, 0, pageW, 12, 'F');
  doc.setFontSize(8);
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.text(`${s.company_name.toUpperCase()} — ${title.toUpperCase()}`, 14, 8);
  doc.text(subtitle, pageW - 14, 8, { align: 'right' });

  let y = 22;
  doc.setFontSize(16);
  doc.setTextColor(...dark);
  doc.setFont('helvetica', 'bold');
  doc.text(title, 14, y); y += 5;
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...muted);
  doc.text(subtitle, 14, y); y += 6;
  doc.setDrawColor(241, 245, 249);
  doc.setLineWidth(0.5);
  doc.line(14, y, pageW - 14, y);
  return y + 6;
}

// ── Sales Report ─────────────────────────────────────────────────────────────

export function exportSalesReportPDF(sales: any[], dateLabel: string) {
  const doc = new jsPDF();
  const startY = makePDFHeader(doc, 'Sales Report', dateLabel);

  const rows = sales.map(s => [
    s.invoice_no || '',
    formatDate(s.date),
    s.customer_name || '',
    formatCurrency(s.subtotal),
    formatCurrency(s.tax),
    formatCurrency(s.total),
    formatCurrency(s.amount_paid || 0),
    (s.status || '').toUpperCase(),
  ]);

  autoTable(doc, {
    startY,
    head: [['Invoice #', 'Date', 'Customer', 'Subtotal', 'Tax', 'Total', 'Paid', 'Status']],
    body: rows,
    styles: { fontSize: 8, cellPadding: 3, textColor: dark },
    headStyles: { fillColor: primary, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 7.5 },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: {
      3: { halign: 'right' },
      4: { halign: 'right' },
      5: { halign: 'right', fontStyle: 'bold' },
      6: { halign: 'right' },
      7: { halign: 'center' },
    },
    margin: { left: 14, right: 14 },
  });

  const totalRevenue = sales.filter(s => s.status !== 'voided').reduce((sum, s) => sum + Number(s.total), 0);
  const finalY = (doc as any).lastAutoTable.finalY + 6;
  const pageW = doc.internal.pageSize.getWidth();
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...primary);
  doc.text(`Total Revenue (excl. voided): ${formatCurrency(totalRevenue)}`, pageW - 14, finalY, { align: 'right' });

  doc.save(`sales-report-${dateLabel.replace(/\s/g, '-')}.pdf`);
}

export function exportSalesReportExcel(sales: any[], dateLabel: string) {
  const data = sales.map(s => ({
    'Invoice #':    s.invoice_no || '',
    'Date':         formatDate(s.date),
    'Customer':     s.customer_name || '',
    'Subtotal':     Number(s.subtotal) || 0,
    'Tax':          Number(s.tax) || 0,
    'Total':        Number(s.total) || 0,
    'Amount Paid':  Number(s.amount_paid) || 0,
    'Balance':      Math.max(0, Number(s.total) - Number(s.amount_paid || 0)),
    'Status':       s.status || '',
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sales Report');
  XLSX.writeFile(wb, `sales-report-${dateLabel.replace(/\s/g, '-')}.xlsx`);
}

// ── Stock Report ─────────────────────────────────────────────────────────────

/** Column wording for stock exports; defaults match a tyre shop. groupOf resolves the Type / Category cell. */
export interface StockLabels { brand: string; name: string; size: string; group: string; groupOf?: (item: any) => string }
const TYRE_LABELS: StockLabels = { brand: 'Brand', name: 'Model', size: 'Size', group: 'Type' };
const groupCell = (t: any, l: StockLabels) => (l.groupOf ? l.groupOf(t) : t.type) || '';

export function exportStockReportPDF(tires: any[], labels: StockLabels = TYRE_LABELS) {
  const doc = new jsPDF({ orientation: 'landscape' });
  const startY = makePDFHeader(doc, 'Stock Report', `Generated ${new Date().toLocaleDateString()}`);

  const rows = tires.map(t => [
    t.brand || '',
    t.model || '',
    t.size  || '',
    groupCell(t, labels),
    t.stock,
    t.reorder_level,
    formatCurrency(t.cost_price),
    formatCurrency(t.sale_price),
    formatCurrency(Number(t.stock) * Number(t.sale_price)),
  ]);

  autoTable(doc, {
    startY,
    head: [[labels.brand, labels.name, labels.size, labels.group, 'Stock', 'Reorder', 'Cost Price', 'Sale Price', 'Stock Value']],
    body: rows,
    styles: { fontSize: 8, cellPadding: 3, textColor: dark },
    headStyles: { fillColor: primary, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 7.5 },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: {
      4: { halign: 'center' },
      5: { halign: 'center' },
      6: { halign: 'right' },
      7: { halign: 'right' },
      8: { halign: 'right', fontStyle: 'bold' },
    },
    margin: { left: 14, right: 14 },
  });

  const totalValue = tires.reduce((sum, t) => sum + Number(t.stock) * Number(t.sale_price), 0);
  const finalY = (doc as any).lastAutoTable.finalY + 6;
  const pageW = doc.internal.pageSize.getWidth();
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...primary);
  doc.text(`Total Stock Value: ${formatCurrency(totalValue)}`, pageW - 14, finalY, { align: 'right' });

  doc.save('stock-report.pdf');
}

export function exportStockReportExcel(tires: any[], labels: StockLabels = TYRE_LABELS) {
  const data = tires.map(t => ({
    [labels.brand]:        t.brand || '',
    [labels.name]:        t.model || '',
    [labels.size]:         t.size  || '',
    'Type':         groupCell(t, labels),
    'Stock':        Number(t.stock) || 0,
    'Reorder Level': Number(t.reorder_level) || 0,
    'Cost Price':   Number(t.cost_price) || 0,
    'Sale Price':   Number(t.sale_price) || 0,
    'Stock Value':  Number(t.stock) * Number(t.sale_price),
    'Cost Value':   Number(t.stock) * Number(t.cost_price),
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Stock Report');
  XLSX.writeFile(wb, 'stock-report.xlsx');
}

// ── Low-Stock Report ─────────────────────────────────────────────────────────

export function exportLowStockReportPDF(tires: any[], labels: StockLabels = TYRE_LABELS) {
  const doc = new jsPDF({ orientation: 'landscape' });
  const startY = makePDFHeader(doc, 'Low Stock Report', `Generated ${new Date().toLocaleDateString()} — ${tires.length} items need reordering`);

  const rows = tires.map(t => [
    t.brand || '',
    t.model || '',
    t.size  || '',
    groupCell(t, labels),
    t.stock,
    t.reorder_level,
    Math.max(0, Number(t.reorder_level) - Number(t.stock)),
    formatCurrency(t.sale_price),
  ]);

  autoTable(doc, {
    startY,
    head: [[labels.brand, labels.name, labels.size, labels.group, 'Current Stock', 'Reorder Level', 'Deficit', 'Sale Price']],
    body: rows,
    styles: { fontSize: 8, cellPadding: 3, textColor: dark },
    headStyles: { fillColor: [239, 68, 68], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 7.5 },
    alternateRowStyles: { fillColor: [254, 242, 242] },
    columnStyles: {
      4: { halign: 'center' },
      5: { halign: 'center' },
      6: { halign: 'center', textColor: [220, 38, 38] as [number,number,number], fontStyle: 'bold' },
      7: { halign: 'right' },
    },
    margin: { left: 14, right: 14 },
  });

  doc.save('low-stock-report.pdf');
}

export function exportLowStockReportExcel(tires: any[], labels: StockLabels = TYRE_LABELS) {
  const data = tires.map(t => ({
    [labels.brand]:          t.brand || '',
    [labels.name]:          t.model || '',
    [labels.size]:           t.size  || '',
    'Type':           groupCell(t, labels),
    'Current Stock':  Number(t.stock) || 0,
    'Reorder Level':  Number(t.reorder_level) || 0,
    'Deficit':        Math.max(0, Number(t.reorder_level) - Number(t.stock)),
    'Sale Price':     Number(t.sale_price) || 0,
    'Cost Price':     Number(t.cost_price) || 0,
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Low Stock');
  XLSX.writeFile(wb, 'low-stock-report.xlsx');
}
