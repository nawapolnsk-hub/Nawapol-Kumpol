import { useEffect, useState, type ChangeEvent } from 'react';
import {
  CheckCircle2,
  Database,
  ExternalLink,
  ImagePlus,
  RefreshCw,
  Settings,
  X,
} from 'lucide-react';
import { apiClient, type SheetsTestResponse, type UserAuthProfile } from '../services/apiClient.ts';
import type { SheetsOAuthSnapshot } from '../services/sheetsOAuthManager.ts';
import type { ConnectionStatus, InterestMethod, SystemConfig } from '../types/rhp.ts';
import { ConfirmationModal } from './ConfirmationModal.tsx';

interface SystemSettingsViewProps {
  hasSheetsAccess: boolean;
  oAuthSnapshot: SheetsOAuthSnapshot;
  reconnectLoading?: boolean;
  userProfile: UserAuthProfile | null;
  connection: ConnectionStatus;
  config: SystemConfig;
  onReconnectSheets: () => Promise<void>;
  onDatabaseReady: () => Promise<void>;
  onConfigUpdated: (nextConfig: SystemConfig) => void;
  onOpenSetupModal: () => void;
}

export function SystemSettingsView({
  hasSheetsAccess,
  oAuthSnapshot,
  reconnectLoading = false,
  userProfile,
  connection,
  config,
  onReconnectSheets,
  onDatabaseReady,
  onConfigUpdated,
  onOpenSetupModal,
}: SystemSettingsViewProps) {
  const [draftCompanyName, setDraftCompanyName] = useState(config.companyName);
  const [draftCompanyAddress, setDraftCompanyAddress] = useState(config.companyAddress);
  const [draftLogo, setDraftLogo] = useState<string | null>(config.companyLogoDataUrl);
  const [draftInterestMethod, setDraftInterestMethod] = useState<InterestMethod>(
    config.defaultInterestMethod
  );
  const [manualId, setManualId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [testResult, setTestResult] = useState<SheetsTestResponse | null>(null);

  const [pendingConfirm, setPendingConfirm] = useState<{
    title: string;
    description: string;
    details: string[];
    tone: 'primary' | 'warning';
    action: () => Promise<void>;
  } | null>(null);

  useEffect(() => {
    setDraftCompanyName(config.companyName);
    setDraftCompanyAddress(config.companyAddress);
    setDraftLogo(config.companyLogoDataUrl);
    setDraftInterestMethod(config.defaultInterestMethod);
  }, [config]);

  const isSuperAdmin = userProfile?.role === 'Super Admin';

  if (!isSuperAdmin) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-8 text-center">
        <Settings className="mx-auto h-10 w-10 text-amber-700" />
        <h3 className="mt-3 text-base font-semibold text-amber-950">
          จำกัดสิทธิ์เฉพาะผู้ดูแลระบบสูงสุด (Super Admin Only)
        </h3>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-amber-900">
          การตั้งค่าระบบ นโยบายการคำนวณเริ่มต้น และการจัดการฐานข้อมูลกลางสงวนสิทธิ์สำหรับ Super Admin เท่านั้น
        </p>
      </div>
    );
  }

  const handleLogoUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/png') && !file.type.startsWith('image/jpeg')) {
      setMessage({ type: 'error', text: 'รองรับเฉพาะไฟล์รูปภาพ PNG หรือ JPG เท่านั้น' });
      return;
    }
    if (file.size > 1024 * 1024) {
      setMessage({ type: 'error', text: 'ขนาดโลโก้ต้องไม่เกิน 1 MB' });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setDraftLogo(typeof reader.result === 'string' ? reader.result : null);
    };
    reader.readAsDataURL(file);
  };

  const handleSaveSettings = () => {
    setPendingConfirm({
      title: 'ยืนยันการบันทึกการตั้งค่าระบบ',
      description:
        'ระบบจะอัปเดตข้อมูลองค์กร โลโก้ และนโยบายวิธีคิดดอกเบี้ยเริ่มต้นลงใน System_Configuration',
      details: [
        `ชื่อองค์กร: ${draftCompanyName || '-'}`,
        `หน่วยงาน/ที่อยู่: ${draftCompanyAddress || '-'}`,
        `Default Interest Method: ${draftInterestMethod}`,
      ],
      tone: 'primary',
      action: async () => {
        setBusy(true);
        setMessage(null);
        try {
          const res = await apiClient.updateConfig({
            companyName: draftCompanyName,
            companyAddress: draftCompanyAddress,
            companyLogoDataUrl: draftLogo,
            defaultInterestMethod: draftInterestMethod,
          });
          onConfigUpdated(res.config);
          setMessage({ type: 'success', text: 'บันทึกการตั้งค่าระบบเรียบร้อยแล้ว' });
        } catch (err) {
          setMessage({
            type: 'error',
            text: err instanceof Error ? err.message : 'ไม่สามารถบันทึกการตั้งค่าได้',
          });
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const handleTestConnection = async () => {
    setBusy(true);
    setMessage(null);
    setTestResult(null);
    try {
      const res = await apiClient.testConnection();
      setTestResult(res);
      setMessage({
        type: 'success',
        text: `เชื่อมต่อ Google Sheets สำเร็จ (${res.latencyMs} ms) — พบชีตครบ ${res.sheetsPresent.length} แท็บ`,
      });
    } catch (err) {
      setMessage({
        type: 'error',
        text: err instanceof Error ? err.message : 'การทดสอบการเชื่อมต่อล้มเหลว',
      });
    } finally {
      setBusy(false);
    }
  };

  const handleConnectExisting = () => {
    if (!manualId.trim()) {
      setMessage({ type: 'error', text: 'กรุณาระบุ Google Spreadsheet ID หรือ URL' });
      return;
    }
    setPendingConfirm({
      title: 'เชื่อมต่อ Google Sheets ที่มีอยู่',
      description:
        'ระบบจะเชื่อมต่อกับสเปรดชีตที่คุณระบุ และตรวจสอบหัวตารางทั้ง 4 ชีตโดยไม่ลบข้อมูลเดิม',
      details: [`Target Spreadsheet: ${manualId.trim()}`],
      tone: 'primary',
      action: async () => {
        setBusy(true);
        setMessage(null);
        try {
          await apiClient.connectDatabase(manualId.trim());
          await onDatabaseReady();
          setManualId('');
          setMessage({ type: 'success', text: 'เชื่อมต่อฐานข้อมูล Google Sheets สำเร็จ' });
        } catch (err) {
          setMessage({
            type: 'error',
            text: err instanceof Error ? err.message : 'ไม่สามารถเชื่อมต่อได้',
          });
        } finally {
          setBusy(false);
        }
      },
    });
  };

  return (
    <div className="space-y-6">
      {message && (
        <div
          className={`flex items-center justify-between gap-4 rounded-lg border px-4 py-3 text-xs font-medium ${
            message.type === 'success'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-red-200 bg-red-50 text-red-700'
          }`}
        >
          <span>{message.text}</span>
          <button
            type="button"
            onClick={() => setMessage(null)}
            className="rounded p-0.5 hover:bg-black/5"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Corporate Identity & Financial Policy */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-6">
          <h3 className="text-base font-semibold text-slate-900">
            ข้อมูลองค์กรและโลโก้ (System Header &amp; PDF Branding)
          </h3>

          <div>
            <label className="block text-xs font-medium text-slate-700">
              ชื่อองค์กร / บริษัท (แสดงร่วมในหัวเอกสาร PDF)
            </label>
            <input
              type="text"
              value={draftCompanyName}
              onChange={(e) => setDraftCompanyName(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-[#0F2942] focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700">
              หน่วยงาน / ที่อยู่
            </label>
            <input
              type="text"
              value={draftCompanyAddress}
              onChange={(e) => setDraftCompanyAddress(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-[#0F2942] focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700">
              โลโก้บริษัท (PNG/JPG ไม่เกิน 1 MB)
            </label>
            <div className="mt-2 flex items-center gap-3">
              {draftLogo ? (
                <img
                  src={draftLogo}
                  alt="Company Logo"
                  referrerPolicy="no-referrer"
                  className="h-14 w-14 rounded-lg border border-slate-200 object-contain p-1"
                />
              ) : (
                <div className="flex h-14 w-14 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 text-slate-400">
                  <ImagePlus className="h-5 w-5" />
                </div>
              )}
              <div className="flex items-center gap-2">
                <label className="cursor-pointer whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50">
                  อัปโหลดโลโก้ใหม่
                  <input
                    type="file"
                    accept="image/png,image/jpeg"
                    onChange={handleLogoUpload}
                    className="hidden"
                  />
                </label>
                {draftLogo && (
                  <button
                    type="button"
                    onClick={() => setDraftLogo(null)}
                    className="text-xs font-medium text-red-600 hover:underline"
                  >
                    ลบโลโก้
                  </button>
                )}
              </div>
            </div>
          </div>
        </section>

        <section className="flex flex-col justify-between space-y-4 rounded-xl border border-slate-200 bg-white p-6">
          <div className="space-y-4">
            <h3 className="text-base font-semibold text-slate-900">
              นโยบายการคำนวณดอกเบี้ยและเลขที่สัญญา
            </h3>

            <div>
              <label className="block text-xs font-medium text-slate-700">
                วิธีคำนวณดอกเบี้ยเริ่มต้น (Default Interest Method)
              </label>
              <div className="mt-2 flex items-center gap-2 rounded-lg bg-slate-100 p-1">
                {(['Flat Rate', 'Reducing Balance'] as InterestMethod[]).map((method) => (
                  <button
                    key={method}
                    type="button"
                    onClick={() => setDraftInterestMethod(method)}
                    className={`flex-1 whitespace-nowrap rounded-md px-3 py-2 text-xs font-semibold transition-colors ${
                      draftInterestMethod === method
                        ? 'bg-white text-[#0F2942] shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {method}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs">
              <p className="font-semibold text-slate-800">รูปแบบเลขที่สัญญาปรับโครงสร้าง (RHP Contract ID)</p>
              <p className="mt-1 font-mono font-bold text-[#0F2942]">
                RHP YYYY-XXX (รีเซ็ต 001 ทุกปีปฏิทินตามเขตเวลา Asia/Bangkok)
              </p>
              <p className="mt-1 text-slate-500">
                ระบบป้องกันการใช้เลขซ้ำและไม่นำเลขที่เคยใช้หรือลบแล้วกลับมาใช้อีก
              </p>
            </div>
          </div>

          <div className="flex justify-end border-t border-slate-100 pt-4">
            <button
              type="button"
              onClick={handleSaveSettings}
              disabled={busy}
              className="whitespace-nowrap rounded-lg bg-[#0F2942] px-5 py-2.5 text-xs font-semibold text-white hover:bg-[#1E3A5F] disabled:opacity-50"
            >
              บันทึกการตั้งค่าองค์กรและนโยบาย
            </button>
          </div>
        </section>
      </div>

      {/* Google Sheets Database Connection Section */}
      <section className="rounded-xl border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 pb-4">
          <div className="flex items-center gap-2.5">
            <Database className="h-5 w-5 text-[#0F2942]" />
            <div>
              <h3 className="text-base font-semibold text-slate-900">
                การเชื่อมต่อฐานข้อมูลกลาง (Google Sheets: RHP_Restructuring_Database)
              </h3>
              <p className="mt-0.5 text-xs text-slate-500">
                โหมดสิทธิ์:{' '}
                {oAuthSnapshot.authMode === 'service_account'
                  ? 'Service Account (เชื่อมต่ออัตโนมัติ)'
                  : hasSheetsAccess
                    ? 'Google OAuth 2.0 (พร้อมใช้งาน)'
                    : 'ต้องต่ออายุสิทธิ์ Google OAuth'}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {!hasSheetsAccess && oAuthSnapshot.authMode !== 'service_account' && (
              <button
                type="button"
                onClick={() => void onReconnectSheets()}
                disabled={reconnectLoading}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-amber-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-amber-800 disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${reconnectLoading ? 'animate-spin' : ''}`} />
                Reconnect Google
              </button>
            )}
            <button
              type="button"
              onClick={onOpenSetupModal}
              className="whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              เปิดหน้าตั้งค่าขั้นสูง / Apps Script
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-slate-800">สถานะฐานข้อมูล:</span>
              <span
                className={`inline-flex items-center gap-1 font-semibold ${
                  connection.connected ? 'text-emerald-700' : 'text-amber-700'
                }`}
              >
                {connection.connected && <CheckCircle2 className="h-3.5 w-3.5" />}
                {connection.connected ? 'เชื่อมต่อแล้ว' : 'ยังไม่ได้เชื่อมต่อ'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-600">ชื่อสเปรดชีต:</span>
              <span className="font-semibold text-slate-900">
                {connection.spreadsheetTitle || '-'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-slate-600">Spreadsheet ID:</span>
              <span className="font-mono text-slate-700">{connection.spreadsheetId || '-'}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-2">
              <button
                type="button"
                onClick={handleTestConnection}
                disabled={busy || !hasSheetsAccess || !connection.connected}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-100 disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
                ทดสอบการเชื่อมต่อ
              </button>
              {connection.spreadsheetUrl && (
                <a
                  href={connection.spreadsheetUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-[#0F2942] hover:bg-slate-100"
                >
                  เปิด Google Sheets
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
            {testResult && (
              <p className="pt-1 font-mono text-[11px] text-emerald-700 tabular-nums">
                Latency: {testResult.latencyMs} ms · สัญญา: {testResult.counts.transactions} ·
                Audit Logs: {testResult.counts.auditLogs}
              </p>
            )}
          </div>

          <div className="space-y-3 rounded-lg border border-slate-200 p-4 text-xs">
            <p className="font-semibold text-slate-900">เปลี่ยนหรือเชื่อมต่อสเปรดชีตด้วย ID / URL</p>
            <input
              type="text"
              value={manualId}
              onChange={(e) => setManualId(e.target.value)}
              placeholder="วาง Google Spreadsheet ID หรือ URL..."
              className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-900 focus:border-[#0F2942] focus:outline-none"
            />
            <button
              type="button"
              onClick={handleConnectExisting}
              disabled={busy || !hasSheetsAccess || !manualId.trim()}
              className="whitespace-nowrap rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50"
            >
              เชื่อมต่อ Spreadsheet ID นี้
            </button>
          </div>
        </div>
      </section>

      <ConfirmationModal
        open={Boolean(pendingConfirm)}
        title={pendingConfirm?.title || ''}
        description={pendingConfirm?.description || ''}
        details={pendingConfirm?.details}
        tone={pendingConfirm?.tone || 'primary'}
        busy={busy}
        onCancel={() => setPendingConfirm(null)}
        onConfirm={() => {
          const act = pendingConfirm?.action;
          setPendingConfirm(null);
          if (act) void act();
        }}
      />
    </div>
  );
}
