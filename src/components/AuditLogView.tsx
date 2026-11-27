import { useMemo, useState } from 'react';
import { History, RefreshCw, Search } from 'lucide-react';
import type { UserAuthProfile } from '../services/apiClient.ts';
import type { AuditLogEntry, ConnectionStatus } from '../types/rhp.ts';

interface AuditLogViewProps {
  isPortalAuthenticated: boolean;
  hasSheetsAccess: boolean;
  reconnectLoading?: boolean;
  userProfile: UserAuthProfile | null;
  connection: ConnectionStatus;
  auditLogs: AuditLogEntry[];
  loading: boolean;
  onRefresh: () => Promise<void>;
  onRequireSetup: () => void;
  onReconnectSheets: () => Promise<void>;
}

export function AuditLogView({
  userProfile,
  auditLogs,
  loading,
  onRefresh,
}: AuditLogViewProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedField, setSelectedField] = useState<string>('ALL');

  const canViewAudit =
    userProfile?.role === 'Super Admin' ||
    userProfile?.role === 'Approver' ||
    Boolean(userProfile?.canApprove);

  const fieldTypes = useMemo(() => {
    const set = new Set<string>();
    for (const log of auditLogs) {
      if (log.fieldChanged) set.add(log.fieldChanged);
    }
    return Array.from(set).sort();
  }, [auditLogs]);

  const filteredLogs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return auditLogs
      .filter((log) => {
        if (selectedField !== 'ALL' && log.fieldChanged !== selectedField) return false;
        if (!q) return true;
        return (
          log.targetContractId.toLowerCase().includes(q) ||
          log.actor.toLowerCase().includes(q) ||
          log.fieldChanged.toLowerCase().includes(q) ||
          log.oldValue.toLowerCase().includes(q) ||
          log.newValue.toLowerCase().includes(q) ||
          log.reason.toLowerCase().includes(q)
        );
      })
      .slice();
  }, [auditLogs, searchQuery, selectedField]);

  if (!canViewAudit) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-8 text-center">
        <History className="mx-auto h-10 w-10 text-amber-700" />
        <h3 className="mt-3 text-base font-semibold text-amber-950">
          จำกัดสิทธิ์เฉพาะผู้ตรวจสอบและผู้ดูแลระบบ (Approver / Super Admin)
        </h3>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-amber-900">
          ประวัติการดำเนินการและการเปลี่ยนแปลงข้อมูล (Audit Log) เปิดให้ตรวจสอบเฉพาะระดับ Approver และ Super Admin เท่านั้น
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white p-5">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            ประวัติการดำเนินการและการเปลี่ยนแปลงข้อมูล (Audit Log)
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            บันทึกเหตุการณ์ด้านสิทธิ์ผู้ใช้งาน, MFA, และรายการสัญญาจากชีต Audit_Log · ทั้งหมด {auditLogs.length} รายการ
          </p>
        </div>

        <button
          type="button"
          onClick={() => void onRefresh()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          ซิงก์ Audit Log ล่าสุด
        </button>
      </div>

      {/* Filters */}
      <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 md:grid-cols-12">
        <div className="relative md:col-span-8">
          <Search className="pointer-events-none absolute top-2.5 left-3 h-4 w-4 text-slate-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="ค้นหาเลขที่สัญญา RHP, อีเมลผู้ดำเนินการ, รายการแก้ไข หรือเหตุผล..."
            className="w-full rounded-lg border border-slate-300 py-2 pr-3 pl-9 text-xs text-slate-900 focus:border-[#0F2942] focus:outline-none"
          />
        </div>
        <div className="md:col-span-4">
          <select
            value={selectedField}
            onChange={(e) => setSelectedField(e.target.value)}
            aria-label="กรองตามประเภทการเปลี่ยนแปลง"
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-800"
          >
            <option value="ALL">ทุกประเภทเหตุการณ์ ({auditLogs.length})</option>
            {fieldTypes.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Audit Table */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        {loading ? (
          <div className="p-8 text-center text-xs text-slate-500">
            กำลังโหลดประวัติ Audit Log จาก Google Sheets...
          </div>
        ) : filteredLogs.length === 0 ? (
          <div className="p-10 text-center text-xs text-slate-500">
            ไม่พบข้อมูลประวัติการดำเนินการที่ตรงกับเงื่อนไข
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-4 py-3 font-semibold">วันเวลา (Asia/Bangkok)</th>
                  <th className="px-4 py-3 font-semibold">ผู้ดำเนินการ (Actor)</th>
                  <th className="px-4 py-3 font-semibold">เลขที่สัญญา RHP</th>
                  <th className="px-4 py-3 font-semibold">รายการที่เปลี่ยนแปลง</th>
                  <th className="px-4 py-3 font-semibold">ค่าเดิม</th>
                  <th className="px-4 py-3 font-semibold">ค่าใหม่</th>
                  <th className="px-4 py-3 font-semibold">เหตุผล</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredLogs.map((log, i) => (
                  <tr key={`${log.timestamp}-${log.targetContractId}-${i}`} className="hover:bg-slate-50">
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
    </div>
  );
}
