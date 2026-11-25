export type InterestMethod = 'Flat Rate' | 'Reducing Balance';

export type InstallmentPeriod = 12 | 24 | 36 | 48 | 60;

export type TransactionStatus = 'Draft' | 'Approved';

export type DownPaymentMode = 'percentage' | 'amount';

export type UserRole = 'Staff' | 'Supervisor' | 'Admin';

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
  role: UserRole;
  canOverrideAr: boolean;
  canApprove: boolean;
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

export interface ConnectionStatus {
  connected: boolean;
  spreadsheetId: string | null;
  spreadsheetUrl: string | null;
  spreadsheetTitle: string | null;
  sheetsPresent: string[];
  lastSyncedAt: string | null;
  error: string | null;
}

export const INSTALLMENT_PERIODS: InstallmentPeriod[] = [12, 24, 36, 48, 60];
export const DOWN_PAYMENT_PRESETS: number[] = [0, 5, 10, 15];
export const DEFAULT_INTEREST_RATES: number[] = [2.99, 3.5, 4.5, 5.0];
