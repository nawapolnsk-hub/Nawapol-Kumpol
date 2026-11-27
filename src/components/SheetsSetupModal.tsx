import { useEffect, useState, type ChangeEvent } from 'react';
import {
  CheckCircle2,
  Database,
  ExternalLink,
  ImagePlus,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
  X,
} from 'lucide-react';
import { apiClient, type SheetsTestResponse, type UserAuthProfile } from '../services/apiClient.ts';
import type { SheetsOAuthSnapshot } from '../services/sheetsOAuthManager.ts';
import {
  ALL_USER_ROLES,
  type ConnectionStatus,
  type InterestMethod,
  type SystemConfig,
  type UserPermissionEntry,
  type UserRole,
} from '../types/rhp.ts';
import { getDefaultRoleCapabilities } from '../utils/transactionLifecycle.ts';
import { ConfirmationModal } from './ConfirmationModal.tsx';
import { GoogleSignInButton } from './GoogleSignInButton.tsx';

interface SheetsSetupModalProps {
  open: boolean;
  onClose: () => void;
  isPortalAuthenticated: boolean;
  hasSheetsAccess: boolean;
  oAuthSnapshot: SheetsOAuthSnapshot;
  reconnectLoading?: boolean;
  authLoading?: boolean;
  userProfile: UserAuthProfile | null;
  onSignIn: () => Promise<void>;
  onReconnectSheets: () => Promise<void>;
  connection: ConnectionStatus;
  config: SystemConfig;
  onDatabaseReady: () => Promise<void>;
  onConfigUpdated: (nextConfig: SystemConfig) => void;
}

type ModalTab = 'sheets' | 'policy' | 'apps_script';

export function SheetsSetupModal({
  open,
  onClose,
  isPortalAuthenticated,
  hasSheetsAccess,
  oAuthSnapshot,
  reconnectLoading = false,
  authLoading = false,
  userProfile,
  onSignIn,
  onReconnectSheets,
  connection,
  config,
  onDatabaseReady,
  onConfigUpdated,
}: SheetsSetupModalProps) {
  const [activeTab, setActiveTab] = useState<ModalTab>('sheets');
  const [manualId, setManualId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [testResult, setTestResult] = useState<SheetsTestResponse | null>(null);

  // Admin System Configuration draft state
  const [draftCompanyName, setDraftCompanyName] = useState(config.companyName);
  const [draftCompanyAddress, setDraftCompanyAddress] = useState(config.companyAddress);
  const [draftLogo, setDraftLogo] = useState<string | null>(config.companyLogoDataUrl);
  const [draftInterestMethod, setDraftInterestMethod] = useState<InterestMethod>(
    config.defaultInterestMethod
  );
  const [draftUsers, setDraftUsers] = useState<UserPermissionEntry[]>(config.authorizedUsers);
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserRole, setNewUserRole] = useState<UserRole>('Risk Control');

  const [pendingConfirm, setPendingConfirm] = useState<{
    title: string;
    description: string;
    details: string[];
    tone: 'primary' | 'warning' | 'danger';
    action: () => Promise<void>;
  } | null>(null);

  useEffect(() => {
    if (open) {
      setDraftCompanyName(config.companyName);
      setDraftCompanyAddress(config.companyAddress);
      setDraftLogo(config.companyLogoDataUrl);
      setDraftInterestMethod(config.defaultInterestMethod);
      setDraftUsers(config.authorizedUsers);
    }
  }, [open, config]);

  if (!open) return null;

  const isSuperAdmin = userProfile?.role === 'Super Admin';

  const handleInitDatabase = () => {
    setPendingConfirm({
      title: 'สร้างหรือเชื่อมต่อฐานข้อมูล RHP_Restructuring_Database',
      description:
        'ระบบจะค้นหาไฟล์ RHP_Restructuring_Database ใน Google Drive ของคุณ หากไม่พบจะสร้างไฟล์ Google Sheets ใหม่พร้อมชีตทั้ง 4 แท็บโดยอัตโนมัติ',
      details: [
        'ชื่อไฟล์: RHP_Restructuring_Database',
        'ชีต 1: Transaction_Records',
        'ชีต 2: Amortization_Schedule',
        'ชีต 3: System_Configuration',
        'ชีต 4: Audit_Log',
      ],
      tone: 'primary',
      action: async () => {
        setBusy(true);
        setMessage(null);
        try {
          await apiClient.initDatabase();
          await onDatabaseReady();
          setMessage({
            type: 'success',
            text: 'เชื่อมต่อและเตรียมโครงสร้างชีตทั้ง 4 แท็บใน Google Sheets เรียบร้อยแล้ว',
          });
        } catch (err) {
          setMessage({
            type: 'error',
            text: err instanceof Error ? err.message : 'ไม่สามารถสร้างฐานข้อมูลได้',
          });
        } finally {
          setBusy(false);
        }
      },
    });
  };

  const handleConnectExisting = () => {
    if (!manualId.trim()) {
      setMessage({ type: 'error', text: 'กรุณาระบุ Google Spreadsheet ID หรือ URL' });
      return;
    }
    setPendingConfirm({
      title: 'เชื่อมต่อ Google Sheets ที่มีอยู่',
      description:
        'ระบบจะเชื่อมต่อกับสเปรดชีตที่คุณระบุ และสร้างแท็บ/หัวตารางที่ยังขาดอยู่ (Transaction_Records, Amortization_Schedule, System_Configuration, Audit_Log) ให้โดยอัตโนมัติ',
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

  const handleTestConnection = async () => {
    setBusy(true);
    setMessage(null);
    setTestResult(null);
    try {
      const res = await apiClient.testConnection();
      setTestResult(res);
      setMessage({
        type: 'success',
        text: `เชื่อมต่อสำเร็จ (${res.latencyMs} ms) — พบชีตครบ ${res.sheetsPresent.length} แท็บ`,
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

  const handleDisconnect = () => {
    setPendingConfirm({
      title: 'ยกเลิกการเชื่อมต่อสเปรดชีตปัจจุบัน',
      description:
        'การดำเนินการนี้จะปลดการเชื่อมต่อจากสเปรดชีตในแอปเท่านั้น ข้อมูลทั้งหมดใน Google Sheets ของคุณจะยังคงอยู่ตามเดิม',
      details: [`Spreadsheet ID: ${connection.spreadsheetId || '-'}`],
      tone: 'warning',
      action: async () => {
        setBusy(true);
        try {
          await apiClient.disconnectDatabase();
          await onDatabaseReady();
          setTestResult(null);
          setMessage({ type: 'success', text: 'ยกเลิกการเชื่อมต่อเรียบร้อยแล้ว' });
        } catch (err) {
          setMessage({
            type: 'error',
            text: err instanceof Error ? err.message : 'เกิดข้อผิดพลาด',
          });
        } finally {
          setBusy(false);
        }
      },
    });
  };

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

  const handleAddUser = () => {
    const email = newUserEmail.trim().toLowerCase();
    if (!email || !email.includes('@')) return;
    if (draftUsers.some((u) => u.email.toLowerCase() === email)) return;
    const defaults = getDefaultRoleCapabilities(newUserRole);
    setDraftUsers((prev) => [
      ...prev,
      {
        email,
        role: newUserRole,
        accountStatus: 'Approved',
        emailVerified: true,
        canOverrideAr: defaults.canOverrideAr,
        canApprove: defaults.canApprove,
        canDelete: defaults.canDelete,
        disabled: false,
      },
    ]);
    setNewUserEmail('');
  };

  const handleSaveConfig = () => {
    setPendingConfirm({
      title: 'บันทึกการตั้งค่าระบบและนโยบายบริษัท',
      description:
        'ระบบจะบันทึกนโยบายวิธีคำนวณดอกเบี้ยเริ่มต้น ข้อมูลบริษัท และสิทธิ์ผู้ใช้งานลงในชีต System_Configuration บน Google Sheets',
      details: [
        `Default Interest Method: ${draftInterestMethod}`,
        `Company Name: ${draftCompanyName}`,
        `Authorized Users: ${draftUsers.length} บัญชี`,
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
            authorizedUsers: draftUsers,
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

  const appsScriptSnippet = `// ตัวอย่าง Google Apps Script สำหรับองค์กรที่ต้องการรับข้อมูลผ่าน Web App (Optional)
function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var payload = JSON.parse(e.postData.contents);
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(payload.sheetName || "Transaction_Records");
    sheet.appendRow(payload.row);
    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}`;

  return (
    <>
      <div
        className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-4"
        role="dialog"
        aria-modal="true"
        aria-label="ตั้งค่าระบบและฐานข้อมูล Google Sheets"
      >
        <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
          <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
            <div className="flex items-center gap-3">
              <Database className="h-5 w-5 text-[#0F2942]" />
              <div>
                <h2 className="text-base font-semibold text-slate-900">
                  ตั้งค่าระบบ ฐานข้อมูล Google Sheets และสิทธิ์ผู้ใช้งาน
                </h2>
                <p className="text-xs text-slate-500">
                  เชื่อมต่อฐานข้อมูลกลาง RHP_Restructuring_Database · Timezone: Asia/Bangkok
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              aria-label="ปิด"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Sub-navigation Tabs */}
          <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-6 py-2.5">
            <button
              type="button"
              onClick={() => setActiveTab('sheets')}
              className={`whitespace-nowrap rounded-lg px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                activeTab === 'sheets'
                  ? 'bg-[#0F2942] text-white'
                  : 'text-slate-600 hover:bg-white hover:text-slate-900'
              }`}
            >
              การเชื่อมต่อ Google Sheets
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('policy')}
              className={`whitespace-nowrap rounded-lg px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                activeTab === 'policy'
                  ? 'bg-[#0F2942] text-white'
                  : 'text-slate-600 hover:bg-white hover:text-slate-900'
              }`}
            >
              นโยบายดอกเบี้ย โลโก้ และสิทธิ์ผู้ใช้
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('apps_script')}
              className={`whitespace-nowrap rounded-lg px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                activeTab === 'apps_script'
                  ? 'bg-[#0F2942] text-white'
                  : 'text-slate-600 hover:bg-white hover:text-slate-900'
              }`}
            >
              ขั้นตอนติดตั้งและ Apps Script Guide
            </button>
          </div>

          <div className="flex-1 space-y-5 overflow-y-auto p-6">
            {message && (
              <div
                className={`rounded-lg border px-4 py-3 text-sm ${
                  message.type === 'success'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                    : 'border-red-200 bg-red-50 text-red-800'
                }`}
              >
                {message.text}
              </div>
            )}

            {activeTab === 'sheets' && (
              <div className="space-y-6">
                {!isPortalAuthenticated ? (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">
                    <h3 className="text-sm font-semibold text-amber-900">
                      ขั้นตอนที่ 1: ยืนยันตัวตนเข้าสู่ระบบ RHP Portal (Firebase Auth)
                    </h3>
                    <p className="mt-1 text-xs leading-relaxed text-amber-800">
                      กรุณาเข้าสู่ระบบด้วยบัญชี Google ขององค์กรเพื่อเปิดใช้งาน RHP Portal
                      และอนุญาตการเชื่อมต่อสเปรดชีต RHP_Restructuring_Database
                    </p>
                    <div className="mt-4">
                      <GoogleSignInButton onClick={() => void onSignIn()} disabled={authLoading} />
                    </div>
                  </div>
                ) : (
                  <>
                    {/* 2-Layer Authentication & Authorization Status Cards */}
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      <div className="rounded-xl border border-slate-200 bg-white p-4">
                        <p className="text-[11px] font-semibold text-slate-500">
                          1. Portal Authentication (Firebase Auth · LOCAL)
                        </p>
                        <p className="mt-1 text-sm font-semibold text-emerald-700">
                          เข้าสู่ระบบแล้ว ({userProfile?.role || 'Viewer'})
                        </p>
                        <p className="mt-0.5 truncate font-mono text-xs text-slate-600">
                          {userProfile?.email}
                        </p>
                        <p className="mt-1 text-[11px] text-slate-500">
                          การหมดอายุของ Google Sheets OAuth จะไม่ทำให้เซสชันนี้หลุด
                        </p>
                      </div>

                      <div className="rounded-xl border border-slate-200 bg-white p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-[11px] font-semibold text-slate-500">
                              2. Google Sheets Authorization
                            </p>
                            {oAuthSnapshot.authMode === 'service_account' ? (
                              <>
                                <p className="mt-1 text-sm font-semibold text-emerald-700">
                                  Google Service Account (อัตโนมัติ)
                                </p>
                                <p className="mt-0.5 truncate font-mono text-xs text-slate-600">
                                  {oAuthSnapshot.serviceAccountEmail || 'Configured on Server'}
                                </p>
                              </>
                            ) : (
                              <>
                                <p
                                  className={`mt-1 text-sm font-semibold ${
                                    hasSheetsAccess ? 'text-emerald-700' : 'text-amber-700'
                                  }`}
                                >
                                  {hasSheetsAccess
                                    ? oAuthSnapshot.hasRefreshToken
                                      ? 'OAuth เชื่อมต่อแล้ว (Auto-Refresh พร้อมใช้)'
                                      : 'OAuth Token พร้อมใช้งาน'
                                    : oAuthSnapshot.status === 'revoked'
                                      ? 'สิทธิ์ OAuth ถูกเพิกถอน'
                                      : 'สิทธิ์ OAuth หมดอายุ (ต้องเชื่อมต่อใหม่)'}
                                </p>
                                {oAuthSnapshot.expiresAtMs && (
                                  <p className="mt-0.5 font-mono text-xs text-slate-600 tabular-nums">
                                    หมดอายุ:{' '}
                                    {new Date(oAuthSnapshot.expiresAtMs).toLocaleTimeString(
                                      'th-TH',
                                      { timeZone: 'Asia/Bangkok', hour12: false }
                                    )}{' '}
                                    (ต่ออายุอัตโนมัติล่วงหน้า 5 นาที)
                                  </p>
                                )}
                              </>
                            )}
                          </div>

                          {oAuthSnapshot.authMode !== 'service_account' && (
                            <button
                              type="button"
                              onClick={() => void onReconnectSheets()}
                              disabled={reconnectLoading}
                              className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50"
                            >
                              <RefreshCw
                                className={`h-3.5 w-3.5 ${reconnectLoading ? 'animate-spin' : ''}`}
                              />
                              Reconnect Google
                            </button>
                          )}
                        </div>
                      </div>
                    </div>

                    {!hasSheetsAccess && oAuthSnapshot.authMode !== 'service_account' && (
                      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
                        <span>
                          {oAuthSnapshot.statusMessage ||
                            'กรุณากด Reconnect Google เพื่อขอสิทธิ์ Google Sheets ก่อนสร้าง ทดสอบ หรือซิงก์สเปรดชีต'}
                        </span>
                        <button
                          type="button"
                          onClick={() => void onReconnectSheets()}
                          disabled={reconnectLoading}
                          className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-amber-700 px-3.5 py-1.5 font-semibold text-white hover:bg-amber-800 disabled:opacity-50"
                        >
                          <RefreshCw
                            className={`h-3.5 w-3.5 ${reconnectLoading ? 'animate-spin' : ''}`}
                          />
                          Reconnect Google
                        </button>
                      </div>
                    )}

                    {/* Current Connection State */}
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-5">
                      <div className="flex flex-wrap items-center justify-between gap-4">
                        <div>
                          <p className="text-xs font-medium text-slate-500">สถานะการเชื่อมต่อฐานข้อมูลกลาง</p>
                          <p className="mt-1 text-base font-semibold text-slate-900">
                            {connection.connected
                              ? connection.spreadsheetTitle || 'RHP_Restructuring_Database'
                              : 'ยังไม่ได้เชื่อมต่อสเปรดชีต'}
                          </p>
                          {connection.spreadsheetId && (
                            <p className="mt-1 font-mono text-xs text-slate-600">
                              ID: {connection.spreadsheetId}
                            </p>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {connection.spreadsheetUrl && (
                            <a
                              href={connection.spreadsheetUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                            >
                              เปิด Google Sheets
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          )}
                          {connection.connected && (
                            <>
                              <button
                                type="button"
                                onClick={() => void handleTestConnection()}
                                disabled={busy || !hasSheetsAccess}
                                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-100 disabled:opacity-50"
                              >
                                <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
                                ทดสอบการเชื่อมต่อ
                              </button>
                              <button
                                type="button"
                                onClick={handleDisconnect}
                                disabled={busy}
                                className="whitespace-nowrap rounded-lg border border-red-200 bg-white px-3 py-2 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                              >
                                ยกเลิกการเชื่อมต่อ
                              </button>
                            </>
                          )}
                        </div>
                      </div>

                      {testResult && (
                        <div className="mt-4 grid grid-cols-1 gap-3 border-t border-slate-200 pt-4 sm:grid-cols-4">
                          <div>
                            <p className="text-xs text-slate-500">ความเร็วตอบสนอง</p>
                            <p className="font-mono text-sm font-semibold text-emerald-700 tabular-nums">
                              {testResult.latencyMs} ms
                            </p>
                          </div>
                          <div>
                            <p className="text-xs text-slate-500">Transaction_Records</p>
                            <p className="font-mono text-sm font-semibold text-slate-900 tabular-nums">
                              {testResult.counts.transactions} รายการ
                            </p>
                          </div>
                          <div>
                            <p className="text-xs text-slate-500">Amortization Contracts</p>
                            <p className="font-mono text-sm font-semibold text-slate-900 tabular-nums">
                              {testResult.counts.amortizationContracts} สัญญา
                            </p>
                          </div>
                          <div>
                            <p className="text-xs text-slate-500">Audit_Log</p>
                            <p className="font-mono text-sm font-semibold text-slate-900 tabular-nums">
                              {testResult.counts.auditLogs} รายการ
                            </p>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Option A: Auto-create or locate */}
                    <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                      <div className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-5">
                        <div>
                          <h4 className="text-sm font-semibold text-slate-900">
                            สร้างฐานข้อมูลอัตโนมัติ (แนะนำ)
                          </h4>
                          <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
                            ระบบจะสร้างสเปรดชีตชื่อ <span className="font-mono font-semibold">RHP_Restructuring_Database</span>{' '}
                            พร้อมชีตทั้ง 4 แท็บและหัวคอลัมน์มาตรฐานครบถ้วนทันที
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={handleInitDatabase}
                          disabled={busy || !hasSheetsAccess}
                          className="mt-4 inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg bg-[#0F2942] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#1E3A5F] disabled:opacity-50"
                        >
                          <CheckCircle2 className="h-4 w-4" />
                          สร้าง / เชื่อมต่อ RHP_Restructuring_Database
                        </button>
                      </div>

                      {/* Option B: Connect existing ID */}
                      <div className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-5">
                        <div>
                          <h4 className="text-sm font-semibold text-slate-900">
                            เชื่อมต่อสเปรดชีตที่มีอยู่ด้วย ID หรือ URL
                          </h4>
                          <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
                            วาง Google Sheets URL หรือ Spreadsheet ID ของไฟล์กลางบริษัทที่สร้างไว้แล้ว
                          </p>
                          <input
                            type="text"
                            value={manualId}
                            onChange={(e) => setManualId(e.target.value)}
                            placeholder="https://docs.google.com/spreadsheets/d/..."
                            className="mt-3 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs text-slate-900 focus:border-[#0F2942] focus:outline-none"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={handleConnectExisting}
                          disabled={busy || !hasSheetsAccess || !manualId.trim()}
                          className="mt-4 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50"
                        >
                          เชื่อมต่อ Spreadsheet ID นี้
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {activeTab === 'policy' && (
              <div className="space-y-6">
                {!isSuperAdmin && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
                    คุณกำลังดูข้อมูลด้วยสิทธิ์ {userProfile?.role || 'Viewer'} — เฉพาะผู้ดูแลระบบสูงสุด (Super Admin)
                    เท่านั้นที่สามารถแก้ไขนโยบายบริษัทและสิทธิ์ผู้ใช้งานได้
                  </div>
                )}

                <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                  <div className="space-y-3 rounded-xl border border-slate-200 p-5">
                    <h4 className="text-sm font-semibold text-slate-900">ข้อมูลบริษัทและโลโก้เอกสาร PDF</h4>
                    <div>
                      <label className="block text-xs font-medium text-slate-700">ชื่อบริษัท (หัวเอกสาร PDF)</label>
                      <input
                        type="text"
                        value={draftCompanyName}
                        onChange={(e) => setDraftCompanyName(e.target.value)}
                        disabled={!isSuperAdmin}
                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 disabled:bg-slate-50"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700">หน่วยงาน / ที่อยู่</label>
                      <input
                        type="text"
                        value={draftCompanyAddress}
                        onChange={(e) => setDraftCompanyAddress(e.target.value)}
                        disabled={!isSuperAdmin}
                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 disabled:bg-slate-50"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700">โลโก้บริษัท (PNG/JPG)</label>
                      <div className="mt-2 flex items-center gap-3">
                        {draftLogo ? (
                          <img
                            src={draftLogo}
                            alt="Company Logo"
                            className="h-12 w-12 rounded-lg border border-slate-200 object-contain p-1"
                          />
                        ) : (
                          <div className="flex h-12 w-12 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 text-slate-400">
                            <ImagePlus className="h-5 w-5" />
                          </div>
                        )}
                        {isSuperAdmin && (
                          <div className="flex items-center gap-2">
                            <label className="cursor-pointer whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
                              อัปโหลดโลโก้
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
                                className="text-xs text-red-600 hover:underline"
                              >
                                ลบโลโก้
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-4 rounded-xl border border-slate-200 p-5">
                    <h4 className="text-sm font-semibold text-slate-900">นโยบายการคำนวณดอกเบี้ยเริ่มต้น</h4>
                    <p className="text-xs text-slate-500">
                      กำหนดวิธีคิดดอกเบี้ยเริ่มต้นของบริษัทเมื่อสร้างรายการปรับโครงสร้างใหม่
                    </p>
                    <div className="flex items-center gap-2 rounded-lg bg-slate-100 p-1">
                      {(['Flat Rate', 'Reducing Balance'] as InterestMethod[]).map((method) => (
                        <button
                          key={method}
                          type="button"
                          disabled={!isSuperAdmin}
                          onClick={() => setDraftInterestMethod(method)}
                          className={`flex-1 whitespace-nowrap rounded-md px-3 py-2 text-xs font-semibold transition-colors ${
                            draftInterestMethod === method
                              ? 'bg-white text-[#0F2942] shadow-sm'
                              : 'text-slate-600 hover:text-slate-900'
                          } disabled:opacity-60`}
                        >
                          {method}
                        </button>
                      ))}
                    </div>
                    <p className="text-xs text-slate-500">
                      หมายเหตุ: เจ้าหน้าที่ยังสามารถเลือกสลับวิธีคำนวณเฉพาะสัญญาได้ในหน้า Calculator
                    </p>
                  </div>
                </div>

                {/* User Permissions Registry */}
                <div className="rounded-xl border border-slate-200 p-5">
                  <div className="flex items-center gap-2">
                    <Shield className="h-4 w-4 text-[#0F2942]" />
                    <h4 className="text-sm font-semibold text-slate-900">
                      การกำหนดสิทธิ์ผู้ใช้งาน (Role & AR Override Permissions)
                    </h4>
                  </div>

                  <div className="mt-4 overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 text-slate-500">
                          <th className="py-2 pr-4 font-semibold">อีเมลพนักงาน (Google Account)</th>
                          <th className="py-2 pr-4 font-semibold">บทบาท (Role)</th>
                          <th className="py-2 pr-4 font-semibold">สิทธิ์ปรับแก้ AR</th>
                          <th className="py-2 pr-4 font-semibold">สิทธิ์อนุมัติสัญญา</th>
                          <th className="py-2 pr-4 font-semibold">สิทธิ์ลบรายการ</th>
                          <th className="py-2 pr-4 font-semibold">ระงับสิทธิ์ (Disabled)</th>
                          <th className="py-2 text-right font-semibold">จัดการ</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {draftUsers.map((u, idx) => (
                          <tr key={u.email}>
                            <td className="py-2.5 pr-4 font-mono text-slate-900">{u.email}</td>
                            <td className="py-2.5 pr-4">
                              <select
                                value={u.role}
                                disabled={!isSuperAdmin}
                                onChange={(e) => {
                                  const role = e.target.value as UserRole;
                                  const defaults = getDefaultRoleCapabilities(role);
                                  setDraftUsers((prev) =>
                                    prev.map((item, i) =>
                                      i === idx
                                        ? {
                                            ...item,
                                            role,
                                            canOverrideAr: defaults.canOverrideAr,
                                            canApprove: defaults.canApprove,
                                            canDelete: defaults.canDelete,
                                          }
                                        : item
                                    )
                                  );
                                }}
                                className="rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                              >
                                {ALL_USER_ROLES.map((r) => (
                                  <option key={r} value={r}>
                                    {r}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="py-2.5 pr-4">
                              <input
                                type="checkbox"
                                checked={u.canOverrideAr}
                                disabled={!isSuperAdmin}
                                onChange={(e) =>
                                  setDraftUsers((prev) =>
                                    prev.map((item, i) =>
                                      i === idx ? { ...item, canOverrideAr: e.target.checked } : item
                                    )
                                  )
                                }
                              />
                            </td>
                            <td className="py-2.5 pr-4">
                              <input
                                type="checkbox"
                                checked={u.canApprove}
                                disabled={!isSuperAdmin}
                                onChange={(e) =>
                                  setDraftUsers((prev) =>
                                    prev.map((item, i) =>
                                      i === idx ? { ...item, canApprove: e.target.checked } : item
                                    )
                                  )
                                }
                              />
                            </td>
                            <td className="py-2.5 pr-4">
                              <input
                                type="checkbox"
                                checked={u.role === 'Super Admin' ? true : Boolean(u.canDelete)}
                                disabled={!isSuperAdmin || u.role === 'Super Admin'}
                                onChange={(e) =>
                                  setDraftUsers((prev) =>
                                    prev.map((item, i) =>
                                      i === idx ? { ...item, canDelete: e.target.checked } : item
                                    )
                                  )
                                }
                              />
                            </td>
                            <td className="py-2.5 pr-4">
                              <input
                                type="checkbox"
                                checked={Boolean(u.disabled)}
                                disabled={
                                  !isSuperAdmin ||
                                  (u.role === 'Super Admin' &&
                                    u.email.toLowerCase() ===
                                      (userProfile?.email || '').toLowerCase())
                                }
                                onChange={(e) =>
                                  setDraftUsers((prev) =>
                                    prev.map((item, i) =>
                                      i === idx ? { ...item, disabled: e.target.checked } : item
                                    )
                                  )
                                }
                              />
                            </td>
                            <td className="py-2.5 text-right">
                              {isSuperAdmin && draftUsers.length > 1 && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setDraftUsers((prev) => prev.filter((_, i) => i !== idx))
                                  }
                                  className="text-red-600 hover:text-red-800"
                                  aria-label="ลบผู้ใช้งาน"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {isSuperAdmin && (
                    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
                      <input
                        type="email"
                        value={newUserEmail}
                        onChange={(e) => setNewUserEmail(e.target.value)}
                        placeholder="user@company.com"
                        className="min-w-[220px] flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-900"
                      />
                      <select
                        value={newUserRole}
                        onChange={(e) => setNewUserRole(e.target.value as UserRole)}
                        className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs"
                      >
                        {ALL_USER_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={handleAddUser}
                        className="inline-flex items-center gap-1 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        เพิ่มผู้ใช้งาน
                      </button>
                    </div>
                  )}
                </div>

                {isSuperAdmin && (
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={handleSaveConfig}
                      disabled={busy}
                      className="whitespace-nowrap rounded-lg bg-[#0F2942] px-5 py-2.5 text-xs font-semibold text-white hover:bg-[#1E3A5F] disabled:opacity-50"
                    >
                      บันทึกการตั้งค่าระบบ
                    </button>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'apps_script' && (
              <div className="space-y-4 text-xs leading-relaxed text-slate-700">
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-5">
                  <h4 className="text-sm font-semibold text-slate-900">
                    ขั้นตอนการตั้งค่าและทดสอบฐานข้อมูลจริง (RHP_Restructuring_Database)
                  </h4>
                  <ol className="mt-3 list-decimal space-y-2 pl-5">
                    <li>
                      กดปุ่ม <strong>Sign in with Google</strong> เพื่อยืนยันตัวตนและอนุญาตการเข้าถึง Google
                      Sheets (โทเค็นจะถูกเก็บในหน่วยความจำชั่วคราวเท่านั้น ไม่เปิดเผย Secret Key ใน Frontend)
                    </li>
                    <li>
                      ไปที่แท็บ <strong>การเชื่อมต่อ Google Sheets</strong> แล้วกด{' '}
                      <strong>สร้าง / เชื่อมต่อ RHP_Restructuring_Database</strong> ระบบจะสร้างสเปรดชีตและชีตทั้ง 4
                      แท็บ (<code>Transaction_Records</code>, <code>Amortization_Schedule</code>,{' '}
                      <code>System_Configuration</code>, <code>Audit_Log</code>) ให้อัตโนมัติ
                    </li>
                    <li>
                      กดปุ่ม <strong>ทดสอบการเชื่อมต่อ</strong> เพื่อตรวจเช็ก Latency และยืนยันการอ่าน/เขียนทั้ง 4 ชีต
                    </li>
                    <li>
                      สร้างรายการปรับโครงสร้างในหน้า <strong>RHP Calculator</strong> แล้วกดบันทึก จากนั้นตรวจสอบแถวข้อมูลใน{' '}
                      <strong>Transaction Database</strong> และเปิดสเปรดชีต Google Sheets จริงเพื่อตรวจเทียบตัวเลข
                    </li>
                  </ol>
                </div>

                <div className="rounded-xl border border-slate-200 p-5">
                  <h4 className="text-sm font-semibold text-slate-900">
                    โครงสร้าง Google Apps Script อ้างอิง (กรณีต้องการ Deploy Script เสริมภายในองค์กร)
                  </h4>
                  <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-900 p-4 font-mono text-[11px] leading-relaxed text-slate-100">
                    {appsScriptSnippet}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

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
    </>
  );
}
