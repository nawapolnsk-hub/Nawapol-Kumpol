import { getFirebaseIdToken, sheetsOAuthManager } from './firebaseAuth.ts';
import type {
  AccountStatus,
  AmortizationRow,
  AuditLogEntry,
  AuthErrorCode,
  FinancialInput,
  RhpTransaction,
  SheetsAuthMode,
  SignatureNames,
  SystemConfig,
  TransactionStatus,
  UserPermissionEntry,
  UserRole,
} from '../types/rhp.ts';

export interface ApiClientErrorDetails {
  duplicateContractId?: string;
  newContractId?: string;
  newTimestamp?: string;
  newTransactionDate?: string;
}

export class ApiClientError extends Error {
  status: number;
  errorCode: AuthErrorCode;
  requiresSheetsReconnect: boolean;
  details?: ApiClientErrorDetails;

  constructor(
    message: string,
    status: number,
    errorCode: AuthErrorCode = 'UNKNOWN_ERROR',
    requiresSheetsReconnect = false,
    details?: ApiClientErrorDetails
  ) {
    super(message);
    this.status = status;
    this.errorCode = errorCode;
    this.requiresSheetsReconnect = requiresSheetsReconnect;
    this.details = details;
  }
}

type AuthScope = 'none' | 'portal' | 'sheets';

let onUserDisabledCallback: ((message: string) => void) | null = null;

export function registerUserDisabledHandler(handler: (message: string) => void): void {
  onUserDisabledCallback = handler;
}

async function apiRequest<T>(
  url: string,
  options: RequestInit = {},
  authScope: AuthScope = 'sheets',
  retryAttempt = 0
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };

  if (authScope === 'portal' || authScope === 'sheets') {
    const idToken = await getFirebaseIdToken(false);
    if (!idToken) {
      throw new ApiClientError(
        'กรุณาเข้าสู่ระบบ RHP Portal ก่อนดำเนินการ',
        401,
        'PORTAL_AUTH_REQUIRED',
        false
      );
    }
    headers.Authorization = `Bearer ${idToken}`;
  }

  if (authScope === 'sheets') {
    const oauthState = sheetsOAuthManager.getState();
    if (oauthState.authMode !== 'service_account') {
      await sheetsOAuthManager.ensureValidAccessToken(false);
      const snap = sheetsOAuthManager.getHeaderTokenSnapshot();
      if (snap.accessToken) {
        headers['X-Google-Access-Token'] = snap.accessToken;
        if (snap.expiresAtMs) {
          headers['X-Google-Token-Expires-At'] = String(snap.expiresAtMs);
        }
      }
    }
  }

  let res: Response;
  try {
    res = await fetch(url, { ...options, headers });
  } catch {
    throw new ApiClientError(
      'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์หรือเครือข่ายได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่อีกครั้ง (ข้อมูลที่กรอกยังคงอยู่)',
      0,
      'NETWORK_ERROR',
      false
    );
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/pdf')) {
    if (!res.ok) {
      throw new ApiClientError('ไม่สามารถสร้างเอกสาร PDF ได้', res.status, 'UNKNOWN_ERROR', false);
    }
    return (await res.blob()) as unknown as T;
  }

  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    errorCode?: AuthErrorCode;
    requiresSheetsReconnect?: boolean;
    duplicateContractId?: string;
    newContractId?: string;
    newTimestamp?: string;
    newTransactionDate?: string;
  };

  if (!res.ok) {
    const errorCode: AuthErrorCode = data.errorCode || 'UNKNOWN_ERROR';
    const message = data.error || `เกิดข้อผิดพลาด (${res.status})`;
    const conflictDetails: ApiClientErrorDetails | undefined =
      data.duplicateContractId || data.newContractId
        ? {
            duplicateContractId: data.duplicateContractId,
            newContractId: data.newContractId,
            newTimestamp: data.newTimestamp,
            newTransactionDate: data.newTransactionDate,
          }
        : undefined;

    // 403 User suspended -> notify app immediately, never retry
    if (res.status === 403 && errorCode === 'USER_DISABLED') {
      onUserDisabledCallback?.(message);
      throw new ApiClientError(message, 403, 'USER_DISABLED', false);
    }

    // 403 Onboarding / MFA / Permission Errors -> preserve exact errorCode
    if (res.status === 403) {
      throw new ApiClientError(
        message,
        403,
        errorCode === 'UNKNOWN_ERROR' ? 'INSUFFICIENT_PERMISSION' : errorCode,
        false
      );
    }

    // 401 Portal Firebase ID Token expired -> force refresh Firebase ID Token & retry once
    if (res.status === 401 && errorCode === 'PORTAL_SESSION_EXPIRED' && retryAttempt === 0) {
      const freshIdToken = await getFirebaseIdToken(true);
      if (freshIdToken) {
        return apiRequest<T>(url, options, authScope, 1);
      }
    }

    // 401 Google Sheets Access Token expired -> attempt single-flight refresh & retry once
    if (
      res.status === 401 &&
      authScope === 'sheets' &&
      (errorCode === 'ACCESS_TOKEN_EXPIRED' || errorCode === 'INVALID_TOKEN') &&
      retryAttempt === 0
    ) {
      const refreshedToken = await sheetsOAuthManager.ensureValidAccessToken(true);
      if (refreshedToken || sheetsOAuthManager.hasUsableSheetsAccess()) {
        return apiRequest<T>(url, options, authScope, 1);
      }
      sheetsOAuthManager.markNeedsReauth(false, message);
      throw new ApiClientError(message, 401, errorCode, true);
    }

    // 401 Refresh Token revoked -> mark revoked cleanly without logging out Firebase
    if (errorCode === 'REFRESH_TOKEN_REVOKED') {
      sheetsOAuthManager.markNeedsReauth(true, message);
      throw new ApiClientError(message, 401, 'REFRESH_TOKEN_REVOKED', true);
    }

    if (data.requiresSheetsReconnect || errorCode === 'ACCESS_TOKEN_EXPIRED') {
      sheetsOAuthManager.markNeedsReauth(false, message);
      throw new ApiClientError(message, res.status, errorCode, true);
    }

    if (res.status >= 500 || res.status === 429) {
      throw new ApiClientError(
        message,
        res.status,
        errorCode === 'UNKNOWN_ERROR' ? 'SHEETS_API_UNAVAILABLE' : errorCode,
        false
      );
    }

    throw new ApiClientError(message, res.status, errorCode, false, conflictDetails);
  }

  return data as T;
}

export interface SheetsStatusResponse {
  connected: boolean;
  spreadsheetId: string | null;
  spreadsheetUrl: string | null;
  spreadsheetTitle: string | null;
  authMode: SheetsAuthMode;
  serviceAccountEmail: string | null;
  offlineOAuthConfigured: boolean;
  initialSetupRequired?: boolean;
  config: SystemConfig;
}

export interface DatabaseLoadResponse {
  connected: boolean;
  spreadsheetId: string;
  spreadsheetUrl: string;
  spreadsheetTitle: string;
  sheetsPresent: string[];
  authMode?: SheetsAuthMode;
  serviceAccountEmail?: string | null;
  transactions: RhpTransaction[];
  schedulesByContract: Record<string, AmortizationRow[]>;
  config: SystemConfig;
  auditLogs: AuditLogEntry[];
}

export interface UserAuthProfile {
  uid?: string;
  email: string;
  displayName?: string;
  role: UserRole;
  accountStatus?: AccountStatus;
  emailVerified?: boolean;
  canOverrideAr: boolean;
  canApprove: boolean;
  canDelete: boolean;
  canCreateContract?: boolean;
  canEditDraft?: boolean;
  canManageUsers?: boolean;
  canManageSettings?: boolean;
  canExportPdf?: boolean;
  mfaRequired?: boolean;
  mfaEnrolled?: boolean;
  mfaVerified?: boolean;
  authMode?: SheetsAuthMode;
  serviceAccountEmail?: string | null;
  offlineOAuthConfigured?: boolean;
  oauthStatus?: {
    connected: boolean;
    hasAccessToken: boolean;
    expiresAtMs: number | null;
    hasRefreshToken: boolean;
    revoked: boolean;
    revokedReason?: string;
  };
  connectionSummary?: {
    connected: boolean;
    spreadsheetId: string | null;
    spreadsheetUrl: string | null;
    spreadsheetTitle: string | null;
  };
  config?: SystemConfig;
}

export interface SessionStatusResponse
  extends Partial<Omit<UserAuthProfile, 'accountStatus'>> {
  uid: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
  signInProvider: string;
  registered: boolean;
  accountStatus: AccountStatus | 'Unregistered';
  role: UserRole;
  department?: string;
  requestNote?: string;
  registeredAt?: string;
  emailVerifiedAt?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewNote?: string;
  mfaRequired: boolean;
  mfaEnrolled: boolean;
  mfaVerified: boolean;
  canAccessPortal: boolean;
  initialSetupRequired: boolean;
}

export interface MfaEnrollInitResponse {
  secretBase32: string;
  otpauthUrl: string;
  qrCodeDataUrl: string;
  issuer: string;
  accountName: string;
}

export interface AdminUsersResponse {
  users: UserPermissionEntry[];
  userAuditLogs: AuditLogEntry[];
  initialSetupCompleted: boolean;
}

export interface ReserveContractResponse {
  contractId: string;
  year: string;
  yymm?: string;
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
  getSheetsStatus: () => apiRequest<SheetsStatusResponse>('/api/sheets/status', {}, 'none'),

  getSessionStatus: () => apiRequest<SessionStatusResponse>('/api/auth/session-status', {}, 'portal'),

  registerRequest: (payload: {
    displayName?: string;
    department?: string;
    requestNote?: string;
  }) =>
    apiRequest<{ entry: UserPermissionEntry; alreadyApproved: boolean }>(
      '/api/auth/register-request',
      { method: 'POST', body: JSON.stringify(payload) },
      'portal'
    ),

  submitInitialAdminSetup: (payload: { setupToken: string; displayName?: string }) =>
    apiRequest<{ ok: boolean; user: UserPermissionEntry }>(
      '/api/auth/initial-admin-setup',
      { method: 'POST', body: JSON.stringify(payload) },
      'portal'
    ),

  initMfaEnrollment: () =>
    apiRequest<MfaEnrollInitResponse>('/api/auth/mfa/enroll-init', { method: 'POST' }, 'portal'),

  verifyMfaCode: (payload: { code: string; mode: 'enroll' | 'login' }) =>
    apiRequest<{ ok: boolean; mfaEnrolled: boolean; mfaVerified: boolean }>(
      '/api/auth/mfa/verify',
      { method: 'POST', body: JSON.stringify(payload) },
      'portal'
    ),

  getAuthProfile: () => apiRequest<UserAuthProfile>('/api/auth/me', {}, 'portal'),

  getAdminUsers: () => apiRequest<AdminUsersResponse>('/api/admin/users', {}, 'portal'),

  reviewAdminUser: (
    email: string,
    payload: {
      action: 'approve' | 'reject' | 'suspend' | 'reactivate' | 'change_role' | 'reset_mfa';
      role?: UserRole;
      reviewNote?: string;
      canOverrideAr?: boolean;
      canDelete?: boolean;
    }
  ) =>
    apiRequest<{ user: UserPermissionEntry; auditEntry: AuditLogEntry }>(
      `/api/admin/users/${encodeURIComponent(email)}/review`,
      { method: 'POST', body: JSON.stringify(payload) },
      'portal'
    ),

  getMergedAuditLogs: () =>
    apiRequest<{ auditLogs: AuditLogEntry[] }>('/api/audit-logs', {}, 'portal'),

  getOAuthStatus: () =>
    apiRequest<{
      authMode: SheetsAuthMode;
      serviceAccountEmail: string | null;
      offlineOAuthConfigured: boolean;
      connected: boolean;
      hasAccessToken: boolean;
      expiresAtMs: number | null;
      hasRefreshToken: boolean;
      revoked: boolean;
      revokedReason?: string;
    }>('/api/oauth/status', {}, 'portal'),

  initDatabase: () => apiRequest<DatabaseLoadResponse>('/api/sheets/init', { method: 'POST' }, 'sheets'),

  connectDatabase: (spreadsheetId: string) =>
    apiRequest<DatabaseLoadResponse>(
      '/api/sheets/connect',
      { method: 'POST', body: JSON.stringify({ spreadsheetId }) },
      'sheets'
    ),

  disconnectDatabase: () =>
    apiRequest<{ connected: boolean }>('/api/sheets/disconnect', { method: 'POST' }, 'portal'),

  testConnection: () =>
    apiRequest<SheetsTestResponse>('/api/sheets/test', { method: 'POST' }, 'sheets'),

  loadDatabase: () => apiRequest<DatabaseLoadResponse>('/api/sheets/data', {}, 'sheets'),

  reserveContractId: () =>
    apiRequest<ReserveContractResponse>('/api/contracts/reserve-id', { method: 'POST' }, 'portal'),

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
      'sheets'
    ),

  updateTransaction: (
    contractId: string,
    payload: {
      action: 'approve' | 'reject' | 'send_back' | 'update' | 'amend';
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
      'sheets'
    ),

  softDeleteTransaction: (contractId: string, reason: string) =>
    apiRequest<{
      transaction: RhpTransaction;
      auditEntries: AuditLogEntry[];
    }>(
      `/api/sheets/transactions/${encodeURIComponent(contractId)}`,
      { method: 'DELETE', body: JSON.stringify({ reason }) },
      'sheets'
    ),

  restoreTransaction: (contractId: string, reason?: string) =>
    apiRequest<{
      transaction: RhpTransaction;
      auditEntries: AuditLogEntry[];
    }>(
      `/api/sheets/transactions/${encodeURIComponent(contractId)}/restore`,
      { method: 'POST', body: JSON.stringify({ reason }) },
      'sheets'
    ),

  updateConfig: (config: Partial<SystemConfig>) =>
    apiRequest<{ config: SystemConfig }>(
      '/api/sheets/config',
      { method: 'POST', body: JSON.stringify(config) },
      'portal'
    ),

  generatePdfBlob: async (payload: {
    transaction: RhpTransaction;
    schedule: AmortizationRow[];
    signatures?: Partial<SignatureNames>;
  }): Promise<{ blob: Blob; filename: string }> => {
    let idToken = await getFirebaseIdToken(false);
    if (!idToken) {
      throw new Error('กรุณาเข้าสู่ระบบ RHP Portal ก่อนสร้างเอกสาร PDF');
    }

    let res = await fetch('/api/pdf/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify(payload),
    });

    if (res.status === 401) {
      const freshToken = await getFirebaseIdToken(true);
      if (freshToken) {
        res = await fetch('/api/pdf/generate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${freshToken}`,
          },
          body: JSON.stringify(payload),
        });
      }
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as { error?: string }).error || 'ไม่สามารถสร้างเอกสาร PDF ได้');
    }

    const blob = await res.blob();
    const filename =
      res.headers.get('X-RHP-Filename') ||
      `${payload.transaction.rhpContractId.trim().replace(/[\s-]+/g, '_')}_${payload.transaction.transactionDate.replace(/-/g, '')}.pdf`;
    return { blob, filename };
  },
};
