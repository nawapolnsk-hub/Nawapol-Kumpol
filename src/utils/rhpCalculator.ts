import type {
  AmortizationRow,
  DuplicateMatch,
  FinancialInput,
  FinancialSummary,
  RhpTransaction,
} from '../types/rhp.ts';

export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function round4(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

export function formatTHB(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(safe);
}

export function formatPercent(value: number, decimals = 2): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `${safe.toFixed(decimals)}%`;
}

export interface CalculationResult {
  summary: FinancialSummary;
  schedule: AmortizationRow[];
  validationErrors: string[];
}

export function calculateRhpFinancials(input: FinancialInput): CalculationResult {
  const validationErrors: string[] = [];

  const machineCost = Math.max(0, Number(input.machineCost) || 0);
  const processingFee = Math.max(0, Number(input.processingFee) || 0);
  const computedAr = round2(machineCost + processingFee);

  const isArOverridden =
    input.arOverride !== null &&
    Number.isFinite(input.arOverride) &&
    round2(input.arOverride) !== computedAr;

  const ar = isArOverridden ? round2(Math.max(0, Number(input.arOverride))) : computedAr;

  if ((Number(input.machineCost) || 0) < 0) {
    validationErrors.push('ราคาต้นทุนเครื่องจักรต้องไม่ติดลบ');
  }
  if ((Number(input.processingFee) || 0) < 0) {
    validationErrors.push('ค่าดำเนินการเพิ่มเติมต้องไม่ติดลบ');
  }
  if (ar <= 0) {
    validationErrors.push('ยอด AR ต้องมากกว่า 0.00 บาท');
  }

  const annualInterestRate = Number(input.interestRate);
  if (!Number.isFinite(annualInterestRate) || annualInterestRate < 0) {
    validationErrors.push('อัตราดอกเบี้ยต้องเป็นตัวเลขตั้งแต่ 0% ขึ้นไป');
  }
  const safeAnnualRate = Math.max(0, Number.isFinite(annualInterestRate) ? annualInterestRate : 0);

  const n = Number(input.installmentPeriod) || 12;
  if (n <= 0) {
    validationErrors.push('จำนวนงวดต้องมากกว่า 0');
  }

  let downPaymentAmount = 0;
  let downPaymentPercentage = 0;

  if (input.downPaymentMode === 'percentage') {
    const rawPct = Number(input.downPaymentPercentage);
    if (!Number.isFinite(rawPct) || rawPct < 0 || rawPct > 100) {
      validationErrors.push('เปอร์เซ็นต์เงินดาวน์ต้องอยู่ระหว่าง 0% ถึง 100%');
    }
    const clampedPct = Math.min(100, Math.max(0, Number.isFinite(rawPct) ? rawPct : 0));
    downPaymentPercentage = round4(clampedPct);
    downPaymentAmount = round2(ar * (clampedPct / 100));
  } else {
    const rawAmt = Number(input.downPaymentAmount);
    if (!Number.isFinite(rawAmt) || rawAmt < 0) {
      validationErrors.push('จำนวนเงินดาวน์ต้องไม่ติดลบ');
    }
    if (rawAmt > ar) {
      validationErrors.push('จำนวนเงินดาวน์ต้องไม่เกินยอด AR');
    }
    const clampedAmt = Math.min(ar, Math.max(0, Number.isFinite(rawAmt) ? rawAmt : 0));
    downPaymentAmount = round2(clampedAmt);
    downPaymentPercentage = ar > 0 ? round4((downPaymentAmount / ar) * 100) : 0;
  }

  if (downPaymentAmount > ar) {
    downPaymentAmount = ar;
    downPaymentPercentage = ar > 0 ? 100 : 0;
  }

  const financedPrincipal = round2(Math.max(0, ar - downPaymentAmount));
  const monthlyInterestRate = safeAnnualRate / 100 / 12;

  const schedule: AmortizationRow[] = [];
  let totalInterest = 0;
  let totalRepayment = 0;
  let monthlyInstallment = 0;

  if (financedPrincipal === 0) {
    for (let k = 1; k <= n; k++) {
      schedule.push({
        installmentNo: k,
        beginningPrincipal: 0,
        principalPaid: 0,
        interestPaid: 0,
        monthlyPayment: 0,
        endingPrincipal: 0,
      });
    }
  } else if (input.interestMethod === 'Flat Rate') {
    totalInterest = round2(financedPrincipal * (safeAnnualRate / 100) * (n / 12));
    totalRepayment = round2(financedPrincipal + totalInterest);
    monthlyInstallment = round2(totalRepayment / n);

    let remainingPrincipal = financedPrincipal;
    let accumulatedInterest = 0;

    for (let k = 1; k <= n; k++) {
      const beginningPrincipal = round2(remainingPrincipal);

      if (k < n) {
        const interestPaid = round2(totalInterest / n);
        const principalPaid = round2(Math.min(beginningPrincipal, monthlyInstallment - interestPaid));
        const monthlyPayment = round2(principalPaid + interestPaid);
        const endingPrincipal = round2(Math.max(0, beginningPrincipal - principalPaid));

        remainingPrincipal = endingPrincipal;
        accumulatedInterest = round2(accumulatedInterest + interestPaid);

        schedule.push({
          installmentNo: k,
          beginningPrincipal,
          principalPaid,
          interestPaid,
          monthlyPayment,
          endingPrincipal,
        });
      } else {
        const principalPaid = beginningPrincipal;
        const interestPaid = round2(Math.max(0, totalInterest - accumulatedInterest));
        const monthlyPayment = round2(principalPaid + interestPaid);

        schedule.push({
          installmentNo: k,
          beginningPrincipal,
          principalPaid,
          interestPaid,
          monthlyPayment,
          endingPrincipal: 0,
        });
      }
    }
  } else {
    // Reducing Balance
    if (monthlyInterestRate === 0) {
      monthlyInstallment = round2(financedPrincipal / n);
      let remainingPrincipal = financedPrincipal;

      for (let k = 1; k <= n; k++) {
        const beginningPrincipal = round2(remainingPrincipal);
        if (k < n) {
          const principalPaid = round2(Math.min(beginningPrincipal, monthlyInstallment));
          const endingPrincipal = round2(Math.max(0, beginningPrincipal - principalPaid));
          remainingPrincipal = endingPrincipal;

          schedule.push({
            installmentNo: k,
            beginningPrincipal,
            principalPaid,
            interestPaid: 0,
            monthlyPayment: principalPaid,
            endingPrincipal,
          });
        } else {
          const principalPaid = beginningPrincipal;
          schedule.push({
            installmentNo: k,
            beginningPrincipal,
            principalPaid,
            interestPaid: 0,
            monthlyPayment: principalPaid,
            endingPrincipal: 0,
          });
        }
      }
      totalInterest = 0;
      totalRepayment = financedPrincipal;
    } else {
      const factor = Math.pow(1 + monthlyInterestRate, n);
      const rawPmt = (financedPrincipal * monthlyInterestRate * factor) / (factor - 1);
      monthlyInstallment = round2(rawPmt);

      let remainingPrincipal = financedPrincipal;
      let sumInterest = 0;
      let sumRepayment = 0;

      for (let k = 1; k <= n; k++) {
        const beginningPrincipal = round2(remainingPrincipal);
        const interestPaid = round2(beginningPrincipal * monthlyInterestRate);

        if (k < n) {
          const principalPaid = round2(Math.min(beginningPrincipal, monthlyInstallment - interestPaid));
          const monthlyPayment = round2(principalPaid + interestPaid);
          const endingPrincipal = round2(Math.max(0, beginningPrincipal - principalPaid));

          remainingPrincipal = endingPrincipal;
          sumInterest = round2(sumInterest + interestPaid);
          sumRepayment = round2(sumRepayment + monthlyPayment);

          schedule.push({
            installmentNo: k,
            beginningPrincipal,
            principalPaid,
            interestPaid,
            monthlyPayment,
            endingPrincipal,
          });
        } else {
          const principalPaid = beginningPrincipal;
          const monthlyPayment = round2(principalPaid + interestPaid);
          sumInterest = round2(sumInterest + interestPaid);
          sumRepayment = round2(sumRepayment + monthlyPayment);

          schedule.push({
            installmentNo: k,
            beginningPrincipal,
            principalPaid,
            interestPaid,
            monthlyPayment,
            endingPrincipal: 0,
          });
        }
      }

      totalInterest = round2(sumInterest);
      totalRepayment = round2(sumRepayment);
    }
  }

  return {
    summary: {
      computedAr,
      ar,
      isArOverridden,
      downPaymentPercentage,
      downPaymentAmount,
      financedPrincipal,
      totalInterest,
      totalRepayment,
      monthlyInstallment,
      monthlyInterestRate,
    },
    schedule,
    validationErrors,
  };
}

export function getBangkokParts(date: Date = new Date()): {
  year: string;
  yy: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
} {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  }

  const year = map.year || '2026';
  return {
    year,
    yy: year.slice(-2),
    month: map.month || '01',
    day: map.day || '01',
    hour: map.hour === '24' ? '00' : map.hour || '00',
    minute: map.minute || '00',
    second: map.second || '00',
  };
}

export function getBangkokYYMM(date: Date = new Date()): string {
  const p = getBangkokParts(date);
  return `${p.yy}${p.month}`;
}

export function formatBangkokDate(date: Date = new Date()): string {
  const p = getBangkokParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

export function formatBangkokTimestamp(date: Date = new Date()): string {
  const p = getBangkokParts(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

export function buildPdfFilename(contractId: string, transactionDate: string): string {
  const normalizedId = contractId.trim().replace(/-/g, '_');
  const compactDate = transactionDate.replace(/[^0-9]/g, '').slice(0, 8) || formatBangkokDate().replace(/-/g, '');
  return `${normalizedId}_${compactDate}.pdf`;
}

export function findDuplicateHistory(
  machineSerialNumber: string,
  originalContractNumber: string,
  transactions: RhpTransaction[],
  excludeContractId?: string
): DuplicateMatch[] {
  const normSerial = machineSerialNumber.trim().toLowerCase();
  const normOrig = originalContractNumber.trim().toLowerCase();

  if (!normSerial && !normOrig) return [];

  const matches: DuplicateMatch[] = [];
  for (const tx of transactions) {
    if (excludeContractId && tx.rhpContractId === excludeContractId) continue;

    const matchedFields: ('machineSerialNumber' | 'originalContractNumber')[] = [];
    if (normSerial && tx.machineSerialNumber.trim().toLowerCase() === normSerial) {
      matchedFields.push('machineSerialNumber');
    }
    if (normOrig && tx.originalContractNumber.trim().toLowerCase() === normOrig) {
      matchedFields.push('originalContractNumber');
    }

    if (matchedFields.length > 0) {
      matches.push({
        rhpContractId: tx.rhpContractId,
        customerId: tx.customerId,
        customerName: tx.customerName,
        machineSerialNumber: tx.machineSerialNumber,
        originalContractNumber: tx.originalContractNumber,
        transactionDate: tx.transactionDate,
        transactionStatus: tx.transactionStatus,
        matchedFields,
      });
    }
  }

  return matches;
}
