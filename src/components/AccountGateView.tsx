import { useEffect, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  KeyRound,
  LogOut,
  MailCheck,
  RefreshCw,
  Send,
  ShieldCheck,
  Smartphone,
} from 'lucide-react';
import {
  apiClient,
  type MfaEnrollInitResponse,
  type SessionStatusResponse,
} from '../services/apiClient.ts';
import { reloadFirebaseUserAndToken, resendVerificationEmail } from '../services/firebaseAuth.ts';

interface AccountGateViewProps {
  sessionStatus: SessionStatusResponse;
  onRefreshSession: () => Promise<void>;
  onLogout: () => Promise<void>;
}

export function AccountGateView({
  sessionStatus,
  onRefreshSession,
  onLogout,
}: AccountGateViewProps) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Registration / Resubmit request state
  const [displayName, setDisplayName] = useState(sessionStatus.displayName || '');
  const [department, setDepartment] = useState(sessionStatus.department || 'Risk Control Department');
  const [requestNote, setRequestNote] = useState(sessionStatus.requestNote || '');

  // Initial Super Admin Setup token state
  const [showInitialSetup, setShowInitialSetup] = useState(false);
  const [setupToken, setSetupToken] = useState('');

  // MFA enrollment & verification state
  const [mfaEnrollData, setMfaEnrollData] = useState<MfaEnrollInitResponse | null>(null);
  const [otpCode, setOtpCode] = useState('');

  useEffect(() => {
    setDisplayName(sessionStatus.displayName || '');
    if (sessionStatus.department) setDepartment(sessionStatus.department);
    if (sessionStatus.requestNote) setRequestNote(sessionStatus.requestNote);
  }, [sessionStatus.department, sessionStatus.displayName, sessionStatus.requestNote]);

  const needsMfaGate =
    sessionStatus.emailVerified &&
    sessionStatus.accountStatus === 'Approved' &&
    sessionStatus.mfaRequired &&
    !sessionStatus.mfaVerified;

  useEffect(() => {
    if (needsMfaGate && !sessionStatus.mfaEnrolled && !mfaEnrollData) {
      void (async () => {
        setBusy(true);
        setError(null);
        try {
          const data = await apiClient.initMfaEnrollment();
          setMfaEnrollData(data);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'ไม่สามารถสร้างรหัสตั้งค่า MFA ได้');
        } finally {
          setBusy(false);
        }
      })();
    }
  }, [needsMfaGate, sessionStatus.mfaEnrolled, mfaEnrollData]);

  const handleResendVerification = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await resendVerificationEmail();
      setNotice(`ส่งอีเมลยืนยันตัวตนไปยัง ${sessionStatus.email} อีกครั้งแล้ว กรุณาตรวจสอบ Inbox / Junk`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ไม่สามารถส่งลิงก์ยืนยันอีเมลได้');
    } finally {
      setBusy(false);
    }
  };

  const handleCheckVerificationAndStatus = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await reloadFirebaseUserAndToken();
      await onRefreshSession();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ไม่สามารถตรวจสอบสถานะล่าสุดได้');
    } finally {
      setBusy(false);
    }
  };

  const handleSubmitRegistrationRequest = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiClient.registerRequest({
        displayName: displayName.trim() || sessionStatus.email,
        department: department.trim(),
        requestNote: requestNote.trim(),
      });
      setNotice('ส่งคำขอเข้าใช้งานระบบเรียบร้อยแล้ว กรุณารอ Super Admin ตรวจสอบและอนุมัติ');
      await onRefreshSession();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ไม่สามารถส่งคำขอเข้าใช้งานได้');
    } finally {
      setBusy(false);
    }
  };

  const handleInitialAdminSetup = async (e: FormEvent) => {
    e.preventDefault();
    if (!setupToken.trim()) {
      setError('กรุณาระบุ One-Time Setup Token ที่ได้จาก Backend Console');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await reloadFirebaseUserAndToken();
      await apiClient.submitInitialAdminSetup({
        setupToken: setupToken.trim(),
        displayName: displayName.trim() || sessionStatus.email,
      });
      setNotice('แต่งตั้ง Super Admin หลักสำเร็จแล้ว กรุณาตั้งค่า MFA เพื่อเข้าสู่ระบบ');
      setSetupToken('');
      setShowInitialSetup(false);
      await onRefreshSession();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ไม่สามารถตั้งค่า Initial Super Admin ได้');
    } finally {
      setBusy(false);
    }
  };

  const handleVerifyMfa = async (e: FormEvent) => {
    e.preventDefault();
    const cleaned = otpCode.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(cleaned)) {
      setError('กรุณากรอกรหัส OTP ตัวเลข 6 หลักจากแอป Authenticator');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiClient.verifyMfaCode({
        code: cleaned,
        mode: sessionStatus.mfaEnrolled ? 'login' : 'enroll',
      });
      setOtpCode('');
      await onRefreshSession();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'รหัส MFA ไม่ถูกต้อง');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-slate-100 text-slate-900">
      <header className="border-b border-slate-200 bg-[#0F2942] px-6 py-3.5 text-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/10 font-mono text-xs font-bold text-white">
              MS
            </div>
            <div>
              <p className="text-sm font-bold tracking-wide text-white">MAX SANY RHP PORTAL</p>
              <p className="text-[11px] text-slate-300">BY RISK CONTROL DEPARTMENT</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void onLogout()}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-white/25 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/20"
          >
            <LogOut className="h-3.5 w-3.5" />
            ออกจากระบบ
          </button>
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center p-4 sm:p-8">
        <div className="w-full max-w-2xl space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
          {/* Identity Summary Header */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                บัญชีผู้ใช้งานที่ลงชื่อเข้าใช้ (Authenticated Identity)
              </p>
              <p className="mt-1 font-mono text-sm font-bold text-[#0F2942]">{sessionStatus.email}</p>
            </div>
            <div className="text-right text-xs">
              <p className="text-slate-500">สถานะบัญชีปัจจุบัน</p>
              <p className="font-semibold text-slate-900">
                {needsMfaGate
                  ? `${sessionStatus.role} · รอยืนยัน MFA`
                  : sessionStatus.accountStatus}
              </p>
            </div>
          </div>

          {notice && (
            <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3.5 text-xs text-emerald-900">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
              <span>{notice}</span>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3.5 text-xs text-red-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
              <span>{error}</span>
            </div>
          )}

          {/* 1. Email Not Verified Gate */}
          {!sessionStatus.emailVerified && (
            <div className="space-y-4">
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">
                <div className="flex items-start gap-3">
                  <MailCheck className="mt-0.5 h-5 w-5 shrink-0 text-amber-800" />
                  <div className="space-y-1.5 text-xs">
                    <h2 className="text-base font-bold text-amber-950">
                      ขั้นตอนที่ 1: กรุณายืนยันความเป็นเจ้าของอีเมล (Email Verification Required)
                    </h2>
                    <p className="leading-relaxed text-amber-900">
                      ระบบได้ส่งลิงก์ยืนยันตัวตนไปยังอีเมล <span className="font-mono font-semibold">{sessionStatus.email}</span> แล้ว
                      กรุณาเปิดอีเมลและคลิกลิงก์ยืนยันให้เรียบร้อย ก่อนกดปุ่มตรวจสอบสถานะด้านล่าง
                    </p>
                    <p className="text-[11px] text-amber-800">
                      * การกรอกอีเมลเพียงอย่างเดียวจะยังไม่สามารถเข้าใช้งานหรือขออนุมัติสิทธิ์ได้จนกว่าจะยืนยันอีเมลสำเร็จ
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void handleCheckVerificationAndStatus()}
                  disabled={busy}
                  className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg bg-[#0F2942] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#1E3A5F] disabled:opacity-50"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
                  ฉันยืนยันอีเมลแล้ว — ตรวจสอบสถานะ
                </button>
                <button
                  type="button"
                  onClick={() => void handleResendVerification()}
                  disabled={busy}
                  className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  <Send className="h-3.5 w-3.5" />
                  ส่งลิงก์ยืนยันอีเมลอีกครั้ง
                </button>
              </div>
            </div>
          )}

          {/* 2. Verified Email but Unregistered -> Submit Request for Super Admin Approval */}
          {sessionStatus.emailVerified && !sessionStatus.registered && (
            <div className="space-y-4">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs">
                <p className="font-bold text-slate-900">
                  ยืนยันอีเมลสำเร็จ — กรุณาส่งคำขอรับสิทธิ์เข้าใช้งานถึง Super Admin
                </p>
                <p className="mt-1 leading-relaxed text-slate-600">
                  การยืนยันอีเมลเป็นการยืนยันความเป็นเจ้าของบัญชีเท่านั้น ท่านต้องส่งคำขอและรอ Super Admin ตรวจสอบอนุมัติพร้อมกำหนดบทบาท (Role) ก่อนเข้าถึงระบบ
                </p>
              </div>

              <form onSubmit={(e) => void handleSubmitRegistrationRequest(e)} className="space-y-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">
                      ชื่อ-นามสกุล (Display Name)
                    </label>
                    <input
                      type="text"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      required
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">
                      หน่วยงาน / แผนก
                    </label>
                    <input
                      type="text"
                      value={department}
                      onChange={(e) => setDepartment(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    หมายเหตุ / รายละเอียดการขอสิทธิ์ถึง Super Admin
                  </label>
                  <input
                    type="text"
                    value={requestNote}
                    onChange={(e) => setRequestNote(e.target.value)}
                    placeholder="ระบุหน้าที่ความรับผิดชอบ หรือเหตุผลในการขอใช้งานระบบ"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900"
                  />
                </div>
                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg bg-[#0F2942] px-5 py-2.5 text-xs font-semibold text-white hover:bg-[#1E3A5F] disabled:opacity-50"
                >
                  <Send className="h-3.5 w-3.5" />
                  ส่งคำขออนุมัติสิทธิ์เข้าใช้งาน
                </button>
              </form>
            </div>
          )}

          {/* 3. Pending Approval Gate */}
          {sessionStatus.emailVerified &&
            sessionStatus.registered &&
            sessionStatus.accountStatus === 'Pending Approval' && (
              <div className="space-y-4">
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">
                  <div className="flex items-start gap-3">
                    <Clock className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
                    <div className="space-y-1.5 text-xs">
                      <h2 className="text-base font-bold text-amber-950">
                        บัญชีอยู่ระหว่างรอ Super Admin ตรวจสอบและอนุมัติ (Pending Approval)
                      </h2>
                      <p className="leading-relaxed text-amber-900">
                        ระบบได้บันทึกคำขอและยืนยันอีเมลของท่านเรียบร้อยแล้ว ขณะนี้รอให้ Super Admin ตรวจสอบและกำหนดบทบาท (Role) ให้ท่านก่อนเข้าใช้งานระบบ
                      </p>
                      <div className="mt-2 grid grid-cols-1 gap-1 pt-2 font-mono text-[11px] text-amber-900 sm:grid-cols-2">
                        <span>วันที่ลงทะเบียน: {sessionStatus.registeredAt || '-'}</span>
                        <span>วันที่ยืนยันอีเมล: {sessionStatus.emailVerifiedAt || '-'}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => void handleCheckVerificationAndStatus()}
                  disabled={busy}
                  className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} />
                  ตรวจสอบผลการอนุมัติล่าสุด
                </button>
              </div>
            )}

          {/* 4. Rejected Gate */}
          {sessionStatus.emailVerified &&
            sessionStatus.registered &&
            sessionStatus.accountStatus === 'Rejected' && (
              <div className="space-y-4">
                <div className="rounded-xl border border-red-200 bg-red-50 p-5">
                  <div className="flex items-start gap-3">
                    <Ban className="mt-0.5 h-5 w-5 shrink-0 text-red-700" />
                    <div className="space-y-1.5 text-xs">
                      <h2 className="text-base font-bold text-red-950">
                        คำขอเข้าใช้งานถูกปฏิเสธ (Rejected)
                      </h2>
                      <p className="text-red-900">
                        หมายเหตุจากผู้ดูแลระบบ:{' '}
                        <span className="font-semibold">
                          {sessionStatus.reviewNote || 'ไม่ได้ระบุหมายเหตุ'}
                        </span>
                      </p>
                      {sessionStatus.reviewedBy && (
                        <p className="font-mono text-[11px] text-red-700">
                          ตรวจสอบโดย: {sessionStatus.reviewedBy} ({sessionStatus.reviewedAt || '-'})
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                <form onSubmit={(e) => void handleSubmitRegistrationRequest(e)} className="space-y-3 rounded-lg border border-slate-200 p-4">
                  <p className="text-xs font-semibold text-slate-800">ส่งคำขอพิจารณาใหม่อีกครั้ง</p>
                  <input
                    type="text"
                    value={requestNote}
                    onChange={(e) => setRequestNote(e.target.value)}
                    placeholder="ระบุข้อมูลเพิ่มเติมหรือเหตุผลการขอสิทธิ์ใหม่..."
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900"
                  />
                  <button
                    type="submit"
                    disabled={busy}
                    className="inline-flex items-center gap-2 whitespace-nowrap rounded-lg bg-[#0F2942] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1E3A5F] disabled:opacity-50"
                  >
                    <Send className="h-3.5 w-3.5" />
                    ส่งคำขออนุมัติใหม่
                  </button>
                </form>
              </div>
            )}

          {/* 5. Suspended Gate */}
          {sessionStatus.emailVerified &&
            sessionStatus.registered &&
            sessionStatus.accountStatus === 'Suspended' && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-5">
                <div className="flex items-start gap-3">
                  <Ban className="mt-0.5 h-5 w-5 shrink-0 text-red-700" />
                  <div className="space-y-1.5 text-xs">
                    <h2 className="text-base font-bold text-red-950">
                      บัญชีผู้ใช้งานถูกระงับสิทธิ์ชั่วคราว (Suspended)
                    </h2>
                    <p className="text-red-900">
                      หมายเหตุ: {sessionStatus.reviewNote || 'ถูกระงับสิทธิ์โดย Super Admin'}
                    </p>
                    <p className="text-[11px] text-red-800">
                      กรุณาติดต่อ Super Admin ของฝ่าย Risk Control หากต้องการเปิดใช้งานบัญชีนี้อีกครั้ง
                    </p>
                  </div>
                </div>
              </div>
            )}

          {/* 6. Mandatory MFA Gate for Super Admin & Approver */}
          {needsMfaGate && (
            <div className="space-y-4">
              <div className="rounded-xl border border-[#0F2942]/20 bg-slate-50 p-5">
                <div className="flex items-start gap-3">
                  <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-[#0F2942]" />
                  <div className="space-y-1 text-xs">
                    <h2 className="text-base font-bold text-[#0F2942]">
                      {sessionStatus.mfaEnrolled
                        ? 'ยืนยันตัวตนขั้นที่ 2 (MFA Verification)'
                        : 'ตั้งค่า MFA ครั้งแรกสำหรับบัญชีที่มีสิทธิ์ระดับสูง'}
                    </h2>
                    <p className="leading-relaxed text-slate-600">
                      บทบาท <span className="font-semibold text-slate-900">{sessionStatus.role}</span>{' '}
                      บังคับใช้ Multi-Factor Authentication (TOTP Authenticator) ก่อนเข้าถึงข้อมูลและอนุมัติสัญญา
                    </p>
                  </div>
                </div>
              </div>

              {!sessionStatus.mfaEnrolled && mfaEnrollData && (
                <div className="grid grid-cols-1 items-center gap-5 rounded-xl border border-slate-200 p-4 sm:grid-cols-12">
                  <div className="flex justify-center sm:col-span-5">
                    <img
                      src={mfaEnrollData.qrCodeDataUrl}
                      alt="MFA QR Code"
                      className="h-44 w-44 rounded-lg border border-slate-200 bg-white p-2"
                    />
                  </div>
                  <div className="space-y-2.5 text-xs sm:col-span-7">
                    <div className="flex items-center gap-1.5 font-semibold text-slate-900">
                      <Smartphone className="h-4 w-4 text-[#0F2942]" />
                      <span>สแกน QR Code ด้วย Google Authenticator / Microsoft Authenticator</span>
                    </div>
                    <p className="text-slate-600">
                      หรือกรอกรหัส Secret Key ด้านล่างในแอป Authenticator ด้วยตนเอง:
                    </p>
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5 font-mono text-[11px] font-bold break-all text-[#0F2942]">
                      {mfaEnrollData.secretBase32}
                    </div>
                  </div>
                </div>
              )}

              <form onSubmit={(e) => void handleVerifyMfa(e)} className="space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    กรอกรหัส 6 หลักจากแอป Authenticator
                  </label>
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-4 py-2.5 text-center font-mono text-lg font-bold tracking-[0.35em] text-[#0F2942] tabular-nums focus:border-[#0F2942] focus:outline-none"
                  />
                </div>
                <button
                  type="submit"
                  disabled={busy || otpCode.length !== 6}
                  className="w-full whitespace-nowrap rounded-lg bg-[#0F2942] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#1E3A5F] disabled:opacity-50"
                >
                  {busy
                    ? 'กำลังตรวจสอบรหัส MFA...'
                    : sessionStatus.mfaEnrolled
                      ? 'ยืนยันรหัส MFA เพื่อเข้าสู่ระบบ'
                      : 'ยืนยันการเปิดใช้งาน MFA และเข้าสู่ระบบ'}
                </button>
              </form>
            </div>
          )}

          {/* Optional Initial Super Admin Bootstrap Box (ONLY visible if no Super Admin exists AND email is verified) */}
          {sessionStatus.initialSetupRequired &&
            sessionStatus.emailVerified &&
            sessionStatus.accountStatus !== 'Approved' && (
              <div className="border-t border-slate-200 pt-4">
                <button
                  type="button"
                  onClick={() => setShowInitialSetup((prev) => !prev)}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-800 hover:underline"
                >
                  <KeyRound className="h-3.5 w-3.5" />
                  {showInitialSetup
                    ? 'ซ่อนแบบฟอร์ม Initial Super Admin Setup'
                    : 'ตั้งค่าบัญชีนี้เป็น Super Admin หลักครั้งแรก (Initial Super Admin Setup)'}
                </button>

                {showInitialSetup && (
                  <form
                    onSubmit={(e) => void handleInitialAdminSetup(e)}
                    className="mt-3 space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-4"
                  >
                    <p className="text-xs leading-relaxed text-amber-950">
                      ใช้สำหรับกำหนด Super Admin หลักคนแรกของระบบเท่านั้น (ใช้งานได้ 1 ครั้งและปิดถาวรอัตโนมัติ) กรุณากรอก One-Time Setup Token ที่แสดงใน Server Log ของ Backend
                    </p>
                    <div>
                      <label className="block text-xs font-semibold text-amber-950">
                        One-Time Setup Token
                      </label>
                      <input
                        type="password"
                        value={setupToken}
                        onChange={(e) => setSetupToken(e.target.value)}
                        placeholder="วาง Setup Token จาก Backend Console..."
                        className="mt-1 w-full rounded-lg border border-amber-300 bg-white px-3 py-2 font-mono text-xs text-slate-900"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={busy || !setupToken.trim()}
                      className="whitespace-nowrap rounded-lg bg-amber-800 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-900 disabled:opacity-50"
                    >
                      ยืนยันและแต่งตั้ง Super Admin หลัก
                    </button>
                  </form>
                )}
              </div>
            )}
        </div>
      </main>
    </div>
  );
}
