import { useMemo, useState } from 'react';
import {
  CheckCircle2,
  Database,
  Edit3,
  Eye,
  FileText,
  History,
  Lock,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { apiClient, type UserAuthProfile } from '../services/apiClient.ts';
import type {
  AmortizationRow,
  AuditLogEntry,
  ConnectionStatus,
  RhpTransaction,
} from '../types/rhp.ts';
import { calculateRhpFinancials, formatPercent, formatTHB } from '../utils/rhpCalculator.ts';
import { ConfirmationModal } from './ConfirmationModal.tsx';
import { PdfPreviewModal } from './PdfPreviewModal.tsx';

interface TransactionDatabaseViewProps {
  isAuthenticated: boolean;
  userProfile: UserAuthProfile | null;
  connection: ConnectionStatus;
  transactions: RhpTransaction[];
  schedulesByContract: Record<string, AmortizationRow[]>;
  auditLogs: AuditLogEntry[];
  loading: boolean;
  onRefresh: () => Promise<void>;
  onRequireSetup: () => void;
}

export function TransactionDatabaseView({
  isAuthenticated,
  userProfile,
  connection,
  transactions,
  schedulesByContract,
  auditLogs,
  loading,
  onRefresh,
  onRequireSetup,
}: TransactionDatabaseViewProps) {
  const [subTab, setSubTab] = useState<'records' | 'audit'>('records');
  const [searchQuery, setSearchQuery] = useState('');
  const [filterDate, setFilterDate] = useState('');
  const [filterMonth, setFilterMonth] = useState('');
  const [filterYear, setFilterYear] = useState('');
  const [filterStatus, setFilterStatus] = useState<'All' | 'Draft' | 'Approved'>('All');

  const [selectedTx, setSelectedTx] = useState<RhpTransaction | null>(null);
  const [pdfTx, setPdfTx] = useState<RhpTransaction | null>(null);

  // Amendment / Edit modal state
  const [editingTx, setEditingTx] = useState<RhpTransaction | null>(null);
  const [editCustomerName, setEditCustomerName] = useState('');
  const [editRate, setEditRate] = useState(0);
  const [editReason, setEditReason] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [confirmApproveTx, setConfirmApproveTx] = useState<RhpTransaction | null>(null);
  const [confirmAmendOpen, setConfirmAmendOpen] = useState(false);

  const availableYears = useMemo(() => {
    const years = new Set<string>();
    for (const tx of transactions) {
      if (tx.transactionDate.length >= 4) {
        years.add(tx.transactionDate.slice(0, 4));
      }
    }
    return Array.from(years).sort().reverse();
  }, [transactions]);

  const filteredTransactions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return transactions
      .filter((tx) => {
        if (filterStatus !== 'All' && tx.transactionStatus !== filterStatus) return false;
        if (filterDate && tx.transactionDate !== filterDate) return false;
        if (filterYear && !tx.transactionDate.startsWith(filterYear)) return false;
        if (filterMonth && tx.transactionDate.slice(5, 7) !== filterMonth) return false;
        if (!q) return true;
        return (
          tx.rhpContractId.toLowerCase().includes(q) ||
          tx.customerId.toLowerCase().includes(q) ||
          tx.customerName.toLowerCase().includes(q) ||
          tx.machineSerialNumber.toLowerCase().includes(q) ||
          tx.originalContractNumber.toLowerCase().includes(q)
        );
      })
      .slice()
      .reverse();
  }, [transactions, searchQuery, filterStatus, filterDate, filterMonth, filterYear]);

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

  const handleApproveTransaction = async (tx: RhpTransaction) => {
    setActionBusy(true);
    setActionError(null);
    try {
      await apiClient.updateTransaction(tx.rhpContractId, {
        action: 'approve',
        amendmentReason: 'อนุมัติรายการปรับโครงสร้างสัญญา',
      });
      await onRefresh();
      if (selectedTx?.rhpContractId === tx.rhpContractId) {
        setSelectedTx(null);
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'ไม่สามารถอนุมัติสัญญาได้');
    } finally {
      setActionBusy(false);
    }
  };

  const openEditModal = (tx: RhpTransaction) => {
    setEditingTx(tx);
    setEditCustomerName(tx.customerName);
    setEditRate(tx.interestRate);
    setEditReason('');
    setActionError(null);
  };

  const handleCommitAmendment = async () => {
    if (!editingTx) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await apiClient.updateTransaction(editingTx.rhpContractId, {
        action: editingTx.transactionStatus === 'Approved' ? 'amend' : 'update',
        amendmentReason: editReason.trim(),
        customerName: editCustomerName.trim(),
        financialInput: {
          machineCost: editingTx.machineCost,
          processingFee: editingTx.processingFee,
          arOverride: editingTx.ar,
          arOverrideReason: '',
          interestRate: editRate,
          interestMethod: editingTx.interestMethod,
          installmentPeriod: editingTx.installmentPeriod,
          downPaymentMode: 'percentage',
          downPaymentPercentage: editingTx.downPaymentPercentage,
          downPaymentAmount: editingTx.downPaymentAmount,
        },
      });
      setEditingTx(null);
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'ไม่สามารถบันทึกการแก้ไขได้');
    } finally {
      setActionBusy(false);
    }
  };

  if (!isAuthenticated || !connection.connected) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-10 text-center">
        <Database className="mx-auto h-10 w-10 text-slate-400" />
        <h3 className="mt-3 text-base font-semibold text-slate-900">
          ยังไม่ได้เชื่อมต่อฐานข้อมูล Google Sheets
        </h3>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-slate-600">
          เชื่อมต่อสเปรดชีต RHP_Restructuring_Database เพื่อค้นหา ดูรายละเอียดย้อนหลัง อนุมัติสัญญา และออกเอกสาร PDF
          จากฐานข้อมูลจริงของบริษัท
        </p>
        <button
          type="button"
          onClick={onRequireSetup}
          className="mt-5 whitespace-nowrap rounded-lg bg-[#0F2942] px-5 py-2.5 text-xs font-semibold text-white hover:bg-[#1E3A5F]"
        >
          ตั้งค่าและเชื่อมต่อ Google Sheets
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header & Sub-tabs */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-1 rounded-lg bg-slate-200/70 p-1">
          <button
            type="button"
            onClick={() => setSubTab('records')}
            className={`whitespace-nowrap rounded-md px-4 py-1.5 text-xs font-semibold transition-colors ${
              subTab === 'records'
                ? 'bg-white text-[#0F2942] shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            รายการปรับโครงสร้างสัญญา ({transactions.length})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('audit')}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-4 py-1.5 text-xs font-semibold transition-colors ${
              subTab === 'audit'
                ? 'bg-white text-[#0F2942] shadow-sm'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <History className="h-3.5 w-3.5" />
            ประวัติการแก้ไข (Audit_Log · {auditLogs.length})
          </button>
        </div>

        <button
          type="button"
          onClick={() => void onRefresh()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          ซิงก์ข้อมูลล่าสุด
        </button>
      </div>

      {actionError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
          {actionError}
        </div>
      )}

      {subTab === 'records' ? (
        <>
          {/* Search & Filters */}
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
              <div className="relative md:col-span-4">
                <Search className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-slate-400" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="ค้นหา RHP ID, รหัส/ชื่อลูกค้า, Serial, สัญญาเดิม..."
                  className="w-full rounded-lg border border-slate-300 py-2 pr-3 pl-9 text-xs text-slate-900 focus:border-[#0F2942] focus:outline-none"
                />
              </div>

              <div className="md:col-span-2">
                <input
                  type="date"
                  value={filterDate}
                  onChange={(e) => setFilterDate(e.target.value)}
                  aria-label="กรองตามวันที่"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-800"
                />
              </div>

              <div className="md:col-span-2">
                <select
                  value={filterMonth}
                  onChange={(e) => setFilterMonth(e.target.value)}
                  aria-label="กรองตามเดือน"
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-800"
                >
                  <option value="">ทุกเดือน</option>
                  {Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0')).map((m) => (
                    <option key={m} value={m}>
                      เดือน {m}
                    </option>
                  ))}
                </select>
              </div>

              <div className="md:col-span-2">
                <select
                  value={filterYear}
                  onChange={(e) => setFilterYear(e.target.value)}
                  aria-label="กรองตามปี"
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-800"
                >
                  <option value="">ทุกปี</option>
                  {availableYears.map((y) => (
                    <option key={y} value={y}>
                      ปี {y}
                    </option>
                  ))}
                </select>
              </div>

              <div className="md:col-span-2">
                <select
                  value={filterStatus}
                  onChange={(e) =>
                    setFilterStatus(e.target.value as 'All' | 'Draft' | 'Approved')
                  }
                  aria-label="กรองตามสถานะ"
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-800"
                >
                  <option value="All">ทุกสถานะ</option>
                  <option value="Draft">Draft (รออนุมัติ)</option>
                  <option value="Approved">Approved (อนุมัติแล้ว)</option>
                </select>
              </div>
            </div>
          </div>

          {/* Transaction Table */}
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            {loading ? (
              <div className="p-8 text-center text-xs text-slate-500">
                กำลังโหลดข้อมูลจาก Google Sheets...
              </div>
            ) : filteredTransactions.length === 0 ? (
              <div className="p-10 text-center text-xs text-slate-500">
                ไม่พบรายการปรับโครงสร้างสัญญาที่ตรงกับเงื่อนไขการค้นหา
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-4 py-3 font-semibold">เลขที่สัญญา RHP</th>
                      <th className="px-4 py-3 font-semibold">วันที่ทำรายการ</th>
                      <th className="px-4 py-3 font-semibold">ลูกค้า</th>
                      <th className="px-4 py-3 font-semibold">Serial / สัญญาเดิม</th>
                      <th className="px-4 py-3 text-right font-semibold">ยอด AR (THB)</th>
                      <th className="px-4 py-3 text-right font-semibold">ค่างวด/เดือน</th>
                      <th className="px-4 py-3 font-semibold">สถานะ</th>
                      <th className="px-4 py-3 text-right font-semibold">จัดการ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredTransactions.map((tx) => (
                      <tr key={tx.rhpContractId} className="hover:bg-slate-50/80">
                        <td className="px-4 py-3 font-mono font-semibold text-[#0F2942] whitespace-nowrap">
                          {tx.rhpContractId}
                        </td>
                        <td className="px-4 py-3 font-mono text-slate-600 whitespace-nowrap tabular-nums">
                          {tx.transactionDate}
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium text-slate-900">{tx.customerName}</div>
                          <div className="font-mono text-[11px] text-slate-500">{tx.customerId}</div>
                        </td>
                        <td className="px-4 py-3 font-mono text-[11px] text-slate-600">
                          <div>SN: {tx.machineSerialNumber}</div>
                          <div>Orig: {tx.originalContractNumber}</div>
                        </td>
                        <td className="px-4 py-3 text-right font-mono font-semibold text-slate-900 tabular-nums whitespace-nowrap">
                          {formatTHB(tx.ar)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono font-semibold text-emerald-700 tabular-nums whitespace-nowrap">
                          {formatTHB(tx.monthlyInstallment)}
                          <div className="text-[11px] font-normal text-slate-500">
                            {tx.installmentPeriod} งวด · {tx.interestMethod}
                          </div>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span
                            className={`font-semibold ${
                              tx.transactionStatus === 'Approved'
                                ? 'text-emerald-700'
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
                              ดูรายละเอียด
                            </button>
                            <button
                              type="button"
                              onClick={() => setPdfTx(tx)}
                              className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-[#0F2942] hover:bg-slate-50"
                            >
                              <FileText className="h-3 w-3" />
                              PDF
                            </button>
                            {tx.transactionStatus === 'Draft' && userProfile?.canApprove && (
                              <button
                                type="button"
                                onClick={() => setConfirmApproveTx(tx)}
                                className="inline-flex items-center gap-1 rounded bg-emerald-700 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-emerald-800"
                              >
                                <CheckCircle2 className="h-3 w-3" />
                                อนุมัติ
                              </button>
                            )}
                            {(tx.transactionStatus === 'Draft' || userProfile?.canApprove) && (
                              <button
                                type="button"
                                onClick={() => openEditModal(tx)}
                                className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
                                title={
                                  tx.transactionStatus === 'Approved'
                                    ? 'ขอแก้ไขรายการที่อนุมัติแล้ว (บันทึก Audit Log)'
                                    : 'แก้ไขรายการ Draft'
                                }
                              >
                                {tx.transactionStatus === 'Approved' ? (
                                  <Lock className="h-3 w-3 text-amber-600" />
                                ) : (
                                  <Edit3 className="h-3 w-3" />
                                )}
                                แก้ไข
                              </button>
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
        </>
      ) : (
        /* Audit Log Table */
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          {auditLogs.length === 0 ? (
            <div className="p-10 text-center text-xs text-slate-500">
              ยังไม่มีประวัติการแก้ไขข้อมูลในชีต Audit_Log
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-4 py-3 font-semibold">วันเวลา</th>
                    <th className="px-4 py-3 font-semibold">ผู้ดำเนินการ</th>
                    <th className="px-4 py-3 font-semibold">เลขที่สัญญา</th>
                    <th className="px-4 py-3 font-semibold">รายการที่แก้ไข</th>
                    <th className="px-4 py-3 font-semibold">ค่าเดิม</th>
                    <th className="px-4 py-3 font-semibold">ค่าใหม่</th>
                    <th className="px-4 py-3 font-semibold">เหตุผล</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {auditLogs.map((log, i) => (
                    <tr key={i} className="hover:bg-slate-50">
                      <td className="px-4 py-2.5 font-mono text-slate-600 whitespace-nowrap tabular-nums">
                        {log.timestamp}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-slate-800">{log.actor}</td>
                      <td className="px-4 py-2.5 font-mono font-semibold text-[#0F2942] whitespace-nowrap">
                        {log.targetContractId}
                      </td>
                      <td className="px-4 py-2.5 font-medium text-slate-900">{log.fieldChanged}</td>
                      <td className="px-4 py-2.5 font-mono text-slate-500">{log.oldValue}</td>
                      <td className="px-4 py-2.5 font-mono font-semibold text-slate-900">
                        {log.newValue}
                      </td>
                      <td className="px-4 py-2.5 text-slate-700">{log.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Detail Modal */}
      {selectedTx && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
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
                        : 'font-semibold text-amber-700'
                    }
                  >
                    {selectedTx.transactionStatus}
                  </span>
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPdfTx(selectedTx)}
                  className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-[#0F2942] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#1E3A5F]"
                >
                  <FileText className="h-3.5 w-3.5" />
                  ดาวน์โหลด PDF
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedTx(null)}
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="flex-1 space-y-5 overflow-y-auto p-6">
              <div className="grid grid-cols-2 gap-4 text-xs sm:grid-cols-4">
                <div>
                  <span className="text-slate-500">Machine Serial</span>
                  <p className="font-mono font-semibold text-slate-900">
                    {selectedTx.machineSerialNumber}
                  </p>
                </div>
                <div>
                  <span className="text-slate-500">Original Contract</span>
                  <p className="font-mono font-semibold text-slate-900">
                    {selectedTx.originalContractNumber}
                  </p>
                </div>
                <div>
                  <span className="text-slate-500">ยอด AR</span>
                  <p className="font-mono font-bold text-[#0F2942] tabular-nums">
                    {formatTHB(selectedTx.ar)} THB
                  </p>
                </div>
                <div>
                  <span className="text-slate-500">ค่างวดต่อเดือน</span>
                  <p className="font-mono font-bold text-emerald-700 tabular-nums">
                    {formatTHB(selectedTx.monthlyInstallment)} THB
                  </p>
                </div>
                <div>
                  <span className="text-slate-500">เงินดาวน์</span>
                  <p className="font-mono font-semibold text-slate-900 tabular-nums">
                    {formatTHB(selectedTx.downPaymentAmount)} THB (
                    {formatPercent(selectedTx.downPaymentPercentage, 2)})
                  </p>
                </div>
                <div>
                  <span className="text-slate-500">ยอดจัดไฟแนนซ์</span>
                  <p className="font-mono font-semibold text-slate-900 tabular-nums">
                    {formatTHB(selectedTx.financedPrincipal)} THB
                  </p>
                </div>
                <div>
                  <span className="text-slate-500">ดอกเบี้ยรวม / วิธีคิด</span>
                  <p className="font-mono font-semibold text-slate-900 tabular-nums">
                    {formatTHB(selectedTx.totalInterest)} THB ({selectedTx.interestMethod})
                  </p>
                </div>
                <div>
                  <span className="text-slate-500">ผู้จัดทำ / ผู้อนุมัติ</span>
                  <p className="font-mono text-slate-700">
                    {selectedTx.createdBy} / {selectedTx.approvedBy || '-'}
                  </p>
                </div>
              </div>

              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 text-slate-700">
                    <tr className="border-b border-slate-200">
                      <th className="px-3 py-2 text-center font-semibold">งวด</th>
                      <th className="px-3 py-2 text-right font-semibold">เงินต้นก่อนชำระ</th>
                      <th className="px-3 py-2 text-right font-semibold">เงินต้นชำระ</th>
                      <th className="px-3 py-2 text-right font-semibold">ดอกเบี้ย</th>
                      <th className="px-3 py-2 text-right font-semibold">ยอดชำระ</th>
                      <th className="px-3 py-2 text-right font-semibold">คงเหลือ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-mono tabular-nums">
                    {getScheduleForTx(selectedTx).map((r) => (
                      <tr key={r.installmentNo}>
                        <td className="px-3 py-1.5 text-center">{r.installmentNo}</td>
                        <td className="px-3 py-1.5 text-right">{formatTHB(r.beginningPrincipal)}</td>
                        <td className="px-3 py-1.5 text-right">{formatTHB(r.principalPaid)}</td>
                        <td className="px-3 py-1.5 text-right">{formatTHB(r.interestPaid)}</td>
                        <td className="px-3 py-1.5 text-right font-semibold text-[#0F2942]">
                          {formatTHB(r.monthlyPayment)}
                        </td>
                        <td className="px-3 py-1.5 text-right">{formatTHB(r.endingPrincipal)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit / Post-Approval Amendment Modal */}
      {editingTx && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
              <h3 className="text-base font-semibold text-slate-900">
                {editingTx.transactionStatus === 'Approved'
                  ? `แก้ไขรายการที่อนุมัติแล้ว (${editingTx.rhpContractId})`
                  : `แก้ไขรายการร่าง (${editingTx.rhpContractId})`}
              </h3>
              <button
                type="button"
                onClick={() => setEditingTx(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-4 px-6 py-5 text-xs">
              {editingTx.transactionStatus === 'Approved' && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900">
                  สัญญานี้ได้รับการอนุมัติแล้ว การแก้ไขจะถูกบันทึกประวัติ (ค่าเดิม → ค่าใหม่ และเหตุผล) ลงในชีต
                  Audit_Log เพื่อตรวจสอบย้อนหลัง
                </div>
              )}
              <div>
                <label className="block font-semibold text-slate-700">ชื่อผู้เช่าซื้อ</label>
                <input
                  type="text"
                  value={editCustomerName}
                  onChange={(e) => setEditCustomerName(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700">อัตราดอกเบี้ย (% ต่อปี)</label>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={editRate}
                  onChange={(e) => setEditRate(Math.max(0, Number(e.target.value) || 0))}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm text-slate-900 tabular-nums"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700">
                  เหตุผลในการแก้ไข{' '}
                  {editingTx.transactionStatus === 'Approved' && (
                    <span className="text-red-600">*</span>
                  )}
                </label>
                <input
                  type="text"
                  value={editReason}
                  onChange={(e) => setEditReason(e.target.value)}
                  placeholder="ระบุเหตุผลการแก้ไขเพื่อบันทึกใน Audit_Log..."
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 px-6 py-4">
              <button
                type="button"
                onClick={() => setEditingTx(null)}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                disabled={
                  actionBusy ||
                  (editingTx.transactionStatus === 'Approved' && !editReason.trim())
                }
                onClick={() => setConfirmAmendOpen(true)}
                className="rounded-lg bg-[#0F2942] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1E3A5F] disabled:opacity-50"
              >
                บันทึกการแก้ไข
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmationModal
        open={Boolean(confirmApproveTx)}
        title={`ยืนยันการอนุมัติสัญญา ${confirmApproveTx?.rhpContractId || ''}`}
        description="เมื่ออนุมัติแล้ว สถานะใน Transaction_Records จะเปลี่ยนเป็น Approved และไม่สามารถแก้ไขได้โดยตรง"
        details={[
          `ลูกค้า: ${confirmApproveTx?.customerName || ''}`,
          `ยอด AR: ${formatTHB(confirmApproveTx?.ar || 0)} THB`,
          `ค่างวด/เดือน: ${formatTHB(confirmApproveTx?.monthlyInstallment || 0)} THB`,
        ]}
        busy={actionBusy}
        onCancel={() => setConfirmApproveTx(null)}
        onConfirm={() => {
          const target = confirmApproveTx;
          setConfirmApproveTx(null);
          if (target) void handleApproveTransaction(target);
        }}
      />

      <ConfirmationModal
        open={confirmAmendOpen}
        title={`ยืนยันการแก้ไขสัญญา ${editingTx?.rhpContractId || ''}`}
        description="ระบบจะอัปเดตข้อมูลและตารางผ่อนชำระใน Google Sheets พร้อมบันทึกประวัติการเปลี่ยนแปลงทั้งหมดลงในชีต Audit_Log"
        details={[
          `เหตุผล: ${editReason || 'แก้ไขรายการ Draft'}`,
          `อัตราดอกเบี้ยใหม่: ${formatPercent(editRate, 2)}`,
        ]}
        tone="warning"
        busy={actionBusy}
        onCancel={() => setConfirmAmendOpen(false)}
        onConfirm={() => {
          setConfirmAmendOpen(false);
          void handleCommitAmendment();
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
