import { useMemo, useState } from 'react';
import {
  Ban,
  CheckCircle2,
  ClipboardCheck,
  Database,
  Eye,
  FileText,
  RefreshCw,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';
import { apiClient, type UserAuthProfile } from '../services/apiClient.ts';
import type { AmortizationRow, ConnectionStatus, RhpTransaction } from '../types/rhp.ts';
import { calculateRhpFinancials, formatPercent, formatTHB } from '../utils/rhpCalculator.ts';
import { ConfirmationModal } from './ConfirmationModal.tsx';
import { PdfPreviewModal } from './PdfPreviewModal.tsx';

interface ApprovalCenterViewProps {
  isPortalAuthenticated: boolean;
  hasSheetsAccess: boolean;
  reconnectLoading?: boolean;
  userProfile: UserAuthProfile | null;
  connection: ConnectionStatus;
  transactions: RhpTransaction[];
  schedulesByContract: Record<string, AmortizationRow[]>;
  loading: boolean;
  onRefresh: () => Promise<void>;
  onRequireSetup: () => void;
  onReconnectSheets: () => Promise<void>;
}

export function ApprovalCenterView({
  isPortalAuthenticated,
  hasSheetsAccess,
  reconnectLoading = false,
  userProfile,
  connection,
  transactions,
  schedulesByContract,
  loading,
  onRefresh,
  onRequireSetup,
  onReconnectSheets,
}: ApprovalCenterViewProps) {
  const [statusTab, setStatusTab] = useState<'pending' | 'revision' | 'approved' | 'rejected'>(
    'pending'
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTx, setSelectedTx] = useState<RhpTransaction | null>(null);
  const [pdfTx, setPdfTx] = useState<RhpTransaction | null>(null);
  const [confirmApproveTx, setConfirmApproveTx] = useState<RhpTransaction | null>(null);
  const [reviewModal, setReviewModal] = useState<{
    tx: RhpTransaction;
    action: 'reject' | 'send_back';
  } | null>(null);
  const [reviewReason, setReviewReason] = useState('');
  const [approvalReason, setApprovalReason] = useState(
    'ตรวจสอบข้อมูลทางการเงินและอนุมัติรายการปรับโครงสร้างสัญญา'
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canApprove = Boolean(
    userProfile?.canApprove ||
      userProfile?.role === 'Super Admin' ||
      userProfile?.role === 'Approver'
  );

  const activeTransactions = useMemo(
    () => transactions.filter((tx) => !tx.isDeleted && tx.transactionStatus !== 'Deleted'),
    [transactions]
  );

  const pendingDrafts = useMemo(
    () =>
      activeTransactions
        .filter((tx) => tx.transactionStatus === 'Draft')
        .slice()
        .reverse(),
    [activeTransactions]
  );

  const revisionList = useMemo(
    () =>
      activeTransactions
        .filter((tx) => tx.transactionStatus === 'Revision Required')
        .slice()
        .reverse(),
    [activeTransactions]
  );

  const approvedList = useMemo(
    () =>
      activeTransactions
        .filter((tx) => tx.transactionStatus === 'Approved')
        .slice()
        .reverse(),
    [activeTransactions]
  );

  const rejectedList = useMemo(
    () =>
      activeTransactions
        .filter((tx) => tx.transactionStatus === 'Rejected')
        .slice()
        .reverse(),
    [activeTransactions]
  );

  const pendingTotalAr = useMemo(
    () => pendingDrafts.reduce((sum, tx) => sum + tx.ar, 0),
    [pendingDrafts]
  );

  const displayedRows = useMemo(() => {
    const source =
      statusTab === 'pending'
        ? pendingDrafts
        : statusTab === 'revision'
          ? revisionList
          : statusTab === 'approved'
            ? approvedList
            : rejectedList;
    const q = searchQuery.trim().toLowerCase();
    if (!q) return source;
    return source.filter(
      (tx) =>
        tx.rhpContractId.toLowerCase().includes(q) ||
        tx.customerId.toLowerCase().includes(q) ||
        tx.customerName.toLowerCase().includes(q) ||
        tx.machineSerialNumber.toLowerCase().includes(q) ||
        tx.originalContractNumber.toLowerCase().includes(q)
    );
  }, [statusTab, pendingDrafts, revisionList, approvedList, rejectedList, searchQuery]);

  const getScheduleForTx = (tx: RhpTransaction): AmortizationRow[] => {
    const stored = schedulesByContract[tx.rhpContractId];
    if (stored && stored.length > 0) return stored;
    return calculateRhpFinancials({
      machineCost: tx.machineCost,
      processingFee: tx.processingFee,
      arOverride: tx.ar,
      arOverrideReason: '',
      interestRate: tx.interestRate,
      interestMethod: tx.interestMethod,
      installmentPeriod: tx.installmentPeriod,
      downPaymentMode: 'percentage',
      downPaymentPercentage: tx.downPaymentPercentage,
      downPaymentAmount: tx.downPaymentAmount,
    }).schedule;
  };

  const handleApprove = async (tx: RhpTransaction) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiClient.updateTransaction(tx.rhpContractId, {
        action: 'approve',
        amendmentReason:
          approvalReason.trim() || 'อนุมัติรายการปรับโครงสร้างสัญญาผ่าน Approval Center',
      });
      await onRefresh();
      setNotice(`อนุมัติสัญญา ${tx.rhpContractId} เรียบร้อยแล้ว`);
      if (selectedTx?.rhpContractId === tx.rhpContractId) {
        setSelectedTx(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ไม่สามารถอนุมัติรายการได้');
    } finally {
      setBusy(false);
    }
  };

  const handleRejectOrSendBack = async () => {
    if (!reviewModal || !reviewReason.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiClient.updateTransaction(reviewModal.tx.rhpContractId, {
        action: reviewModal.action,
        amendmentReason: reviewReason.trim(),
      });
      const targetId = reviewModal.tx.rhpContractId;
      const actionLabel =
        reviewModal.action === 'reject' ? 'ปฏิเสธรายการ' : 'ส่งกลับแก้ไข';
      setReviewModal(null);
      setReviewReason('');
      await onRefresh();
      setNotice(`${actionLabel}สำหรับสัญญา ${targetId} เรียบร้อยแล้ว`);
      if (selectedTx?.rhpContractId === targetId) {
        setSelectedTx(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ไม่สามารถบันทึกผลการตรวจสอบได้');
    } finally {
      setBusy(false);
    }
  };

  if (!canApprove) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-8 text-center">
        <ClipboardCheck className="mx-auto h-10 w-10 text-amber-700" />
        <h3 className="mt-3 text-base font-semibold text-amber-950">
          จำกัดสิทธิ์เฉพาะผู้มีอำนาจอนุมัติ (Approver / Super Admin)
        </h3>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-amber-900">
          บัญชีของคุณ ({userProfile?.role || 'Viewer'}) ไม่มีสิทธิ์เข้าถึงศูนย์อนุมัติรายการปรับโครงสร้างสัญญา
        </p>
      </div>
    );
  }

  if (!isPortalAuthenticated || !connection.connected || !hasSheetsAccess) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-10 text-center">
        <Database className="mx-auto h-10 w-10 text-slate-400" />
        <h3 className="mt-3 text-base font-semibold text-slate-900">
          {!hasSheetsAccess
            ? 'สิทธิ์เชื่อมต่อ Google Sheets หมดอายุชั่วคราว'
            : 'ยังไม่ได้เชื่อมต่อฐานข้อมูล Google Sheets'}
        </h3>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-slate-600">
          {!hasSheetsAccess
            ? 'กรุณากด Reconnect Google เพื่อต่ออายุสิทธิ์ตรวจสอบและอนุมัติรายการใน Google Sheets'
            : 'กรุณาเชื่อมต่อ RHP_Restructuring_Database ก่อนตรวจสอบและอนุมัติรายการสัญญา'}
        </p>
        {!hasSheetsAccess ? (
          <button
            type="button"
            onClick={() => void onReconnectSheets()}
            disabled={reconnectLoading}
            className="mt-5 inline-flex items-center gap-2 whitespace-nowrap rounded-lg bg-amber-700 px-5 py-2.5 text-xs font-semibold text-white hover:bg-amber-800 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${reconnectLoading ? 'animate-spin' : ''}`} />
            {reconnectLoading ? 'กำลังเชื่อมต่อใหม่...' : 'Reconnect Google'}
          </button>
        ) : (
          <button
            type="button"
            onClick={onRequireSetup}
            className="mt-5 whitespace-nowrap rounded-lg bg-[#0F2942] px-5 py-2.5 text-xs font-semibold text-white hover:bg-[#1E3A5F]"
          >
            ตั้งค่าและเชื่อมต่อ Google Sheets
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header & Summary Strip */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-medium text-slate-500">รายการรออนุมัติ (Pending Drafts)</p>
          <p className="mt-2 font-mono text-2xl font-bold text-amber-700 tabular-nums">
            {pendingDrafts.length}{' '}
            <span className="text-xs font-normal text-slate-500">สัญญา</span>
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-medium text-slate-500">ยอด AR รวมที่รออนุมัติ</p>
          <p className="mt-2 font-mono text-2xl font-bold text-[#0F2942] tabular-nums">
            {formatTHB(pendingTotalAr)}{' '}
            <span className="text-xs font-normal text-slate-500">THB</span>
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-medium text-slate-500">รายการที่อนุมัติแล้ว (Approved)</p>
          <p className="mt-2 font-mono text-2xl font-bold text-emerald-700 tabular-nums">
            {approvedList.length}{' '}
            <span className="text-xs font-normal text-slate-500">สัญญา</span>
          </p>
        </div>
      </div>

      {/* Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-200/70 p-1">
          <button
            type="button"
            onClick={() => setStatusTab('pending')}
            className={`whitespace-nowrap rounded-md px-3.5 py-1.5 text-xs font-semibold transition-colors ${
              statusTab === 'pending'
                ? 'bg-white text-amber-800 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            รออนุมัติ ({pendingDrafts.length})
          </button>
          <button
            type="button"
            onClick={() => setStatusTab('revision')}
            className={`whitespace-nowrap rounded-md px-3.5 py-1.5 text-xs font-semibold transition-colors ${
              statusTab === 'revision'
                ? 'bg-white text-[#0F2942] shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            ส่งกลับแก้ไข ({revisionList.length})
          </button>
          <button
            type="button"
            onClick={() => setStatusTab('approved')}
            className={`whitespace-nowrap rounded-md px-3.5 py-1.5 text-xs font-semibold transition-colors ${
              statusTab === 'approved'
                ? 'bg-white text-emerald-800 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            อนุมัติแล้ว ({approvedList.length})
          </button>
          <button
            type="button"
            onClick={() => setStatusTab('rejected')}
            className={`whitespace-nowrap rounded-md px-3.5 py-1.5 text-xs font-semibold transition-colors ${
              statusTab === 'rejected'
                ? 'bg-white text-red-700 shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            ปฏิเสธ ({rejectedList.length})
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative min-w-[240px]">
            <Search className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="ค้นหา RHP ID, ลูกค้า, Serial..."
              className="w-full rounded-lg border border-slate-300 bg-white py-2 pr-3 pl-9 text-xs text-slate-900 focus:border-[#0F2942] focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={() => void onRefresh()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            รีเฟรชรายการ
          </button>
        </div>
      </div>

      {notice && (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-800">
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="rounded p-0.5 text-emerald-700 hover:bg-emerald-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {error && (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="rounded p-0.5 text-red-600 hover:bg-red-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Approval Table */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        {loading ? (
          <div className="p-8 text-center text-xs text-slate-500">
            กำลังโหลดรายการสัญญาจาก Google Sheets...
          </div>
        ) : displayedRows.length === 0 ? (
          <div className="p-10 text-center text-xs text-slate-500">
            ไม่พบรายการสัญญาในหมวดหมู่นี้
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-4 py-3 font-semibold">เลขที่สัญญา RHP</th>
                  <th className="px-4 py-3 font-semibold">วันที่ทำรายการ</th>
                  <th className="px-4 py-3 font-semibold">ลูกค้า / เครื่องจักร</th>
                  <th className="px-4 py-3 font-semibold">ผู้จัดทำ (Prepared By)</th>
                  <th className="px-4 py-3 text-right font-semibold">ยอด AR (THB)</th>
                  <th className="px-4 py-3 text-right font-semibold">ค่างวด/เดือน</th>
                  <th className="px-4 py-3 font-semibold">สถานะ</th>
                  <th className="px-4 py-3 text-right font-semibold">ดำเนินการ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {displayedRows.map((tx) => (
                  <tr key={tx.rhpContractId} className="hover:bg-slate-50/80">
                    <td className="px-4 py-3 font-mono font-semibold text-[#0F2942] whitespace-nowrap">
                      {tx.rhpContractId}
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-600 whitespace-nowrap tabular-nums">
                      {tx.transactionDate}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{tx.customerName}</div>
                      <div className="font-mono text-[11px] text-slate-500">
                        {tx.customerId} · SN: {tx.machineSerialNumber}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-700">{tx.createdBy || '-'}</td>
                    <td className="px-4 py-3 text-right font-mono font-semibold text-slate-900 tabular-nums whitespace-nowrap">
                      {formatTHB(tx.ar)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono font-semibold text-emerald-700 tabular-nums whitespace-nowrap">
                      {formatTHB(tx.monthlyInstallment)}
                      <div className="text-[11px] font-normal text-slate-500">
                        {tx.installmentPeriod} งวด · {formatPercent(tx.interestRate, 2)}
                      </div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span
                        className={`font-semibold ${
                          tx.transactionStatus === 'Approved'
                            ? 'text-emerald-700'
                            : tx.transactionStatus === 'Rejected'
                              ? 'text-red-700'
                              : tx.transactionStatus === 'Revision Required'
                                ? 'text-[#0F2942]'
                                : 'text-amber-700'
                        }`}
                      >
                        {tx.transactionStatus}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setSelectedTx(tx)}
                          className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
                        >
                          <Eye className="h-3 w-3" />
                          ตรวจสอบ
                        </button>
                        <button
                          type="button"
                          onClick={() => setPdfTx(tx)}
                          className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-[#0F2942] hover:bg-slate-50"
                        >
                          <FileText className="h-3 w-3" />
                          PDF
                        </button>
                        {(tx.transactionStatus === 'Draft' ||
                          tx.transactionStatus === 'Revision Required') && (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                setApprovalReason(
                                  'ตรวจสอบข้อมูลทางการเงินและอนุมัติรายการปรับโครงสร้างสัญญา'
                                );
                                setConfirmApproveTx(tx);
                              }}
                              className="inline-flex items-center gap-1 rounded bg-emerald-700 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-emerald-800"
                            >
                              <CheckCircle2 className="h-3 w-3" />
                              อนุมัติ
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setReviewReason('');
                                setReviewModal({ tx, action: 'send_back' });
                              }}
                              className="inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-900 hover:bg-amber-100"
                            >
                              <RotateCcw className="h-3 w-3" />
                              ส่งกลับแก้ไข
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setReviewReason('');
                                setReviewModal({ tx, action: 'reject' });
                              }}
                              className="inline-flex items-center gap-1 rounded border border-red-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-50"
                            >
                              <Ban className="h-3 w-3" />
                              ปฏิเสธ
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Inspection Modal */}
      {selectedTx && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <div>
                <h3 className="font-mono text-base font-bold text-[#0F2942]">
                  {selectedTx.rhpContractId}
                </h3>
                <p className="text-xs text-slate-500">
                  {selectedTx.customerName} ({selectedTx.customerId}) · สถานะ:{' '}
                  <span
                    className={
                      selectedTx.transactionStatus === 'Approved'
                        ? 'font-semibold text-emerald-700'
                        : selectedTx.transactionStatus === 'Rejected'
                          ? 'font-semibold text-red-700'
                          : 'font-semibold text-amber-700'
                    }
                  >
                    {selectedTx.transactionStatus}
                  </span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedTx(null)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="overflow-y-auto p-6 text-xs">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2 rounded-lg border border-slate-200 p-4">
                  <p className="font-semibold text-slate-900">ข้อมูลลูกค้าและเครื่องจักร</p>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Serial Number:</span>
                    <span className="font-mono text-slate-900">{selectedTx.machineSerialNumber}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">สัญญาเดิม:</span>
                    <span className="font-mono text-slate-900">{selectedTx.originalContractNumber}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">ผู้จัดทำ:</span>
                    <span className="font-mono text-slate-900">{selectedTx.createdBy}</span>
                  </div>
                </div>
                <div className="space-y-2 rounded-lg border border-slate-200 p-4">
                  <p className="font-semibold text-slate-900">รายละเอียดทางการเงิน</p>
                  <div className="flex justify-between">
                    <span className="text-slate-500">ยอด AR:</span>
                    <span className="font-mono font-semibold text-slate-900 tabular-nums">
                      {formatTHB(selectedTx.ar)} THB
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">เงินดาวน์:</span>
                    <span className="font-mono text-slate-900 tabular-nums">
                      {formatTHB(selectedTx.downPaymentAmount)} THB ({formatPercent(selectedTx.downPaymentPercentage, 2)})
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">ยอดจัดไฟแนนซ์:</span>
                    <span className="font-mono font-semibold text-[#0F2942] tabular-nums">
                      {formatTHB(selectedTx.financedPrincipal)} THB
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">ค่างวด/เดือน:</span>
                    <span className="font-mono font-bold text-emerald-700 tabular-nums">
                      {formatTHB(selectedTx.monthlyInstallment)} THB ({selectedTx.installmentPeriod} งวด)
                    </span>
                  </div>
                </div>
              </div>

              {(selectedTx.transactionStatus === 'Draft' ||
                selectedTx.transactionStatus === 'Revision Required') && (
                <div className="mt-5 flex flex-wrap items-center justify-end gap-2.5 border-t border-slate-200 pt-4">
                  <button
                    type="button"
                    onClick={() => {
                      setReviewReason('');
                      setReviewModal({ tx: selectedTx, action: 'send_back' });
                    }}
                    className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-100"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    ส่งกลับแก้ไข (Revision Required)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setReviewReason('');
                      setReviewModal({ tx: selectedTx, action: 'reject' });
                    }}
                    className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-red-200 bg-white px-3.5 py-2 text-xs font-semibold text-red-700 hover:bg-red-50"
                  >
                    <Ban className="h-3.5 w-3.5" />
                    ปฏิเสธสัญญา (Reject)
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmApproveTx(selectedTx)}
                    className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-emerald-700 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-800"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    อนุมัติสัญญานี้ (Approve)
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Reject / Send Back Modal */}
      {reviewModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  {reviewModal.action === 'reject'
                    ? `ยืนยันการปฏิเสธสัญญา ${reviewModal.tx.rhpContractId}`
                    : `ส่งกลับสัญญาเพื่อแก้ไข ${reviewModal.tx.rhpContractId}`}
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  {reviewModal.tx.customerName} ({reviewModal.tx.customerId})
                </p>
              </div>
              <button
                type="button"
                onClick={() => setReviewModal(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3 px-6 py-5 text-xs">
              <p className="text-slate-600">
                {reviewModal.action === 'reject'
                  ? 'สถานะสัญญาจะเปลี่ยนเป็น Rejected และบันทึกเหตุผลลง Audit_Log'
                  : 'สถานะสัญญาจะเปลี่ยนเป็น Revision Required เพื่อให้ Risk Control แก้ไขและนำกลับมาเสนอใหม่'}
              </p>
              <div>
                <label className="block font-semibold text-slate-800">
                  เหตุผล / หมายเหตุ (บังคับระบุ) <span className="text-red-600">*</span>
                </label>
                <input
                  type="text"
                  value={reviewReason}
                  onChange={(e) => setReviewReason(e.target.value)}
                  placeholder="ระบุรายละเอียดหรือสิ่งที่ต้องแก้ไข..."
                  className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5 border-t border-slate-100 px-6 py-4">
              <button
                type="button"
                onClick={() => setReviewModal(null)}
                disabled={busy}
                className="whitespace-nowrap rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={() => void handleRejectOrSendBack()}
                disabled={busy || !reviewReason.trim()}
                className={`whitespace-nowrap rounded-lg px-4 py-2 text-xs font-semibold text-white disabled:opacity-50 ${
                  reviewModal.action === 'reject'
                    ? 'bg-red-700 hover:bg-red-800'
                    : 'bg-amber-700 hover:bg-amber-800'
                }`}
              >
                {busy ? 'กำลังบันทึก...' : 'ยืนยันดำเนินการ'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Approve Confirmation Modal */}
      <ConfirmationModal
        open={Boolean(confirmApproveTx)}
        title={`ยืนยันการอนุมัติสัญญา ${confirmApproveTx?.rhpContractId || ''}`}
        description="เมื่ออนุมัติแล้ว สถานะสัญญาจะเปลี่ยนเป็น Approved พร้อมบันทึกชื่อผู้อนุมัติและประวัติลง Audit Log"
        details={
          confirmApproveTx
            ? [
                `ลูกค้า: ${confirmApproveTx.customerId} - ${confirmApproveTx.customerName}`,
                `ยอด AR: ${formatTHB(confirmApproveTx.ar)} THB`,
                `ยอดจัดไฟแนนซ์: ${formatTHB(confirmApproveTx.financedPrincipal)} THB`,
                `ค่างวด/เดือน: ${formatTHB(confirmApproveTx.monthlyInstallment)} THB (${confirmApproveTx.installmentPeriod} งวด)`,
              ]
            : undefined
        }
        busy={busy}
        onCancel={() => setConfirmApproveTx(null)}
        onConfirm={() => {
          const target = confirmApproveTx;
          setConfirmApproveTx(null);
          if (target) void handleApprove(target);
        }}
      />

      <PdfPreviewModal
        open={Boolean(pdfTx)}
        transaction={pdfTx}
        schedule={pdfTx ? getScheduleForTx(pdfTx) : []}
        onClose={() => setPdfTx(null)}
      />
    </div>
  );
}
