import type { RhpTransaction } from '../types/rhp.ts';
import {
  formatBangkokDate,
  formatBangkokTimestamp,
  getBangkokYear,
} from './rhpCalculator.ts';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function formatAnnualRhpContractId(
  year: string,
  runningNumber: number,
  prefix = 'RHP'
): string {
  const cleanPrefix = (prefix || 'RHP').trim() || 'RHP';
  const safeSeq = Math.max(1, Math.floor(Number(runningNumber) || 1));
  return `${cleanPrefix} ${year}-${String(safeSeq).padStart(3, '0')}`;
}

export function isValidRhpContractId(contractId: string, prefix = 'RHP'): boolean {
  const trimmed = contractId.trim();
  const cleanPrefix = escapeRegExp((prefix || 'RHP').trim() || 'RHP');
  const annualPattern = new RegExp(`^${cleanPrefix} \\d{4}-\\d{3,}$`);
  const legacyPattern = new RegExp(`^${cleanPrefix}-\\d{4}-\\d{6}$`);
  return annualPattern.test(trimmed) || legacyPattern.test(trimmed);
}

export function parseAnnualRunningNumber(
  contractId: string,
  year: string,
  prefix = 'RHP'
): number | null {
  const cleanPrefix = escapeRegExp((prefix || 'RHP').trim() || 'RHP');
  const pattern = new RegExp(`^${cleanPrefix}\\s+${escapeRegExp(year)}-(\\d+)$`);
  const match = pattern.exec(contractId.trim());
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function parseMaxRunningForYear(
  transactions: Pick<RhpTransaction, 'rhpContractId'>[],
  reservedContractIds: string[],
  year: string,
  prefix = 'RHP'
): number {
  let maxSeq = 0;

  // Scan ALL transactions including Deleted/Soft-Deleted records so IDs are never reused
  for (const tx of transactions) {
    const seq = parseAnnualRunningNumber(tx.rhpContractId || '', year, prefix);
    if (seq !== null && seq > maxSeq) {
      maxSeq = seq;
    }
  }

  // Scan all previously reserved IDs so cancelled/abandoned drafts are never reused
  for (const reservedId of reservedContractIds) {
    const seq = parseAnnualRunningNumber(reservedId || '', year, prefix);
    if (seq !== null && seq > maxSeq) {
      maxSeq = seq;
    }
  }

  return maxSeq;
}

export function isDuplicateContractId(
  contractId: string,
  transactions: Pick<RhpTransaction, 'rhpContractId'>[]
): boolean {
  const target = contractId.trim().toUpperCase();
  if (!target) return false;
  // Intentionally checks ALL records (including Deleted / isDeleted)
  return transactions.some(
    (tx) => String(tx.rhpContractId || '').trim().toUpperCase() === target
  );
}

export interface ContractReservationResult {
  contractId: string;
  year: string;
  runningNumber: number;
  timestamp: string;
  transactionDate: string;
}

export function computeNextContractReservation(params: {
  now?: Date;
  prefix?: string;
  runningNumbers?: Record<string, number>;
  sheetRunningNumbers?: Record<string, number>;
  reservedContractIds?: string[];
  transactions?: Pick<RhpTransaction, 'rhpContractId'>[];
}): ContractReservationResult {
  const now = params.now ?? new Date();
  const prefix = (params.prefix || 'RHP').trim() || 'RHP';
  const year = getBangkokYear(now);
  const transactions = params.transactions ?? [];
  const reservedContractIds = params.reservedContractIds ?? [];

  const localSeq = Number(params.runningNumbers?.[year]) || 0;
  const sheetSeq = Number(params.sheetRunningNumbers?.[year]) || 0;
  const historicalMax = parseMaxRunningForYear(
    transactions,
    reservedContractIds,
    year,
    prefix
  );

  const usedIds = new Set<string>();
  for (const tx of transactions) {
    const id = String(tx.rhpContractId || '').trim().toUpperCase();
    if (id) usedIds.add(id);
  }
  for (const id of reservedContractIds) {
    const norm = String(id || '').trim().toUpperCase();
    if (norm) usedIds.add(norm);
  }

  let nextNumber = Math.max(localSeq, sheetSeq, historicalMax) + 1;
  let contractId = formatAnnualRhpContractId(year, nextNumber, prefix);

  while (usedIds.has(contractId.toUpperCase())) {
    nextNumber += 1;
    contractId = formatAnnualRhpContractId(year, nextNumber, prefix);
  }

  return {
    contractId,
    year,
    runningNumber: nextNumber,
    timestamp: formatBangkokTimestamp(now),
    transactionDate: formatBangkokDate(now),
  };
}
