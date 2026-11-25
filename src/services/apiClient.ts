import { getAccessToken } from './firebaseAuth.ts';
import type {
  AmortizationRow,
  AuditLogEntry,
  FinancialInput,
  RhpTransaction,
  SignatureNames,
  SystemConfig,
  TransactionStatus,
  UserRole,
} from '../types/rhp.ts';

async function apiRequest<T>(
  url: string,
  options: RequestInit = {},
  requireAuth = true
): Promise<T> {
  const token = getAccessToken();
  if (requireAuth && !token) {
    throw new Error('กรุณาเข้าสู่ระบบด้วยบัญชี Google ก่อนดำเนินการ');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(url, { ...options, headers });
  const contentType = res.headers.get('content-type') || '';

  if (contentType.includes('application/pdf')) {
    if (!res.ok) {
      throw new Error('ไม่สามารถสร้างเอกสาร PDF ได้');
    }
    return (await res.blob()) as unknown as T;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `เกิดข้อผิดพลาด (${res.status})`);
  }
  return data as T;
}

export interface SheetsStatusResponse {
  connected: boolean;
  spreadsheetId: string | null;
  spreadsheetUrl: string | null;
  spreadsheetTitle: string | null;
  config: SystemConfig;
}

export interface DatabaseLoadResponse {
  connected: boolean;
  spreadsheetId: string;
  spreadsheetUrl: string;
  spreadsheetTitle: string;
  sheetsPresent: string[];
  transactions: RhpTransaction[];
  schedulesByContract: Record<string, AmortizationRow[]>;
  config: SystemConfig;
  auditLogs: AuditLogEntry[];
}

export interface UserAuthProfile {
  email: string;
  role: UserRole;
  canOverrideAr: boolean;
  canApprove: boolean;
}

export interface ReserveContractResponse {
  contractId: string;
  yymm: string;
  runningNumber: number;
  timestamp: string;
  transactionDate: string;
}

export interface SheetsTestResponse {
  ok: boolean;
  latencyMs: number;
  spreadsheetId: string;
  spreadsheetTitle: string;
  sheetsPresent: string[];
  counts: {
    transactions: number;
    amortizationContracts: number;
    auditLogs: number;
  };
}

export const apiClient = {
  getSheetsStatus: () => apiRequest<SheetsStatusResponse>('/api/sheets/status', {}, false),

  getAuthProfile: () => apiRequest<UserAuthProfile>('/api/auth/me', {}, true),

  initDatabase: () => apiRequest<DatabaseLoadResponse>('/api/sheets/init', { method: 'POST' }, true),

  connectDatabase: (spreadsheetId: string) =>
    apiRequest<DatabaseLoadResponse>(
      '/api/sheets/connect',
      { method: 'POST', body: JSON.stringify({ spreadsheetId }) },
      true
    ),

  disconnectDatabase: () =>
    apiRequest<{ connected: boolean }>('/api/sheets/disconnect', { method: 'POST' }, true),

  testConnection: () =>
    apiRequest<SheetsTestResponse>('/api/sheets/test', { method: 'POST' }, true),

  loadDatabase: () => apiRequest<DatabaseLoadResponse>('/api/sheets/data', {}, true),

  reserveContractId: () =>
    apiRequest<ReserveContractResponse>('/api/contracts/reserve-id', { method: 'POST' }, false),

  createTransaction: (payload: {
    rhpContractId: string;
    customerId: string;
    customerName: string;
    machineSerialNumber: string;
    originalContractNumber: string;
    financialInput: FinancialInput;
    transactionStatus: TransactionStatus;
    duplicateReason?: string;
  }) =>
    apiRequest<{
      transaction: RhpTransaction;
      schedule: AmortizationRow[];
      auditEntries: AuditLogEntry[];
    }>(
      '/api/sheets/transactions',
      { method: 'POST', body: JSON.stringify(payload) },
      true
    ),

  updateTransaction: (
    contractId: string,
    payload: {
      action: 'approve' | 'update' | 'amend';
      amendmentReason?: string;
      customerId?: string;
      customerName?: string;
      machineSerialNumber?: string;
      originalContractNumber?: string;
      financialInput?: FinancialInput;
    }
  ) =>
    apiRequest<{
      transaction: RhpTransaction;
      schedule: AmortizationRow[];
      auditEntries: AuditLogEntry[];
    }>(
      `/api/sheets/transactions/${encodeURIComponent(contractId)}`,
      { method: 'PUT', body: JSON.stringify(payload) },
      true
    ),

  updateConfig: (config: Partial<SystemConfig>) =>
    apiRequest<{ config: SystemConfig }>(
      '/api/sheets/config',
      { method: 'POST', body: JSON.stringify(config) },
      true
    ),

  generatePdfBlob: async (payload: {
    transaction: RhpTransaction;
    schedule: AmortizationRow[];
    signatures?: Partial<SignatureNames>;
  }): Promise<{ blob: Blob; filename: string }> => {
    const res = await fetch('/api/pdf/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { error?: string }).error || 'ไม่สามารถสร้างเอกสาร PDF ได้');
    }

    const blob = await res.blob();
    const filename =
      res.headers.get('X-RHP-Filename') ||
      `${payload.transaction.rhpContractId.replace(/-/g, '_')}_${payload.transaction.transactionDate.replace(/-/g, '')}.pdf`;
    return { blob, filename };
  },
};
