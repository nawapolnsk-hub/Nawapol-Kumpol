import { useEffect, useState } from 'react';
import { Plus, Shield, Trash2, Users, X } from 'lucide-react';
import { apiClient, type UserAuthProfile } from '../services/apiClient.ts';
import {
  ALL_USER_ROLES,
  type SystemConfig,
  type UserPermissionEntry,
  type UserRole,
} from '../types/rhp.ts';
import { getDefaultRoleCapabilities } from '../utils/transactionLifecycle.ts';
import { ConfirmationModal } from './ConfirmationModal.tsx';

interface UserManagementViewProps {
  userProfile: UserAuthProfile | null;
  config: SystemConfig;
  onConfigUpdated: (nextConfig: SystemConfig) => void;
  onNavigateApprovalCenter?: () => void;
}

export function UserManagementView({
  userProfile,
  config,
  onConfigUpdated,
  onNavigateApprovalCenter,
}: UserManagementViewProps) {
  const [draftUsers, setDraftUsers] = useState<UserPermissionEntry[]>(config.authorizedUsers);
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserDisplayName, setNewUserDisplayName] = useState('');
  const [newUserRole, setNewUserRole] = useState<UserRole>('Risk Control');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    setDraftUsers(config.authorizedUsers);
  }, [config.authorizedUsers]);

  const isSuperAdmin = userProfile?.role === 'Super Admin';

  if (!isSuperAdmin) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-8 text-center">
        <Users className="mx-auto h-10 w-10 text-amber-700" />
        <h3 className="mt-3 text-base font-semibold text-amber-950">
          จำกัดสิทธิ์เฉพาะผู้ดูแลระบบสูงสุด (Super Admin Only)
        </h3>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-amber-900">
          การจัดการบัญชีและสิทธิ์ผู้ใช้งาน (RBAC) สามารถดำเนินการได้โดย Super Admin เท่านั้น
        </p>
      </div>
    );
  }

  const handleAddUser = () => {
    const email = newUserEmail.trim().toLowerCase();
    if (!email || !email.includes('@')) {
      setError('กรุณาระบุอีเมลผู้ใช้งานที่ถูกต้อง');
      return;
    }
    if (draftUsers.some((u) => u.email.toLowerCase() === email)) {
      setError(`บัญชี ${email} มีอยู่ในรายการผู้ใช้งานแล้ว`);
      return;
    }
    setError(null);
    const caps = getDefaultRoleCapabilities(newUserRole);
    setDraftUsers((prev) => [
      ...prev,
      {
        email,
        displayName: newUserDisplayName.trim() || email,
        role: newUserRole,
        accountStatus: 'Approved',
        emailVerified: true,
        canOverrideAr: caps.canOverrideAr,
        canApprove: caps.canApprove,
        canDelete: caps.canDelete,
        disabled: false,
      },
    ]);
    setNewUserEmail('');
    setNewUserDisplayName('');
  };

  const handleSaveUsers = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiClient.updateConfig({
        authorizedUsers: draftUsers,
      });
      onConfigUpdated(res.config);
      setNotice('บันทึกบัญชีผู้ใช้งานและสิทธิ์ RBAC ลงฐานข้อมูลเรียบร้อยแล้ว');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ไม่สามารถบันทึกข้อมูลผู้ใช้งานได้');
    } finally {
      setBusy(false);
    }
  };

  const activeCount = draftUsers.filter(
    (u) => u.accountStatus === 'Approved' && !u.disabled
  ).length;
  const superAdminCount = draftUsers.filter(
    (u) => u.role === 'Super Admin' && u.accountStatus === 'Approved' && !u.disabled
  ).length;
  const approverCount = draftUsers.filter(
    (u) => u.role === 'Approver' && u.accountStatus === 'Approved' && !u.disabled
  ).length;

  return (
    <div className="space-y-5">
      {/* Summary Strip */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-medium text-slate-500">บัญชีที่ได้รับอนุมัติและใช้งานได้</p>
          <p className="mt-2 font-mono text-2xl font-bold text-[#0F2942] tabular-nums">
            {activeCount}{' '}
            <span className="text-xs font-normal text-slate-500">
              / {draftUsers.length} บัญชี
            </span>
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-medium text-slate-500">Approver (ผู้ตรวจสอบและอนุมัติสัญญา)</p>
          <p className="mt-2 font-mono text-2xl font-bold text-emerald-700 tabular-nums">
            {approverCount}{' '}
            <span className="text-xs font-normal text-slate-500">บัญชี</span>
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-medium text-slate-500">Super Admin (ผู้ดูแลระบบสูงสุด)</p>
          <p className="mt-2 font-mono text-2xl font-bold text-slate-900 tabular-nums">
            {superAdminCount}{' '}
            <span className="text-xs font-normal text-slate-500">บัญชี</span>
          </p>
        </div>
      </div>

      {onNavigateApprovalCenter && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-5 py-3.5 text-xs">
          <span className="text-slate-700">
            ต้องการอนุมัติผู้สมัครใหม่ ตรวจสอบการยืนยันอีเมล หรือรีเซ็ต MFA?
          </span>
          <button
            type="button"
            onClick={onNavigateApprovalCenter}
            className="whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3.5 py-1.5 font-semibold text-[#0F2942] hover:bg-slate-100"
          >
            เปิด User Approval Center
          </button>
        </div>
      )}

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

      {/* User Directory & Permissions Table */}
      <div className="rounded-xl border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
          <div className="flex items-center gap-2.5">
            <Shield className="h-5 w-5 text-[#0F2942]" />
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                ระบบจัดการบัญชีและสิทธิ์ผู้ใช้งาน (User Management &amp; RBAC)
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                กำหนดบทบาท (Super Admin / Risk Control / Approver / Viewer) และสิทธิ์ AR Override, Approve, Delete
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={busy}
            className="whitespace-nowrap rounded-lg bg-[#0F2942] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1E3A5F] disabled:opacity-50"
          >
            บันทึกสิทธิ์ผู้ใช้งาน
          </button>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <th className="px-3 py-3 font-semibold">อีเมลผู้ใช้งาน</th>
                <th className="px-3 py-3 font-semibold">ชื่อแสดงผล</th>
                <th className="px-3 py-3 font-semibold">สถานะบัญชี</th>
                <th className="px-3 py-3 font-semibold">บทบาท (Role)</th>
                <th className="px-3 py-3 text-center font-semibold">ปรับแก้ AR</th>
                <th className="px-3 py-3 text-center font-semibold">อนุมัติสัญญา</th>
                <th className="px-3 py-3 text-center font-semibold">ลบรายการ</th>
                <th className="px-3 py-3 text-center font-semibold">ระงับสิทธิ์</th>
                <th className="px-3 py-3 text-right font-semibold">จัดการ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {draftUsers.map((u, idx) => {
                const isSelf =
                  u.email.toLowerCase() === (userProfile?.email || '').toLowerCase();
                const isLockedRole = u.role === 'Super Admin' || u.role === 'Viewer';
                return (
                  <tr key={u.email} className="hover:bg-slate-50/80">
                    <td className="px-3 py-2.5 font-mono text-slate-900 whitespace-nowrap">
                      {u.email}
                    </td>
                    <td className="px-3 py-2.5">
                      <input
                        type="text"
                        value={u.displayName || ''}
                        onChange={(e) =>
                          setDraftUsers((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, displayName: e.target.value } : item
                            )
                          )
                        }
                        placeholder={u.email}
                        className="w-full min-w-[140px] rounded border border-slate-300 px-2.5 py-1 text-xs text-slate-900 focus:border-[#0F2942] focus:outline-none"
                      />
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap">
                      <span
                        className={`font-semibold ${
                          u.accountStatus === 'Approved' && !u.disabled
                            ? 'text-emerald-700'
                            : u.accountStatus === 'Pending Approval'
                              ? 'text-amber-700'
                              : 'text-red-700'
                        }`}
                      >
                        {u.accountStatus}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <select
                        value={u.role}
                        disabled={isSelf}
                        onChange={(e) => {
                          const role = e.target.value as UserRole;
                          const caps = getDefaultRoleCapabilities(role);
                          setDraftUsers((prev) =>
                            prev.map((item, i) =>
                              i === idx
                                ? {
                                    ...item,
                                    role,
                                    canOverrideAr: caps.canOverrideAr,
                                    canApprove: caps.canApprove,
                                    canDelete: caps.canDelete,
                                  }
                                : item
                            )
                          );
                        }}
                        className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs disabled:bg-slate-100"
                      >
                        {ALL_USER_ROLES.map((roleOpt) => (
                          <option key={roleOpt} value={roleOpt}>
                            {roleOpt}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <input
                        type="checkbox"
                        checked={u.role === 'Super Admin' ? true : u.role === 'Viewer' ? false : u.canOverrideAr}
                        disabled={isLockedRole}
                        onChange={(e) =>
                          setDraftUsers((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, canOverrideAr: e.target.checked } : item
                            )
                          )
                        }
                      />
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <input
                        type="checkbox"
                        checked={u.role === 'Super Admin' || u.role === 'Approver' ? true : false}
                        disabled={true}
                        readOnly
                      />
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <input
                        type="checkbox"
                        checked={u.role === 'Super Admin' ? true : u.role === 'Viewer' ? false : Boolean(u.canDelete)}
                        disabled={isLockedRole}
                        onChange={(e) =>
                          setDraftUsers((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, canDelete: e.target.checked } : item
                            )
                          )
                        }
                      />
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <input
                        type="checkbox"
                        checked={Boolean(u.disabled) || u.accountStatus === 'Suspended'}
                        disabled={isSelf}
                        onChange={(e) =>
                          setDraftUsers((prev) =>
                            prev.map((item, i) =>
                              i === idx
                                ? {
                                    ...item,
                                    disabled: e.target.checked,
                                    accountStatus: e.target.checked ? 'Suspended' : 'Approved',
                                  }
                                : item
                            )
                          )
                        }
                      />
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {draftUsers.length > 1 && !isSelf && (
                        <button
                          type="button"
                          onClick={() =>
                            setDraftUsers((prev) => prev.filter((_, i) => i !== idx))
                          }
                          className="rounded p-1 text-red-600 hover:bg-red-50 hover:text-red-800"
                          aria-label={`ลบบัญชี ${u.email}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Add Authorized Staff Form */}
        <div className="mt-5 grid grid-cols-1 gap-3 border-t border-slate-200 pt-5 sm:grid-cols-12">
          <div className="sm:col-span-4">
            <input
              type="email"
              value={newUserEmail}
              onChange={(e) => setNewUserEmail(e.target.value)}
              placeholder="อีเมลผู้ใช้งาน (เช่น officer@company.com)"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900 focus:border-[#0F2942] focus:outline-none"
            />
          </div>
          <div className="sm:col-span-4">
            <input
              type="text"
              value={newUserDisplayName}
              onChange={(e) => setNewUserDisplayName(e.target.value)}
              placeholder="ชื่อ-นามสกุลผู้ใช้งาน (ถ้ามี)"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900 focus:border-[#0F2942] focus:outline-none"
            />
          </div>
          <div className="sm:col-span-2">
            <select
              value={newUserRole}
              onChange={(e) => setNewUserRole(e.target.value as UserRole)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs"
            >
              {ALL_USER_ROLES.map((roleOpt) => (
                <option key={roleOpt} value={roleOpt}>
                  {roleOpt}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <button
              type="button"
              onClick={handleAddUser}
              className="inline-flex w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50"
            >
              <Plus className="h-3.5 w-3.5" />
              เพิ่มบัญชี
            </button>
          </div>
        </div>
      </div>

      <ConfirmationModal
        open={confirmOpen}
        title="ยืนยันการบันทึกสิทธิ์ผู้ใช้งาน"
        description="ระบบจะอัปเดตรายชื่อผู้ใช้งานที่ได้รับอนุญาตและสิทธิ์ RBAC ลงใน System_Configuration และ Google Sheets"
        details={[
          `จำนวนบัญชีทั้งหมด: ${draftUsers.length} บัญชี`,
          `บัญชีที่ใช้งานได้: ${activeCount} บัญชี`,
        ]}
        busy={busy}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          void handleSaveUsers();
        }}
      />
    </div>
  );
}
