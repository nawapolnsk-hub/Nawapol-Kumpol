import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  History,
  KeyRound,
  RefreshCw,
  RotateCcw,
  Shield,
  UserCheck,
  X,
} from 'lucide-react';
import { apiClient, type UserAuthProfile } from '../services/apiClient.ts';
import {
  ALL_USER_ROLES,
  type AuditLogEntry,
  type UserPermissionEntry,
  type UserRole,
} from '../types/rhp.ts';

interface UserApprovalCenterViewProps {
  userProfile: UserAuthProfile | null;
  onUsersUpdated?: () => Promise<void>;
}

type FilterTab = 'pending' | 'all' | 'approved' | 'rejected_suspended' | 'audit';

const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  'Super Admin': 'สิทธิ์สูงสุด: อนุมัติผู้ใช้, กำหนด Role, ตั้งค่า Google Sheets, จัดการระบบทั้งหมด (บังคับ MFA)',
  'Risk Control': 'สร้าง/คำนวณ/บันทึกสัญญา RHP, แก้ไข Draft/Revision Required และส่งออก PDF',
  Approver: 'ตรวจสอบ อนุมัติ ปฏิเสธ ส่งกลับแก้ไขสัญญา, แก้ไขสัญญาอนุมัติ, ดู Audit Log (บังคับ MFA)',
  Viewer: 'ดู Dashboard, ฐานข้อมูลสัญญา และดาวน์โหลด PDF เท่านั้น (Read-Only)',
};

export function UserApprovalCenterView({
  userProfile,
  onUsersUpdated,
}: UserApprovalCenterViewProps) {
  const [tab, setTab] = useState<FilterTab>('pending');
  const [users, setUsers] = useState<UserPermissionEntry[]>([]);
  const [userAuditLogs, setUserAuditLogs] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Modal state for Approve / Reject / Suspend / Change Role / Reactivate / Reset MFA
  const [modalAction, setModalAction] = useState<{
    action: 'approve' | 'reject' | 'suspend' | 'reactivate' | 'change_role' | 'reset_mfa';
    target: UserPermissionEntry;
  } | null>(null);
  const [selectedRole, setSelectedRole] = useState<UserRole>('Risk Control');
  const [reviewNote, setReviewNote] = useState('');

  const isSuperAdmin = userProfile?.role === 'Super Admin';

  const loadUsers = useCallback(async () => {
    if (!isSuperAdmin) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.getAdminUsers();
      setUsers(res.users);
      setUserAuditLogs(res.userAuditLogs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ไม่สามารถโหลดรายชื่อผู้สมัครและผู้ใช้งานได้');
    } finally {
      setLoading(false);
    }
  }, [isSuperAdmin]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const counts = useMemo(() => {
    let pendingApproval = 0;
    let pendingVerification = 0;
    let approved = 0;
    let rejectedOrSuspended = 0;
    for (const u of users) {
      if (u.accountStatus === 'Pending Approval') pendingApproval++;
      else if (u.accountStatus === 'Pending Verification') pendingVerification++;
      else if (u.accountStatus === 'Approved' && !u.disabled) approved++;
      else rejectedOrSuspended++;
    }
    return { pendingApproval, pendingVerification, approved, rejectedOrSuspended };
  }, [users]);

  const filteredUsers = useMemo(() => {
    if (tab === 'pending') {
      return users.filter(
        (u) => u.accountStatus === 'Pending Approval' || u.accountStatus === 'Pending Verification'
      );
    }
    if (tab === 'approved') {
      return users.filter((u) => u.accountStatus === 'Approved' && !u.disabled);
    }
    if (tab === 'rejected_suspended') {
      return users.filter(
        (u) => u.accountStatus === 'Rejected' || u.accountStatus === 'Suspended' || u.disabled
      );
    }
    return users;
  }, [users, tab]);

  if (!isSuperAdmin) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-8 text-center">
        <Shield className="mx-auto h-10 w-10 text-amber-700" />
        <h3 className="mt-3 text-base font-semibold text-amber-950">
          จำกัดสิทธิ์เฉพาะ Super Admin เท่านั้น
        </h3>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-amber-900">
          การอนุมัติผู้สมัครใหม่ การกำหนด Role และการระงับบัญชีสามารถดำเนินการได้โดย Super Admin เท่านั้น
        </p>
      </div>
    );
  }

  const openActionModal = (
    action: 'approve' | 'reject' | 'suspend' | 'reactivate' | 'change_role' | 'reset_mfa',
    target: UserPermissionEntry
  ) => {
    setModalAction({ action, target });
    setSelectedRole(
      target.accountStatus === 'Pending Approval' ? 'Risk Control' : target.role
    );
    setReviewNote('');
    setError(null);
  };

  const handleSubmitModal = async () => {
    if (!modalAction) return;
    const { action, target } = modalAction;

    if ((action === 'reject' || action === 'suspend') && !reviewNote.trim()) {
      setError('กรุณาระบุหมายเหตุประกอบการปฏิเสธหรือระงับบัญชี');
      return;
    }
    if (action === 'change_role' && selectedRole === 'Super Admin' && !reviewNote.trim()) {
      setError('การปรับสิทธิ์เป็น Super Admin จำเป็นต้องระบุเหตุผลใน Audit Log');
      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiClient.reviewAdminUser(target.email, {
        action,
        role:
          action === 'approve' || action === 'change_role' || action === 'reactivate'
            ? selectedRole
            : undefined,
        reviewNote: reviewNote.trim() || undefined,
      });
      setModalAction(null);
      setNotice(`อัปเดตสถานะบัญชี ${target.email} เรียบร้อยแล้ว`);
      await loadUsers();
      if (onUsersUpdated) {
        await onUsersUpdated();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ไม่สามารถดำเนินการจัดการบัญชีได้');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* KPI Summary Strip */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-medium text-slate-500">รอ Super Admin อนุมัติ</p>
          <p className="mt-2 font-mono text-2xl font-bold text-amber-700 tabular-nums">
            {counts.pendingApproval}{' '}
            <span className="text-xs font-normal text-slate-500">บัญชี</span>
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-medium text-slate-500">รอยืนยันอีเมล (Email Verification)</p>
          <p className="mt-2 font-mono text-2xl font-bold text-slate-700 tabular-nums">
            {counts.pendingVerification}{' '}
            <span className="text-xs font-normal text-slate-500">บัญชี</span>
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-medium text-slate-500">อนุมัติแล้ว (Approved)</p>
          <p className="mt-2 font-mono text-2xl font-bold text-emerald-700 tabular-nums">
            {counts.approved}{' '}
            <span className="text-xs font-normal text-slate-500">บัญชี</span>
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-medium text-slate-500">ปฏิเสธ / ระงับสิทธิ์</p>
          <p className="mt-2 font-mono text-2xl font-bold text-red-700 tabular-nums">
            {counts.rejectedOrSuspended}{' '}
            <span className="text-xs font-normal text-slate-500">บัญชี</span>
          </p>
        </div>
      </div>

      {/* Controls & Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-200/70 p-1">
          {[
            { id: 'pending' as const, label: `รอดำเนินการ (${counts.pendingApproval + counts.pendingVerification})` },
            { id: 'all' as const, label: `ผู้สมัครทั้งหมด (${users.length})` },
            { id: 'approved' as const, label: `อนุมัติแล้ว (${counts.approved})` },
            { id: 'rejected_suspended' as const, label: `ปฏิเสธ / ระงับ (${counts.rejectedOrSuspended})` },
            { id: 'audit' as const, label: `ประวัติการอนุมัติ (${userAuditLogs.length})` },
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`whitespace-nowrap rounded-md px-3.5 py-1.5 text-xs font-semibold transition-colors ${
                tab === item.id
                  ? 'bg-white text-[#0F2942] shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => void loadUsers()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          รีเฟรชรายการ
        </button>
      </div>

      {notice && (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-800">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="rounded p-0.5 hover:bg-emerald-100">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {error && (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="rounded p-0.5 hover:bg-red-100">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Main Content Table */}
      {tab === 'audit' ? (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-5 py-3.5 text-xs font-semibold text-slate-900">
            <History className="h-4 w-4 text-[#0F2942]" />
            <span>ประวัติการสมัคร ยืนยันอีเมล อนุมัติสิทธิ์ และ MFA (User Audit Log)</span>
          </div>
          {userAuditLogs.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500">ยังไม่มีประวัติการจัดการผู้ใช้งาน</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-4 py-3 font-semibold">วันเวลา</th>
                    <th className="px-4 py-3 font-semibold">ผู้ดำเนินการ</th>
                    <th className="px-4 py-3 font-semibold">บัญชีเป้าหมาย</th>
                    <th className="px-4 py-3 font-semibold">เหตุการณ์</th>
                    <th className="px-4 py-3 font-semibold">ค่าเดิม → ค่าใหม่</th>
                    <th className="px-4 py-3 font-semibold">หมายเหตุ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {userAuditLogs.map((log, idx) => (
                    <tr key={`${log.timestamp}-${idx}`} className="hover:bg-slate-50">
                      <td className="px-4 py-2.5 font-mono text-slate-600 whitespace-nowrap tabular-nums">
                        {log.timestamp}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-slate-800">{log.actor}</td>
                      <td className="px-4 py-2.5 font-mono font-semibold text-[#0F2942]">
                        {log.targetContractId.replace(/^USER:/, '')}
                      </td>
                      <td className="px-4 py-2.5 font-medium text-slate-900">{log.fieldChanged}</td>
                      <td className="px-4 py-2.5 font-mono text-slate-700">
                        {log.oldValue} → <span className="font-semibold text-slate-900">{log.newValue}</span>
                      </td>
                      <td className="px-4 py-2.5 text-slate-700">{log.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          {loading ? (
            <div className="p-8 text-center text-xs text-slate-500">กำลังโหลดข้อมูลผู้ใช้งาน...</div>
          ) : filteredUsers.length === 0 ? (
            <div className="p-10 text-center text-xs text-slate-500">
              ไม่มีรายการผู้ใช้งานในหมวดหมู่นี้
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-4 py-3 font-semibold">อีเมล / ชื่อผู้สมัคร</th>
                    <th className="px-4 py-3 font-semibold">ยืนยันอีเมล</th>
                    <th className="px-4 py-3 font-semibold">วันที่สมัคร / ยืนยัน</th>
                    <th className="px-4 py-3 font-semibold">สถานะ &amp; MFA</th>
                    <th className="px-4 py-3 font-semibold">บทบาท (Role)</th>
                    <th className="px-4 py-3 font-semibold">หมายเหตุคำขอ / ผลตรวจ</th>
                    <th className="px-4 py-3 text-right font-semibold">การจัดการ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredUsers.map((u) => {
                    const isSelf =
                      u.email.toLowerCase() === (userProfile?.email || '').toLowerCase();
                    return (
                      <tr key={u.email} className="hover:bg-slate-50/80">
                        <td className="px-4 py-3">
                          <div className="font-mono font-semibold text-[#0F2942]">{u.email}</div>
                          <div className="text-[11px] text-slate-600">
                            {u.displayName || '-'} {u.department ? `· ${u.department}` : ''}
                          </div>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          {u.emailVerified ? (
                            <span className="inline-flex items-center gap-1 font-semibold text-emerald-700">
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              Verified
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 font-semibold text-amber-700">
                              <Clock className="h-3.5 w-3.5" />
                              Unverified
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 font-mono text-[11px] text-slate-600 whitespace-nowrap tabular-nums">
                          <div>Reg: {u.registeredAt || '-'}</div>
                          <div>Ver: {u.emailVerifiedAt || '-'}</div>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <div
                            className={`font-semibold ${
                              u.accountStatus === 'Approved' && !u.disabled
                                ? 'text-emerald-700'
                                : u.accountStatus === 'Pending Approval'
                                  ? 'text-amber-700'
                                  : u.accountStatus === 'Rejected' || u.accountStatus === 'Suspended'
                                    ? 'text-red-700'
                                    : 'text-slate-600'
                            }`}
                          >
                            {u.accountStatus}
                          </div>
                          {(u.role === 'Super Admin' || u.role === 'Approver') && (
                            <div className="text-[11px] text-slate-500">
                              MFA: {u.mfaEnabled ? 'Enabled' : 'Pending Setup'}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 font-semibold text-slate-900 whitespace-nowrap">
                          {u.accountStatus === 'Pending Approval' || u.accountStatus === 'Pending Verification'
                            ? 'ยังไม่กำหนด (รอ Approve)'
                            : u.role}
                        </td>
                        <td className="max-w-xs px-4 py-3 text-[11px] text-slate-600">
                          {u.requestNote && <p>คำขอ: {u.requestNote}</p>}
                          {u.reviewNote && <p className="text-slate-800">ผลตรวจ: {u.reviewNote}</p>}
                        </td>
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          <div className="inline-flex flex-wrap items-center justify-end gap-1.5">
                            {u.accountStatus === 'Pending Approval' && u.emailVerified && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => openActionModal('approve', u)}
                                  className="inline-flex items-center gap-1 rounded bg-emerald-700 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-emerald-800"
                                >
                                  <UserCheck className="h-3 w-3" />
                                  กำหนด Role &amp; อนุมัติ
                                </button>
                                <button
                                  type="button"
                                  onClick={() => openActionModal('reject', u)}
                                  className="inline-flex items-center gap-1 rounded border border-red-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-50"
                                >
                                  <Ban className="h-3 w-3" />
                                  ปฏิเสธ
                                </button>
                              </>
                            )}

                            {u.accountStatus === 'Approved' && !u.disabled && !isSelf && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => openActionModal('change_role', u)}
                                  className="rounded border border-slate-300 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50"
                                >
                                  เปลี่ยน Role
                                </button>
                                <button
                                  type="button"
                                  onClick={() => openActionModal('suspend', u)}
                                  className="rounded border border-red-200 bg-white px-2.5 py-1 text-[11px] font-medium text-red-700 hover:bg-red-50"
                                >
                                  ระงับสิทธิ์
                                </button>
                              </>
                            )}

                            {(u.accountStatus === 'Rejected' ||
                              u.accountStatus === 'Suspended' ||
                              u.disabled) &&
                              u.emailVerified && (
                                <button
                                  type="button"
                                  onClick={() => openActionModal('reactivate', u)}
                                  className="inline-flex items-center gap-1 rounded bg-[#0F2942] px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-[#1E3A5F]"
                                >
                                  <RotateCcw className="h-3 w-3" />
                                  เปิดใช้งานอีกครั้ง
                                </button>
                              )}

                            {(u.role === 'Super Admin' || u.role === 'Approver') &&
                              u.mfaEnabled && (
                                <button
                                  type="button"
                                  onClick={() => openActionModal('reset_mfa', u)}
                                  className="inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-900 hover:bg-amber-100"
                                >
                                  <KeyRound className="h-3 w-3" />
                                  Reset MFA
                                </button>
                              )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Super Admin Review / Role Assignment Modal */}
      {modalAction && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
              <div>
                <h3 className="text-base font-bold text-slate-900">
                  {modalAction.action === 'approve'
                    ? 'อนุมัติบัญชีและกำหนดบทบาท (Approve & Assign Role)'
                    : modalAction.action === 'reject'
                      ? 'ปฏิเสธคำขอเข้าใช้งาน (Reject Applicant)'
                      : modalAction.action === 'suspend'
                        ? 'ระงับสิทธิ์การใช้งาน (Suspend User)'
                        : modalAction.action === 'reactivate'
                          ? 'เปิดใช้งานบัญชีอีกครั้ง (Reactivate User)'
                          : modalAction.action === 'reset_mfa'
                            ? 'รีเซ็ตการตั้งค่า MFA (Reset TOTP)'
                            : 'เปลี่ยนบทบาทผู้ใช้งาน (Change Role)'}
                </h3>
                <p className="mt-0.5 font-mono text-xs text-slate-500">
                  {modalAction.target.email}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setModalAction(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4 px-6 py-5 text-xs">
              {(modalAction.action === 'approve' ||
                modalAction.action === 'change_role' ||
                modalAction.action === 'reactivate') && (
                <div className="space-y-2">
                  <label className="block font-semibold text-slate-800">
                    เลือกบทบาท (Role) <span className="text-red-600">*</span>
                  </label>
                  <div className="space-y-2">
                    {ALL_USER_ROLES.map((r) => (
                      <label
                        key={r}
                        className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 ${
                          selectedRole === r
                            ? 'border-[#0F2942] bg-slate-50'
                            : 'border-slate-200 hover:bg-slate-50/70'
                        }`}
                      >
                        <input
                          type="radio"
                          name="assign-role"
                          checked={selectedRole === r}
                          onChange={() => setSelectedRole(r)}
                          className="mt-0.5"
                        />
                        <div>
                          <p className="font-semibold text-slate-900">{r}</p>
                          <p className="text-[11px] text-slate-600">{ROLE_DESCRIPTIONS[r]}</p>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {modalAction.action === 'reset_mfa' && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      ผู้ใช้งานจะถูกยกเลิกการผูก Authenticator เดิม และต้องสแกน QR Code ตั้งค่า MFA ใหม่ในการเข้าสู่ระบบครั้งถัดไป
                    </span>
                  </div>
                </div>
              )}

              <div>
                <label className="block font-semibold text-slate-800">
                  หมายเหตุ / เหตุผลประกอบ (บันทึกใน Audit Log){' '}
                  {(modalAction.action === 'reject' ||
                    modalAction.action === 'suspend' ||
                    (modalAction.action === 'change_role' && selectedRole === 'Super Admin')) && (
                    <span className="text-red-600">*</span>
                  )}
                </label>
                <input
                  type="text"
                  value={reviewNote}
                  onChange={(e) => setReviewNote(e.target.value)}
                  placeholder="ระบุหมายเหตุหรือเหตุผลประกอบการพิจารณา..."
                  className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5 border-t border-slate-100 px-6 py-4">
              <button
                type="button"
                onClick={() => setModalAction(null)}
                disabled={busy}
                className="whitespace-nowrap rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={() => void handleSubmitModal()}
                disabled={busy}
                className={`whitespace-nowrap rounded-lg px-4 py-2 text-xs font-semibold text-white disabled:opacity-50 ${
                  modalAction.action === 'reject' || modalAction.action === 'suspend'
                    ? 'bg-red-700 hover:bg-red-800'
                    : 'bg-[#0F2942] hover:bg-[#1E3A5F]'
                }`}
              >
                {busy ? 'กำลังบันทึก...' : 'ยืนยันการดำเนินการ'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
