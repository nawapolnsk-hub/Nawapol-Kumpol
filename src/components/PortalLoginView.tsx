import { useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  KeyRound,
  Lock,
  Mail,
  ShieldAlert,
  ShieldCheck,
  UserPlus,
} from 'lucide-react';
import { GoogleSignInButton } from './GoogleSignInButton.tsx';

interface PortalLoginViewProps {
  companyLogoDataUrl?: string | null;
  companyName?: string;
  initialSetupRequired?: boolean;
  authLoading: boolean;
  authError: string | null;
  onGoogleSignIn: () => Promise<void>;
  onEmailSignIn: (email: string, password: string) => Promise<void>;
  onEmailRegister: (payload: {
    email: string;
    password: string;
    displayName: string;
    department: string;
    requestNote: string;
  }) => Promise<void>;
  onGoogleRegister: (payload: {
    department: string;
    requestNote: string;
  }) => Promise<void>;
  onPasswordReset: (email: string) => Promise<void>;
  onDismissError: () => void;
}

type AuthTab = 'signin' | 'register' | 'initial-setup';

export function PortalLoginView({
  companyLogoDataUrl,
  companyName,
  initialSetupRequired = false,
  authLoading,
  authError,
  onGoogleSignIn,
  onEmailSignIn,
  onEmailRegister,
  onGoogleRegister,
  onPasswordReset,
  onDismissError,
}: PortalLoginViewProps) {
  const [tab, setTab] = useState<AuthTab>('signin');
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [forgotMode, setForgotMode] = useState(false);
  const [localNotice, setLocalNotice] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  // Registration form fields (no pre-allowlist or domain restriction)
  const [regDisplayName, setRegDisplayName] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regDepartment, setRegDepartment] = useState('Risk Control Department');
  const [regRequestNote, setRegRequestNote] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regConfirmPassword, setRegConfirmPassword] = useState('');

  const activeError = localError || authError;

  const handleTabSwitch = (nextTab: AuthTab) => {
    setTab(nextTab);
    setForgotMode(false);
    setLocalError(null);
    setLocalNotice(null);
    onDismissError();
  };

  const handleEmailSignInSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    setLocalNotice(null);
    onDismissError();

    if (forgotMode) {
      if (!loginEmail.trim() || !loginEmail.includes('@')) {
        setLocalError('กรุณากรอกอีเมลที่ต้องการรีเซ็ตรหัสผ่าน');
        return;
      }
      try {
        await onPasswordReset(loginEmail.trim());
        setLocalNotice(`ส่งลิงก์สำหรับตั้งรหัสผ่านใหม่ไปยัง ${loginEmail.trim()} เรียบร้อยแล้ว`);
        setForgotMode(false);
      } catch (err) {
        setLocalError(err instanceof Error ? err.message : 'ไม่สามารถส่งอีเมลรีเซ็ตรหัสผ่านได้');
      }
      return;
    }

    if (!loginEmail.trim() || !loginPassword) {
      setLocalError('กรุณากรอกอีเมลและรหัสผ่านให้ครบถ้วน');
      return;
    }

    await onEmailSignIn(loginEmail.trim(), loginPassword);
  };

  const handleRegisterSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    setLocalNotice(null);
    onDismissError();

    const email = regEmail.trim().toLowerCase();
    const displayName = regDisplayName.trim();
    if (!displayName) {
      setLocalError('กรุณากรอกชื่อ-นามสกุลผู้ขอสิทธิ์เข้าใช้งาน');
      return;
    }
    if (!email || !email.includes('@')) {
      setLocalError('กรุณากรอกอีเมลให้ถูกต้อง');
      return;
    }
    if (regPassword.length < 8) {
      setLocalError('รหัสผ่านต้องมีความยาวอย่างน้อย 8 ตัวอักษร');
      return;
    }
    if (regPassword !== regConfirmPassword) {
      setLocalError('รหัสผ่านและการยืนยันรหัสผ่านไม่ตรงกัน');
      return;
    }

    await onEmailRegister({
      email,
      password: regPassword,
      displayName,
      department: regDepartment.trim(),
      requestNote: regRequestNote.trim(),
    });
  };

  return (
    <div className="flex min-h-screen flex-col bg-slate-100 text-slate-900">
      {/* Top Corporate Strip */}
      <header className="border-b border-slate-200 bg-[#0F2942] px-6 py-3.5 text-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/10 font-mono text-xs font-bold tracking-wider text-white">
              MS
            </div>
            <div>
              <p className="text-sm font-bold tracking-wide text-white">MAX SANY RHP PORTAL</p>
              <p className="text-[11px] text-slate-300">BY RISK CONTROL DEPARTMENT</p>
            </div>
          </div>
          <span className="hidden text-xs font-medium text-slate-200 sm:inline">
            Secure Internal Management System
          </span>
        </div>
      </header>

      {/* Main Centered Two-Column Institutional Portal Card */}
      <main className="flex flex-1 items-center justify-center p-4 sm:p-8">
        <div className="grid w-full max-w-5xl grid-cols-1 items-stretch overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm lg:grid-cols-12">
          {/* Left Panel: Corporate Identity & Security Mandate */}
          <div className="flex flex-col justify-between bg-[#0F2942] p-8 text-white sm:p-10 lg:col-span-6">
            <div className="space-y-6">
              <div className="flex items-center gap-4">
                {companyLogoDataUrl ? (
                  <img
                    src={companyLogoDataUrl}
                    alt="MAX SANY Logo"
                    referrerPolicy="no-referrer"
                    className="h-14 w-14 rounded-lg border border-white/20 bg-white object-contain p-1.5"
                  />
                ) : (
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg border border-white/20 bg-white/10">
                    <Building2 className="h-7 w-7 text-white" />
                  </div>
                )}
                <div>
                  <p className="text-xs font-semibold tracking-widest text-slate-300">MAX SANY</p>
                  <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
                    RHP PORTAL
                  </h1>
                </div>
              </div>

              <div className="space-y-2 border-t border-white/15 pt-6">
                <h2 className="text-lg font-semibold leading-snug text-white sm:text-xl">
                  ระบบคำนวณและบริหารจัดการสัญญาปรับโครงสร้างหนี้
                </h2>
                <p className="text-sm leading-relaxed text-slate-200">
                  Restructuring Hire Purchase Calculation &amp; Contract Management System
                </p>
              </div>

              <div className="space-y-1 text-xs text-slate-300">
                <p className="font-semibold tracking-wider text-white">
                  BY RISK CONTROL DEPARTMENT
                </p>
                <p>Secure Internal Management System</p>
                {companyName && <p className="pt-1 text-slate-300">{companyName}</p>}
              </div>

              {/* Verification & Approval Governance Rules */}
              <div className="space-y-2 rounded-lg border border-white/15 bg-white/5 p-4 text-xs text-slate-200">
                <p className="font-semibold text-white">หลักเกณฑ์การเข้าถึงระบบ (Access Governance)</p>
                <ol className="list-inside list-decimal space-y-1 text-[11px] leading-relaxed text-slate-300">
                  <li>สมัครด้วยอีเมลใดก็ได้ที่ใช้งานจริง (Email/Password หรือ Google)</li>
                  <li>ยืนยันความเป็นเจ้าของอีเมลผ่าน Verification Link</li>
                  <li>รอ Super Admin ตรวจสอบและอนุมัติพร้อมกำหนด Role ก่อนเข้าใช้งาน</li>
                  <li>บัญชีระดับ Super Admin และ Approver ต้องยืนยันตัวตนด้วย MFA</li>
                </ol>
              </div>
            </div>

            <div className="mt-8 border-t border-white/15 pt-5 text-xs leading-relaxed text-slate-300">
              <p>
                เครื่องมือภายในองค์กรสำหรับคำนวณ วิเคราะห์ จัดทำสัญญาปรับโครงสร้างหนี้เช่าซื้อเครื่องจักร
                ออกเอกสารทางการ PDF และจัดเก็บข้อมูลบนฐานข้อมูลกลาง Google Sheets ภายใต้การควบคุมสิทธิ์ RBAC
              </p>
            </div>
          </div>

          {/* Right Panel: Sign-In, Registration, and Initial Setup */}
          <div className="flex flex-col justify-between bg-white p-7 sm:p-9 lg:col-span-6">
            <div className="space-y-5">
              {/* Navigation Tabs */}
              <div className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-100 p-1">
                <button
                  type="button"
                  onClick={() => handleTabSwitch('signin')}
                  className={`flex-1 whitespace-nowrap rounded-md px-3 py-2 text-xs font-semibold transition-colors ${
                    tab === 'signin'
                      ? 'bg-white text-[#0F2942] shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  เข้าสู่ระบบ (Sign In)
                </button>
                <button
                  type="button"
                  onClick={() => handleTabSwitch('register')}
                  className={`flex-1 whitespace-nowrap rounded-md px-3 py-2 text-xs font-semibold transition-colors ${
                    tab === 'register'
                      ? 'bg-white text-[#0F2942] shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  สมัครขอสิทธิ์ใช้งาน
                </button>
                {initialSetupRequired && (
                  <button
                    type="button"
                    onClick={() => handleTabSwitch('initial-setup')}
                    className={`whitespace-nowrap rounded-md px-3 py-2 text-xs font-semibold transition-colors ${
                      tab === 'initial-setup'
                        ? 'bg-amber-700 text-white shadow-sm'
                        : 'text-amber-800 hover:bg-amber-100'
                    }`}
                  >
                    Initial Setup
                  </button>
                )}
              </div>

              {localNotice && (
                <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
                  <span>{localNotice}</span>
                </div>
              )}

              {activeError && (
                <div
                  role="alert"
                  className="flex items-start justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-3.5 text-xs text-red-800"
                >
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
                    <span className="leading-relaxed">{activeError}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setLocalError(null);
                      onDismissError();
                    }}
                    className="shrink-0 font-semibold text-red-700 hover:underline"
                  >
                    ปิด
                  </button>
                </div>
              )}

              {tab === 'signin' && (
                <div className="space-y-4">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-semibold text-[#0F2942]">
                      <Lock className="h-4 w-4" />
                      <span>ยืนยันตัวตนเข้าสู่ระบบภายในองค์กร</span>
                    </div>
                    <h3 className="mt-1.5 text-lg font-bold text-slate-900">
                      เข้าสู่ระบบ MAX SANY RHP PORTAL
                    </h3>
                    <p className="mt-1 text-xs leading-relaxed text-slate-600">
                      ลงชื่อเข้าใช้ด้วยบัญชีที่ผ่านการยืนยันอีเมลและได้รับอนุมัติสิทธิ์จาก Super Admin แล้วเท่านั้น
                    </p>
                  </div>

                  <form onSubmit={(e) => void handleEmailSignInSubmit(e)} className="space-y-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700">
                        อีเมล (Email)
                      </label>
                      <div className="relative mt-1">
                        <Mail className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-slate-400" />
                        <input
                          type="email"
                          autoComplete="email"
                          value={loginEmail}
                          onChange={(e) => setLoginEmail(e.target.value)}
                          placeholder="name@example.com"
                          className="w-full rounded-lg border border-slate-300 py-2 pr-3 pl-9 text-xs text-slate-900 focus:border-[#0F2942] focus:outline-none"
                        />
                      </div>
                    </div>

                    {!forgotMode && (
                      <div>
                        <div className="flex items-center justify-between">
                          <label className="block text-xs font-semibold text-slate-700">
                            รหัสผ่าน (Password)
                          </label>
                          <button
                            type="button"
                            onClick={() => {
                              setForgotMode(true);
                              setLocalError(null);
                              setLocalNotice(null);
                            }}
                            className="text-[11px] font-medium text-[#0F2942] hover:underline"
                          >
                            ลืมรหัสผ่าน?
                          </button>
                        </div>
                        <input
                          type="password"
                          autoComplete="current-password"
                          value={loginPassword}
                          onChange={(e) => setLoginPassword(e.target.value)}
                          placeholder="ระบุรหัสผ่านของท่าน"
                          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900 focus:border-[#0F2942] focus:outline-none"
                        />
                      </div>
                    )}

                    <div className="flex items-center gap-2 pt-1">
                      <button
                        type="submit"
                        disabled={authLoading}
                        className="flex-1 whitespace-nowrap rounded-lg bg-[#0F2942] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#1E3A5F] disabled:opacity-50"
                      >
                        {authLoading
                          ? 'กำลังดำเนินการ...'
                          : forgotMode
                            ? 'ส่งลิงก์ตั้งรหัสผ่านใหม่'
                            : 'เข้าสู่ระบบด้วยอีเมล'}
                      </button>
                      {forgotMode && (
                        <button
                          type="button"
                          onClick={() => setForgotMode(false)}
                          className="whitespace-nowrap rounded-lg border border-slate-300 px-3 py-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          ยกเลิก
                        </button>
                      )}
                    </div>
                  </form>

                  <div className="relative flex items-center py-1">
                    <div className="flex-grow border-t border-slate-200" />
                    <span className="mx-3 shrink-0 text-[11px] font-medium text-slate-400">
                      หรือเข้าสู่ระบบด้วย Google
                    </span>
                    <div className="flex-grow border-t border-slate-200" />
                  </div>

                  <GoogleSignInButton
                    onClick={() => void onGoogleSignIn()}
                    disabled={authLoading}
                    label={
                      authLoading
                        ? 'กำลังยืนยันตัวตนเข้าสู่ระบบ...'
                        : 'Sign in with Google'
                    }
                  />

                  <div className="rounded-lg border border-amber-300 bg-amber-50 p-3.5">
                    <div className="flex items-start gap-2">
                      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-800" />
                      <p className="text-[11px] leading-relaxed text-amber-950">
                        <span className="font-bold">AUTHORIZED PERSONNEL ONLY:</span>{' '}
                        การลงชื่อเข้าใช้โดยยังไม่ได้รับอนุมัติจาก Super Admin จะยังไม่สามารถเข้าถึงข้อมูล Dashboard, ฐานข้อมูลสัญญา, Google Sheets หรือส่งออก PDF ได้
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {tab === 'register' && (
                <div className="space-y-4">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-semibold text-[#0F2942]">
                      <UserPlus className="h-4 w-4" />
                      <span>ลงทะเบียนขอสิทธิ์เข้าใช้งานระบบ</span>
                    </div>
                    <h3 className="mt-1.5 text-lg font-bold text-slate-900">
                      สมัครสมาชิกและขออนุมัติสิทธิ์
                    </h3>
                    <p className="mt-1 text-xs leading-relaxed text-slate-600">
                      สามารถใช้ Email ใดก็ได้ในการสมัคร จากนั้นระบบจะส่งลิงก์ยืนยันอีเมลและส่งคำขอให้ Super Admin ตรวจสอบอนุมัติและกำหนดบทบาท (Role)
                    </p>
                  </div>

                  <form onSubmit={(e) => void handleRegisterSubmit(e)} className="space-y-3">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div>
                        <label className="block text-xs font-semibold text-slate-700">
                          ชื่อ-นามสกุล (Full Name) <span className="text-red-600">*</span>
                        </label>
                        <input
                          type="text"
                          value={regDisplayName}
                          onChange={(e) => setRegDisplayName(e.target.value)}
                          placeholder="เช่น สมชาย ใจดี"
                          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900 focus:border-[#0F2942] focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-700">
                          แผนก / หน่วยงาน (Department)
                        </label>
                        <input
                          type="text"
                          value={regDepartment}
                          onChange={(e) => setRegDepartment(e.target.value)}
                          placeholder="เช่น Risk Control"
                          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900 focus:border-[#0F2942] focus:outline-none"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-slate-700">
                        อีเมลสำหรับใช้งาน (Any valid email) <span className="text-red-600">*</span>
                      </label>
                      <input
                        type="email"
                        autoComplete="email"
                        value={regEmail}
                        onChange={(e) => setRegEmail(e.target.value)}
                        placeholder="user@domain.com"
                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900 focus:border-[#0F2942] focus:outline-none"
                      />
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div>
                        <label className="block text-xs font-semibold text-slate-700">
                          รหัสผ่าน (อย่างน้อย 8 ตัวอักษร) <span className="text-red-600">*</span>
                        </label>
                        <input
                          type="password"
                          autoComplete="new-password"
                          value={regPassword}
                          onChange={(e) => setRegPassword(e.target.value)}
                          placeholder="ตั้งรหัสผ่าน"
                          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900 focus:border-[#0F2942] focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-700">
                          ยืนยันรหัสผ่าน <span className="text-red-600">*</span>
                        </label>
                        <input
                          type="password"
                          autoComplete="new-password"
                          value={regConfirmPassword}
                          onChange={(e) => setRegConfirmPassword(e.target.value)}
                          placeholder="กรอกรหัสผ่านอีกครั้ง"
                          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900 focus:border-[#0F2942] focus:outline-none"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-slate-700">
                        เหตุผล / บทบาทที่ขอใช้งาน (หมายเหตุถึง Super Admin)
                      </label>
                      <input
                        type="text"
                        value={regRequestNote}
                        onChange={(e) => setRegRequestNote(e.target.value)}
                        placeholder="เช่น เจ้าหน้าที่ฝ่าย Risk Control ขอสิทธิ์จัดทำสัญญา RHP"
                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900 focus:border-[#0F2942] focus:outline-none"
                      />
                    </div>

                    <button
                      type="submit"
                      disabled={authLoading}
                      className="w-full whitespace-nowrap rounded-lg bg-[#0F2942] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#1E3A5F] disabled:opacity-50"
                    >
                      {authLoading
                        ? 'กำลังลงทะเบียนและส่งลิงก์ยืนยันอีเมล...'
                        : 'สมัครสมาชิกและส่งลิงก์ยืนยันอีเมล'}
                    </button>
                  </form>

                  <div className="relative flex items-center py-0.5">
                    <div className="flex-grow border-t border-slate-200" />
                    <span className="mx-3 shrink-0 text-[11px] font-medium text-slate-400">
                      หรือขอสิทธิ์ด้วยบัญชี Google
                    </span>
                    <div className="flex-grow border-t border-slate-200" />
                  </div>

                  <GoogleSignInButton
                    onClick={() =>
                      void onGoogleRegister({
                        department: regDepartment.trim(),
                        requestNote: regRequestNote.trim(),
                      })
                    }
                    disabled={authLoading}
                    label="Continue with Google เพื่อส่งคำขออนุมัติ"
                  />
                </div>
              )}

              {tab === 'initial-setup' && initialSetupRequired && (
                <div className="space-y-4">
                  <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
                    <div className="flex items-start gap-2.5">
                      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-800" />
                      <div className="space-y-1 text-xs">
                        <p className="font-bold text-amber-950">
                          Initial Super Admin Setup (ใช้งานได้เพียงครั้งเดียว)
                        </p>
                        <p className="leading-relaxed text-amber-900">
                          ระบบตรวจพบว่ายังไม่มี Super Admin หลักในระบบ กรุณายืนยันตัวตนด้วยบัญชีของคุณก่อน (เข้าสู่ระบบด้วย Google หรือสมัครด้วย Email แล้วกดยืนยันลิงก์ในกล่องจดหมาย) จากนั้นระบบจะแสดงช่องกรอก One-Time Setup Token ที่ได้จาก Backend Console เพื่อแต่งตั้ง Super Admin คนแรก และปิดหน้าจอนี้ถาวรทันที
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2.5">
                    <div className="flex items-center gap-2 text-xs font-semibold text-slate-800">
                      <KeyRound className="h-4 w-4 text-[#0F2942]" />
                      <span>ขั้นตอนที่ 1: ยืนยันตัวตนบัญชีที่จะเป็น Super Admin หลัก</span>
                    </div>
                    <GoogleSignInButton
                      onClick={() => void onGoogleSignIn()}
                      disabled={authLoading}
                      label="ยืนยันตัวตนด้วย Google เพื่อตั้งค่า Super Admin"
                    />
                    <button
                      type="button"
                      onClick={() => handleTabSwitch('register')}
                      className="w-full rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50"
                    >
                      หรือสมัครด้วย Email / Password ก่อนรับ Token
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="mt-6 border-t border-slate-200 pt-4 text-[11px] text-slate-500">
              <p className="font-semibold text-slate-700">MAX SANY RHP PORTAL</p>
              <p>ระบบคำนวณและบริหารจัดการสัญญาปรับโครงสร้างหนี้ · Risk Control Department</p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
