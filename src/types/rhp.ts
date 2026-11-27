export type InterestMethod = 'Flat Rate' | 'Reducing Balance';

export type InstallmentPeriod = 12 | 24 | 36 | 48 | 60;

export type TransactionStatus =
  | 'Draft'
  | 'Approved'
  | 'Rejected'
  | 'Revision Required'
  | 'Deleted';

export type DownPaymentMode = 'percentage' | 'amount';

export type UserRole = 'Super Admin' | 'Risk Control' | 'Approver' | 'Viewer';

export type AccountStatus =
  | 'Pending Verification'
  | 'Pending Approval'
  | 'Approved'
  | 'Rejected'
  | 'Suspended';

export interface CustomerInfo {
  customerId: string;
  customerName: string;
  machineSerialNumber: string;
  originalContractNumber: string;
}

export interface FinancialInput {
  machineCost: number;
  processingFee: number;
  arOverride: number | null;
  arOverrideReason: string;
  interestRate: number;
  interestMethod: InterestMethod;
  installmentPeriod: InstallmentPeriod;
  downPaymentMode: DownPaymentMode;
  downPaymentPercentage: number;
  downPaymentAmount: number;
}

export interface FinancialSummary {
  computedAr: number;
  ar: number;
  isArOverridden: boolean;
  downPaymentPercentage: number;
  downPaymentAmount: number;
  financedPrincipal: number;
  totalInterest: number;
  totalRepayment: number;
  monthlyInstallment: number;
  monthlyInterestRate: number;
}

export interface AmortizationRow {
  installmentNo: number;
  beginningPrincipal: number;
  principalPaid: number;
  interestPaid: number;
  monthlyPayment: number;
  endingPrincipal: number;
}

export interface DuplicateMatch {
  rhpContractId: string;
  customerId: string;
  customerName: string;
  machineSerialNumber: string;
  originalContractNumber: string;
  transactionDate: string;
  transactionStatus: TransactionStatus;
  matchedFields: ('machineSerialNumber' | 'originalContractNumber')[];
}

export interface RhpTransaction {
  timestamp: string;
  transactionDate: string;
  rhpContractId: string;
  customerId: string;
  customerName: string;
  machineSerialNumber: string;
  originalContractNumber: string;
  machineCost: number;
  processingFee: number;
  ar: number;
  interestRate: number;
  interestMethod: InterestMethod;
  installmentPeriod: InstallmentPeriod;
  downPaymentPercentage: number;
  downPaymentAmount: number;
  financedPrincipal: number;
  totalInterest: number;
  totalRepayment: number;
  monthlyInstallment: number;
  transactionStatus: TransactionStatus;
  createdBy: string;
  approvedBy: string;
  lastUpdated: string;
  duplicateReason?: string;
  arOverrideReason?: string;
  isDeleted?: boolean;
  deletedAt?: string;
  deletedBy?: string;
  deletionReason?: string;
  previousStatus?: 'Draft' | 'Approved';
}

export interface AuditLogEntry {
  timestamp: string;
  actor: string;
  targetContractId: string;
  fieldChanged: string;
  oldValue: string;
  newValue: string;
  reason: string;
}

export interface UserPermissionEntry {
  email: string;
  uid?: string;
  role: UserRole;
  accountStatus: AccountStatus;
  emailVerified: boolean;
  emailVerifiedAt?: string;
  registeredAt?: string;
  department?: string;
  requestNote?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewNote?: string;
  mfaEnabled?: boolean;
  mfaEnrolledAt?: string;
  authProvider?: string;
  canOverrideAr: boolean;
  canApprove: boolean;
  canDelete?: boolean;
  disabled?: boolean;
  displayName?: string;
}

export interface SystemConfig {
  contractIdPrefix: string;
  runningNumbers: Record<string, number>;
  defaultInterestMethod: InterestMethod;
  availableInstallmentPeriods: InstallmentPeriod[];
  downPaymentOptions: number[];
  companyName: string;
  companyAddress: string;
  companyLogoDataUrl: string | null;
  authorizedUsers: UserPermissionEntry[];
}

export interface SignatureNames {
  preparedByName: string;
  preparedByPosition: string;
  preparedDate: string;
  reviewedByName: string;
  reviewedByPosition: string;
  reviewedDate: string;
  approvedByName: string;
  approvedByPosition: string;
  approvedDate: string;
}

export type SheetsAuthMode = 'oauth' | 'service_account';

export type SheetsAuthStatus =
  | 'active'
  | 'refreshing'
  | 'needs_reauth'
  | 'revoked'
  | 'service_account'
  | 'disconnected'
  | 'error';

export type AuthErrorCode =
  | 'PORTAL_AUTH_REQUIRED'
  | 'PORTAL_SESSION_EXPIRED'
  | 'EMAIL_VERIFICATION_REQUIRED'
  | 'ACCOUNT_NOT_REGISTERED'
  | 'ACCOUNT_PENDING_APPROVAL'
  | 'ACCOUNT_REJECTED'
  | 'MFA_REQUIRED'
  | 'INITIAL_SETUP_CLOSED'
  | 'USER_DISABLED'
  | 'ACCESS_TOKEN_EXPIRED'
  | 'INVALID_TOKEN'
  | 'REFRESH_TOKEN_REVOKED'
  | 'INSUFFICIENT_PERMISSION'
  | 'SHEETS_API_UNAVAILABLE'
  | 'DUPLICATE_CONTRACT_ID'
  | 'NETWORK_ERROR'
  | 'UNKNOWN_ERROR';

export interface ConnectionStatus {
  connected: boolean;
  spreadsheetId: string | null;
  spreadsheetUrl: string | null;
  spreadsheetTitle: string | null;
  sheetsPresent: string[];
  lastSyncedAt: string | null;
  error: string | null;
  authMode?: SheetsAuthMode;
  sheetsAuthStatus?: SheetsAuthStatus;
  serviceAccountEmail?: string | null;
  oauthExpiresAt?: number | null;
  offlineOAuthConfigured?: boolean;
  hasRefreshToken?: boolean;
}

export const INSTALLMENT_PERIODS: InstallmentPeriod[] = [12, 24, 36, 48, 60];
export const DOWN_PAYMENT_PRESETS: number[] = [0, 5, 10, 15];
export const DEFAULT_INTEREST_RATES: number[] = [2.99, 3.5, 4.5, 5.0];
export const ALL_USER_ROLES: UserRole[] = [
  'Super Admin',
  'Risk Control',
  'Approver',
  'Viewer',
];
