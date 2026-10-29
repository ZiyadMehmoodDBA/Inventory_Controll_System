import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { formatCurrency, formatDate } from './utils';
import { getCachedSettings } from './appSettings';

export function generateInvoicePDF(sale: any): jsPDF {
  const s = getCachedSettings();
  const doc = new jsPDF();
  const primary = [13, 148, 136] as [number, number, number];  // teal-600
  const dark = [15, 23, 42] as [number, number, number];       // slate-900
  const muted = [100, 116, 139] as [number, number, number];   // slate-500
  const light = [241, 245, 249] as [number, number, number];   // slate-100

  const pageW = doc.internal.pageSize.getWidth();
  let y = 18;

  // ── Header bar ─────────────────────────────────────────────────────────────
  doc.setFillColor(...primary);
  doc.rect(0, 0, pageW, 12, 'F');
  doc.setFontSize(8);
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.text(`${s.company_name.toUpperCase()} — ${s.company_tagline.toUpperCase()}`, 14, 8);
  doc.text('INVOICE', pageW - 14, 8, { align: 'right' });

  y = 22;

  // ── Company info ───────────────────────────────────────────────────────────
  doc.setFontSize(16);
  doc.setTextColor(...dark);
  doc.setFont('helvetica', 'bold');
  doc.text(s.company_name, 14, y);
  y += 5;
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...muted);
  if (s.company_address) { doc.text(s.company_address, 14, y); y += 4; }
  const contactLine = [s.company_email, s.company_phone].filter(Boolean).join('  |  ');
  if (contactLine) { doc.text(contactLine, 14, y); }

  // ── Invoice details (right column) ─────────────────────────────────────────
  const rightX = pageW - 14;
  let ry = 22;
  doc.setFontSize(22);
  doc.setTextColor(...light);
  doc.setFont('helvetica', 'bold');
  doc.text('INVOICE', rightX, ry, { align: 'right' });
  ry += 7;
  doc.setFontSize(11);
  doc.setTextColor(...primary);
  doc.text(sale.invoice_no || `INV-${sale.id}`, rightX, ry, { align: 'right' });
  ry += 5;
  doc.setFontSize(8);
  doc.setTextColor(...muted);
  doc.setFont('helvetica', 'normal');
  doc.text(`Date: ${formatDate(sale.date)}`, rightX, ry, { align: 'right' });
  ry += 4;
  const statusColors: Record<string, [number, number, number]> = {
    paid: [16, 185, 129],
    pending: [245, 158, 11],
    overdue: [239, 68, 68],
  };
  const sc = statusColors[sale.status] || muted;
  doc.setTextColor(...sc);
  doc.setFont('helvetica', 'bold');
  doc.text((sale.status || '').toUpperCase(), rightX, ry, { align: 'right' });

  y = Math.max(y, ry) + 10;

  // ── Divider ────────────────────────────────────────────────────────────────
  doc.setDrawColor(...light);
  doc.setLineWidth(0.5);
  doc.line(14, y, pageW - 14, y);
  y += 6;

  // ── Bill To ────────────────────────────────────────────────────────────────
  doc.setFontSize(7);
  doc.setTextColor(...muted);
  doc.setFont('helvetica', 'bold');
  doc.text('BILL TO', 14, y);
  y += 4;
  doc.setFontSize(10);
  doc.setTextColor(...dark);
  doc.text(sale.customer_name || 'N/A', 14, y);
  y += 4;
  if (sale.customer_phone) {
    doc.setFontSize(8);
    doc.setTextColor(...muted);
    doc.setFont('helvetica', 'normal');
    doc.text(sale.customer_phone, 14, y);
    y += 4;
  }
  if (sale.customer_address) {
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...muted);
    doc.text(sale.customer_address, 14, y);
    y += 4;
  }
  y += 4;

  // ── Items table ────────────────────────────────────────────────────────────
  const items = sale.items || [];
  autoTable(doc, {
    startY: y,
    head: [['#', 'Description', 'Qty', 'Unit Price', 'Amount']],
    body: items.map((it: any, i: number) => [
      i + 1,
      it.tire_name || it.tire || '',
      it.qty,
      formatCurrency(it.unit_price ?? it.price ?? 0),
      formatCurrency(it.amount ?? (it.qty * (it.unit_price ?? it.price ?? 0))),
    ]),
    styles: { fontSize: 8, cellPadding: 3, textColor: dark },
    headStyles: { fillColor: primary, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 7.5 },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: {
      0: { cellWidth: 8, halign: 'center' },
      2: { halign: 'center', cellWidth: 15 },
      3: { halign: 'right', cellWidth: 32 },
      4: { halign: 'right', cellWidth: 32 },
    },
    margin: { left: 14, right: 14 },
  });

  const afterTable = (doc as any).lastAutoTable.finalY + 6;
  const totalsX = pageW - 14;
  let ty = afterTable;

  // ── Totals ─────────────────────────────────────────────────────────────────
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...muted);
  doc.text('Subtotal:', totalsX - 40, ty, { align: 'right' });
  doc.setTextColor(...dark);
  doc.text(formatCurrency(sale.subtotal), totalsX, ty, { align: 'right' });
  ty += 5;
  doc.setTextColor(...muted);
  doc.text(`Tax (${s.default_tax_rate}%):`, totalsX - 40, ty, { align: 'right' });
  doc.setTextColor(...dark);
  doc.text(formatCurrency(sale.tax), totalsX, ty, { align: 'right' });
  ty += 1;

  doc.setDrawColor(...light);
  doc.line(totalsX - 55, ty + 1, totalsX, ty + 1);
  ty += 5;

  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...primary);
  doc.text('TOTAL:', totalsX - 40, ty, { align: 'right' });
  doc.text(formatCurrency(sale.total), totalsX, ty, { align: 'right' });

  // ── Footer ─────────────────────────────────────────────────────────────────
  const pageH = doc.internal.pageSize.getHeight();
  doc.setFillColor(...primary);
  doc.rect(0, pageH - 10, pageW, 10, 'F');
  doc.setFontSize(7);
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'normal');
  doc.text(`Thank you for your business — Payment due within ${s.payment_due_days} days — ${s.company_name}`, pageW / 2, pageH - 4, { align: 'center' });

  return doc;
}

export function printInvoice(sale: any) {
  const doc = generateInvoicePDF(sale);
  const blob = doc.output('blob');
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  if (win) {
    win.onload = () => {
      win.focus();
      win.print();
    };
  }
}

export function downloadInvoice(sale: any) {
  const doc = generateInvoicePDF(sale);
  doc.save(`${sale.invoice_no || `invoice-${sale.id}`}.pdf`);
}

export function printThermalReceipt(sale: any) {
  const s = getCachedSettings();
  const items = (sale.items || []) as any[];

  const row = (left: string, right: string, bold = false) =>
    `<tr><td style="${bold ? 'font-weight:700;' : ''}">${left}</td><td class="r" style="${bold ? 'font-weight:700;' : ''}">${right}</td></tr>`;

  const divider = `<tr><td colspan="2"><div class="div"></div></td></tr>`;

  const itemRows = items.map(it => {
    const disc = Number(it.discount || 0);
    const name = it.tire_name || it.tire || '';
    const amt  = Number(it.amount ?? it.qty * (it.unit_price ?? 0));
    return `
      <tr><td colspan="2" style="padding-top:4px;font-weight:600;">${name}</td></tr>
      <tr>
        <td class="muted">${it.qty} × ${formatCurrency(it.unit_price ?? 0)}${disc > 0 ? ` −${disc}%` : ''}</td>
        <td class="r">${formatCurrency(amt)}</td>
      </tr>`;
  }).join('');

  const cashGiven = Number(sale.cash_given || 0);
  const changeDue = Number(sale.change_due || (cashGiven > 0 ? Math.max(0, cashGiven - Number(sale.total)) : 0));

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<style>
  @page { size: 80mm auto; margin: 4mm 3mm; }
  * { box-sizing: border-box; }
  body {
    font-family: 'Courier New', monospace;
    font-size: 11px;
    color: #000;
    width: 74mm;
    margin: 0;
  }
  .center { text-align: center; }
  .r { text-align: right; }
  .muted { color: #555; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 1px 0; vertical-align: top; }
  .div { border-top: 1px dashed #000; margin: 5px 0; }
  .big { font-size: 15px; font-weight: 700; }
  h1 { font-size: 14px; margin: 2px 0; }
</style>
</head>
<body>
<div class="center">
  <h1>${s.company_name}</h1>
  <div class="muted">${s.company_tagline || ''}</div>
  <div class="muted">${s.company_address || ''}</div>
  <div class="muted">${[s.company_phone, s.company_email].filter(Boolean).join(' | ')}</div>
</div>
<div class="div"></div>
<table>
  <tr><td>Invoice:</td><td class="r">${sale.invoice_no || ''}</td></tr>
  <tr><td>Date:</td><td class="r">${formatDate(sale.date)}</td></tr>
  <tr><td>Customer:</td><td class="r">${sale.customer_name || ''}</td></tr>
  ${sale.customer_phone ? `<tr><td></td><td class="r muted">${sale.customer_phone}</td></tr>` : ''}
</table>
<div class="div"></div>
<table>
  ${itemRows}
</table>
<div class="div"></div>
<table>
  ${Number(sale.discount) > 0 ? row('Discount', `−${formatCurrency(sale.discount)}`) : ''}
  ${row('Tax (' + s.default_tax_rate + '%):', formatCurrency(sale.tax))}
  ${divider}
  ${row('TOTAL', formatCurrency(sale.total), true)}
  ${sale.payment_method ? row('Payment', (sale.payment_method || '').toUpperCase()) : ''}
  ${cashGiven > 0 ? row('Cash Given', formatCurrency(cashGiven)) : ''}
  ${changeDue > 0 ? row('Change Due', formatCurrency(changeDue)) : ''}
</table>
<div class="div"></div>
<div class="center muted" style="font-size:10px;margin-top:4px;">
  Thank you for your business!<br/>
  Payment due within ${s.payment_due_days} days
</div>
<script>window.onload=()=>{ window.print(); setTimeout(()=>window.close(),1000); }</script>
</body>
</html>`;

  const win = window.open('', '_blank', 'width=320,height=600');
  if (win) {
    win.document.write(html);
    win.document.close();
  }
}
