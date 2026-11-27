import type {
  AccountStatus,
  AuditLogEntry,
  RhpTransaction,
  UserPermissionEntry,
  UserRole,
} from '../types/rhp.ts';

export interface ResolvedUserPermissions {
  registered: boolean;
  role: UserRole;
  accountStatus: AccountStatus | 'Unregistered';
  emailVerified: boolean;
  canOverrideAr: boolean;
  canApprove: boolean;
  canDelete: boolean;
  canCreateContract: boolean;
  canEditDraft: boolean;
  canManageUsers: boolean;
  canManageSettings: boolean;
  canExportPdf: boolean;
  mfaRequired: boolean;
  disabled?: boolean;
}

export class LifecycleRuleError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function normalizeUserRole(rawRole: unknown): UserRole {
  const s = String(rawRole || '').trim();
  if (s === 'Super Admin' || s === 'Admin') return 'Super Admin';
  if (s === 'Approver' || s === 'Supervisor') return 'Approver';
  if (s === 'Risk Control' || s === 'Staff') return 'Risk Control';
  if (s === 'Viewer') return 'Viewer';
  return 'Viewer';
}

export function normalizeAccountStatus(
  rawStatus: unknown,
  disabled?: boolean
): AccountStatus {
  if (disabled) return 'Suspended';
  const s = String(rawStatus || '').trim();
  if (
    s === 'Pending Verification' ||
    s === 'Pending Approval' ||
    s === 'Approved' ||
    s === 'Rejected' ||
    s === 'Suspended'
  ) {
    return s;
  }
  // Legacy entries stored prior to approval workflow were pre-approved
  return 'Approved';
}

export function getDefaultRoleCapabilities(role: UserRole): {
  canOverrideAr: boolean;
  canApprove: boolean;
  canDelete: boolean;
  canCreateContract: boolean;
  canEditDraft: boolean;
  canManageUsers: boolean;
  canManageSettings: boolean;
  canExportPdf: boolean;
  mfaRequired: boolean;
} {
  switch (role) {
    case 'Super Admin':
      return {
        canOverrideAr: true,
        canApprove: true,
        canDelete: true,
        canCreateContract: true,
        canEditDraft: true,
        canManageUsers: true,
        canManageSettings: true,
        canExportPdf: true,
        mfaRequired: true,
      };
    case 'Approver':
      return {
        canOverrideAr: true,
        canApprove: true,
        canDelete: false,
        canCreateContract: false,
        canEditDraft: false,
        canManageUsers: false,
        canManageSettings: false,
        canExportPdf: true,
        mfaRequired: true,
      };
    case 'Risk Control':
      return {
        canOverrideAr: false,
        canApprove: false,
        canDelete: false,
        canCreateContract: true,
        canEditDraft: true,
        canManageUsers: false,
        canManageSettings: false,
        canExportPdf: true,
        mfaRequired: false,
      };
    case 'Viewer':
    default:
      return {
        canOverrideAr: false,
        canApprove: false,
        canDelete: false,
        canCreateContract: false,
        canEditDraft: false,
        canManageUsers: false,
        canManageSettings: false,
        canExportPdf: true,
        mfaRequired: false,
      };
  }
}

export function normalizeUserEntry(raw: Partial<UserPermissionEntry>): UserPermissionEntry {
  const email = String(raw.email || '').trim().toLowerCase();
  const role = normalizeUserRole(raw.role);
  const accountStatus = normalizeAccountStatus(raw.accountStatus, raw.disabled);
  const defaults = getDefaultRoleCapabilities(role);

  return {
    email,
    uid: raw.uid,
    role,
    accountStatus,
    emailVerified: raw.emailVerified !== undefined ? Boolean(raw.emailVerified) : accountStatus !== 'Pending Verification',
    emailVerifiedAt: raw.emailVerifiedAt,
    registeredAt: raw.registeredAt,
    department: raw.department,
    requestNote: raw.requestNote,
    reviewedAt: raw.reviewedAt,
    reviewedBy: raw.reviewedBy,
    reviewNote: raw.reviewNote,
    mfaEnabled: Boolean(raw.mfaEnabled),
    mfaEnrolledAt: raw.mfaEnrolledAt,
    authProvider: raw.authProvider,
    canOverrideAr:
      role === 'Super Admin'
        ? true
        : role === 'Viewer'
          ? false
          : raw.canOverrideAr ?? defaults.canOverrideAr,
    canApprove:
      role === 'Super Admin' || role === 'Approver'
        ? true
        : false,
    canDelete:
      role === 'Super Admin'
        ? true
        : role === 'Viewer'
          ? false
          : Boolean(raw.canDelete ?? defaults.canDelete),
    disabled: accountStatus === 'Suspended' || Boolean(raw.disabled),
    displayName: raw.displayName || email,
  };
}

export function resolvePermissionsFromRegistry(
  email: string,
  authorizedUsers: UserPermissionEntry[]
): ResolvedUserPermissions {
  const norm = email.trim().toLowerCase();
  const foundRaw = authorizedUsers.find((u) => u.email.trim().toLowerCase() === norm);
  if (!foundRaw) {
    return {
      registered: false,
      role: 'Viewer',
      accountStatus: 'Unregistered',
      emailVerified: false,
      canOverrideAr: false,
      canApprove: false,
      canDelete: false,
      canCreateContract: false,
      canEditDraft: false,
      canManageUsers: false,
      canManageSettings: false,
      canExportPdf: false,
      mfaRequired: false,
      disabled: true,
    };
  }

  const found = normalizeUserEntry(foundRaw);
  const defaults = getDefaultRoleCapabilities(found.role);
  const isApproved = found.accountStatus === 'Approved' && !found.disabled;

  return {
    registered: true,
    role: found.role,
    accountStatus: found.accountStatus,
    emailVerified: found.emailVerified,
    canOverrideAr: isApproved && found.canOverrideAr,
    canApprove: isApproved && found.canApprove,
    canDelete: isApproved && Boolean(found.canDelete),
    canCreateContract: isApproved && defaults.canCreateContract,
    canEditDraft: isApproved && defaults.canEditDraft,
    canManageUsers: isApproved && defaults.canManageUsers,
    canManageSettings: isApproved && defaults.canManageSettings,
    canExportPdf: isApproved && defaults.canExportPdf,
    mfaRequired: defaults.mfaRequired,
    disabled: found.accountStatus === 'Suspended' || Boolean(found.disabled),
  };
}

export function canUserDeleteTransaction(
  perms: Pick<ResolvedUserPermissions, 'role' | 'canDelete'> | null | undefined,
  tx: RhpTransaction
): boolean {
  if (!perms) return false;
  if (tx.isDeleted || tx.transactionStatus === 'Deleted') return false;
  if (perms.role === 'Super Admin') return true;
  if (!perms.canDelete) return false;
  // Approved transactions require Super Admin privileges with explicit reason
  if (tx.transactionStatus === 'Approved') return false;
  return true;
}

export function buildSoftDeleteTransition(params: {
  existingTx: RhpTransaction;
  actorEmail: string;
  perms: Pick<ResolvedUserPermissions, 'role' | 'canDelete'>;
  reason: string;
  timestamp: string;
}): { deletedTx: RhpTransaction; auditEntries: AuditLogEntry[] } {
  const { existingTx, actorEmail, perms, reason, timestamp } = params;

  if (existingTx.isDeleted || existingTx.transactionStatus === 'Deleted') {
    throw new LifecycleRuleError('รายการปรับโครงสร้างสัญญานี้ถูกลบไปแล้ว', 400);
  }

  if (perms.role !== 'Super Admin' && !perms.canDelete) {
    throw new LifecycleRuleError('คุณไม่มีสิทธิ์ลบรายการปรับโครงสร้างสัญญา', 403);
  }

  if (existingTx.transactionStatus === 'Approved' && perms.role !== 'Super Admin') {
    throw new LifecycleRuleError(
      'รายการที่อนุมัติแล้ว (Approved) สามารถลบได้เฉพาะ Super Admin เท่านั้น',
      403
    );
  }

  const trimmedReason = reason.trim();
  if (!trimmedReason) {
    throw new LifecycleRuleError('กรุณาระบุเหตุผลในการลบรายการเพื่อบันทึก Audit Log', 400);
  }

  const previousStatus: 'Draft' | 'Approved' =
    existingTx.transactionStatus === 'Approved' ? 'Approved' : 'Draft';

  const deletedTx: RhpTransaction = {
    ...existingTx,
    previousStatus,
    transactionStatus: 'Deleted',
    isDeleted: true,
    deletedAt: timestamp,
    deletedBy: actorEmail,
    deletionReason: trimmedReason,
    lastUpdated: timestamp,
  };

  const auditEntries: AuditLogEntry[] = [
    {
      timestamp,
      actor: actorEmail,
      targetContractId: existingTx.rhpContractId,
      fieldChanged: 'Transaction Soft Delete',
      oldValue: previousStatus,
      newValue: 'Deleted',
      reason: trimmedReason,
    },
  ];

  return { deletedTx, auditEntries };
}

export function buildRestoreTransition(params: {
  existingTx: RhpTransaction;
  actorEmail: string;
  perms: Pick<ResolvedUserPermissions, 'role'>;
  reason?: string;
  timestamp: string;
}): { restoredTx: RhpTransaction; auditEntries: AuditLogEntry[] } {
  const { existingTx, actorEmail, perms, reason, timestamp } = params;

  if (perms.role !== 'Super Admin') {
    throw new LifecycleRuleError(
      'เฉพาะ Super Admin เท่านั้นที่สามารถกู้คืนรายการที่ถูกลบได้',
      403
    );
  }

  if (!existingTx.isDeleted && existingTx.transactionStatus !== 'Deleted') {
    throw new LifecycleRuleError('รายการนี้ไม่ได้อยู่ในสถานะถูกลบ ไม่สามารถกู้คืนได้', 400);
  }

  const restoredStatus: 'Draft' | 'Approved' =
    existingTx.previousStatus || (existingTx.approvedBy ? 'Approved' : 'Draft');

  const trimmedReason =
    (reason || '').trim() || 'กู้คืนรายการปรับโครงสร้างสัญญาโดย Super Admin';

  const restoredTx: RhpTransaction = {
    ...existingTx,
    transactionStatus: restoredStatus,
    isDeleted: false,
    deletedAt: '',
    deletedBy: '',
    deletionReason: '',
    previousStatus: undefined,
    lastUpdated: timestamp,
  };

  const auditEntries: AuditLogEntry[] = [
    {
      timestamp,
      actor: actorEmail,
      targetContractId: existingTx.rhpContractId,
      fieldChanged: 'Transaction Restore',
      oldValue: 'Deleted',
      newValue: restoredStatus,
      reason: trimmedReason,
    },
  ];

  return { restoredTx, auditEntries };
}
