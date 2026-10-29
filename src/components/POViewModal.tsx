import { X, Printer, Download } from 'lucide-react';
import { formatCurrency, formatDate } from '../lib/utils';
import { getCachedSettings } from '../lib/appSettings';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

interface POViewModalProps {
  po: any;
  onClose: () => void;
}

const statusColor: Record<string, string> = {
  received: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
  pending: 'bg-amber-50 text-amber-700 border border-amber-200',
  cancelled: 'bg-red-50 text-red-700 border border-red-200',
};

function downloadPO(po: any) {
  const s = getCachedSettings();
  const doc = new jsPDF();
  const teal: [number, number, number] = [13, 148, 136];
  const dark: [number, number, number] = [15, 23, 42];
  const muted: [number, number, number] = [100, 116, 139];
  const light: [number, number, number] = [241, 245, 249];
  const pageW = doc.internal.pageSize.getWidth();

  doc.setFillColor(...teal);
  doc.rect(0, 0, pageW, 12, 'F');
  doc.setFontSize(8);
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.text(`${s.company_name.toUpperCase()} — ${s.company_tagline.toUpperCase()}`, 14, 8);
  doc.text('PURCHASE ORDER', pageW - 14, 8, { align: 'right' });

  let y = 22;
  doc.setFontSize(16);
  doc.setTextColor(...dark);
  doc.setFont('helvetica', 'bold');
  doc.text(s.company_name, 14, y);
  y += 5;
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...muted);
  doc.text(s.company_address, 14, y);
  y += 4;
  const contactLine = [s.company_email, s.company_phone].filter(Boolean).join('  |  ');
  if (contactLine) doc.text(contactLine, 14, y);

  const rightX = pageW - 14;
  let ry = 22;
  doc.setFontSize(22);
  doc.setTextColor(...light);
  doc.setFont('helvetica', 'bold');
  doc.text('PURCHASE ORDER', rightX, ry, { align: 'right' });
  ry += 7;
  doc.setFontSize(11);
  doc.setTextColor(...teal);
  doc.text(po.po_no || `PO-${po.id}`, rightX, ry, { align: 'right' });
  ry += 5;
  doc.setFontSize(8);
  doc.setTextColor(...muted);
  doc.setFont('helvetica', 'normal');
  doc.text(`Date: ${formatDate(po.date)}`, rightX, ry, { align: 'right' });

  y = Math.max(y, ry) + 10;
  doc.setDrawColor(...light);
  doc.setLineWidth(0.5);
  doc.line(14, y, pageW - 14, y);
  y += 6;

  doc.setFontSize(7);
  doc.setTextColor(...muted);
  doc.setFont('helvetica', 'bold');
  doc.text('SUPPLIER', 14, y);
  y += 4;
  doc.setFontSize(10);
  doc.setTextColor(...dark);
  doc.text(po.supplier_name || 'N/A', 14, y);
  y += 8;

  const items = po.items || [];
  autoTable(doc, {
    startY: y,
    head: [['#', 'Description', 'Qty', 'Unit Price', 'Amount']],
    body: items.map((it: any, i: number) => [
      i + 1,
      it.tire_name || '',
      it.qty,
      formatCurrency(it.unit_price ?? 0),
      formatCurrency(it.amount ?? (it.qty * (it.unit_price ?? 0))),
    ]),
    styles: { fontSize: 8, cellPadding: 3, textColor: dark },
    headStyles: { fillColor: teal, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 7.5 },
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
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...teal);
  doc.text('TOTAL:', totalsX - 40, afterTable, { align: 'right' });
  doc.text(formatCurrency(po.total), totalsX, afterTable, { align: 'right' });

  const pageH = doc.internal.pageSize.getHeight();
  doc.setFillColor(...teal);
  doc.rect(0, pageH - 10, pageW, 10, 'F');
  doc.setFontSize(7);
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'normal');
  doc.text(`${getCachedSettings().company_name} — Purchase Order Document`, pageW / 2, pageH - 4, { align: 'center' });

  doc.save(`${po.po_no || `PO-${po.id}`}.pdf`);
}

function printPO(po: any) {
  const s = getCachedSettings();
  const doc = new jsPDF();
  const teal: [number, number, number] = [13, 148, 136];
  const dark: [number, number, number] = [15, 23, 42];
  const pageW = doc.internal.pageSize.getWidth();

  doc.setFillColor(...teal);
  doc.rect(0, 0, pageW, 12, 'F');
  doc.setFontSize(8);
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.text(`${s.company_name.toUpperCase()} — PURCHASE ORDER`, 14, 8);
  doc.text(po.po_no || '', pageW - 14, 8, { align: 'right' });

  const items = po.items || [];
  autoTable(doc, {
    startY: 22,
    head: [['#', 'Description', 'Qty', 'Unit Price', 'Amount']],
    body: items.map((it: any, i: number) => [
      i + 1, it.tire_name, it.qty,
      formatCurrency(it.unit_price ?? 0),
      formatCurrency(it.amount ?? (it.qty * (it.unit_price ?? 0))),
    ]),
    styles: { fontSize: 8, textColor: dark },
    headStyles: { fillColor: teal },
    margin: { left: 14, right: 14 },
  });

  const blob = doc.output('blob');
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  if (win) win.onload = () => { win.focus(); win.print(); };
}

export default function POViewModal({ po, onClose }: POViewModalProps) {
  if (!po) return null;
  const items = po.items || [];

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 flex-shrink-0">
          <h2 className="text-base font-bold text-slate-900">Purchase Order — {po.po_no}</h2>
          <div className="flex items-center gap-2">
            <button onClick={() => printPO(po)}
              className="flex items-center gap-1.5 text-sm text-slate-600 bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-lg transition-colors">
              <Printer size={14} /> Print
            </button>
            <button onClick={() => downloadPO(po)}
              className="flex items-center gap-1.5 text-sm text-white bg-teal-600 hover:bg-teal-700 px-3 py-1.5 rounded-lg transition-colors">
              <Download size={14} /> Download PDF
            </button>
            <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg transition-colors">
              <X size={16} className="text-slate-500" />
            </button>
          </div>
        </div>

        <div className="overflow-y-auto flex-1 p-6 sm:p-8">
          <div className="max-w-xl mx-auto">
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-4 mb-6">
              <div>
                <div className="flex items-center gap-2.5 mb-2">
                  <div className="w-10 h-10 bg-teal-600 rounded-xl flex items-center justify-center">
                    <span className="text-white font-bold text-sm">
                      {getCachedSettings().company_name.split(' ').map((w: string) => w[0] || '').join('').slice(0, 2).toUpperCase()}
                    </span>
                  </div>
                  <div>
                    <p className="text-base font-bold text-slate-900">{getCachedSettings().company_name}</p>
                    <p className="text-xs text-slate-500">{getCachedSettings().company_tagline}</p>
                  </div>
                </div>
                <p className="text-xs text-slate-500">{getCachedSettings().company_address}</p>
              </div>
              <div className="sm:text-right">
                <p className="text-2xl font-bold text-slate-200 uppercase tracking-widest">PO</p>
                <p className="text-base font-bold text-teal-600 mt-1">{po.po_no}</p>
                <p className="text-xs text-slate-500 mt-1">Date: {formatDate(po.date)}</p>
                <span className={`inline-block mt-2 text-xs font-semibold px-2.5 py-1 rounded-full ${statusColor[po.status] || ''}`}>
                  {(po.status || '').toUpperCase()}
                </span>
              </div>
            </div>

            <div className="bg-slate-50 rounded-xl p-4 mb-5">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Supplier</p>
              <p className="text-sm font-bold text-slate-900">{po.supplier_name || 'N/A'}</p>
              {po.supplier_phone && <p className="text-xs text-slate-500 mt-0.5">{po.supplier_phone}</p>}
            </div>

            <div className="overflow-x-auto mb-5">
              <table className="w-full min-w-[380px]">
                <thead>
                  <tr className="bg-teal-600 text-white">
                    <th className="text-xs font-semibold text-left px-3 py-2.5 rounded-l-lg">#</th>
                    <th className="text-xs font-semibold text-left px-3 py-2.5">Description</th>
                    <th className="text-xs font-semibold text-center px-3 py-2.5">Qty</th>
                    <th className="text-xs font-semibold text-right px-3 py-2.5">Unit Price</th>
                    <th className="text-xs font-semibold text-right px-3 py-2.5 rounded-r-lg">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {items.map((item: any, i: number) => (
                    <tr key={i} className="hover:bg-slate-50">
                      <td className="px-3 py-2.5 text-xs text-slate-500">{i + 1}</td>
                      <td className="px-3 py-2.5 text-sm text-slate-900">{item.tire_name}</td>
                      <td className="px-3 py-2.5 text-sm text-slate-700 text-center">{item.qty}</td>
                      <td className="px-3 py-2.5 text-sm text-slate-700 text-right">{formatCurrency(item.unit_price ?? 0)}</td>
                      <td className="px-3 py-2.5 text-sm font-semibold text-slate-900 text-right">
                        {formatCurrency(item.amount ?? (item.qty * (item.unit_price ?? 0)))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end">
              <div className="w-52 space-y-2">
                <div className="flex justify-between text-sm text-slate-600">
                  <span>Subtotal</span><span>{formatCurrency(po.subtotal)}</span>
                </div>
                <div className="flex justify-between text-base font-bold pt-2 border-t-2 border-slate-200">
                  <span className="text-slate-900">Total</span>
                  <span className="text-teal-600">{formatCurrency(po.total)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
