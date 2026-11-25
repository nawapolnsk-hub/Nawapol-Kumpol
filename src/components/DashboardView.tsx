import { useMemo, useState } from 'react';
import { BarChart3, Database } from 'lucide-react';
import type { ConnectionStatus, RhpTransaction } from '../types/rhp.ts';
import { formatTHB, getBangkokParts } from '../utils/rhpCalculator.ts';

interface DashboardViewProps {
  isAuthenticated: boolean;
  connection: ConnectionStatus;
  transactions: RhpTransaction[];
  onRequireSetup: () => void;
  onNavigateCalculator: () => void;
}

export function DashboardView({
  isAuthenticated,
  connection,
  transactions,
  onRequireSetup,
  onNavigateCalculator,
}: DashboardViewProps) {
  const bangkokNow = getBangkokParts();
  const currentYYYYMM = `${bangkokNow.year}-${bangkokNow.month}`;

  const [selectedYear, setSelectedYear] = useState<string>('ALL');
  const [selectedMonth, setSelectedMonth] = useState<string>('ALL');

  const availableYears = useMemo(() => {
    const years = new Set<string>([bangkokNow.year]);
    for (const tx of transactions) {
      if (tx.transactionDate.length >= 4) {
        years.add(tx.transactionDate.slice(0, 4));
      }
    }
    return Array.from(years).sort().reverse();
  }, [transactions, bangkokNow.year]);

  const filtered = useMemo(() => {
    return transactions.filter((tx) => {
      if (selectedYear !== 'ALL' && !tx.transactionDate.startsWith(selectedYear)) return false;
      if (selectedMonth !== 'ALL' && tx.transactionDate.slice(5, 7) !== selectedMonth) return false;
      return true;
    });
  }, [transactions, selectedYear, selectedMonth]);

  const metrics = useMemo(() => {
    let totalAr = 0;
    let totalDownPayment = 0;
    let totalFinancedPrincipal = 0;
    let draftCount = 0;
    let approvedCount = 0;
    let currentMonthCount = 0;
    let flatRateCount = 0;
    let reducingCount = 0;

    for (const tx of transactions) {
      if (tx.transactionDate.startsWith(currentYYYYMM)) {
        currentMonthCount++;
      }
    }

    for (const tx of filtered) {
      totalAr += tx.ar;
      totalDownPayment += tx.downPaymentAmount;
      totalFinancedPrincipal += tx.financedPrincipal;
      if (tx.transactionStatus === 'Approved') approvedCount++;
      else draftCount++;

      if (tx.interestMethod === 'Reducing Balance') reducingCount++;
      else flatRateCount++;
    }

    return {
      totalAllCount: transactions.length,
      filteredCount: filtered.length,
      currentMonthCount,
      totalAr,
      totalDownPayment,
      totalFinancedPrincipal,
      draftCount,
      approvedCount,
      flatRateCount,
      reducingCount,
    };
  }, [transactions, filtered, currentYYYYMM]);

  // Monthly breakdown for chart
  const monthlySeries = useMemo(() => {
    const map = new Map<string, { ym: string; count: number; ar: number; principal: number }>();
    for (const tx of filtered) {
      const ym = tx.transactionDate.slice(0, 7) || 'Unknown';
      const existing = map.get(ym) || { ym, count: 0, ar: 0, principal: 0 };
      existing.count += 1;
      existing.ar += tx.ar;
      existing.principal += tx.financedPrincipal;
      map.set(ym, existing);
    }
    return Array.from(map.values())
      .sort((a, b) => a.ym.localeCompare(b.ym))
      .slice(-8);
  }, [filtered]);

  const maxMonthlyAr = Math.max(1, ...monthlySeries.map((m) => m.ar));

  if (!isAuthenticated || !connection.connected) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-10 text-center">
        <Database className="mx-auto h-10 w-10 text-slate-400" />
        <h3 className="mt-3 text-base font-semibold text-slate-900">
          เชื่อมต่อ Google Sheets เพื่อแสดงผล Dashboard จริง
        </h3>
        <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-slate-600">
          ระบบ Dashboard แสดงข้อมูลจากฐานข้อมูลจริง RHP_Restructuring_Database เท่านั้น ไม่ใช้ข้อมูลจำลอง
        </p>
        <button
          type="button"
          onClick={onRequireSetup}
          className="mt-5 whitespace-nowrap rounded-lg bg-[#0F2942] px-5 py-2.5 text-xs font-semibold text-white hover:bg-[#1E3A5F]"
        >
          เชื่อมต่อ Google Sheets
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Period Filters */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            ภาพรวมพอร์ตการปรับโครงสร้างสัญญาเช่าซื้อ (RHP Portfolio)
          </h2>
          <p className="text-xs text-slate-500">
            ข้อมูลจากฐานข้อมูลกลาง {connection.spreadsheetTitle || 'RHP_Restructuring_Database'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <select
            value={selectedYear}
            onChange={(e) => setSelectedYear(e.target.value)}
            aria-label="เลือกปี"
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-800"
          >
            <option value="ALL">ทุกปี</option>
            {availableYears.map((y) => (
              <option key={y} value={y}>
                ปี {y}
              </option>
            ))}
          </select>

          <select
            value={selectedMonth}
            onChange={(e) => setSelectedMonth(e.target.value)}
            aria-label="เลือกเดือน"
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-800"
          >
            <option value="ALL">ทุกเดือน</option>
            {Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, '0')).map((m) => (
              <option key={m} value={m}>
                เดือน {m}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* 7 Required KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-medium text-slate-500">จำนวนรายการปรับโครงสร้างทั้งหมด</p>
          <p className="mt-2 font-mono text-2xl font-bold text-[#0F2942] tabular-nums">
            {metrics.totalAllCount}{' '}
            <span className="text-xs font-normal text-slate-500">สัญญา</span>
          </p>
          <p className="mt-1 text-[11px] text-slate-500 tabular-nums">
            ตามตัวกรองปัจจุบัน: {metrics.filteredCount} สัญญา
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-medium text-slate-500">
            จำนวนรายการในเดือนปัจจุบัน ({currentYYYYMM})
          </p>
          <p className="mt-2 font-mono text-2xl font-bold text-[#0F2942] tabular-nums">
            {metrics.currentMonthCount}{' '}
            <span className="text-xs font-normal text-slate-500">สัญญา</span>
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-medium text-slate-500">ยอด AR รวม</p>
          <p className="mt-2 font-mono text-2xl font-bold text-slate-900 tabular-nums">
            {formatTHB(metrics.totalAr)}
          </p>
          <p className="mt-1 text-[11px] text-slate-500">THB</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-medium text-slate-500">ยอดเงินดาวน์รวม</p>
          <p className="mt-2 font-mono text-2xl font-bold text-slate-900 tabular-nums">
            {formatTHB(metrics.totalDownPayment)}
          </p>
          <p className="mt-1 text-[11px] text-slate-500">THB</p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 sm:col-span-2">
          <p className="text-xs font-medium text-slate-500">ยอดเงินต้นที่จัดไฟแนนซ์รวม (Financed Principal)</p>
          <p className="mt-2 font-mono text-2xl font-bold text-[#0F2942] tabular-nums">
            {formatTHB(metrics.totalFinancedPrincipal)}{' '}
            <span className="text-xs font-semibold text-slate-500">THB</span>
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-medium text-slate-500">รายการที่รออนุมัติ (Draft)</p>
          <p className="mt-2 font-mono text-2xl font-bold text-amber-700 tabular-nums">
            {metrics.draftCount}{' '}
            <span className="text-xs font-normal text-slate-500">รายการ</span>
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-xs font-medium text-slate-500">รายการที่อนุมัติแล้ว (Approved)</p>
          <p className="mt-2 font-mono text-2xl font-bold text-emerald-700 tabular-nums">
            {metrics.approvedCount}{' '}
            <span className="text-xs font-normal text-slate-500">รายการ</span>
          </p>
        </div>
      </div>

      {/* Charts / Distribution */}
      {filtered.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
          <BarChart3 className="mx-auto h-8 w-8 text-slate-400" />
          <p className="mt-2 text-sm font-semibold text-slate-900">
            ยังไม่มีข้อมูลรายการปรับโครงสร้างในช่วงเวลาที่เลือก
          </p>
          <button
            type="button"
            onClick={onNavigateCalculator}
            className="mt-4 whitespace-nowrap rounded-lg bg-[#0F2942] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1E3A5F]"
          >
            สร้างรายการปรับโครงสร้างแรก
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <div className="rounded-xl border border-slate-200 bg-white p-6 lg:col-span-8">
            <h3 className="text-sm font-semibold text-slate-900">
              ยอด AR และยอดเงินต้นจัดไฟแนนซ์รายเดือน (THB)
            </h3>
            <div className="mt-5 space-y-4">
              {monthlySeries.map((item) => {
                const arPct = Math.round((item.ar / maxMonthlyAr) * 100);
                const prinPct = Math.round((item.principal / maxMonthlyAr) * 100);
                return (
                  <div key={item.ym} className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-mono font-semibold text-slate-800">
                        {item.ym} · {item.count} สัญญา
                      </span>
                      <span className="font-mono text-slate-600 tabular-nums">
                        AR {formatTHB(item.ar)} / เงินต้น {formatTHB(item.principal)} THB
                      </span>
                    </div>
                    <div className="space-y-1">
                      <div className="h-2.5 w-full overflow-hidden rounded bg-slate-100">
                        <div
                          className="h-full rounded bg-[#0F2942]"
                          style={{ width: `${Math.max(2, arPct)}%` }}
                        />
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded bg-slate-100">
                        <div
                          className="h-full rounded bg-emerald-600"
                          style={{ width: `${Math.max(2, prinPct)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-5 flex items-center gap-6 border-t border-slate-100 pt-3 text-xs text-slate-600">
              <span className="inline-flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-sm bg-[#0F2942]" />
                ยอด AR รวม
              </span>
              <span className="inline-flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-sm bg-emerald-600" />
                ยอดเงินต้นจัดไฟแนนซ์
              </span>
            </div>
          </div>

          <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 lg:col-span-4">
            <h3 className="text-sm font-semibold text-slate-900">สัดส่วนวิธีคิดดอกเบี้ยและสถานะ</h3>
            <div className="space-y-3 border-t border-slate-100 pt-4 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-slate-600">Flat Rate</span>
                <span className="font-mono font-semibold text-slate-900 tabular-nums">
                  {metrics.flatRateCount} สัญญา
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-600">Reducing Balance</span>
                <span className="font-mono font-semibold text-slate-900 tabular-nums">
                  {metrics.reducingCount} สัญญา
                </span>
              </div>
            </div>

            <div className="space-y-3 border-t border-slate-100 pt-4 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-emerald-700 font-medium">Approved</span>
                <span className="font-mono font-semibold text-emerald-700 tabular-nums">
                  {metrics.approvedCount} สัญญา
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-amber-700 font-medium">Draft (รออนุมัติ)</span>
                <span className="font-mono font-semibold text-amber-700 tabular-nums">
                  {metrics.draftCount} สัญญา
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
