import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Calculator,
  CheckCircle2,
  Database,
  FileText,
  Lock,
  PlusCircle,
  RefreshCw,
  Save,
  Unlock,
} from 'lucide-react';
import { ApiClientError, apiClient, type UserAuthProfile } from '../services/apiClient.ts';
import {
  DEFAULT_INTEREST_RATES,
  DOWN_PAYMENT_PRESETS,
  INSTALLMENT_PERIODS,
  type AmortizationRow,
  type ConnectionStatus,
  type CustomerInfo,
  type DownPaymentMode,
  type FinancialInput,
  type InstallmentPeriod,
  type InterestMethod,
  type RhpTransaction,
  type SystemConfig,
} from '../types/rhp.ts';
import {
  calculateRhpFinancials,
  findDuplicateHistory,
  formatBangkokTimestamp,
  formatPercent,
  formatTHB,
} from '../utils/rhpCalculator.ts';
import { isDuplicateContractId } from '../utils/contractIdGenerator.ts';
import { ConfirmationModal } from './ConfirmationModal.tsx';
import { PdfPreviewModal } from './PdfPreviewModal.tsx';

interface RhpCalculatorViewProps {
  isPortalAuthenticated: boolean;
  hasSheetsAccess: boolean;
  reconnectLoading?: boolean;
  userProfile: UserAuthProfile | null;
  connection: ConnectionStatus;
  config: SystemConfig;
  transactions: RhpTransaction[];
  onRequireSetup: () => void;
  onReconnectSheets: () => Promise<void>;
  onTransactionSaved: () => Promise<void>;
}

export function RhpCalculatorView({
  isPortalAuthenticated,
  hasSheetsAccess,
  reconnectLoading = false,
  userProfile,
  connection,
  config,
  transactions,
  onRequireSetup,
  onReconnectSheets,
  onTransactionSaved,
}: RhpCalculatorViewProps) {
  const [rhpContractId, setRhpContractId] = useState<string>('');
  const [contractCreatedAt, setContractCreatedAt] = useState<string>('');
  const [reservingId, setReservingId] = useState(false);

  const [customer, setCustomer] = useState<CustomerInfo>({
    customerId: '',
    customerName: '',
    machineSerialNumber: '',
    originalContractNumber: '',
  });
  const [duplicateReason, setDuplicateReason] = useState('');

  const [financialInput, setFinancialInput] = useState<FinancialInput>({
    machineCost: 500000,
    processingFee: 20000,
    arOverride: null,
    arOverrideReason: '',
    interestRate: 4.5,
    interestMethod: config.defaultInterestMethod || 'Flat Rate',
    installmentPeriod: 36,
    downPaymentMode: 'percentage',
    downPaymentPercentage: 10,
    downPaymentAmount: 52000,
  });

  const [arEditUnlocked, setArEditUnlocked] = useState(false);
  const [customDownPct, setCustomDownPct] = useState(false);

  const [savedRecord, setSavedRecord] = useState<{
    transaction: RhpTransaction;
    schedule: AmortizationRow[];
    signatureKey: string;
  } | null>(null);

  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
    requiresReconnect?: boolean;
  } | null>(null);
  const [pdfModalOpen, setPdfModalOpen] = useState(false);

  const [confirmSave, setConfirmSave] = useState<{
    status: 'Draft' | 'Approved';
  } | null>(null);

  const [duplicateContractAlert, setDuplicateContractAlert] = useState<{
    oldId: string;
    newId: string;
    message: string;
  } | null>(null);

  // Sync default interest method if config updates before user edits
  useEffect(() => {
    setFinancialInput((prev) => ({
      ...prev,
      interestMethod: config.defaultInterestMethod || prev.interestMethod,
    }));
  }, [config.defaultInterestMethod]);

  const reserveNewContract = async () => {
    setReservingId(true);
    setFeedback(null);
    try {
      const res = await apiClient.reserveContractId();
      setRhpContractId(res.contractId);
      setContractCreatedAt(res.timestamp);
      setSavedRecord(null);
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'ไม่สามารถออกเลขที่สัญญาใหม่ได้',
      });
    } finally {
      setReservingId(false);
    }
  };

  useEffect(() => {
    if (!rhpContractId) {
      void reserveNewContract();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const calc = useMemo(() => calculateRhpFinancials(financialInput), [financialInput]);

  const duplicateMatches = useMemo(
    () =>
      findDuplicateHistory(
        customer.machineSerialNumber,
        customer.originalContractNumber,
        transactions,
        rhpContractId
      ),
    [customer.machineSerialNumber, customer.originalContractNumber, transactions, rhpContractId]
  );

  const currentSignatureKey = useMemo(
    () =>
      JSON.stringify({
        rhpContractId,
        customer,
        financialInput,
      }),
    [rhpContractId, customer, financialInput]
  );

  const isSavedAndSynced =
    savedRecord !== null && savedRecord.signatureKey === currentSignatureKey;

  const customerComplete =
    customer.customerId.trim().length > 0 &&
    customer.customerName.trim().length > 0 &&
    customer.machineSerialNumber.trim().length > 0 &&
    customer.originalContractNumber.trim().length > 0;

  const canCreateContract = Boolean(
    userProfile?.canCreateContract ||
      userProfile?.role === 'Super Admin' ||
      userProfile?.role === 'Risk Control'
  );

  const canSave =
    isPortalAuthenticated &&
    hasSheetsAccess &&
    connection.connected &&
    canCreateContract &&
    Boolean(rhpContractId) &&
    customerComplete &&
    calc.validationErrors.length === 0 &&
    (!calc.summary.isArOverridden || financialInput.arOverrideReason.trim().length > 0) &&
    (duplicateMatches.length === 0 || duplicateReason.trim().length > 0);

  const handleResetNewForm = async () => {
    setCustomer({
      customerId: '',
      customerName: '',
      machineSerialNumber: '',
      originalContractNumber: '',
    });
    setDuplicateReason('');
    setArEditUnlocked(false);
    setCustomDownPct(false);
    setFinancialInput({
      machineCost: 500000,
      processingFee: 20000,
      arOverride: null,
      arOverrideReason: '',
      interestRate: 4.5,
      interestMethod: config.defaultInterestMethod || 'Flat Rate',
      installmentPeriod: 36,
      downPaymentMode: 'percentage',
      downPaymentPercentage: 10,
      downPaymentAmount: 52000,
    });
    await reserveNewContract();
  };

  const handleDuplicateContractCollision = async (
    duplicateId: string,
    suggestedNewId?: string,
    suggestedTimestamp?: string,
    customMessage?: string
  ) => {
    let nextId = suggestedNewId || '';
    let nextTimestamp = suggestedTimestamp || '';

    if (!nextId) {
      const res = await apiClient.reserveContractId();
      nextId = res.contractId;
      nextTimestamp = res.timestamp;
    }

    setRhpContractId(nextId);
    if (nextTimestamp) {
      setContractCreatedAt(nextTimestamp);
    }
    setSavedRecord(null);
    setDuplicateContractAlert({
      oldId: duplicateId,
      newId: nextId,
      message:
        customMessage ||
        'เลขที่สัญญานี้ถูกใช้งานแล้ว (This Contract ID has already been used.)',
    });
  };

  const handleRequestSave = async (targetStatus: 'Draft' | 'Approved') => {
    if (!canSave || saving) return;

    if (isDuplicateContractId(rhpContractId, transactions)) {
      setReservingId(true);
      try {
        await handleDuplicateContractCollision(rhpContractId);
      } catch (err) {
        setFeedback({
          type: 'error',
          text: err instanceof Error ? err.message : 'ไม่สามารถสร้างเลขที่สัญญาใหม่ได้',
        });
      } finally {
        setReservingId(false);
      }
      return;
    }

    setConfirmSave({ status: targetStatus });
  };

  const executeSaveTransaction = async (targetStatus: 'Draft' | 'Approved') => {
    if (isDuplicateContractId(rhpContractId, transactions)) {
      setReservingId(true);
      try {
        await handleDuplicateContractCollision(rhpContractId);
      } catch (err) {
        setFeedback({
          type: 'error',
          text: err instanceof Error ? err.message : 'ไม่สามารถสร้างเลขที่สัญญาใหม่ได้',
        });
      } finally {
        setReservingId(false);
      }
      return;
    }

    setSaving(true);
    setFeedback(null);
    try {
      const res = await apiClient.createTransaction({
        rhpContractId,
        customerId: customer.customerId.trim(),
        customerName: customer.customerName.trim(),
        machineSerialNumber: customer.machineSerialNumber.trim(),
        originalContractNumber: customer.originalContractNumber.trim(),
        financialInput,
        transactionStatus: targetStatus,
        duplicateReason: duplicateReason.trim() || undefined,
      });

      setSavedRecord({
        transaction: res.transaction,
        schedule: res.schedule,
        signatureKey: currentSignatureKey,
      });

      await onTransactionSaved();
      setFeedback({
        type: 'success',
        text: `บันทึกสัญญา ${res.transaction.rhpContractId} (สถานะ: ${res.transaction.transactionStatus}) ลง Google Sheets เรียบร้อยแล้ว`,
      });
    } catch (err) {
      if (err instanceof ApiClientError && err.errorCode === 'DUPLICATE_CONTRACT_ID') {
        try {
          await handleDuplicateContractCollision(
            err.details?.duplicateContractId || rhpContractId,
            err.details?.newContractId,
            err.details?.newTimestamp,
            err.message
          );
          await onTransactionSaved();
        } catch (reserveErr) {
          setFeedback({
            type: 'error',
            text:
              reserveErr instanceof Error
                ? reserveErr.message
                : 'เลขที่สัญญานี้ถูกใช้งานแล้ว และไม่สามารถสร้างเลขใหม่ได้',
          });
        }
        return;
      }

      const requiresReconnect =
        err instanceof ApiClientError && Boolean(err.requiresSheetsReconnect);
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'ไม่สามารถบันทึกข้อมูลลง Google Sheets ได้',
        requiresReconnect,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDownPaymentModeSwitch = (mode: DownPaymentMode) => {
    if (mode === 'percentage') {
      setFinancialInput((prev) => ({
        ...prev,
        downPaymentMode: 'percentage',
        downPaymentPercentage: calc.summary.downPaymentPercentage,
      }));
    } else {
      setCustomDownPct(false);
      setFinancialInput((prev) => ({
        ...prev,
        downPaymentMode: 'amount',
        downPaymentAmount: calc.summary.downPaymentAmount,
      }));
    }
  };

  const periodsList =
    config.availableInstallmentPeriods.length > 0
      ? config.availableInstallmentPeriods
      : INSTALLMENT_PERIODS;

  const downPresets =
    config.downPaymentOptions.length > 0 ? config.downPaymentOptions : DOWN_PAYMENT_PRESETS;

  return (
    <div className="space-y-6">
      {/* Database prerequisite notice if not connected or Sheets OAuth needs reconnect */}
      {(!isPortalAuthenticated || !hasSheetsAccess || !connection.connected) && (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-amber-200 bg-amber-50 px-5 py-4">
          <div className="flex items-start gap-3">
            <Database className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
            <div>
              <p className="text-sm font-semibold text-amber-900">
                {!isPortalAuthenticated
                  ? 'ยังไม่ได้เข้าสู่ระบบ MAX SANY RHP PORTAL'
                  : !hasSheetsAccess
                    ? 'สิทธิ์การเชื่อมต่อ Google Sheets หมดอายุชั่วคราว (ข้อมูลที่กรอกยังคงอยู่)'
                    : 'ยังไม่ได้เชื่อมต่อฐานข้อมูล Google Sheets (RHP_Restructuring_Database)'}
              </p>
              <p className="mt-0.5 text-xs text-amber-800">
                {!isPortalAuthenticated
                  ? 'คุณสามารถทดลองคำนวณตัวเลขได้ทันที แต่จำเป็นต้องเข้าสู่ระบบและเชื่อมต่อ Google Sheets ก่อนบันทึกรายการและออกเอกสาร PDF อย่างเป็นทางการ'
                  : !hasSheetsAccess
                    ? 'กรุณากด Reconnect Google เพื่อต่ออายุสิทธิ์บันทึกข้อมูลลง Google Sheets โดยไม่ต้องออกจากระบบ'
                    : 'คุณสามารถทดลองคำนวณตัวเลขได้ทันที แต่จำเป็นต้องเชื่อมต่อสเปรดชีต RHP_Restructuring_Database ก่อนบันทึกและออก PDF'}
              </p>
            </div>
          </div>
          {isPortalAuthenticated && !hasSheetsAccess ? (
            <button
              type="button"
              onClick={() => void onReconnectSheets()}
              disabled={reconnectLoading}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-amber-700 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-800 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${reconnectLoading ? 'animate-spin' : ''}`} />
              {reconnectLoading ? 'กำลังเชื่อมต่อใหม่...' : 'Reconnect Google'}
            </button>
          ) : (
            <button
              type="button"
              onClick={onRequireSetup}
              className="whitespace-nowrap rounded-lg bg-amber-700 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-800"
            >
              ตั้งค่าการเชื่อมต่อ Google Sheets
            </button>
          )}
        </div>
      )}

      {feedback && (
        <div
          className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-5 py-3.5 text-sm font-medium ${
            feedback.type === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-red-200 bg-red-50 text-red-800'
          }`}
        >
          <div className="flex items-center gap-2.5">
            {feedback.type === 'success' ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
            ) : (
              <AlertTriangle className="h-4 w-4 shrink-0 text-red-600" />
            )}
            <span>{feedback.text}</span>
          </div>
          {feedback.requiresReconnect && (
            <button
              type="button"
              onClick={() => void onReconnectSheets()}
              disabled={reconnectLoading}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-amber-700 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-amber-800 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${reconnectLoading ? 'animate-spin' : ''}`} />
              Reconnect Google
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        {/* Left Column: Contract ID + Customer Info + Financial Inputs */}
        <div className="space-y-6 xl:col-span-7">
          {/* Section 1 & 2: RHP Contract ID Generator */}
          <section className="rounded-xl border border-slate-200 bg-white p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  1. เลขที่สัญญาปรับโครงสร้างใหม่ (RHP Contract ID)
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  ระบบสร้างรหัสอัตโนมัติรูปแบบ RHP YYYY-XXX (เริ่ม 001 ใหม่ทุกปีตามเวลา Asia/Bangkok) ป้องกันเลขซ้ำเมื่อใช้งานพร้อมกัน
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleResetNewForm()}
                disabled={reservingId}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50"
              >
                <PlusCircle className="h-3.5 w-3.5" />
                {reservingId ? 'กำลังออกเลขที่สัญญา...' : 'สร้างรายการใหม่ (New RHP)'}
              </button>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 border-t border-slate-100 pt-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-slate-600">
                  เลขที่สัญญา RHP ใหม่ (แก้ไขไม่ได้)
                </label>
                <input
                  type="text"
                  readOnly
                  value={rhpContractId || 'กำลังสร้าง...'}
                  className="mt-1.5 w-full cursor-not-allowed rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 font-mono text-sm font-bold text-[#0F2942] tabular-nums"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600">
                  วันและเวลาที่สร้างรายการ (Asia/Bangkok)
                </label>
                <input
                  type="text"
                  readOnly
                  value={contractCreatedAt || formatBangkokTimestamp()}
                  className="mt-1.5 w-full cursor-not-allowed rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 font-mono text-sm text-slate-700 tabular-nums"
                />
              </div>
            </div>
          </section>

          {/* Section 2: Customer Information */}
          <section className="rounded-xl border border-slate-200 bg-white p-6">
            <h2 className="text-base font-semibold text-slate-900">
              2. ข้อมูลพื้นฐานลูกค้า (Customer Information)
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              จำเป็นต้องกรอกให้ครบทั้ง 4 รายการก่อนบันทึกรายการ ระบบตรวจสอบเลขเครื่องจักรและสัญญาเดิมซ้ำอัตโนมัติ
            </p>

            <div className="mt-4 grid grid-cols-1 gap-4 border-t border-slate-100 pt-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  รหัสลูกค้า (Customer ID) <span className="text-red-600">*</span>
                </label>
                <input
                  type="text"
                  value={customer.customerId}
                  onChange={(e) => setCustomer((c) => ({ ...c, customerId: e.target.value }))}
                  placeholder="เช่น CUST-2026-0142"
                  className="mt-1.5 w-full rounded-lg border border-slate-300 px-3.5 py-2 font-mono text-sm text-slate-900 focus:border-[#0F2942] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  ชื่อผู้เช่าซื้อ (Customer Name) <span className="text-red-600">*</span>
                </label>
                <input
                  type="text"
                  value={customer.customerName}
                  onChange={(e) => setCustomer((c) => ({ ...c, customerName: e.target.value }))}
                  placeholder="ชื่อบริษัท หรือ ชื่อ-นามสกุลผู้เช่าซื้อ"
                  className="mt-1.5 w-full rounded-lg border border-slate-300 px-3.5 py-2 text-sm text-slate-900 focus:border-[#0F2942] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  หมายเลขประจำเครื่องจักร (Machine Serial Number){' '}
                  <span className="text-red-600">*</span>
                </label>
                <input
                  type="text"
                  value={customer.machineSerialNumber}
                  onChange={(e) =>
                    setCustomer((c) => ({ ...c, machineSerialNumber: e.target.value }))
                  }
                  placeholder="เช่น SN-EX200-884920"
                  className="mt-1.5 w-full rounded-lg border border-slate-300 px-3.5 py-2 font-mono text-sm text-slate-900 focus:border-[#0F2942] focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  เลขที่สัญญาเช่าซื้อเดิม (Original Contract Number){' '}
                  <span className="text-red-600">*</span>
                </label>
                <input
                  type="text"
                  value={customer.originalContractNumber}
                  onChange={(e) =>
                    setCustomer((c) => ({ ...c, originalContractNumber: e.target.value }))
                  }
                  placeholder="เช่น HP-2024-00912"
                  className="mt-1.5 w-full rounded-lg border border-slate-300 px-3.5 py-2 font-mono text-sm text-slate-900 focus:border-[#0F2942] focus:outline-none"
                />
              </div>
            </div>

            {duplicateMatches.length > 0 && (
              <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4">
                <div className="flex items-start gap-2.5">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                  <div className="flex-1 space-y-2">
                    <p className="text-xs font-semibold text-amber-900">
                      พบประวัติการปรับโครงสร้างซ้ำ ({duplicateMatches.length} รายการ)
                    </p>
                    <ul className="space-y-1 text-xs text-amber-800">
                      {duplicateMatches.map((m) => (
                        <li key={m.rhpContractId} className="font-mono">
                          {m.rhpContractId} · {m.customerName} · วันที่ {m.transactionDate} · สถานะ{' '}
                          {m.transactionStatus}
                        </li>
                      ))}
                    </ul>
                    <div>
                      <label className="block text-xs font-semibold text-amber-900">
                        เหตุผลที่เหมาะสมในการปรับโครงสร้างซ้ำ (บังคับกรอกเพื่อบันทึก){' '}
                        <span className="text-red-600">*</span>
                      </label>
                      <input
                        type="text"
                        value={duplicateReason}
                        onChange={(e) => setDuplicateReason(e.target.value)}
                        placeholder="ระบุเหตุผลประกอบการพิจารณาของฝ่าย Risk Control..."
                        className="mt-1 w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-amber-600 focus:outline-none"
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* Section 3: Financial Calculator */}
          <section className="rounded-xl border border-slate-200 bg-white p-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  3. เงื่อนไขและข้อมูลทางการเงิน (Financial Calculator)
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  คำนวณยอด AR เงินดาวน์ ดอกเบี้ย และค่างวดต่อเดือนแบบ Real-time
                </p>
              </div>
              <Calculator className="h-5 w-5 text-[#0F2942]" />
            </div>

            <div className="mt-4 space-y-5 border-t border-slate-100 pt-4">
              {/* 4.1 Cost & Processing Fee & AR */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    ราคาต้นทุนเครื่องจักร (Machine Cost, THB)
                  </label>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={financialInput.machineCost}
                    onChange={(e) =>
                      setFinancialInput((f) => ({
                        ...f,
                        machineCost: Math.max(0, Number(e.target.value) || 0),
                      }))
                    }
                    className="mt-1.5 w-full rounded-lg border border-slate-300 px-3.5 py-2 font-mono text-sm text-slate-900 tabular-nums focus:border-[#0F2942] focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    ค่าดำเนินการเพิ่มเติม (Processing Fee, THB)
                  </label>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={financialInput.processingFee}
                    onChange={(e) =>
                      setFinancialInput((f) => ({
                        ...f,
                        processingFee: Math.max(0, Number(e.target.value) || 0),
                      }))
                    }
                    className="mt-1.5 w-full rounded-lg border border-slate-300 px-3.5 py-2 font-mono text-sm text-slate-900 tabular-nums focus:border-[#0F2942] focus:outline-none"
                  />
                </div>
              </div>

              {/* Computed AR + Authorized Override */}
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-medium text-slate-600">
                      ยอดลูกหนี้เช่าซื้อรวม (AR = Machine Cost + Processing Fee)
                    </p>
                    <p className="mt-1 font-mono text-2xl font-bold text-[#0F2942] tabular-nums">
                      {formatTHB(calc.summary.ar)}{' '}
                      <span className="text-sm font-semibold text-slate-500">THB</span>
                    </p>
                    {calc.summary.isArOverridden && (
                      <p className="mt-1 font-mono text-xs text-amber-700">
                        ปรับแก้จากยอดคำนวณเดิม {formatTHB(calc.summary.computedAr)} THB
                      </p>
                    )}
                  </div>

                  {userProfile?.canOverrideAr ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (arEditUnlocked) {
                          setArEditUnlocked(false);
                          setFinancialInput((f) => ({
                            ...f,
                            arOverride: null,
                            arOverrideReason: '',
                          }));
                        } else {
                          setArEditUnlocked(true);
                          setFinancialInput((f) => ({
                            ...f,
                            arOverride: calc.summary.computedAr,
                          }));
                        }
                      }}
                      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
                    >
                      {arEditUnlocked ? (
                        <>
                          <Lock className="h-3.5 w-3.5" />
                          ใช้ยอด AR คำนวณอัตโนมัติ
                        </>
                      ) : (
                        <>
                          <Unlock className="h-3.5 w-3.5" />
                          ปรับแก้ยอด AR (Authorized)
                        </>
                      )}
                    </button>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                      <Lock className="h-3.5 w-3.5" />
                      การปรับแก้ AR จำกัดเฉพาะ Approver / Super Admin
                    </span>
                  )}
                </div>

                {arEditUnlocked && userProfile?.canOverrideAr && (
                  <div className="mt-4 grid grid-cols-1 gap-3 border-t border-slate-200 pt-3 sm:grid-cols-2">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700">
                        ยอด AR ใหม่ (THB)
                      </label>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={financialInput.arOverride ?? calc.summary.computedAr}
                        onChange={(e) =>
                          setFinancialInput((f) => ({
                            ...f,
                            arOverride: Math.max(0, Number(e.target.value) || 0),
                          }))
                        }
                        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 tabular-nums"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-700">
                        เหตุผลในการแก้ไขยอด AR <span className="text-red-600">*</span>
                      </label>
                      <input
                        type="text"
                        value={financialInput.arOverrideReason}
                        onChange={(e) =>
                          setFinancialInput((f) => ({ ...f, arOverrideReason: e.target.value }))
                        }
                        placeholder="บันทึกประวัติลง Audit_Log..."
                        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* 4.2 Interest Rate & 4.5 Interest Method */}
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    อัตราดอกเบี้ยต่อปี (% ต่อปี)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step="0.01"
                    value={financialInput.interestRate}
                    onChange={(e) =>
                      setFinancialInput((f) => ({
                        ...f,
                        interestRate: Math.max(0, Number(e.target.value) || 0),
                      }))
                    }
                    className="mt-1.5 w-full rounded-lg border border-slate-300 px-3.5 py-2 font-mono text-sm text-slate-900 tabular-nums focus:border-[#0F2942] focus:outline-none"
                  />
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {[0, ...DEFAULT_INTEREST_RATES].map((rate) => (
                      <button
                        key={rate}
                        type="button"
                        onClick={() => setFinancialInput((f) => ({ ...f, interestRate: rate }))}
                        className={`whitespace-nowrap rounded-md border px-2.5 py-1 font-mono text-xs font-medium transition-colors ${
                          financialInput.interestRate === rate
                            ? 'border-[#0F2942] bg-[#0F2942] text-white'
                            : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                        }`}
                      >
                        {rate.toFixed(2)}%
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    วิธีคำนวณดอกเบี้ย (Interest Method)
                  </label>
                  <div className="mt-1.5 flex items-center gap-1 rounded-lg bg-slate-100 p-1">
                    {(['Flat Rate', 'Reducing Balance'] as InterestMethod[]).map((method) => (
                      <button
                        key={method}
                        type="button"
                        onClick={() =>
                          setFinancialInput((f) => ({ ...f, interestMethod: method }))
                        }
                        className={`flex-1 whitespace-nowrap rounded-md px-3 py-2 text-xs font-semibold transition-colors ${
                          financialInput.interestMethod === method
                            ? 'bg-white text-[#0F2942] shadow-sm'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {method}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 font-mono text-xs text-slate-500 tabular-nums">
                    อัตราดอกเบี้ยต่อปี: {formatPercent(financialInput.interestRate, 2)} · ต่อเดือน:{' '}
                    {formatPercent(calc.summary.monthlyInterestRate * 100, 4)}
                  </p>
                </div>
              </div>

              {/* 4.3 Installment Period */}
              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  ระยะเวลาการผ่อนชำระ (Installment Period)
                </label>
                <div className="mt-1.5 grid grid-cols-5 gap-2">
                  {periodsList.map((months) => (
                    <button
                      key={months}
                      type="button"
                      onClick={() =>
                        setFinancialInput((f) => ({
                          ...f,
                          installmentPeriod: months as InstallmentPeriod,
                        }))
                      }
                      className={`whitespace-nowrap rounded-lg border py-2.5 text-center font-mono text-xs font-semibold transition-colors tabular-nums ${
                        financialInput.installmentPeriod === months
                          ? 'border-[#0F2942] bg-[#0F2942] text-white'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      {months} เดือน
                    </button>
                  ))}
                </div>
              </div>

              {/* 4.4 Down Payment */}
              <div className="space-y-3 border-t border-slate-100 pt-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="text-xs font-semibold text-slate-700">
                    เงินดาวน์ (Down Payment)
                  </label>
                  <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
                    <button
                      type="button"
                      onClick={() => handleDownPaymentModeSwitch('percentage')}
                      className={`whitespace-nowrap rounded-md px-3 py-1 text-xs font-semibold ${
                        financialInput.downPaymentMode === 'percentage'
                          ? 'bg-white text-[#0F2942] shadow-sm'
                          : 'text-slate-600'
                      }`}
                    >
                      กำหนดเป็น %
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDownPaymentModeSwitch('amount')}
                      className={`whitespace-nowrap rounded-md px-3 py-1 text-xs font-semibold ${
                        financialInput.downPaymentMode === 'amount'
                          ? 'bg-white text-[#0F2942] shadow-sm'
                          : 'text-slate-600'
                      }`}
                    >
                      กำหนดเป็นบาท (THB)
                    </button>
                  </div>
                </div>

                {financialInput.downPaymentMode === 'percentage' ? (
                  <div className="space-y-2.5">
                    <div className="flex flex-wrap gap-2">
                      {downPresets.map((pct) => (
                        <button
                          key={pct}
                          type="button"
                          onClick={() => {
                            setCustomDownPct(false);
                            setFinancialInput((f) => ({
                              ...f,
                              downPaymentPercentage: pct,
                            }));
                          }}
                          className={`whitespace-nowrap rounded-lg border px-3.5 py-2 font-mono text-xs font-semibold transition-colors ${
                            !customDownPct && financialInput.downPaymentPercentage === pct
                              ? 'border-[#0F2942] bg-[#0F2942] text-white'
                              : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                          }`}
                        >
                          {pct}%
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => setCustomDownPct(true)}
                        className={`whitespace-nowrap rounded-lg border px-3.5 py-2 text-xs font-semibold transition-colors ${
                          customDownPct
                            ? 'border-[#0F2942] bg-[#0F2942] text-white'
                            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        กำหนดเอง
                      </button>
                    </div>
                    {customDownPct && (
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step="0.01"
                        value={financialInput.downPaymentPercentage}
                        onChange={(e) =>
                          setFinancialInput((f) => ({
                            ...f,
                            downPaymentPercentage: Math.min(
                              100,
                              Math.max(0, Number(e.target.value) || 0)
                            ),
                          }))
                        }
                        placeholder="ระบุเปอร์เซ็นต์เงินดาวน์ (0 - 100)"
                        className="w-full rounded-lg border border-slate-300 px-3.5 py-2 font-mono text-sm text-slate-900 tabular-nums focus:border-[#0F2942] focus:outline-none"
                      />
                    )}
                  </div>
                ) : (
                  <div>
                    <input
                      type="number"
                      min={0}
                      max={calc.summary.ar}
                      step="0.01"
                      value={financialInput.downPaymentAmount}
                      onChange={(e) => {
                        const val = Number(e.target.value) || 0;
                        const clamped = Math.min(calc.summary.ar, Math.max(0, val));
                        setFinancialInput((f) => ({
                          ...f,
                          downPaymentAmount: clamped,
                        }));
                      }}
                      placeholder="ระบุจำนวนเงินดาวน์ (THB)"
                      className="w-full rounded-lg border border-slate-300 px-3.5 py-2 font-mono text-sm text-slate-900 tabular-nums focus:border-[#0F2942] focus:outline-none"
                    />
                    <p className="mt-1 font-mono text-xs text-slate-500 tabular-nums">
                      คิดเป็น {formatPercent(calc.summary.downPaymentPercentage, 2)} ของยอด AR (สูงสุดไม่เกิน{' '}
                      {formatTHB(calc.summary.ar)} THB)
                    </p>
                  </div>
                )}

                {calc.validationErrors.length > 0 && (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-700">
                    {calc.validationErrors.join(' · ')}
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>

        {/* Right Column: Live 17-Point Financial Summary & Action Bar */}
        <div className="space-y-6 xl:col-span-5">
          <section className="rounded-xl border border-slate-200 bg-white p-6">
            <div className="flex items-center justify-between border-b border-slate-100 pb-4">
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  4. ตารางสรุปผลการคำนวณ (Financial Summary)
                </h2>
                <p className="mt-0.5 text-xs text-slate-500">
                  วิธีคำนวณ: <span className="font-semibold text-slate-800">{financialInput.interestMethod}</span> · สกุลเงิน THB
                </p>
              </div>
              {isSavedAndSynced && (
                <span
                  className={`text-xs font-semibold ${
                    savedRecord.transaction.transactionStatus === 'Approved'
                      ? 'text-emerald-700'
                      : 'text-amber-700'
                  }`}
                >
                  บันทึกแล้ว ({savedRecord.transaction.transactionStatus})
                </span>
              )}
            </div>

            {/* Highlighted Primary Outcomes */}
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                <p className="text-xs font-semibold text-emerald-800">ค่างวดต่อเดือน (Monthly Installment)</p>
                <p className="mt-1 font-mono text-2xl font-bold text-emerald-900 tabular-nums">
                  {formatTHB(calc.summary.monthlyInstallment)}{' '}
                  <span className="text-xs font-semibold">THB</span>
                </p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs font-semibold text-slate-600">ยอด AR รวม (Accounts Receivable)</p>
                <p className="mt-1 font-mono text-2xl font-bold text-[#0F2942] tabular-nums">
                  {formatTHB(calc.summary.ar)}{' '}
                  <span className="text-xs font-semibold text-slate-500">THB</span>
                </p>
              </div>
            </div>

            {/* All 17 Summary Fields */}
            <dl className="mt-5 divide-y divide-slate-100 text-xs">
              {[
                ['1. เลขที่สัญญา RHP ใหม่', rhpContractId || '-'],
                ['2. รหัสลูกค้า', customer.customerId || '-'],
                ['3. ชื่อลูกค้า', customer.customerName || '-'],
                ['4. Serial Number เครื่องจักร', customer.machineSerialNumber || '-'],
                ['5. เลขที่สัญญาเดิม', customer.originalContractNumber || '-'],
                ['6. ราคาต้นทุนเครื่องจักร', `${formatTHB(financialInput.machineCost)} THB`],
                ['7. ค่าดำเนินการเพิ่มเติม', `${formatTHB(financialInput.processingFee)} THB`],
                ['8. ยอด AR', `${formatTHB(calc.summary.ar)} THB`],
                ['9. อัตราดอกเบี้ยต่อปี', formatPercent(financialInput.interestRate, 2)],
                ['10. วิธีคำนวณดอกเบี้ย', financialInput.interestMethod],
                ['11. เปอร์เซ็นต์เงินดาวน์', formatPercent(calc.summary.downPaymentPercentage, 2)],
                ['12. จำนวนเงินดาวน์', `${formatTHB(calc.summary.downPaymentAmount)} THB`],
                ['13. ยอดเงินต้นที่จัดไฟแนนซ์', `${formatTHB(calc.summary.financedPrincipal)} THB`],
                ['14. ระยะเวลาผ่อนชำระ', `${financialInput.installmentPeriod} เดือน`],
                ['15. ดอกเบี้ยรวม', `${formatTHB(calc.summary.totalInterest)} THB`],
                ['16. ยอดชำระรวม', `${formatTHB(calc.summary.totalRepayment)} THB`],
                ['17. ค่างวดต่อเดือน', `${formatTHB(calc.summary.monthlyInstallment)} THB`],
              ].map(([label, value], idx) => (
                <div key={idx} className="flex items-center justify-between gap-4 py-2">
                  <dt className="text-slate-600">{label}</dt>
                  <dd className="text-right font-mono font-semibold text-slate-900 tabular-nums">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>

            {/* Primary Save & Export Actions */}
            <div className="mt-6 space-y-2.5 border-t border-slate-200 pt-5">
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                <button
                  type="button"
                  disabled={!canSave || saving || reservingId}
                  onClick={() => void handleRequestSave('Draft')}
                  className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-[#0F2942] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#1E3A5F] disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <Save className="h-4 w-4" />
                  บันทึกเป็น Draft ลง Sheets
                </button>

                <button
                  type="button"
                  disabled={!canSave || saving || reservingId || !userProfile?.canApprove}
                  onClick={() => void handleRequestSave('Approved')}
                  title={
                    !userProfile?.canApprove
                      ? 'เฉพาะ Approver หรือ Super Admin เท่านั้นที่สามารถอนุมัติสัญญาได้'
                      : ''
                  }
                  className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-emerald-700 px-4 py-2.5 text-xs font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  บันทึกและอนุมัติ (Approve)
                </button>
              </div>

              <button
                type="button"
                disabled={!isSavedAndSynced}
                onClick={() => setPdfModalOpen(true)}
                className="inline-flex w-full items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold text-slate-900 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <FileText className="h-4 w-4 text-[#0F2942]" />
                Export PDF / Download RHP Calculation Form
              </button>

              {!isSavedAndSynced && (
                <p className="text-center text-[11px] text-slate-500">
                  กรุณาบันทึกข้อมูลลงฐานข้อมูล Google Sheets ก่อนออกเอกสาร PDF เพื่อรับประกันความถูกต้องตรงกันของข้อมูล
                </p>
              )}
            </div>
          </section>
        </div>
      </div>

      {/* Section 5: Amortization Schedule Table */}
      <section className="rounded-xl border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              5. ตารางแสดงรายละเอียดการผ่อนชำระ (Amortization Schedule)
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              คำนวณครบทั้ง {calc.schedule.length} งวด พร้อมปรับเศษสตางค์ในงวดสุดท้ายให้ยอดเงินต้นคงเหลือปิดที่ 0.00 THB
            </p>
          </div>
          <span className="font-mono text-xs font-semibold text-slate-600 tabular-nums">
            {rhpContractId} · {financialInput.interestMethod}
          </span>
        </div>

        <div className="mt-4 max-h-[460px] overflow-auto rounded-lg border border-slate-200">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-slate-100 text-slate-700">
              <tr className="border-b border-slate-200">
                <th className="px-3 py-2.5 text-center font-semibold">งวดที่</th>
                <th className="px-3 py-2.5 text-right font-semibold">เงินต้นคงเหลือก่อนชำระ</th>
                <th className="px-3 py-2.5 text-right font-semibold">เงินต้นที่ชำระ</th>
                <th className="px-3 py-2.5 text-right font-semibold">ดอกเบี้ยประจำงวด</th>
                <th className="px-3 py-2.5 text-right font-semibold">ยอดชำระประจำงวด</th>
                <th className="px-3 py-2.5 text-right font-semibold">เงินต้นคงเหลือหลังชำระ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-mono tabular-nums">
              {calc.schedule.map((row) => (
                <tr key={row.installmentNo} className="hover:bg-slate-50">
                  <td className="px-3 py-2 text-center font-semibold text-slate-800">
                    {row.installmentNo}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-700">
                    {formatTHB(row.beginningPrincipal)}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-900">
                    {formatTHB(row.principalPaid)}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-700">
                    {formatTHB(row.interestPaid)}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-[#0F2942]">
                    {formatTHB(row.monthlyPayment)}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-700">
                    {formatTHB(row.endingPrincipal)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="sticky bottom-0 border-t-2 border-slate-300 bg-slate-50 font-mono font-bold text-slate-900 tabular-nums">
              <tr>
                <td className="px-3 py-2.5 text-center">รวม</td>
                <td className="px-3 py-2.5 text-right">-</td>
                <td className="px-3 py-2.5 text-right">{formatTHB(calc.summary.financedPrincipal)}</td>
                <td className="px-3 py-2.5 text-right">{formatTHB(calc.summary.totalInterest)}</td>
                <td className="px-3 py-2.5 text-right text-[#0F2942]">
                  {formatTHB(calc.summary.totalRepayment)}
                </td>
                <td className="px-3 py-2.5 text-right text-emerald-700">0.00</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      {/* Confirmation Dialog before writing to Google Sheets */}
      <ConfirmationModal
        open={Boolean(confirmSave)}
        title={
          confirmSave?.status === 'Approved'
            ? `ยืนยันบันทึกและอนุมัติสัญญา ${rhpContractId}`
            : `ยืนยันบันทึกร่างสัญญา ${rhpContractId}`
        }
        description={
          confirmSave?.status === 'Approved'
            ? 'ระบบจะบันทึกข้อมูลสัญญาและตารางผ่อนชำระลงใน Google Sheets (Transaction_Records, Amortization_Schedule และ Audit_Log) พร้อมตั้งสถานะเป็น Approved'
            : 'ระบบจะบันทึกข้อมูลสัญญาและตารางผ่อนชำระลงใน Google Sheets (Transaction_Records และ Amortization_Schedule) ในสถานะ Draft'
        }
        details={[
          `RHP Contract ID: ${rhpContractId}`,
          `ลูกค้า: ${customer.customerId} - ${customer.customerName}`,
          `ยอด AR: ${formatTHB(calc.summary.ar)} THB`,
          `ค่างวดต่อเดือน: ${formatTHB(calc.summary.monthlyInstallment)} THB (${financialInput.installmentPeriod} งวด)`,
          `วิธีคิดดอกเบี้ย: ${financialInput.interestMethod} (${formatPercent(financialInput.interestRate, 2)})`,
        ]}
        tone={confirmSave?.status === 'Approved' ? 'primary' : 'primary'}
        busy={saving}
        onCancel={() => setConfirmSave(null)}
        onConfirm={() => {
          const st = confirmSave?.status || 'Draft';
          setConfirmSave(null);
          void executeSaveTransaction(st);
        }}
      />

      {/* Official PDF Preview & Export Modal */}
      <PdfPreviewModal
        open={pdfModalOpen}
        transaction={savedRecord?.transaction || null}
        schedule={savedRecord?.schedule || calc.schedule}
        onClose={() => setPdfModalOpen(false)}
      />

      {/* Duplicate Contract ID Alert Pop-up Modal */}
      {duplicateContractAlert && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-[1px]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="duplicate-contract-modal-title"
        >
          <div className="w-full max-w-md rounded-xl border border-amber-200 bg-white p-6 shadow-xl">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-700">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="flex-1">
                <h3
                  id="duplicate-contract-modal-title"
                  className="text-base font-semibold text-slate-900"
                >
                  พบเลขที่สัญญาซ้ำในฐานข้อมูล
                </h3>
                <p className="mt-1.5 text-sm font-medium text-amber-900">
                  {duplicateContractAlert.message}
                </p>
              </div>
            </div>

            <div className="mt-4 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500">เลขที่สัญญาเดิมที่ซ้ำ:</span>
                <span className="font-mono font-semibold text-red-700 line-through tabular-nums">
                  {duplicateContractAlert.oldId}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-600 font-medium">เลขที่สัญญาใหม่ที่สร้างให้:</span>
                <span className="font-mono text-sm font-bold text-[#0F2942] tabular-nums">
                  {duplicateContractAlert.newId}
                </span>
              </div>
            </div>

            <p className="mt-3 text-xs leading-relaxed text-slate-600">
              ระบบได้สร้างเลขที่สัญญาใหม่ให้อัตโนมัติแล้ว โดยข้อมูลลูกค้าและรายละเอียดทางการเงินที่กรอกไว้ยังคงอยู่ครบถ้วน กรุณาตรวจสอบเลขที่สัญญาใหม่และกดบันทึกอีกครั้ง
            </p>

            <div className="mt-5 flex justify-end">
              <button
                type="button"
                onClick={() => setDuplicateContractAlert(null)}
                className="whitespace-nowrap rounded-lg bg-[#0F2942] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1E3A5F]"
              >
                รับทราบและใช้เลขที่สัญญาใหม่
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
