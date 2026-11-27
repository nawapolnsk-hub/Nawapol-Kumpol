import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  FirebaseTokenError,
  verifyFirebaseIdToken,
  type VerifiedFirebaseClaims,
} from './src/server/firebaseTokenVerifier.ts';
import { defaultMfaService } from './src/server/mfaService.ts';
import { generateRhpPdfBuffer } from './src/server/pdfGenerator.ts';
import { defaultServiceAccountManager } from './src/server/serviceAccountAuth.ts';
import {
  appendAuditLogsToSheet,
  appendTransactionToSheet,
  createRhpDatabaseSpreadsheet,
  ensureHeadersAndDefaults,
  findExistingDatabaseSpreadsheet,
  getSpreadsheetMetadata,
  readAllDatabaseData,
  SheetsApiError,
  updateTransactionInSheet,
  updateTransactionStatusOnlyInSheet,
  writeConfigToSheet,
} from './src/server/sheetsService.ts';
import { defaultTokenVault, TokenVaultError } from './src/server/tokenVault.ts';
import {
  ALL_USER_ROLES,
  type AccountStatus,
  type AmortizationRow,
  type AuditLogEntry,
  type AuthErrorCode,
  type FinancialInput,
  type InstallmentPeriod,
  type InterestMethod,
  type RhpTransaction,
  type SheetsAuthMode,
  type SignatureNames,
  type SystemConfig,
  type TransactionStatus,
  type UserPermissionEntry,
  type UserRole,
} from './src/types/rhp.ts';
import {
  buildPdfFilename,
  calculateRhpFinancials,
  formatBangkokDate,
  formatBangkokTimestamp,
  getBangkokYear,
} from './src/utils/rhpCalculator.ts';
import {
  computeNextContractReservation,
  isDuplicateContractId,
  isValidRhpContractId,
  parseAnnualRunningNumber,
} from './src/utils/contractIdGenerator.ts';
import {
  buildRestoreTransition,
  buildSoftDeleteTransition,
  getDefaultRoleCapabilities,
  LifecycleRuleError,
  normalizeUserEntry,
  normalizeUserRole,
  resolvePermissionsFromRegistry,
} from './src/utils/transactionLifecycle.ts';

const PORT = Number(process.env.PORT) || 3000;

function resolveWritableDataDir(): string {
  const preferred = path.resolve(process.cwd(), 'data');
  try {
    if (!fs.existsSync(preferred)) {
      fs.mkdirSync(preferred, { recursive: true });
    }
    fs.accessSync(preferred, fs.constants.W_OK);
    return preferred;
  } catch {
    const fallback = path.join(os.tmpdir(), 'rhp-portal-data');
    if (!fs.existsSync(fallback)) {
      fs.mkdirSync(fallback, { recursive: true });
    }
    return fallback;
  }
}

const DATA_DIR = resolveWritableDataDir();
const STATE_FILE = path.join(DATA_DIR, 'server-state.json');

interface FirebaseConfigFile {
  projectId: string;
  oAuthClientId?: string;
}

function loadFirebaseProjectConfig(): FirebaseConfigFile {
  try {
    const cfgPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    const raw = fs.readFileSync(cfgPath, 'utf8');
    return JSON.parse(raw) as FirebaseConfigFile;
  } catch {
    return { projectId: 'gen-lang-client-0027664088' };
  }
}

const FIREBASE_CONFIG = loadFirebaseProjectConfig();
const OAUTH_STATE_SIGNING_KEY = crypto.randomBytes(32);

interface ServerState {
  spreadsheetId: string | null;
  spreadsheetUrl: string | null;
  spreadsheetTitle: string | null;
  runningNumbers: Record<string, number>;
  reservedContractIds: string[];
  initialSetupCompleted: boolean;
  initialSetupTokenHash: string | null;
  securityAuditLogs: AuditLogEntry[];
  config: SystemConfig;
}

const DEFAULT_CONFIG: SystemConfig = {
  contractIdPrefix: 'RHP',
  runningNumbers: {},
  defaultInterestMethod: 'Flat Rate',
  availableInstallmentPeriods: [12, 24, 36, 48, 60],
  downPaymentOptions: [0, 5, 10, 15],
  companyName: 'บริษัท สินเชื่อเครื่องจักรอุตสาหกรรม จำกัด (ฝ่าย Risk Control)',
  companyAddress: 'ฝ่ายควบคุมความเสี่ยงและปรับโครงสร้างหนี้ (Restructuring Hire Purchase)',
  companyLogoDataUrl: null,
  authorizedUsers: [],
};

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function hashSetupToken(token: string): string {
  return crypto.createHash('sha256').update(token.trim(), 'utf8').digest('hex');
}

function loadServerState(): ServerState {
  ensureDataDir();
  if (fs.existsSync(STATE_FILE)) {
    try {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw) as Partial<ServerState>;
      const normalizedUsers = Array.isArray(parsed.config?.authorizedUsers)
        ? parsed.config!.authorizedUsers.map((u) => normalizeUserEntry(u))
        : [];
      const hasActiveSuperAdmin = normalizedUsers.some(
        (u) => u.role === 'Super Admin' && u.accountStatus === 'Approved' && !u.disabled
      );

      return {
        spreadsheetId: parsed.spreadsheetId ?? null,
        spreadsheetUrl: parsed.spreadsheetUrl ?? null,
        spreadsheetTitle: parsed.spreadsheetTitle ?? null,
        runningNumbers: parsed.runningNumbers || {},
        reservedContractIds: Array.isArray(parsed.reservedContractIds) ? parsed.reservedContractIds : [],
        initialSetupCompleted: Boolean(parsed.initialSetupCompleted) || hasActiveSuperAdmin,
        initialSetupTokenHash: parsed.initialSetupTokenHash ?? null,
        securityAuditLogs: Array.isArray(parsed.securityAuditLogs) ? parsed.securityAuditLogs : [],
        config: {
          ...DEFAULT_CONFIG,
          ...(parsed.config || {}),
          authorizedUsers: normalizedUsers,
        },
      };
    } catch {
      // fallback to default state
    }
  }
  return {
    spreadsheetId: null,
    spreadsheetUrl: null,
    spreadsheetTitle: null,
    runningNumbers: {},
    reservedContractIds: [],
    initialSetupCompleted: false,
    initialSetupTokenHash: null,
    securityAuditLogs: [],
    config: { ...DEFAULT_CONFIG },
  };
}

function saveServerState(state: ServerState): void {
  ensureDataDir();
  const tmpFile = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmpFile, STATE_FILE);
}

let serverState: ServerState = loadServerState();

// Initialize single-use backend token for Initial Super Admin Setup if no Super Admin exists yet
function ensureInitialSetupTokenReady(): void {
  const hasActiveSuperAdmin = serverState.config.authorizedUsers.some(
    (u) => u.role === 'Super Admin' && u.accountStatus === 'Approved' && !u.disabled
  );

  if (hasActiveSuperAdmin || serverState.initialSetupCompleted) {
    if (!serverState.initialSetupCompleted || serverState.initialSetupTokenHash !== null) {
      serverState.initialSetupCompleted = true;
      serverState.initialSetupTokenHash = null;
      saveServerState(serverState);
    }
    return;
  }

  const envToken = String(process.env.INITIAL_ADMIN_SETUP_TOKEN || '').trim();
  if (envToken) {
    serverState.initialSetupTokenHash = hashSetupToken(envToken);
    saveServerState(serverState);
    console.info('[MAX SANY RHP PORTAL] Initial Super Admin Setup is active using INITIAL_ADMIN_SETUP_TOKEN from environment.');
    return;
  }

  const generatedToken = crypto.randomBytes(18).toString('base64url');
  serverState.initialSetupTokenHash = hashSetupToken(generatedToken);
  saveServerState(serverState);
  console.info(
    `[MAX SANY RHP PORTAL] One-Time Initial Super Admin Setup Token: ${generatedToken}`
  );
}

ensureInitialSetupTokenReady();

// Strict in-process async mutex queue for atomic contract ID reservation & writes
let lockChain: Promise<void> = Promise.resolve();
async function withAtomicLock<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = lockChain;
  lockChain = next;
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

interface PortalUser {
  uid: string;
  email: string;
  displayName: string;
  role: UserRole;
  accountStatus: AccountStatus;
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
  mfaEnrolled: boolean;
  mfaVerified: boolean;
  disabled: boolean;
}

interface AuthedRequest extends Request {
  firebaseClaims?: VerifiedFirebaseClaims;
  portalUser?: PortalUser;
  googleAccessTokenFromHeader?: string;
}

function getSheetsAuthMode(): SheetsAuthMode {
  return defaultServiceAccountManager.isConfigured() ? 'service_account' : 'oauth';
}

function isOfflineOAuthConfigured(): boolean {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || FIREBASE_CONFIG.oAuthClientId || '';
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
  return Boolean(clientId && clientSecret && process.env.APP_URL);
}

function syncHeaderGoogleTokenToVault(req: AuthedRequest, uid: string, email: string): void {
  const headerToken = String(req.headers['x-google-access-token'] || '').trim();
  if (!headerToken) return;
  req.googleAccessTokenFromHeader = headerToken;

  const currentStatus = defaultTokenVault.getUserStatus(uid);
  const expiresAtHeader = Number(req.headers['x-google-token-expires-at'] || 0);
  // Save client-supplied token into vault if vault doesn't already hold a fresher token
  if (!currentStatus.hasAccessToken || (expiresAtHeader && expiresAtHeader > (currentStatus.expiresAtMs || 0))) {
    defaultTokenVault.saveUserTokens({
      uid,
      email,
      accessToken: headerToken,
      expiresAtMs: Number.isFinite(expiresAtHeader) && expiresAtHeader > Date.now() ? expiresAtHeader : undefined,
    });
  }
}

async function recordSecurityAudit(
  entry: AuditLogEntry,
  sheetsAccessToken?: string | null
): Promise<void> {
  serverState.securityAuditLogs.push(entry);
  if (serverState.securityAuditLogs.length > 2000) {
    serverState.securityAuditLogs = serverState.securityAuditLogs.slice(-2000);
  }
  saveServerState(serverState);

  if (serverState.spreadsheetId && sheetsAccessToken) {
    try {
      await appendAuditLogsToSheet(sheetsAccessToken, serverState.spreadsheetId, [entry]);
    } catch {
      // Security audit log is already safely persisted on server state
    }
  }
}

function extractBearerIdToken(req: Request): string {
  const authHeader = req.headers.authorization || '';
  const firebaseHeader = String(req.headers['x-firebase-id-token'] || '').trim();
  return firebaseHeader || (authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '');
}

/**
 * Verifies only Firebase Identity Token (does NOT grant access to internal data).
 * Used for onboarding, email verification check, initial admin setup, MFA verification, and logout.
 */
async function requireFirebaseIdentity(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const idToken = extractBearerIdToken(req);
  if (!idToken) {
    res.status(401).json({
      errorCode: 'PORTAL_AUTH_REQUIRED' satisfies AuthErrorCode,
      error: 'กรุณาเข้าสู่ระบบ RHP Portal ก่อนดำเนินการ',
    });
    return;
  }

  try {
    const claims = await verifyFirebaseIdToken(idToken, FIREBASE_CONFIG.projectId);
    req.firebaseClaims = claims;
    next();
  } catch (err) {
    if (err instanceof FirebaseTokenError) {
      res.status(err.statusCode).json({
        errorCode: err.errorCode,
        error: err.message,
      });
      return;
    }
    res.status(401).json({
      errorCode: 'INVALID_TOKEN' satisfies AuthErrorCode,
      error: err instanceof Error ? err.message : 'การยืนยันตัวตนไม่สำเร็จ',
    });
  }
}

/**
 * Layer 1 (Strict Authentication, Account Approval, Role & MFA Guard):
 * Rejects unverified emails, unregistered emails, Pending Verification, Pending Approval,
 * Rejected, Suspended users, and unverified MFA sessions for Super Admin / Approver.
 */
async function requirePortalAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const idToken = extractBearerIdToken(req);

  if (!idToken) {
    res.status(401).json({
      errorCode: 'PORTAL_AUTH_REQUIRED' satisfies AuthErrorCode,
      error: 'กรุณาเข้าสู่ระบบ MAX SANY RHP PORTAL ก่อนดำเนินการ',
    });
    return;
  }

  try {
    const claims = await verifyFirebaseIdToken(idToken, FIREBASE_CONFIG.projectId);
    req.firebaseClaims = claims;

    if (!claims.emailVerified) {
      res.status(403).json({
        errorCode: 'EMAIL_VERIFICATION_REQUIRED' satisfies AuthErrorCode,
        error: 'กรุณายืนยันความเป็นเจ้าของอีเมลของคุณก่อนจึงจะดำเนินการต่อได้',
      });
      return;
    }

    const perms = resolvePermissionsFromRegistry(claims.email, serverState.config.authorizedUsers);
    if (!perms.registered) {
      res.status(403).json({
        errorCode: 'ACCOUNT_NOT_REGISTERED' satisfies AuthErrorCode,
        error: 'บัญชีนี้ยังไม่ได้ส่งคำขอลงทะเบียนหรือยังไม่ได้รับอนุมัติจาก Super Admin',
      });
      return;
    }

    if (perms.accountStatus === 'Pending Verification') {
      res.status(403).json({
        errorCode: 'EMAIL_VERIFICATION_REQUIRED' satisfies AuthErrorCode,
        error: 'บัญชีอยู่ระหว่างรอยืนยันอีเมล กรุณายืนยันอีเมลและส่งคำขออนุมัติก่อนใช้งาน',
      });
      return;
    }

    if (perms.accountStatus === 'Pending Approval') {
      res.status(403).json({
        errorCode: 'ACCOUNT_PENDING_APPROVAL' satisfies AuthErrorCode,
        error: 'บัญชีของคุณอยู่ระหว่างรอ Super Admin ตรวจสอบและอนุมัติสิทธิ์เข้าใช้งาน',
      });
      return;
    }

    if (perms.accountStatus === 'Rejected') {
      res.status(403).json({
        errorCode: 'ACCOUNT_REJECTED' satisfies AuthErrorCode,
        error: 'คำขอเข้าใช้งานบัญชีนี้ถูกปฏิเสธโดยผู้ดูแลระบบ ไม่สามารถเข้าถึงข้อมูลภายในได้',
      });
      return;
    }

    if (perms.accountStatus === 'Suspended' || perms.disabled) {
      res.status(403).json({
        errorCode: 'USER_DISABLED' satisfies AuthErrorCode,
        error: 'บัญชีผู้ใช้งานนี้ถูกระงับสิทธิ์โดย Super Admin ไม่สามารถใช้งานระบบได้',
      });
      return;
    }

    const mfaState = defaultMfaService.getUserMfaState(claims.email, claims.authTime);
    if (perms.mfaRequired && !mfaState.mfaVerified) {
      res.status(403).json({
        errorCode: 'MFA_REQUIRED' satisfies AuthErrorCode,
        error: mfaState.mfaEnrolled
          ? 'บทบาท Super Admin และ Approver จำเป็นต้องยืนยันรหัส MFA ก่อนเข้าถึงข้อมูลระบบ'
          : 'บทบาท Super Admin และ Approver จำเป็นต้องตั้งค่า MFA (Authenticator) ก่อนเข้าใช้งาน',
      });
      return;
    }

    const matchedEntry = serverState.config.authorizedUsers.find(
      (u) => u.email.trim().toLowerCase() === claims.email
    );

    req.portalUser = {
      uid: claims.uid,
      email: claims.email,
      displayName: matchedEntry?.displayName || claims.name || claims.email,
      role: perms.role,
      accountStatus: 'Approved',
      emailVerified: true,
      canOverrideAr: perms.canOverrideAr,
      canApprove: perms.canApprove,
      canDelete: perms.canDelete,
      canCreateContract: perms.canCreateContract,
      canEditDraft: perms.canEditDraft,
      canManageUsers: perms.canManageUsers,
      canManageSettings: perms.canManageSettings,
      canExportPdf: perms.canExportPdf,
      mfaRequired: perms.mfaRequired,
      mfaEnrolled: mfaState.mfaEnrolled,
      mfaVerified: mfaState.mfaVerified,
      disabled: false,
    };

    syncHeaderGoogleTokenToVault(req, claims.uid, claims.email);
    next();
  } catch (err) {
    if (err instanceof FirebaseTokenError) {
      res.status(err.statusCode).json({
        errorCode: err.errorCode,
        error: err.message,
      });
      return;
    }
    res.status(401).json({
      errorCode: 'INVALID_TOKEN' satisfies AuthErrorCode,
      error: err instanceof Error ? err.message : 'การยืนยันตัวตนไม่สำเร็จ',
    });
  }
}

function requireSuperAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.portalUser || req.portalUser.role !== 'Super Admin') {
    res.status(403).json({
      errorCode: 'INSUFFICIENT_PERMISSION' satisfies AuthErrorCode,
      error: 'เฉพาะ Super Admin เท่านั้นที่สามารถดำเนินการส่วนนี้ได้',
    });
    return;
  }
  next();
}

/**
 * Layer 2 (Authorization): Resolves Google Sheets Access Token (Service Account or OAuth Vault)
 * with single-flight proactive refresh & 1x transparent 401 retry.
 * Never retries 403 Insufficient Permission errors.
 */
async function withSheetsAccess<T>(
  req: AuthedRequest,
  fn: (accessToken: string) => Promise<T>
): Promise<T> {
  const user = req.portalUser!;

  if (defaultServiceAccountManager.isConfigured()) {
    let token = await defaultServiceAccountManager.getAccessToken(false);
    try {
      return await fn(token);
    } catch (err) {
      if (err instanceof SheetsApiError && err.errorCode === 'ACCESS_TOKEN_EXPIRED') {
        token = await defaultServiceAccountManager.getAccessToken(true);
        return await fn(token);
      }
      throw err;
    }
  }

  let token: string;
  try {
    const valid = await defaultTokenVault.getValidAccessToken(user.uid, false);
    token = valid.accessToken;
  } catch (vaultErr) {
    if (req.googleAccessTokenFromHeader) {
      token = req.googleAccessTokenFromHeader;
    } else {
      throw vaultErr;
    }
  }

  try {
    return await fn(token);
  } catch (err) {
    if (err instanceof SheetsApiError && err.errorCode === 'ACCESS_TOKEN_EXPIRED') {
      defaultTokenVault.markAccessTokenExpired(user.uid);
      if (defaultTokenVault.canOfflineRefresh(user.uid)) {
        const refreshed = await defaultTokenVault.refreshUserAccessToken(user.uid);
        return await fn(refreshed.accessToken);
      }
      throw new TokenVaultError(
        'สิทธิ์เชื่อมต่อ Google Sheets หมดอายุ กรุณากด Reconnect Google โดยข้อมูลที่กรอกไว้ยังคงอยู่ครบถ้วน',
        'ACCESS_TOKEN_EXPIRED',
        401
      );
    }
    throw err;
  }
}

function sendRouteError(res: Response, err: unknown, fallbackMessage: string, defaultStatus = 400): void {
  if (err instanceof FirebaseTokenError) {
    res.status(err.statusCode).json({
      errorCode: err.errorCode,
      error: err.message,
    });
    return;
  }
  if (err instanceof TokenVaultError) {
    res.status(err.statusCode).json({
      errorCode: err.errorCode,
      requiresSheetsReconnect: true,
      error: err.message,
    });
    return;
  }
  if (err instanceof SheetsApiError) {
    res.status(err.status).json({
      errorCode: err.errorCode,
      requiresSheetsReconnect: err.errorCode === 'ACCESS_TOKEN_EXPIRED',
      error: err.message,
    });
    return;
  }
  if (err instanceof LifecycleRuleError) {
    res.status(err.statusCode).json({
      errorCode: err.statusCode === 403 ? 'INSUFFICIENT_PERMISSION' : 'UNKNOWN_ERROR',
      error: err.message,
    });
    return;
  }

  res.status(defaultStatus).json({
    errorCode: 'UNKNOWN_ERROR' satisfies AuthErrorCode,
    error: err instanceof Error ? err.message : fallbackMessage,
  });
}

function extractSpreadsheetId(input: string): string {
  const trimmed = input.trim();
  const urlMatch = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(trimmed);
  if (urlMatch) return urlMatch[1];
  if (/^[a-zA-Z0-9-_]{15,}$/.test(trimmed)) return trimmed;
  throw new Error('รูปแบบ Spreadsheet ID หรือ URL ของ Google Sheets ไม่ถูกต้อง');
}

function createSignedOAuthState(uid: string, email: string): string {
  const payload = Buffer.from(
    JSON.stringify({ uid, email, exp: Date.now() + 10 * 60 * 1000, nonce: crypto.randomBytes(8).toString('hex') }),
    'utf8'
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', OAUTH_STATE_SIGNING_KEY).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySignedOAuthState(state: string): { uid: string; email: string } {
  const [payload, sig] = state.split('.');
  if (!payload || !sig) {
    throw new Error('Invalid OAuth state');
  }
  const expectedSig = crypto
    .createHmac('sha256', OAUTH_STATE_SIGNING_KEY)
    .update(payload)
    .digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
    throw new Error('OAuth state signature mismatch');
  }
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    uid: string;
    email: string;
    exp: number;
  };
  if (Date.now() > parsed.exp) {
    throw new Error('OAuth state expired');
  }
  return { uid: parsed.uid, email: parsed.email };
}

function getSafePublicConfig(): Omit<SystemConfig, 'authorizedUsers'> & {
  authorizedUsers: UserPermissionEntry[];
} {
  return {
    ...serverState.config,
    authorizedUsers: [],
  };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get(['/healthz', '/api/health'], (_req: Request, res: Response) => {
    res.status(200).json({ ok: true, port: PORT });
  });

  // Public portal branding & initial-setup check ONLY (zero sensitive user/Sheets details leaked)
  app.get('/api/sheets/status', (_req: Request, res: Response) => {
    res.json({
      connected: Boolean(serverState.spreadsheetId),
      spreadsheetId: null,
      spreadsheetUrl: null,
      spreadsheetTitle: null,
      authMode: getSheetsAuthMode(),
      serviceAccountEmail: null,
      offlineOAuthConfigured: isOfflineOAuthConfigured(),
      initialSetupRequired: !serverState.initialSetupCompleted,
      config: getSafePublicConfig(),
    });
  });

  // Onboarding, approval status, MFA gate & full profile inspection (Firebase identity only)
  app.get('/api/auth/session-status', requireFirebaseIdentity, async (req: AuthedRequest, res: Response) => {
    const claims = req.firebaseClaims!;
    const nowStr = formatBangkokTimestamp();

    let matchedIdx = serverState.config.authorizedUsers.findIndex(
      (u) => u.email.trim().toLowerCase() === claims.email
    );

    // If user verified their email link and was Pending Verification, transition to Pending Approval automatically
    if (matchedIdx >= 0 && claims.emailVerified) {
      const existing = normalizeUserEntry(serverState.config.authorizedUsers[matchedIdx]);
      if (existing.accountStatus === 'Pending Verification') {
        const promoted: UserPermissionEntry = {
          ...existing,
          uid: claims.uid,
          emailVerified: true,
          emailVerifiedAt: existing.emailVerifiedAt || nowStr,
          accountStatus: 'Pending Approval',
        };
        serverState.config.authorizedUsers[matchedIdx] = promoted;
        saveServerState(serverState);
        await recordSecurityAudit({
          timestamp: nowStr,
          actor: claims.email,
          targetContractId: `USER:${claims.email}`,
          fieldChanged: 'Email Verified -> Pending Approval',
          oldValue: 'Pending Verification',
          newValue: 'Pending Approval',
          reason: 'ผู้สมัครยืนยันความเป็นเจ้าของอีเมลสำเร็จ ส่งคำขอรอ Super Admin อนุมัติ',
        });
      }
    }

    const matchedEntry =
      matchedIdx >= 0 ? normalizeUserEntry(serverState.config.authorizedUsers[matchedIdx]) : null;
    const perms = resolvePermissionsFromRegistry(claims.email, serverState.config.authorizedUsers);
    const mfaState = defaultMfaService.getUserMfaState(claims.email, claims.authTime);

    const isApproved =
      Boolean(matchedEntry) &&
      claims.emailVerified &&
      matchedEntry!.accountStatus === 'Approved' &&
      !matchedEntry!.disabled;

    const canAccessPortal = isApproved && (!perms.mfaRequired || mfaState.mfaVerified);

    if (!canAccessPortal) {
      res.json({
        uid: claims.uid,
        email: claims.email,
        displayName: matchedEntry?.displayName || claims.name || claims.email,
        emailVerified: claims.emailVerified,
        signInProvider: claims.signInProvider || 'password',
        registered: perms.registered,
        accountStatus: !claims.emailVerified
          ? 'Pending Verification'
          : perms.accountStatus,
        role: perms.role,
        department: matchedEntry?.department || '',
        requestNote: matchedEntry?.requestNote || '',
        registeredAt: matchedEntry?.registeredAt || '',
        emailVerifiedAt: matchedEntry?.emailVerifiedAt || '',
        reviewedAt: matchedEntry?.reviewedAt || '',
        reviewedBy: matchedEntry?.reviewedBy || '',
        reviewNote: matchedEntry?.reviewNote || '',
        mfaRequired: isApproved ? perms.mfaRequired : false,
        mfaEnrolled: mfaState.mfaEnrolled,
        mfaVerified: mfaState.mfaVerified,
        canAccessPortal: false,
        initialSetupRequired: !serverState.initialSetupCompleted,
      });
      return;
    }

    const authMode = getSheetsAuthMode();
    const oauthStatus = defaultTokenVault.getUserStatus(claims.uid);

    res.json({
      uid: claims.uid,
      email: claims.email,
      displayName: matchedEntry!.displayName || claims.name || claims.email,
      emailVerified: true,
      signInProvider: claims.signInProvider || 'password',
      registered: true,
      accountStatus: 'Approved',
      role: perms.role,
      canOverrideAr: perms.canOverrideAr,
      canApprove: perms.canApprove,
      canDelete: perms.canDelete,
      canCreateContract: perms.canCreateContract,
      canEditDraft: perms.canEditDraft,
      canManageUsers: perms.canManageUsers,
      canManageSettings: perms.canManageSettings,
      canExportPdf: perms.canExportPdf,
      mfaRequired: perms.mfaRequired,
      mfaEnrolled: mfaState.mfaEnrolled,
      mfaVerified: mfaState.mfaVerified,
      canAccessPortal: true,
      initialSetupRequired: !serverState.initialSetupCompleted,
      authMode,
      serviceAccountEmail: defaultServiceAccountManager.getServiceAccountEmail(),
      offlineOAuthConfigured: isOfflineOAuthConfigured(),
      oauthStatus,
      connectionSummary: {
        connected: Boolean(serverState.spreadsheetId),
        spreadsheetId: serverState.spreadsheetId,
        spreadsheetUrl: serverState.spreadsheetUrl,
        spreadsheetTitle: serverState.spreadsheetTitle,
      },
      config:
        perms.role === 'Super Admin'
          ? serverState.config
          : { ...serverState.config, authorizedUsers: [matchedEntry!] },
    });
  });

  // Submit or update registration / email-verification request (NEVER auto-approves or grants privileged role)
  app.post('/api/auth/register-request', requireFirebaseIdentity, async (req: AuthedRequest, res: Response) => {
    const claims = req.firebaseClaims!;
    const body = req.body as {
      displayName?: string;
      department?: string;
      requestNote?: string;
    };

    try {
      const outcome = await withAtomicLock(async () => {
        const nowStr = formatBangkokTimestamp();
        const idx = serverState.config.authorizedUsers.findIndex(
          (u) => u.email.trim().toLowerCase() === claims.email
        );
        const existing = idx >= 0 ? normalizeUserEntry(serverState.config.authorizedUsers[idx]) : null;

        if (existing && existing.accountStatus === 'Approved' && !existing.disabled) {
          return { entry: existing, alreadyApproved: true };
        }
        if (existing && (existing.accountStatus === 'Suspended' || existing.disabled)) {
          throw new LifecycleRuleError(
            'บัญชีนี้ถูกระงับการใช้งานโดย Super Admin กรุณาติดต่อผู้ดูแลระบบ',
            403
          );
        }

        const displayName = String(body.displayName || existing?.displayName || claims.name || claims.email).trim();
        const department = String(body.department ?? existing?.department ?? '').trim();
        const requestNote = String(body.requestNote ?? existing?.requestNote ?? '').trim();

        const nextStatus: AccountStatus = claims.emailVerified
          ? 'Pending Approval'
          : 'Pending Verification';

        const nextEntry: UserPermissionEntry = normalizeUserEntry({
          email: claims.email,
          uid: claims.uid,
          displayName,
          department,
          requestNote,
          role: existing?.role || 'Viewer',
          accountStatus: nextStatus,
          emailVerified: claims.emailVerified,
          emailVerifiedAt: claims.emailVerified
            ? existing?.emailVerifiedAt || nowStr
            : undefined,
          registeredAt: existing?.registeredAt || nowStr,
          authProvider: claims.signInProvider || existing?.authProvider || 'password',
          canOverrideAr: false,
          canApprove: false,
          canDelete: false,
          disabled: false,
          reviewedAt: existing?.reviewedAt,
          reviewedBy: existing?.reviewedBy,
          reviewNote: nextStatus === 'Pending Approval' ? '' : existing?.reviewNote,
        });

        if (idx >= 0) {
          serverState.config.authorizedUsers[idx] = nextEntry;
        } else {
          serverState.config.authorizedUsers.push(nextEntry);
        }
        saveServerState(serverState);

        await recordSecurityAudit({
          timestamp: nowStr,
          actor: claims.email,
          targetContractId: `USER:${claims.email}`,
          fieldChanged: claims.emailVerified
            ? 'Registration Request (Pending Approval)'
            : 'User Registration (Pending Verification)',
          oldValue: existing?.accountStatus || 'Unregistered',
          newValue: nextStatus,
          reason: requestNote || (claims.emailVerified ? 'ยืนยัน Email แล้ว ส่งคำขออนุมัติถึง Super Admin' : 'ลงทะเบียนใหม่ รอยืนยัน Email'),
        });

        return { entry: nextEntry, alreadyApproved: false };
      });

      res.json(outcome);
    } catch (err) {
      sendRouteError(res, err, 'ไม่สามารถบันทึกคำขอสมัครเข้าใช้งานได้', 400);
    }
  });

  // One-time Initial Super Admin Setup (verified email + single-use backend token, auto-closes forever)
  app.post('/api/auth/initial-admin-setup', requireFirebaseIdentity, async (req: AuthedRequest, res: Response) => {
    const claims = req.firebaseClaims!;
    const body = req.body as { setupToken?: string; displayName?: string };

    try {
      const result = await withAtomicLock(async () => {
        const hasActiveSuperAdmin = serverState.config.authorizedUsers.some(
          (u) => normalizeUserRole(u.role) === 'Super Admin' && u.accountStatus === 'Approved' && !u.disabled
        );

        if (serverState.initialSetupCompleted || hasActiveSuperAdmin || !serverState.initialSetupTokenHash) {
          throw new LifecycleRuleError(
            'Initial Super Admin Setup ถูกปิดใช้งานถาวรแล้ว เนื่องจากมี Super Admin ในระบบแล้ว',
            403
          );
        }

        if (!claims.emailVerified) {
          throw new LifecycleRuleError(
            'กรุณายืนยันความเป็นเจ้าของ Email ของคุณให้เรียบร้อยก่อนตั้งค่า Super Admin',
            403
          );
        }

        const submittedToken = String(body.setupToken || '').trim();
        if (!submittedToken) {
          throw new LifecycleRuleError('กรุณาระบุ Initial Setup Token ที่ได้จาก Backend', 400);
        }

        const submittedHash = hashSetupToken(submittedToken);
        const expectedBuf = Buffer.from(serverState.initialSetupTokenHash, 'hex');
        const submittedBuf = Buffer.from(submittedHash, 'hex');
        if (
          expectedBuf.length !== submittedBuf.length ||
          !crypto.timingSafeEqual(submittedBuf, expectedBuf)
        ) {
          throw new LifecycleRuleError('Initial Setup Token ไม่ถูกต้องหรือหมดอายุแล้ว', 403);
        }

        const nowStr = formatBangkokTimestamp();
        const caps = getDefaultRoleCapabilities('Super Admin');
        const adminEntry: UserPermissionEntry = normalizeUserEntry({
          email: claims.email,
          uid: claims.uid,
          displayName: String(body.displayName || claims.name || claims.email).trim(),
          department: 'Risk Control Department',
          role: 'Super Admin',
          accountStatus: 'Approved',
          emailVerified: true,
          emailVerifiedAt: nowStr,
          registeredAt: nowStr,
          reviewedAt: nowStr,
          reviewedBy: 'Initial Setup Bootstrap',
          reviewNote: 'กำหนดสิทธิ์ Super Admin หลักครั้งแรกผ่าน One-Time Setup Token',
          authProvider: claims.signInProvider || 'password',
          ...caps,
          disabled: false,
        });

        const existingIdx = serverState.config.authorizedUsers.findIndex(
          (u) => u.email.trim().toLowerCase() === claims.email
        );
        if (existingIdx >= 0) {
          serverState.config.authorizedUsers[existingIdx] = adminEntry;
        } else {
          serverState.config.authorizedUsers.push(adminEntry);
        }

        // Single-use: permanently lock Initial Setup and clear token hash
        serverState.initialSetupCompleted = true;
        serverState.initialSetupTokenHash = null;
        saveServerState(serverState);

        await recordSecurityAudit({
          timestamp: nowStr,
          actor: claims.email,
          targetContractId: `USER:${claims.email}`,
          fieldChanged: 'Initial Super Admin Setup',
          oldValue: 'Unconfigured',
          newValue: 'Super Admin (Approved)',
          reason: 'ลงทะเบียนบัญชี Super Admin หลักครั้งแรกสำเร็จ และปิด Initial Setup อัตโนมัติ',
        });

        return { ok: true, user: adminEntry };
      });

      res.json(result);
    } catch (err) {
      if (err instanceof LifecycleRuleError) {
        res.status(err.statusCode).json({
          errorCode: err.message.includes('ปิดใช้งานถาวร')
            ? ('INITIAL_SETUP_CLOSED' satisfies AuthErrorCode)
            : ('INSUFFICIENT_PERMISSION' satisfies AuthErrorCode),
          error: err.message,
        });
        return;
      }
      sendRouteError(res, err, 'ไม่สามารถตั้งค่า Super Admin เริ่มต้นได้', 400);
    }
  });

  // MFA Enrollment Initialization (Allowed for Approved Super Admin / Approver with verified email)
  app.post('/api/auth/mfa/enroll-init', requireFirebaseIdentity, async (req: AuthedRequest, res: Response) => {
    const claims = req.firebaseClaims!;
    if (!claims.emailVerified) {
      res.status(403).json({
        errorCode: 'EMAIL_VERIFICATION_REQUIRED' satisfies AuthErrorCode,
        error: 'กรุณายืนยันอีเมลก่อนตั้งค่า MFA',
      });
      return;
    }

    const perms = resolvePermissionsFromRegistry(claims.email, serverState.config.authorizedUsers);
    if (!perms.registered || perms.accountStatus !== 'Approved' || perms.disabled) {
      res.status(403).json({
        errorCode: 'INSUFFICIENT_PERMISSION' satisfies AuthErrorCode,
        error: 'บัญชีต้องได้รับอนุมัติจาก Super Admin ก่อนตั้งค่า MFA',
      });
      return;
    }

    if (!perms.mfaRequired) {
      res.status(400).json({ error: 'บทบาทของคุณไม่จำเป็นต้องตั้งค่า MFA บังคับ' });
      return;
    }

    try {
      const enrollment = await defaultMfaService.beginEnrollment(claims.uid, claims.email);
      res.json(enrollment);
    } catch (err) {
      sendRouteError(res, err, 'ไม่สามารถเริ่มการตั้งค่า MFA ได้', 500);
    }
  });

  // MFA Code Verification (Enrollment confirmation or Login session verification)
  app.post('/api/auth/mfa/verify', requireFirebaseIdentity, async (req: AuthedRequest, res: Response) => {
    const claims = req.firebaseClaims!;
    const body = req.body as { code?: string; mode?: 'enroll' | 'login' };
    const code = String(body.code || '').trim();
    const mode = body.mode === 'enroll' ? 'enroll' : 'login';

    if (!claims.emailVerified) {
      res.status(403).json({
        errorCode: 'EMAIL_VERIFICATION_REQUIRED' satisfies AuthErrorCode,
        error: 'กรุณายืนยันอีเมลก่อนตรวจสอบ MFA',
      });
      return;
    }

    const idx = serverState.config.authorizedUsers.findIndex(
      (u) => u.email.trim().toLowerCase() === claims.email
    );
    if (idx === -1) {
      res.status(403).json({
        errorCode: 'ACCOUNT_NOT_REGISTERED' satisfies AuthErrorCode,
        error: 'ไม่พบบัญชีผู้ใช้งานในระบบ',
      });
      return;
    }

    const userEntry = normalizeUserEntry(serverState.config.authorizedUsers[idx]);
    if (userEntry.accountStatus !== 'Approved' || userEntry.disabled) {
      res.status(403).json({
        errorCode: 'INSUFFICIENT_PERMISSION' satisfies AuthErrorCode,
        error: 'บัญชีนี้ยังไม่ได้รับอนุมัติหรือถูกระงับการใช้งาน',
      });
      return;
    }

    const nowStr = formatBangkokTimestamp();
    if (mode === 'enroll') {
      const ok = defaultMfaService.confirmEnrollment(
        claims.uid,
        claims.email,
        claims.authTime,
        code,
        nowStr
      );
      if (!ok) {
        res.status(400).json({ error: 'รหัส OTP 6 หลักจาก Authenticator ไม่ถูกต้อง กรุณาลองใหม่' });
        return;
      }

      serverState.config.authorizedUsers[idx] = {
        ...userEntry,
        mfaEnabled: true,
        mfaEnrolledAt: nowStr,
      };
      saveServerState(serverState);

      await recordSecurityAudit({
        timestamp: nowStr,
        actor: claims.email,
        targetContractId: `USER:${claims.email}`,
        fieldChanged: 'MFA Enrolled',
        oldValue: 'Disabled',
        newValue: 'Enabled (TOTP)',
        reason: `เปิดใช้งาน MFA สำหรับบทบาท ${userEntry.role}`,
      });

      res.json({ ok: true, mfaEnrolled: true, mfaVerified: true });
      return;
    }

    const ok = defaultMfaService.verifyLoginCode(claims.uid, claims.email, claims.authTime, code);
    if (!ok) {
      res.status(400).json({ error: 'รหัส MFA 6 หลักไม่ถูกต้องหรือหมดอายุ กรุณากรอกรหัสปัจจุบันจากแอป Authenticator' });
      return;
    }

    await recordSecurityAudit({
      timestamp: nowStr,
      actor: claims.email,
      targetContractId: `USER:${claims.email}`,
      fieldChanged: 'MFA Session Verified',
      oldValue: 'Pending MFA',
      newValue: 'Verified',
      reason: `ยืนยันตัวตน MFA ระดับ ${userEntry.role} สำเร็จ`,
    });

    res.json({ ok: true, mfaEnrolled: true, mfaVerified: true });
  });

  // Get authenticated user permissions (works via Firebase ID Token even if Google OAuth expired)
  app.get('/api/auth/me', requirePortalAuth, (req: AuthedRequest, res: Response) => {
    const user = req.portalUser!;
    const authMode = getSheetsAuthMode();
    const oauthStatus = defaultTokenVault.getUserStatus(user.uid);
    res.json({
      uid: user.uid,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      accountStatus: user.accountStatus,
      emailVerified: user.emailVerified,
      canOverrideAr: user.canOverrideAr,
      canApprove: user.canApprove,
      canDelete: user.canDelete,
      canCreateContract: user.canCreateContract,
      canEditDraft: user.canEditDraft,
      canManageUsers: user.canManageUsers,
      canManageSettings: user.canManageSettings,
      canExportPdf: user.canExportPdf,
      mfaRequired: user.mfaRequired,
      mfaEnrolled: user.mfaEnrolled,
      mfaVerified: user.mfaVerified,
      authMode,
      serviceAccountEmail: defaultServiceAccountManager.getServiceAccountEmail(),
      offlineOAuthConfigured: isOfflineOAuthConfigured(),
      oauthStatus,
      connectionSummary: {
        connected: Boolean(serverState.spreadsheetId),
        spreadsheetId: serverState.spreadsheetId,
        spreadsheetUrl: serverState.spreadsheetUrl,
        spreadsheetTitle: serverState.spreadsheetTitle,
      },
      config:
        user.role === 'Super Admin'
          ? serverState.config
          : { ...serverState.config, authorizedUsers: [] },
    });
  });

  // Super Admin: List all registered/pending/approved/rejected/suspended users & approval audit logs
  app.get(
    '/api/admin/users',
    requirePortalAuth,
    requireSuperAdmin,
    (_req: AuthedRequest, res: Response) => {
      const users = serverState.config.authorizedUsers.map((u) => {
        const norm = normalizeUserEntry(u);
        const mfaState = defaultMfaService.getUserMfaState(norm.email, 0);
        return {
          ...norm,
          mfaEnabled: Boolean(norm.mfaEnabled || mfaState.mfaEnrolled),
        };
      });

      const userAuditLogs = serverState.securityAuditLogs
        .filter((log) => log.targetContractId.startsWith('USER:'))
        .slice()
        .reverse();

      res.json({
        users,
        userAuditLogs,
        initialSetupCompleted: serverState.initialSetupCompleted,
      });
    }
  );

  // Super Admin: Approve, Reject, Suspend, Reactivate, Change Role, or Reset MFA
  app.post(
    '/api/admin/users/:email/review',
    requirePortalAuth,
    requireSuperAdmin,
    async (req: AuthedRequest, res: Response) => {
      const actor = req.portalUser!;
      const targetEmail = decodeURIComponent(String(req.params.email || '')).trim().toLowerCase();
      const body = req.body as {
        action?: 'approve' | 'reject' | 'suspend' | 'reactivate' | 'change_role' | 'reset_mfa';
        role?: UserRole;
        reviewNote?: string;
        canOverrideAr?: boolean;
        canDelete?: boolean;
      };

      const action = body.action;
      if (
        !action ||
        !['approve', 'reject', 'suspend', 'reactivate', 'change_role', 'reset_mfa'].includes(action)
      ) {
        res.status(400).json({ error: 'คำสั่งจัดการบัญชีผู้ใช้งานไม่ถูกต้อง' });
        return;
      }

      try {
        const result = await withAtomicLock(async () => {
          const idx = serverState.config.authorizedUsers.findIndex(
            (u) => u.email.trim().toLowerCase() === targetEmail
          );
          if (idx === -1) {
            throw new LifecycleRuleError(`ไม่พบบัญชี ${targetEmail} ในระบบ`, 404);
          }

          const current = normalizeUserEntry(serverState.config.authorizedUsers[idx]);
          const note = String(body.reviewNote || '').trim();
          const nowStr = formatBangkokTimestamp();

          if (targetEmail === actor.email && (action === 'suspend' || action === 'reject' || action === 'change_role')) {
            throw new LifecycleRuleError(
              'ห้ามผู้ใช้งานเปลี่ยน Role หรือระงับสิทธิ์บัญชีของตนเอง กรุณาให้ Super Admin ท่านอื่นเป็นผู้ดำเนินการ',
              403
            );
          }

          if (action === 'approve' && !current.emailVerified) {
            throw new LifecycleRuleError(
              'ไม่สามารถอนุมัติบัญชีนี้ได้ เนื่องจากผู้สมัครยังไม่ได้ยืนยันความเป็นเจ้าของ Email',
              400
            );
          }

          let nextRole: UserRole = current.role;
          if (action === 'approve' || action === 'change_role') {
            if (!body.role || !ALL_USER_ROLES.includes(body.role)) {
              throw new LifecycleRuleError(
                'กรุณาเลือก Role (Super Admin / Risk Control / Approver / Viewer) ก่อนดำเนินการ',
                400
              );
            }
            nextRole = body.role;
          }

          // Prevent removing the last active Super Admin
          const activeSuperAdmins = serverState.config.authorizedUsers.filter(
            (u) =>
              normalizeUserRole(u.role) === 'Super Admin' &&
              normalizeUserEntry(u).accountStatus === 'Approved' &&
              !u.disabled
          );
          if (
            current.role === 'Super Admin' &&
            current.accountStatus === 'Approved' &&
            !current.disabled &&
            activeSuperAdmins.length <= 1 &&
            (action === 'suspend' || action === 'reject' || (action === 'change_role' && nextRole !== 'Super Admin'))
          ) {
            throw new LifecycleRuleError(
              'ไม่สามารถระงับหรือลดสิทธิ์ Super Admin คนสุดท้ายของระบบได้',
              400
            );
          }

          if ((action === 'reject' || action === 'suspend') && !note) {
            throw new LifecycleRuleError('กรุณาระบุหมายเหตุประกอบการปฏิเสธหรือระงับบัญชี', 400);
          }

          if (action === 'change_role' && nextRole === 'Super Admin' && !note) {
            throw new LifecycleRuleError(
              'การกำหนดหรือเปลี่ยนสิทธิ์เป็น Super Admin จำเป็นต้องระบุเหตุผลเพื่อบันทึกใน Audit Log',
              400
            );
          }

          if (action === 'reset_mfa') {
            defaultMfaService.resetUserMfa(targetEmail);
            const updated: UserPermissionEntry = {
              ...current,
              mfaEnabled: false,
              mfaEnrolledAt: undefined,
              reviewedAt: nowStr,
              reviewedBy: actor.email,
              reviewNote: note || 'รีเซ็ต MFA เพื่อให้ผู้ใช้ลงทะเบียน Authenticator ใหม่',
            };
            serverState.config.authorizedUsers[idx] = updated;
            saveServerState(serverState);

            const auditEntry: AuditLogEntry = {
              timestamp: nowStr,
              actor: actor.email,
              targetContractId: `USER:${targetEmail}`,
              fieldChanged: 'MFA Reset',
              oldValue: current.mfaEnabled ? 'Enabled' : 'Disabled',
              newValue: 'Reset (Re-enroll Required)',
              reason: updated.reviewNote || 'รีเซ็ต MFA',
            };

            let sheetsToken: string | null = null;
            try {
              if (serverState.spreadsheetId) {
                sheetsToken = await withSheetsAccess(req, async (t) => t);
              }
            } catch {
              sheetsToken = null;
            }
            await recordSecurityAudit(auditEntry, sheetsToken);

            return { user: updated, auditEntry };
          }

          const caps = getDefaultRoleCapabilities(nextRole);
          let nextStatus: AccountStatus = current.accountStatus;
          if (action === 'approve' || action === 'reactivate') {
            nextStatus = 'Approved';
          } else if (action === 'reject') {
            nextStatus = 'Rejected';
          } else if (action === 'suspend') {
            nextStatus = 'Suspended';
          }

          const updated: UserPermissionEntry = normalizeUserEntry({
            ...current,
            role: nextRole,
            accountStatus: nextStatus,
            disabled: nextStatus === 'Suspended' || nextStatus === 'Rejected',
            canOverrideAr:
              body.canOverrideAr !== undefined && nextRole !== 'Super Admin' && nextRole !== 'Viewer'
                ? Boolean(body.canOverrideAr)
                : caps.canOverrideAr,
            canApprove: caps.canApprove,
            canDelete:
              body.canDelete !== undefined && nextRole !== 'Super Admin' && nextRole !== 'Viewer'
                ? Boolean(body.canDelete)
                : caps.canDelete,
            reviewedAt: nowStr,
            reviewedBy: actor.email,
            reviewNote:
              note ||
              (action === 'approve'
                ? `อนุมัติสิทธิ์ระดับ ${nextRole}`
                : action === 'reactivate'
                  ? `เปิดใช้งานบัญชีระดับ ${nextRole} อีกครั้ง`
                  : `ปรับเปลี่ยนสิทธิ์จาก ${current.role} เป็น ${nextRole}`),
          });

          serverState.config.authorizedUsers[idx] = updated;
          saveServerState(serverState);

          if (nextStatus !== 'Approved') {
            defaultMfaService.clearSessionVerification(targetEmail);
          }

          const fieldLabel =
            action === 'approve'
              ? 'User Approval'
              : action === 'reject'
                ? 'User Rejection'
                : action === 'suspend'
                  ? 'User Suspended'
                  : action === 'reactivate'
                    ? 'User Reactivated'
                    : nextRole === 'Super Admin' || current.role === 'Super Admin'
                      ? 'Super Admin Role Change'
                      : 'User Role Change';

          const auditEntry: AuditLogEntry = {
            timestamp: nowStr,
            actor: actor.email,
            targetContractId: `USER:${targetEmail}`,
            fieldChanged: fieldLabel,
            oldValue: `${current.accountStatus} (${current.role})`,
            newValue: `${updated.accountStatus} (${updated.role})`,
            reason: updated.reviewNote || '-',
          };

          let sheetsToken: string | null = null;
          try {
            if (serverState.spreadsheetId) {
              sheetsToken = await withSheetsAccess(req, async (t) => t);
            }
          } catch {
            sheetsToken = null;
          }

          await recordSecurityAudit(auditEntry, sheetsToken);

          if (serverState.spreadsheetId && sheetsToken) {
            try {
              await writeConfigToSheet(
                sheetsToken,
                serverState.spreadsheetId,
                serverState.config,
                actor.email
              );
            } catch {
              // Saved in local atomic state
            }
          }

          return { user: updated, auditEntry };
        });

        res.json(result);
      } catch (err) {
        sendRouteError(res, err, 'ไม่สามารถดำเนินการอนุมัติหรือจัดการบัญชีได้', 400);
      }
    }
  );

  // Merged Audit Logs (Security/User Events + Google Sheets Audit_Log) for Super Admin & Approver
  app.get('/api/audit-logs', requirePortalAuth, async (req: AuthedRequest, res: Response) => {
    const user = req.portalUser!;
    if (user.role !== 'Super Admin' && user.role !== 'Approver') {
      res.status(403).json({
        errorCode: 'INSUFFICIENT_PERMISSION' satisfies AuthErrorCode,
        error: 'จำกัดสิทธิ์เฉพาะ Super Admin และ Approver เท่านั้น',
      });
      return;
    }

    const localLogs = serverState.securityAuditLogs.slice().reverse();
    let sheetLogs: AuditLogEntry[] = [];
    if (serverState.spreadsheetId) {
      try {
        sheetLogs = await withSheetsAccess(req, async (accessToken) => {
          const dbData = await readAllDatabaseData(
            accessToken,
            serverState.spreadsheetId!,
            serverState.config
          );
          return dbData.auditLogs;
        });
      } catch {
        sheetLogs = [];
      }
    }

    const seen = new Set<string>();
    const merged: AuditLogEntry[] = [];
    for (const item of [...sheetLogs, ...localLogs]) {
      const key = `${item.timestamp}|${item.actor}|${item.targetContractId}|${item.fieldChanged}|${item.newValue}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(item);
      }
    }
    merged.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    res.json({ auditLogs: merged });
  });

  // Store/Sync Google Sheets OAuth Access Token into encrypted backend vault
  app.post('/api/oauth/session', requirePortalAuth, (req: AuthedRequest, res: Response) => {
    const user = req.portalUser!;
    const body = req.body as {
      accessToken?: string;
      expiresInSec?: number;
      expiresAtMs?: number;
    };

    const token = String(body.accessToken || '').trim();
    if (!token) {
      res.status(400).json({ error: 'ไม่พบ Google OAuth Access Token' });
      return;
    }

    const saved = defaultTokenVault.saveUserTokens({
      uid: user.uid,
      email: user.email,
      accessToken: token,
      expiresInSec: body.expiresInSec,
      expiresAtMs: body.expiresAtMs,
    });

    res.json({
      connected: true,
      expiresAtMs: saved.expiresAtMs,
      hasRefreshToken: Boolean(saved.refreshToken),
    });
  });

  // Query Google Sheets authorization status safely (never returns refresh_token or private keys)
  app.get('/api/oauth/status', requirePortalAuth, (req: AuthedRequest, res: Response) => {
    const user = req.portalUser!;
    const authMode = getSheetsAuthMode();
    if (authMode === 'service_account') {
      res.json({
        authMode,
        serviceAccountEmail: defaultServiceAccountManager.getServiceAccountEmail(),
        connected: true,
        hasAccessToken: true,
        expiresAtMs: defaultServiceAccountManager.getExpiresAtMs() || null,
        hasRefreshToken: true,
        revoked: false,
        offlineOAuthConfigured: isOfflineOAuthConfigured(),
      });
      return;
    }

    const status = defaultTokenVault.getUserStatus(user.uid);
    res.json({
      authMode,
      serviceAccountEmail: null,
      offlineOAuthConfigured: isOfflineOAuthConfigured(),
      ...status,
    });
  });

  // Backend proactive / reactive single-flight token refresh endpoint
  app.post('/api/oauth/refresh', requirePortalAuth, async (req: AuthedRequest, res: Response) => {
    const user = req.portalUser!;
    try {
      if (defaultServiceAccountManager.isConfigured()) {
        await defaultServiceAccountManager.getAccessToken(true);
        res.json({
          refreshed: true,
          authMode: 'service_account',
          expiresAtMs: defaultServiceAccountManager.getExpiresAtMs(),
        });
        return;
      }

      const refreshed = await defaultTokenVault.refreshUserAccessToken(user.uid);
      res.json({
        refreshed: true,
        authMode: 'oauth',
        expiresAtMs: refreshed.expiresAtMs,
      });
    } catch (err) {
      sendRouteError(res, err, 'ไม่สามารถต่ออายุ Google Sheets Token ได้', 401);
    }
  });

  // Explicit logout cleanup of backend token vault and MFA session for this user
  app.post('/api/auth/logout', requireFirebaseIdentity, (req: AuthedRequest, res: Response) => {
    const claims = req.firebaseClaims!;
    defaultTokenVault.clearUserTokens(claims.uid);
    defaultMfaService.clearSessionVerification(claims.email);
    res.json({ ok: true });
  });

  // Optional Server-side Offline Authorization Code Flow (only when GOOGLE_OAUTH_CLIENT_SECRET & APP_URL are configured)
  app.get('/api/oauth/google/authorize-url', requirePortalAuth, (req: AuthedRequest, res: Response) => {
    const user = req.portalUser!;
    if (!isOfflineOAuthConfigured()) {
      res.status(400).json({
        error: 'ไม่ได้ตั้งค่า GOOGLE_OAUTH_CLIENT_SECRET สำหรับ Server-side Offline OAuth บนสภาพแวดล้อมนี้',
      });
      return;
    }

    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || FIREBASE_CONFIG.oAuthClientId || '';
    const appUrl = String(process.env.APP_URL || '').replace(/\/+$/, '');
    const redirectUri = `${appUrl}/api/oauth/google/callback`;
    const state = createSignedOAuthState(user.uid, user.email);

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file',
      login_hint: user.email,
      state,
    });

    res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
  });

  app.get(['/api/oauth/google/callback', '/api/oauth/google/callback/'], async (req: Request, res: Response) => {
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    const oauthErr = String(req.query.error || '');

    if (oauthErr || !code || !state) {
      res.status(400).send(`
        <html><body style="font-family:sans-serif;padding:24px;">
          <p>การเชื่อมต่อ Google Sheets ถูกยกเลิกหรือไม่สำเร็จ</p>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'RHP_SHEETS_OAUTH_ERROR', error: 'การเชื่อมต่อถูกยกเลิก' }, '*');
              window.close();
            }
          </script>
        </body></html>
      `);
      return;
    }

    try {
      const { uid, email } = verifySignedOAuthState(state);
      const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || FIREBASE_CONFIG.oAuthClientId || '';
      const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
      const appUrl = String(process.env.APP_URL || '').replace(/\/+$/, '');
      const redirectUri = `${appUrl}/api/oauth/google/callback`;

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }).toString(),
      });

      const data = (await tokenRes.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error_description?: string;
      };

      if (!tokenRes.ok || !data.access_token) {
        throw new Error(data.error_description || 'Token exchange failed');
      }

      const saved = defaultTokenVault.saveUserTokens({
        uid,
        email,
        accessToken: data.access_token,
        expiresInSec: data.expires_in,
        refreshToken: data.refresh_token,
      });

      res.send(`
        <html><body style="font-family:sans-serif;padding:24px;">
          <p>เชื่อมต่อ Google Sheets สำเร็จ หน้าต่างนี้จะปิดอัตโนมัติ</p>
          <script>
            if (window.opener) {
              window.opener.postMessage({
                type: 'RHP_SHEETS_OAUTH_SUCCESS',
                expiresAtMs: ${saved.expiresAtMs},
                hasRefreshToken: ${Boolean(saved.refreshToken)}
              }, '*');
              window.close();
            }
          </script>
        </body></html>
      `);
    } catch {
      res.status(400).send(`
        <html><body style="font-family:sans-serif;padding:24px;">
          <p>ไม่สามารถยืนยันรหัสเชื่อมต่อ Google Sheets ได้</p>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'RHP_SHEETS_OAUTH_ERROR', error: 'ไม่สามารถยืนยันรหัสเชื่อมต่อได้' }, '*');
              window.close();
            }
          </script>
        </body></html>
      `);
    }
  });

  // Initialize or find RHP_Restructuring_Database spreadsheet in Google Drive/Sheets (Super Admin only)
  app.post('/api/sheets/init', requirePortalAuth, requireSuperAdmin, async (req: AuthedRequest, res: Response) => {
    const user = req.portalUser!;
    try {
      const payload = await withSheetsAccess(req, async (accessToken) => {
        const existing = await findExistingDatabaseSpreadsheet(accessToken);
        let meta;
        if (existing) {
          meta = await ensureHeadersAndDefaults(
            accessToken,
            existing.spreadsheetId,
            null,
            serverState.config,
            user.email
          );
        } else {
          meta = await createRhpDatabaseSpreadsheet(accessToken, serverState.config, user.email);
        }

        serverState.spreadsheetId = meta.spreadsheetId;
        serverState.spreadsheetUrl = meta.spreadsheetUrl;
        serverState.spreadsheetTitle = meta.properties.title;
        saveServerState(serverState);

        const dbData = await readAllDatabaseData(accessToken, meta.spreadsheetId, serverState.config);
        const serverUsersByEmail = new Map(
          serverState.config.authorizedUsers.map((u) => [u.email.trim().toLowerCase(), normalizeUserEntry(u)])
        );
        for (const sheetUser of dbData.config.authorizedUsers || []) {
          const k = sheetUser.email.trim().toLowerCase();
          if (k && !serverUsersByEmail.has(k)) {
            serverUsersByEmail.set(k, normalizeUserEntry(sheetUser));
          }
        }
        serverState.config = {
          ...dbData.config,
          companyLogoDataUrl: serverState.config.companyLogoDataUrl,
          authorizedUsers: Array.from(serverUsersByEmail.values()),
        };
        for (const [k, v] of Object.entries(dbData.config.runningNumbers || {})) {
          serverState.runningNumbers[k] = Math.max(serverState.runningNumbers[k] || 0, v);
        }
        saveServerState(serverState);

        return {
          connected: true,
          spreadsheetId: meta.spreadsheetId,
          spreadsheetUrl: meta.spreadsheetUrl,
          spreadsheetTitle: meta.properties.title,
          sheetsPresent: meta.sheets.map((s) => s.properties.title),
          authMode: getSheetsAuthMode(),
          serviceAccountEmail: defaultServiceAccountManager.getServiceAccountEmail(),
          ...dbData,
          config: serverState.config,
        };
      });

      res.json(payload);
    } catch (err) {
      sendRouteError(res, err, 'ไม่สามารถสร้างฐานข้อมูล Google Sheets ได้', 502);
    }
  });

  // Connect to a specific existing Spreadsheet ID or URL (Super Admin only)
  app.post('/api/sheets/connect', requirePortalAuth, requireSuperAdmin, async (req: AuthedRequest, res: Response) => {
    const user = req.portalUser!;
    const rawId = String(req.body?.spreadsheetId || '');
    try {
      const spreadsheetId = extractSpreadsheetId(rawId);
      const payload = await withSheetsAccess(req, async (accessToken) => {
        const meta = await ensureHeadersAndDefaults(
          accessToken,
          spreadsheetId,
          null,
          serverState.config,
          user.email
        );

        serverState.spreadsheetId = meta.spreadsheetId;
        serverState.spreadsheetUrl = meta.spreadsheetUrl;
        serverState.spreadsheetTitle = meta.properties.title;
        saveServerState(serverState);

        const dbData = await readAllDatabaseData(accessToken, meta.spreadsheetId, serverState.config);
        const serverUsersByEmail = new Map(
          serverState.config.authorizedUsers.map((u) => [u.email.trim().toLowerCase(), normalizeUserEntry(u)])
        );
        for (const sheetUser of dbData.config.authorizedUsers || []) {
          const k = sheetUser.email.trim().toLowerCase();
          if (k && !serverUsersByEmail.has(k)) {
            serverUsersByEmail.set(k, normalizeUserEntry(sheetUser));
          }
        }
        serverState.config = {
          ...dbData.config,
          companyLogoDataUrl: serverState.config.companyLogoDataUrl,
          authorizedUsers: Array.from(serverUsersByEmail.values()),
        };
        for (const [k, v] of Object.entries(dbData.config.runningNumbers || {})) {
          serverState.runningNumbers[k] = Math.max(serverState.runningNumbers[k] || 0, v);
        }
        saveServerState(serverState);

        return {
          connected: true,
          spreadsheetId: meta.spreadsheetId,
          spreadsheetUrl: meta.spreadsheetUrl,
          spreadsheetTitle: meta.properties.title,
          sheetsPresent: meta.sheets.map((s) => s.properties.title),
          authMode: getSheetsAuthMode(),
          serviceAccountEmail: defaultServiceAccountManager.getServiceAccountEmail(),
          ...dbData,
          config: serverState.config,
        };
      });

      res.json(payload);
    } catch (err) {
      sendRouteError(res, err, 'ไม่สามารถเชื่อมต่อ Google Sheets ID ที่ระบุได้', 400);
    }
  });

  app.post('/api/sheets/disconnect', requirePortalAuth, requireSuperAdmin, async (req: AuthedRequest, res: Response) => {
    const user = req.portalUser!;
    const prevId = serverState.spreadsheetId || '-';
    serverState.spreadsheetId = null;
    serverState.spreadsheetUrl = null;
    serverState.spreadsheetTitle = null;
    saveServerState(serverState);
    await recordSecurityAudit({
      timestamp: formatBangkokTimestamp(),
      actor: user.email,
      targetContractId: 'SYSTEM:SHEETS',
      fieldChanged: 'Database Disconnected',
      oldValue: prevId,
      newValue: 'Disconnected',
      reason: 'Super Admin ยกเลิกการเชื่อมต่อฐานข้อมูล Google Sheets',
    });
    res.json({ connected: false });
  });

  // Connection diagnostics test endpoint
  app.post('/api/sheets/test', requirePortalAuth, async (req: AuthedRequest, res: Response) => {
    if (!serverState.spreadsheetId) {
      res.status(400).json({ error: 'ยังไม่ได้เชื่อมต่อไฟล์ Google Sheets' });
      return;
    }

    const startedAt = Date.now();
    try {
      const payload = await withSheetsAccess(req, async (accessToken) => {
        const meta = await getSpreadsheetMetadata(accessToken, serverState.spreadsheetId!);
        const dbData = await readAllDatabaseData(accessToken, serverState.spreadsheetId!, serverState.config);
        const latencyMs = Date.now() - startedAt;

        return {
          ok: true,
          latencyMs,
          spreadsheetId: meta.spreadsheetId,
          spreadsheetTitle: meta.properties.title,
          sheetsPresent: meta.sheets.map((s) => s.properties.title),
          counts: {
            transactions: dbData.transactions.length,
            amortizationContracts: Object.keys(dbData.schedulesByContract).length,
            auditLogs: dbData.auditLogs.length,
          },
        };
      });

      res.json(payload);
    } catch (err) {
      sendRouteError(res, err, 'การทดสอบการเชื่อมต่อ Google Sheets ล้มเหลว', 502);
    }
  });

  // Read live data from Google Sheets (Approved + MFA-verified Portal users only)
  app.get('/api/sheets/data', requirePortalAuth, async (req: AuthedRequest, res: Response) => {
    const user = req.portalUser!;
    if (!serverState.spreadsheetId) {
      res.status(400).json({ error: 'ยังไม่ได้เชื่อมต่อฐานข้อมูล Google Sheets' });
      return;
    }

    try {
      const payload = await withSheetsAccess(req, async (accessToken) => {
        const meta = await getSpreadsheetMetadata(accessToken, serverState.spreadsheetId!);
        const dbData = await readAllDatabaseData(accessToken, serverState.spreadsheetId!, serverState.config);
        const serverUsersByEmail = new Map(
          serverState.config.authorizedUsers.map((u) => [u.email.trim().toLowerCase(), normalizeUserEntry(u)])
        );
        for (const sheetUser of dbData.config.authorizedUsers || []) {
          const k = sheetUser.email.trim().toLowerCase();
          if (k && !serverUsersByEmail.has(k)) {
            serverUsersByEmail.set(k, normalizeUserEntry(sheetUser));
          }
        }
        serverState.config = {
          ...dbData.config,
          companyLogoDataUrl: serverState.config.companyLogoDataUrl,
          authorizedUsers: Array.from(serverUsersByEmail.values()),
        };
        for (const [k, v] of Object.entries(dbData.config.runningNumbers || {})) {
          serverState.runningNumbers[k] = Math.max(serverState.runningNumbers[k] || 0, v);
        }
        saveServerState(serverState);

        // Merge securityAuditLogs with Sheets Audit_Log for Super Admin / Approver
        const combinedAuditLogs =
          user.role === 'Super Admin' || user.role === 'Approver'
            ? [...dbData.auditLogs, ...serverState.securityAuditLogs.slice().reverse()]
                .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
            : [];

        return {
          connected: true,
          spreadsheetId: meta.spreadsheetId,
          spreadsheetUrl: meta.spreadsheetUrl,
          spreadsheetTitle: meta.properties.title,
          sheetsPresent: meta.sheets.map((s) => s.properties.title),
          authMode: getSheetsAuthMode(),
          serviceAccountEmail: defaultServiceAccountManager.getServiceAccountEmail(),
          transactions: dbData.transactions,
          schedulesByContract: dbData.schedulesByContract,
          auditLogs: combinedAuditLogs,
          config:
            user.role === 'Super Admin'
              ? serverState.config
              : { ...serverState.config, authorizedUsers: [] },
        };
      });

      res.json(payload);
    } catch (err) {
      sendRouteError(res, err, 'ไม่สามารถโหลดข้อมูลจาก Google Sheets ได้', 502);
    }
  });

  // Atomic, concurrency-safe RHP Contract ID Generator (Authenticated Super Admin / Risk Control only)
  app.post('/api/contracts/reserve-id', requirePortalAuth, async (req: AuthedRequest, res: Response) => {
    const user = req.portalUser!;
    if (!user.canCreateContract) {
      res.status(403).json({
        errorCode: 'INSUFFICIENT_PERMISSION' satisfies AuthErrorCode,
        error: 'บทบาทของคุณไม่มีสิทธิ์สร้างเลขที่สัญญา RHP ใหม่ (เฉพาะ Super Admin หรือ Risk Control)',
      });
      return;
    }

    try {
      let sheetsAccessToken: string | null = null;
      try {
        if (defaultServiceAccountManager.isConfigured()) {
          sheetsAccessToken = await defaultServiceAccountManager.getAccessToken(false);
        } else {
          const valid = await defaultTokenVault.getValidAccessToken(user.uid, false);
          sheetsAccessToken = valid.accessToken;
        }
      } catch {
        sheetsAccessToken = req.googleAccessTokenFromHeader || null;
      }

      const result = await withAtomicLock(async () => {
        const now = new Date();
        const prefix = serverState.config.contractIdPrefix || 'RHP';
        let dbTransactions: RhpTransaction[] = [];
        let sheetRunningNumbers: Record<string, number> | undefined;

        if (serverState.spreadsheetId && sheetsAccessToken) {
          try {
            const dbData = await readAllDatabaseData(
              sheetsAccessToken,
              serverState.spreadsheetId,
              serverState.config
            );
            dbTransactions = dbData.transactions;
            sheetRunningNumbers = dbData.config.runningNumbers;
          } catch {
            // Fall back to local atomic sequence if sheet read momentarily fails
          }
        }

        const reservation = computeNextContractReservation({
          now,
          prefix,
          runningNumbers: serverState.runningNumbers,
          sheetRunningNumbers,
          reservedContractIds: serverState.reservedContractIds,
          transactions: dbTransactions,
        });

        serverState.runningNumbers[reservation.year] = reservation.runningNumber;
        serverState.config.runningNumbers = { ...serverState.runningNumbers };
        if (!serverState.reservedContractIds.includes(reservation.contractId)) {
          serverState.reservedContractIds.push(reservation.contractId);
        }
        saveServerState(serverState);

        if (serverState.spreadsheetId && sheetsAccessToken) {
          try {
            await writeConfigToSheet(
              sheetsAccessToken,
              serverState.spreadsheetId,
              serverState.config,
              user.email
            );
          } catch {
            // Local sequence already advanced atomically; sheet config syncs on save
          }
        }

        return {
          contractId: reservation.contractId,
          year: reservation.year,
          yymm: reservation.year,
          runningNumber: reservation.runningNumber,
          timestamp: reservation.timestamp,
          transactionDate: reservation.transactionDate,
        };
      });

      res.json(result);
    } catch (err) {
      sendRouteError(res, err, 'ไม่สามารถสร้างเลขที่สัญญา RHP ได้', 500);
    }
  });

  // Save new RHP Transaction to Google Sheets (Super Admin / Risk Control only)
  app.post('/api/sheets/transactions', requirePortalAuth, async (req: AuthedRequest, res: Response) => {
    const user = req.portalUser!;
    if (!user.canCreateContract) {
      res.status(403).json({
        errorCode: 'INSUFFICIENT_PERMISSION' satisfies AuthErrorCode,
        error: 'บทบาทของคุณไม่มีสิทธิ์สร้างหรือบันทึกรายการสัญญาใหม่ (เฉพาะ Super Admin หรือ Risk Control)',
      });
      return;
    }
    if (!serverState.spreadsheetId) {
      res.status(400).json({ error: 'ยังไม่ได้เชื่อมต่อฐานข้อมูล Google Sheets' });
      return;
    }

    try {
      const body = req.body as {
        rhpContractId?: string;
        customerId?: string;
        customerName?: string;
        machineSerialNumber?: string;
        originalContractNumber?: string;
        financialInput?: FinancialInput;
        transactionStatus?: TransactionStatus;
        duplicateReason?: string;
      };

      const rhpContractId = String(body.rhpContractId || '').trim();
      const customerId = String(body.customerId || '').trim();
      const customerName = String(body.customerName || '').trim();
      const machineSerialNumber = String(body.machineSerialNumber || '').trim();
      const originalContractNumber = String(body.originalContractNumber || '').trim();

      const prefix = serverState.config.contractIdPrefix || 'RHP';
      if (!rhpContractId || !isValidRhpContractId(rhpContractId, prefix)) {
        res.status(400).json({ error: 'เลขที่สัญญา RHP ไม่ถูกต้องตามรูปแบบ RHP YYYY-XXX' });
        return;
      }
      if (!customerId || !customerName || !machineSerialNumber || !originalContractNumber) {
        res.status(400).json({ error: 'กรุณากรอกข้อมูลลูกค้าทั้ง 4 ช่องให้ครบถ้วนก่อนบันทึก' });
        return;
      }
      if (!body.financialInput) {
        res.status(400).json({ error: 'ไม่พบข้อมูลการคำนวณทางการเงิน' });
        return;
      }

      const calc = calculateRhpFinancials(body.financialInput);
      if (calc.validationErrors.length > 0) {
        res.status(400).json({ error: calc.validationErrors.join(', ') });
        return;
      }

      if (calc.summary.isArOverridden) {
        if (!user.canOverrideAr) {
          res.status(403).json({
            errorCode: 'INSUFFICIENT_PERMISSION' satisfies AuthErrorCode,
            error: 'คุณไม่มีสิทธิ์ในการปรับแก้ยอด AR กรุณาติดต่อผู้ดูแลระบบหรือหัวหน้างาน',
          });
          return;
        }
        if (!String(body.financialInput.arOverrideReason || '').trim()) {
          res.status(400).json({ error: 'กรุณาระบุเหตุผลในการปรับแก้ยอด AR' });
          return;
        }
      }

      const requestedStatus: TransactionStatus =
        body.transactionStatus === 'Approved' ? 'Approved' : 'Draft';
      if (requestedStatus === 'Approved' && !user.canApprove) {
        res.status(403).json({
          errorCode: 'INSUFFICIENT_PERMISSION' satisfies AuthErrorCode,
          error: 'คุณไม่มีสิทธิ์อนุมัติสัญญาโดยตรง กรุณาบันทึกเป็นสถานะ Draft เพื่อรอการอนุมัติ',
        });
        return;
      }

      const now = new Date();
      const timestamp = formatBangkokTimestamp(now);
      const transactionDate = formatBangkokDate(now);

      const newTx: RhpTransaction = {
        timestamp,
        transactionDate,
        rhpContractId,
        customerId,
        customerName,
        machineSerialNumber,
        originalContractNumber,
        machineCost: Number(body.financialInput.machineCost) || 0,
        processingFee: Number(body.financialInput.processingFee) || 0,
        ar: calc.summary.ar,
        interestRate: Number(body.financialInput.interestRate) || 0,
        interestMethod: body.financialInput.interestMethod,
        installmentPeriod: body.financialInput.installmentPeriod,
        downPaymentPercentage: calc.summary.downPaymentPercentage,
        downPaymentAmount: calc.summary.downPaymentAmount,
        financedPrincipal: calc.summary.financedPrincipal,
        totalInterest: calc.summary.totalInterest,
        totalRepayment: calc.summary.totalRepayment,
        monthlyInstallment: calc.summary.monthlyInstallment,
        transactionStatus: requestedStatus,
        createdBy: user.email,
        approvedBy: requestedStatus === 'Approved' ? user.email : '',
        lastUpdated: timestamp,
      };

      const auditEntries: AuditLogEntry[] = [];
      if (calc.summary.isArOverridden) {
        auditEntries.push({
          timestamp,
          actor: user.email,
          targetContractId: rhpContractId,
          fieldChanged: 'AR Override',
          oldValue: String(calc.summary.computedAr),
          newValue: String(calc.summary.ar),
          reason: String(body.financialInput.arOverrideReason || '').trim(),
        });
      }
      if (body.duplicateReason && body.duplicateReason.trim()) {
        auditEntries.push({
          timestamp,
          actor: user.email,
          targetContractId: rhpContractId,
          fieldChanged: 'Duplicate Asset/Contract Justification',
          oldValue: `${machineSerialNumber} / ${originalContractNumber}`,
          newValue: rhpContractId,
          reason: body.duplicateReason.trim(),
        });
      }
      if (requestedStatus === 'Approved') {
        auditEntries.push({
          timestamp,
          actor: user.email,
          targetContractId: rhpContractId,
          fieldChanged: 'Transaction Status',
          oldValue: 'New',
          newValue: 'Approved',
          reason: 'อนุมัติรายการเมื่อบันทึก',
        });
      }

      const saveOutcome = await withAtomicLock(async () => {
        return withSheetsAccess(req, async (accessToken) => {
          const dbData = await readAllDatabaseData(
            accessToken,
            serverState.spreadsheetId!,
            serverState.config
          );

          for (const [k, v] of Object.entries(dbData.config.runningNumbers || {})) {
            serverState.runningNumbers[k] = Math.max(serverState.runningNumbers[k] || 0, v);
          }

          if (isDuplicateContractId(rhpContractId, dbData.transactions)) {
            const nextReservation = computeNextContractReservation({
              now: new Date(),
              prefix,
              runningNumbers: serverState.runningNumbers,
              sheetRunningNumbers: dbData.config.runningNumbers,
              reservedContractIds: serverState.reservedContractIds,
              transactions: dbData.transactions,
            });

            serverState.runningNumbers[nextReservation.year] = nextReservation.runningNumber;
            serverState.config.runningNumbers = { ...serverState.runningNumbers };
            if (!serverState.reservedContractIds.includes(nextReservation.contractId)) {
              serverState.reservedContractIds.push(nextReservation.contractId);
            }
            saveServerState(serverState);

            try {
              await writeConfigToSheet(
                accessToken,
                serverState.spreadsheetId!,
                serverState.config,
                user.email
              );
            } catch {
              // Local atomic state already persisted
            }

            return {
              duplicate: true as const,
              newReservation: nextReservation,
            };
          }

          await appendTransactionToSheet(
            accessToken,
            serverState.spreadsheetId!,
            newTx,
            calc.schedule,
            auditEntries
          );

          const currentYear = getBangkokYear(now);
          const parsedSeq = parseAnnualRunningNumber(rhpContractId, currentYear, prefix);
          let stateChanged = false;
          if (parsedSeq !== null && parsedSeq > (serverState.runningNumbers[currentYear] || 0)) {
            serverState.runningNumbers[currentYear] = parsedSeq;
            serverState.config.runningNumbers = { ...serverState.runningNumbers };
            stateChanged = true;
          }
          if (!serverState.reservedContractIds.includes(rhpContractId)) {
            serverState.reservedContractIds.push(rhpContractId);
            stateChanged = true;
          }
          if (stateChanged) {
            saveServerState(serverState);
            try {
              await writeConfigToSheet(
                accessToken,
                serverState.spreadsheetId!,
                serverState.config,
                user.email
              );
            } catch {
              // Sheet transaction already appended; config sync is best-effort
            }
          }

          return { duplicate: false as const };
        });
      });

      if (saveOutcome.duplicate) {
        res.status(409).json({
          errorCode: 'DUPLICATE_CONTRACT_ID' satisfies AuthErrorCode,
          error: 'เลขที่สัญญานี้ถูกใช้งานแล้ว (This Contract ID has already been used.)',
          duplicateContractId: rhpContractId,
          newContractId: saveOutcome.newReservation.contractId,
          newTimestamp: saveOutcome.newReservation.timestamp,
          newTransactionDate: saveOutcome.newReservation.transactionDate,
        });
        return;
      }

      res.json({
        transaction: newTx,
        schedule: calc.schedule,
        auditEntries,
      });
    } catch (err) {
      sendRouteError(res, err, 'ไม่สามารถบันทึกรายการลง Google Sheets ได้', 400);
    }
  });

  // Update / Approve / Reject / Send Back / Amend an existing transaction with Audit Trail enforcement
  app.put(
    '/api/sheets/transactions/:contractId',
    requirePortalAuth,
    async (req: AuthedRequest, res: Response) => {
      const user = req.portalUser!;
      if (!serverState.spreadsheetId) {
        res.status(400).json({ error: 'ยังไม่ได้เชื่อมต่อฐานข้อมูล Google Sheets' });
        return;
      }

      const contractId = req.params.contractId;
      try {
        const result = await withAtomicLock(async () => {
          return withSheetsAccess(req, async (accessToken) => {
            const dbData = await readAllDatabaseData(
              accessToken,
              serverState.spreadsheetId!,
              serverState.config
            );
            const existingTx = dbData.transactions.find((t) => t.rhpContractId === contractId);
            if (!existingTx) {
              throw new Error(`ไม่พบเลขที่สัญญา ${contractId}`);
            }
            if (existingTx.isDeleted || existingTx.transactionStatus === 'Deleted') {
              throw new Error(
                'รายการนี้ถูกลบแล้ว ไม่สามารถแก้ไขหรืออนุมัติได้ กรุณาให้ผู้ดูแลระบบกู้คืนรายการก่อน'
              );
            }

            const body = req.body as {
              action?: 'approve' | 'reject' | 'send_back' | 'update' | 'amend';
              amendmentReason?: string;
              customerId?: string;
              customerName?: string;
              machineSerialNumber?: string;
              originalContractNumber?: string;
              financialInput?: FinancialInput;
            };

            const nowStr = formatBangkokTimestamp();
            const auditEntries: AuditLogEntry[] = [];

            if (existingTx.transactionStatus === 'Approved' && body.action !== 'amend') {
              throw new Error(
                'ห้ามแก้ไขข้อมูลธุรกรรมที่อนุมัติแล้วโดยตรง กรุณาใช้โหมดขอแก้ไขรายการที่อนุมัติพร้อมระบุเหตุผล'
              );
            }

            if (body.action === 'approve' || body.action === 'reject' || body.action === 'send_back') {
              if (!user.canApprove) {
                throw new LifecycleRuleError('คุณไม่มีสิทธิ์อนุมัติ ปฏิเสธ หรือส่งคืนรายการปรับโครงสร้างสัญญา', 403);
              }
              const reason = String(body.amendmentReason || '').trim();
              if ((body.action === 'reject' || body.action === 'send_back') && !reason) {
                throw new Error('กรุณาระบุเหตุผลประกอบการปฏิเสธหรือส่งรายการกลับไปแก้ไข');
              }

              const nextStatus: TransactionStatus =
                body.action === 'approve'
                  ? 'Approved'
                  : body.action === 'reject'
                    ? 'Rejected'
                    : 'Revision Required';

              const updatedStatusTx: RhpTransaction = {
                ...existingTx,
                transactionStatus: nextStatus,
                approvedBy: nextStatus === 'Approved' ? user.email : '',
                lastUpdated: nowStr,
              };
              const existingSchedule = dbData.schedulesByContract[contractId] || [];
              auditEntries.push({
                timestamp: nowStr,
                actor: user.email,
                targetContractId: contractId,
                fieldChanged: 'Transaction Status',
                oldValue: existingTx.transactionStatus,
                newValue: nextStatus,
                reason:
                  reason ||
                  (nextStatus === 'Approved' ? 'อนุมัติสัญญาปรับโครงสร้างหนี้' : 'ดำเนินการโดยผู้อนุมัติ'),
              });

              await updateTransactionInSheet(
                accessToken,
                serverState.spreadsheetId!,
                updatedStatusTx,
                existingSchedule,
                auditEntries
              );
              return { transaction: updatedStatusTx, schedule: existingSchedule, auditEntries };
            }

            const reason = String(body.amendmentReason || '').trim();
            if (existingTx.transactionStatus === 'Approved') {
              if (!user.canApprove) {
                throw new LifecycleRuleError(
                  'เฉพาะ Approver หรือ Super Admin เท่านั้นที่สามารถแก้ไขข้อมูลสัญญาที่อนุมัติแล้ว',
                  403
                );
              }
              if (!reason) {
                throw new Error('กรุณาระบุเหตุผลในการแก้ไขข้อมูลสัญญาที่อนุมัติแล้ว');
              }
            } else {
              if (!user.canEditDraft) {
                throw new LifecycleRuleError(
                  'บทบาทของคุณไม่มีสิทธิ์แก้ไขรายการสัญญาที่ยังไม่อนุมัติ',
                  403
                );
              }
            }

            const finInput: FinancialInput = body.financialInput || {
              machineCost: existingTx.machineCost,
              processingFee: existingTx.processingFee,
              arOverride: existingTx.ar,
              arOverrideReason: '',
              interestRate: existingTx.interestRate,
              interestMethod: existingTx.interestMethod,
              installmentPeriod: existingTx.installmentPeriod,
              downPaymentMode: 'percentage',
              downPaymentPercentage: existingTx.downPaymentPercentage,
              downPaymentAmount: existingTx.downPaymentAmount,
            };

            const calc = calculateRhpFinancials(finInput);
            if (calc.validationErrors.length > 0) {
              throw new Error(calc.validationErrors.join(', '));
            }

            if (calc.summary.isArOverridden && !user.canOverrideAr) {
              throw new LifecycleRuleError('คุณไม่มีสิทธิ์ในการปรับแก้ยอด AR', 403);
            }

            const nextEditableStatus: TransactionStatus =
              existingTx.transactionStatus === 'Approved' ? 'Approved' : 'Draft';

            const updatedTx: RhpTransaction = {
              ...existingTx,
              transactionStatus: nextEditableStatus,
              customerId: String(body.customerId ?? existingTx.customerId).trim(),
              customerName: String(body.customerName ?? existingTx.customerName).trim(),
              machineSerialNumber: String(body.machineSerialNumber ?? existingTx.machineSerialNumber).trim(),
              originalContractNumber: String(
                body.originalContractNumber ?? existingTx.originalContractNumber
              ).trim(),
              machineCost: Number(finInput.machineCost) || 0,
              processingFee: Number(finInput.processingFee) || 0,
              ar: calc.summary.ar,
              interestRate: Number(finInput.interestRate) || 0,
              interestMethod: finInput.interestMethod,
              installmentPeriod: finInput.installmentPeriod,
              downPaymentPercentage: calc.summary.downPaymentPercentage,
              downPaymentAmount: calc.summary.downPaymentAmount,
              financedPrincipal: calc.summary.financedPrincipal,
              totalInterest: calc.summary.totalInterest,
              totalRepayment: calc.summary.totalRepayment,
              monthlyInstallment: calc.summary.monthlyInstallment,
              lastUpdated: nowStr,
            };

            if (existingTx.transactionStatus !== nextEditableStatus) {
              auditEntries.push({
                timestamp: nowStr,
                actor: user.email,
                targetContractId: contractId,
                fieldChanged: 'Transaction Status',
                oldValue: existingTx.transactionStatus,
                newValue: nextEditableStatus,
                reason: reason || 'แก้ไขรายการและส่งกลับเข้าสู่คิวรออนุมัติ (Draft)',
              });
            }

            const compareFields: Array<[string, string | number, string | number]> = [
              ['Customer ID', existingTx.customerId, updatedTx.customerId],
              ['Customer Name', existingTx.customerName, updatedTx.customerName],
              ['Machine Serial Number', existingTx.machineSerialNumber, updatedTx.machineSerialNumber],
              ['Original Contract Number', existingTx.originalContractNumber, updatedTx.originalContractNumber],
              ['AR', existingTx.ar, updatedTx.ar],
              ['Interest Rate', existingTx.interestRate, updatedTx.interestRate],
              ['Interest Method', existingTx.interestMethod, updatedTx.interestMethod],
              ['Installment Period', existingTx.installmentPeriod, updatedTx.installmentPeriod],
              ['Down Payment Amount', existingTx.downPaymentAmount, updatedTx.downPaymentAmount],
              ['Monthly Installment', existingTx.monthlyInstallment, updatedTx.monthlyInstallment],
            ];

            for (const [label, oldV, newV] of compareFields) {
              if (String(oldV) !== String(newV)) {
                auditEntries.push({
                  timestamp: nowStr,
                  actor: user.email,
                  targetContractId: contractId,
                  fieldChanged: label,
                  oldValue: String(oldV),
                  newValue: String(newV),
                  reason: reason || 'แก้ไขรายการ Draft',
                });
              }
            }

            await updateTransactionInSheet(
              accessToken,
              serverState.spreadsheetId!,
              updatedTx,
              calc.schedule,
              auditEntries
            );
            return { transaction: updatedTx, schedule: calc.schedule, auditEntries };
          });
        });

        res.json(result);
      } catch (err) {
        sendRouteError(res, err, 'ไม่สามารถอัปเดตข้อมูลสัญญาได้', 400);
      }
    }
  );

  // Soft Delete RHP Transaction (Preserves Transaction_Records row & Amortization_Schedule)
  app.delete(
    '/api/sheets/transactions/:contractId',
    requirePortalAuth,
    async (req: AuthedRequest, res: Response) => {
      const user = req.portalUser!;
      if (!serverState.spreadsheetId) {
        res.status(400).json({ error: 'ยังไม่ได้เชื่อมต่อฐานข้อมูล Google Sheets' });
        return;
      }

      const contractId = req.params.contractId;
      const reason = String((req.body as { reason?: string } | undefined)?.reason || '');

      try {
        const result = await withAtomicLock(async () => {
          return withSheetsAccess(req, async (accessToken) => {
            const dbData = await readAllDatabaseData(
              accessToken,
              serverState.spreadsheetId!,
              serverState.config
            );
            const existingTx = dbData.transactions.find((t) => t.rhpContractId === contractId);
            if (!existingTx) {
              throw new LifecycleRuleError(`ไม่พบเลขที่สัญญา ${contractId}`, 404);
            }

            const nowStr = formatBangkokTimestamp();
            const { deletedTx, auditEntries } = buildSoftDeleteTransition({
              existingTx,
              actorEmail: user.email,
              perms: {
                role: user.role,
                canDelete: user.canDelete,
              },
              reason,
              timestamp: nowStr,
            });

            await updateTransactionStatusOnlyInSheet(
              accessToken,
              serverState.spreadsheetId!,
              deletedTx,
              auditEntries
            );

            return { transaction: deletedTx, auditEntries };
          });
        });

        res.json(result);
      } catch (err) {
        sendRouteError(res, err, 'ไม่สามารถลบรายการสัญญาได้', 400);
      }
    }
  );

  // Admin: Restore a soft-deleted RHP Transaction back to its original status
  app.post(
    '/api/sheets/transactions/:contractId/restore',
    requirePortalAuth,
    async (req: AuthedRequest, res: Response) => {
      const user = req.portalUser!;
      if (!serverState.spreadsheetId) {
        res.status(400).json({ error: 'ยังไม่ได้เชื่อมต่อฐานข้อมูล Google Sheets' });
        return;
      }

      const contractId = req.params.contractId;
      const reason = String((req.body as { reason?: string } | undefined)?.reason || '');

      try {
        const result = await withAtomicLock(async () => {
          return withSheetsAccess(req, async (accessToken) => {
            const dbData = await readAllDatabaseData(
              accessToken,
              serverState.spreadsheetId!,
              serverState.config
            );
            const existingTx = dbData.transactions.find((t) => t.rhpContractId === contractId);
            if (!existingTx) {
              throw new LifecycleRuleError(`ไม่พบเลขที่สัญญา ${contractId}`, 404);
            }

            const nowStr = formatBangkokTimestamp();
            const { restoredTx, auditEntries } = buildRestoreTransition({
              existingTx,
              actorEmail: user.email,
              perms: {
                role: user.role,
              },
              reason,
              timestamp: nowStr,
            });

            await updateTransactionStatusOnlyInSheet(
              accessToken,
              serverState.spreadsheetId!,
              restoredTx,
              auditEntries
            );

            return { transaction: restoredTx, auditEntries };
          });
        });

        res.json(result);
      } catch (err) {
        sendRouteError(res, err, 'ไม่สามารถกู้คืนรายการสัญญาได้', 400);
      }
    }
  );

  // Super Admin: Update System Configuration (Interest policy, Company header/logo, User roles)
  app.post('/api/sheets/config', requirePortalAuth, requireSuperAdmin, async (req: AuthedRequest, res: Response) => {
    const user = req.portalUser!;

    try {
      const incoming = req.body as Partial<SystemConfig>;
      const validMethods: InterestMethod[] = ['Flat Rate', 'Reducing Balance'];
      const nextMethod: InterestMethod = validMethods.includes(incoming.defaultInterestMethod as InterestMethod)
        ? (incoming.defaultInterestMethod as InterestMethod)
        : serverState.config.defaultInterestMethod;

      const nextPeriods: InstallmentPeriod[] = Array.isArray(incoming.availableInstallmentPeriods)
        ? (incoming.availableInstallmentPeriods
            .map(Number)
            .filter((n): n is InstallmentPeriod => [12, 24, 36, 48, 60].includes(n)) as InstallmentPeriod[])
        : serverState.config.availableInstallmentPeriods;

      const nextDownOptions: number[] = Array.isArray(incoming.downPaymentOptions)
        ? incoming.downPaymentOptions.map(Number).filter((n) => Number.isFinite(n) && n >= 0 && n <= 100)
        : serverState.config.downPaymentOptions;

      let nextUsers = serverState.config.authorizedUsers;
      if (Array.isArray(incoming.authorizedUsers)) {
        const existingMap = new Map(
          serverState.config.authorizedUsers.map((u) => [u.email.trim().toLowerCase(), normalizeUserEntry(u)])
        );
        const mapped = incoming.authorizedUsers
          .filter((u) => u.email && u.email.trim())
          .map((u) => {
            const email = u.email.trim().toLowerCase();
            const prev = existingMap.get(email);
            const role = normalizeUserRole(u.role);
            const caps = getDefaultRoleCapabilities(role);
            // Prevent user from modifying their own role or disabling themselves
            const finalRole = email === user.email && prev ? prev.role : role;
            const finalDisabled = email === user.email ? false : Boolean(u.disabled);

            return normalizeUserEntry({
              ...prev,
              ...u,
              email,
              role: finalRole,
              accountStatus: finalDisabled
                ? 'Suspended'
                : prev?.accountStatus === 'Pending Verification' || prev?.accountStatus === 'Pending Approval'
                  ? prev.accountStatus
                  : 'Approved',
              emailVerified: prev?.emailVerified ?? true,
              canOverrideAr:
                finalRole === 'Super Admin'
                  ? true
                  : finalRole === 'Viewer'
                    ? false
                    : Boolean(u.canOverrideAr ?? caps.canOverrideAr),
              canApprove: finalRole === 'Super Admin' || finalRole === 'Approver',
              canDelete:
                finalRole === 'Super Admin'
                  ? true
                  : finalRole === 'Viewer'
                    ? false
                    : Boolean(u.canDelete ?? caps.canDelete),
              disabled: finalDisabled,
              displayName: u.displayName || prev?.displayName || email,
            });
          });

        const hasActiveSuperAdmin = mapped.some(
          (u) => u.role === 'Super Admin' && u.accountStatus === 'Approved' && !u.disabled
        );
        if (!hasActiveSuperAdmin) {
          res.status(400).json({
            error: 'ต้องมีบัญชี Super Admin ที่ใช้งานได้อย่างน้อย 1 บัญชีเสมอ',
          });
          return;
        }
        nextUsers = mapped;
      }

      serverState.config = {
        ...serverState.config,
        defaultInterestMethod: nextMethod,
        availableInstallmentPeriods: nextPeriods.length > 0 ? nextPeriods : [12, 24, 36, 48, 60],
        downPaymentOptions: nextDownOptions.length > 0 ? nextDownOptions : [0, 5, 10, 15],
        companyName: String(incoming.companyName ?? serverState.config.companyName).trim(),
        companyAddress: String(incoming.companyAddress ?? serverState.config.companyAddress).trim(),
        companyLogoDataUrl:
          incoming.companyLogoDataUrl !== undefined
            ? incoming.companyLogoDataUrl
            : serverState.config.companyLogoDataUrl,
        authorizedUsers: nextUsers,
      };
      saveServerState(serverState);

      await recordSecurityAudit({
        timestamp: formatBangkokTimestamp(),
        actor: user.email,
        targetContractId: 'SYSTEM:CONFIG',
        fieldChanged: 'System Configuration Updated',
        oldValue: '-',
        newValue: `Interest=${nextMethod}, Users=${nextUsers.length}`,
        reason: 'บันทึกการตั้งค่าระบบและสิทธิ์ผู้ใช้งานโดย Super Admin',
      });

      if (serverState.spreadsheetId) {
        await withSheetsAccess(req, async (accessToken) => {
          await writeConfigToSheet(
            accessToken,
            serverState.spreadsheetId!,
            serverState.config,
            user.email
          );
        });
      }

      res.json({ config: serverState.config });
    } catch (err) {
      sendRouteError(res, err, 'ไม่สามารถบันทึกการตั้งค่าระบบได้', 400);
    }
  });

  // Generate Official Thai PDF Document (Approved + MFA-verified Portal users only)
  app.post('/api/pdf/generate', requirePortalAuth, async (req: AuthedRequest, res: Response) => {
    try {
      const body = req.body as {
        transaction?: RhpTransaction;
        schedule?: AmortizationRow[];
        signatures?: Partial<SignatureNames>;
      };

      if (!body.transaction || !body.transaction.rhpContractId) {
        res.status(400).json({ error: 'ไม่พบข้อมูลสัญญาสำหรับสร้างเอกสาร PDF' });
        return;
      }

      const tx = body.transaction;
      const schedule =
        Array.isArray(body.schedule) && body.schedule.length > 0
          ? body.schedule
          : calculateRhpFinancials({
              machineCost: tx.machineCost,
              processingFee: tx.processingFee,
              arOverride: tx.ar,
              arOverrideReason: '',
              interestRate: tx.interestRate,
              interestMethod: tx.interestMethod,
              installmentPeriod: tx.installmentPeriod,
              downPaymentMode: 'percentage',
              downPaymentPercentage: tx.downPaymentPercentage,
              downPaymentAmount: tx.downPaymentAmount,
            }).schedule;

      const generatedAt = formatBangkokTimestamp();
      const buffer = await generateRhpPdfBuffer({
        transaction: tx,
        schedule,
        companyName: serverState.config.companyName,
        companyAddress: serverState.config.companyAddress,
        companyLogoDataUrl: serverState.config.companyLogoDataUrl,
        signatures: body.signatures,
        generatedAt,
      });

      const filename = buildPdfFilename(tx.rhpContractId, tx.transactionDate);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('X-RHP-Filename', filename);
      res.send(buffer);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'ไม่สามารถสร้างไฟล์ PDF ได้',
      });
    }
  });

  // Vite dev middleware or production static serving
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    const indexHtmlPath = path.join(distDir, 'index.html');
    app.use(express.static(distDir));
    app.get('*', (req, res) => {
      if (req.path.startsWith('/api/')) {
        res.status(404).json({ error: 'API endpoint not found' });
        return;
      }
      if (fs.existsSync(indexHtmlPath)) {
        res.sendFile(indexHtmlPath);
        return;
      }
      res.status(404).send('Production build not found');
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`RHP Management System running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start RHP server:', err);
  process.exit(1);
});
