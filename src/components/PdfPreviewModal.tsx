import { useEffect, useState } from 'react';
import { Download, FileText, Printer, RefreshCw, X } from 'lucide-react';
import { apiClient } from '../services/apiClient.ts';
import type { AmortizationRow, RhpTransaction, SignatureNames } from '../types/rhp.ts';
import { buildPdfFilename, formatBangkokDate } from '../utils/rhpCalculator.ts';

interface PdfPreviewModalProps {
  open: boolean;
  transaction: RhpTransaction | null;
  schedule: AmortizationRow[];
  onClose: () => void;
}

export function PdfPreviewModal({ open, transaction, schedule, onClose }: PdfPreviewModalProps) {
  const [signatures, setSignatures] = useState<SignatureNames>({
    preparedByName: '',
    preparedByPosition: 'Risk Control Officer',
    preparedDate: formatBangkokDate(),
    reviewedByName: '',
    reviewedByPosition: 'Risk Control Supervisor',
    reviewedDate: '',
    approvedByName: '',
    approvedByPosition: 'Risk Management Approver',
    approvedDate: '',
  });
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [filename, setFilename] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !transaction) return;
    setSignatures({
      preparedByName: transaction.createdBy || '',
      preparedByPosition: 'Risk Control Officer',
      preparedDate: transaction.transactionDate || formatBangkokDate(),
      reviewedByName: '',
      reviewedByPosition: 'Risk Control Supervisor',
      reviewedDate: '',
      approvedByName: transaction.transactionStatus === 'Approved' ? transaction.approvedBy : '',
      approvedByPosition: 'Risk Management Approver',
      approvedDate:
        transaction.transactionStatus === 'Approved'
          ? transaction.lastUpdated.slice(0, 10)
          : '',
    });
  }, [open, transaction]);

  const buildPreview = async (sigOverride?: SignatureNames) => {
    if (!transaction) return;
    setLoading(true);
    setError(null);
    try {
      const result = await apiClient.generatePdfBlob({
        transaction,
        schedule,
        signatures: sigOverride || signatures,
      });
      setPdfUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(result.blob);
      });
      setFilename(result.filename);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ไม่สามารถสร้างไฟล์ PDF ได้');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open && transaction) {
      const initialSigs: SignatureNames = {
        preparedByName: transaction.createdBy || '',
        preparedByPosition: 'Risk Control Officer',
        preparedDate: transaction.transactionDate || formatBangkokDate(),
        reviewedByName: '',
        reviewedByPosition: 'Risk Control Supervisor',
        reviewedDate: '',
        approvedByName: transaction.transactionStatus === 'Approved' ? transaction.approvedBy : '',
        approvedByPosition: 'Risk Management Approver',
        approvedDate:
          transaction.transactionStatus === 'Approved'
            ? transaction.lastUpdated.slice(0, 10)
            : '',
      };
      void buildPreview(initialSigs);
    }
    return () => {
      setPdfUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, transaction?.rhpContractId, transaction?.transactionStatus]);

  if (!open || !transaction) return null;

  const targetFilename =
    filename || buildPdfFilename(transaction.rhpContractId, transaction.transactionDate);

  const handleDownload = () => {
    if (!pdfUrl) return;
    const link = document.createElement('a');
    link.href = pdfUrl;
    link.download = targetFilename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handlePrint = () => {
    const iframe = document.getElementById('rhp-pdf-preview-frame') as HTMLIFrameElement | null;
    if (iframe?.contentWindow) {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="ตัวอย่างเอกสาร PDF แบบสรุปการคำนวณ RHP"
    >
      <div className="flex h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 px-6 py-4">
          <div className="flex items-center gap-3">
            <FileText className="h-5 w-5 text-[#0F2942]" />
            <div>
              <h3 className="text-base font-semibold text-slate-900">
                เอกสารสรุปการคำนวณ RHP (PDF A4 แนวตั้ง)
              </h3>
              <p className="text-xs text-slate-500">
                <span className="font-mono font-medium text-slate-700">{targetFilename}</span>
                <span className="mx-2" aria-hidden="true">
                  ·
                </span>
                <span
                  className={
                    transaction.transactionStatus === 'Approved'
                      ? 'font-semibold text-emerald-700'
                      : 'font-semibold text-amber-700'
                  }
                >
                  สถานะ: {transaction.transactionStatus === 'Approved' ? 'Approved (อนุมัติแล้ว)' : 'Draft (ร่างเอกสาร)'}
                </span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void buildPreview()}
              disabled={loading}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              อัปเดตผู้ลงนามใน PDF
            </button>
            <button
              type="button"
              onClick={handlePrint}
              disabled={!pdfUrl || loading}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <Printer className="h-3.5 w-3.5" />
              พิมพ์เอกสาร
            </button>
            <button
              type="button"
              onClick={handleDownload}
              disabled={!pdfUrl || loading}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-[#0F2942] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1E3A5F] disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" />
              ดาวน์โหลด PDF
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              aria-label="ปิด"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-12">
          {/* Signature editor sidebar */}
          <div className="overflow-y-auto border-b border-slate-200 bg-slate-50 p-5 lg:col-span-4 lg:border-b-0 lg:border-r">
            <h4 className="text-sm font-semibold text-slate-900">ข้อมูลผู้ลงนามในเอกสาร</h4>
            <p className="mt-1 text-xs text-slate-500">
              ระบุชื่อ ตำแหน่ง และวันที่ลงนาม (สามารถเว้นว่างเพื่อพิมพ์ไปเซ็นสดได้) แล้วกดอัปเดต PDF
            </p>

            <div className="mt-4 space-y-5">
              <div className="space-y-2 border-b border-slate-200 pb-4">
                <p className="text-xs font-semibold text-slate-800">1. ผู้จัดทำรายการ (Prepared By)</p>
                <input
                  type="text"
                  placeholder="ชื่อ-นามสกุล"
                  value={signatures.preparedByName}
                  onChange={(e) =>
                    setSignatures((s) => ({ ...s, preparedByName: e.target.value }))
                  }
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 focus:border-[#0F2942] focus:outline-none"
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    placeholder="ตำแหน่ง"
                    value={signatures.preparedByPosition}
                    onChange={(e) =>
                      setSignatures((s) => ({ ...s, preparedByPosition: e.target.value }))
                    }
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 focus:border-[#0F2942] focus:outline-none"
                  />
                  <input
                    type="text"
                    placeholder="YYYY-MM-DD"
                    value={signatures.preparedDate}
                    onChange={(e) =>
                      setSignatures((s) => ({ ...s, preparedDate: e.target.value }))
                    }
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono text-xs text-slate-900 focus:border-[#0F2942] focus:outline-none"
                  />
                </div>
              </div>

              <div className="space-y-2 border-b border-slate-200 pb-4">
                <p className="text-xs font-semibold text-slate-800">2. ผู้ตรวจสอบ (Reviewed By)</p>
                <input
                  type="text"
                  placeholder="ชื่อ-นามสกุล"
                  value={signatures.reviewedByName}
                  onChange={(e) =>
                    setSignatures((s) => ({ ...s, reviewedByName: e.target.value }))
                  }
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 focus:border-[#0F2942] focus:outline-none"
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    placeholder="ตำแหน่ง"
                    value={signatures.reviewedByPosition}
                    onChange={(e) =>
                      setSignatures((s) => ({ ...s, reviewedByPosition: e.target.value }))
                    }
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 focus:border-[#0F2942] focus:outline-none"
                  />
                  <input
                    type="text"
                    placeholder="YYYY-MM-DD"
                    value={signatures.reviewedDate}
                    onChange={(e) =>
                      setSignatures((s) => ({ ...s, reviewedDate: e.target.value }))
                    }
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono text-xs text-slate-900 focus:border-[#0F2942] focus:outline-none"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-xs font-semibold text-slate-800">3. ผู้อนุมัติ (Approved By)</p>
                <input
                  type="text"
                  placeholder="ชื่อ-นามสกุล"
                  value={signatures.approvedByName}
                  onChange={(e) =>
                    setSignatures((s) => ({ ...s, approvedByName: e.target.value }))
                  }
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 focus:border-[#0F2942] focus:outline-none"
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    placeholder="ตำแหน่ง"
                    value={signatures.approvedByPosition}
                    onChange={(e) =>
                      setSignatures((s) => ({ ...s, approvedByPosition: e.target.value }))
                    }
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 focus:border-[#0F2942] focus:outline-none"
                  />
                  <input
                    type="text"
                    placeholder="YYYY-MM-DD"
                    value={signatures.approvedDate}
                    onChange={(e) =>
                      setSignatures((s) => ({ ...s, approvedDate: e.target.value }))
                    }
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-mono text-xs text-slate-900 focus:border-[#0F2942] focus:outline-none"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* PDF Embedded Viewer */}
          <div className="relative flex flex-col bg-slate-200 lg:col-span-8">
            {error && (
              <div className="m-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            )}
            {loading && (
              <div className="flex flex-1 items-center justify-center text-sm font-medium text-slate-600">
                กำลังสร้างเอกสาร PDF ภาษาไทย...
              </div>
            )}
            {!loading && pdfUrl && (
              <iframe
                id="rhp-pdf-preview-frame"
                src={pdfUrl}
                title="RHP PDF Preview"
                className="h-full w-full flex-1 border-0"
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
