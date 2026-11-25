import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createServer as createViteServer } from 'vite';
import { generateRhpPdfBuffer } from './src/server/pdfGenerator.ts';
import {
  appendTransactionToSheet,
  createRhpDatabaseSpreadsheet,
  ensureHeadersAndDefaults,
  findExistingDatabaseSpreadsheet,
  getSpreadsheetMetadata,
  readAllDatabaseData,
  updateTransactionInSheet,
  writeConfigToSheet,
} from './src/server/sheetsService.ts';
import type {
  AmortizationRow,
  AuditLogEntry,
  FinancialInput,
  InstallmentPeriod,
  InterestMethod,
  RhpTransaction,
  SignatureNames,
  SystemConfig,
  TransactionStatus,
  UserPermissionEntry,
  UserRole,
} from './src/types/rhp.ts';
import {
  buildPdfFilename,
  calculateRhpFinancials,
  formatBangkokDate,
  formatBangkokTimestamp,
  getBangkokYYMM,
} from './src/utils/rhpCalculator.ts';

const PORT = 3000;
const DATA_DIR = path.resolve(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'server-state.json');

interface ServerState {
  spreadsheetId: string | null;
  spreadsheetUrl: string | null;
  spreadsheetTitle: string | null;
  runningNumbers: Record<string, number>;
  reservedContractIds: string[];
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

function loadServerState(): ServerState {
  ensureDataDir();
  if (fs.existsSync(STATE_FILE)) {
    try {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw) as Partial<ServerState>;
      return {
        spreadsheetId: parsed.spreadsheetId ?? null,
        spreadsheetUrl: parsed.spreadsheetUrl ?? null,
        spreadsheetTitle: parsed.spreadsheetTitle ?? null,
        runningNumbers: parsed.runningNumbers || {},
        reservedContractIds: Array.isArray(parsed.reservedContractIds) ? parsed.reservedContractIds : [],
        config: {
          ...DEFAULT_CONFIG,
          ...(parsed.config || {}),
          authorizedUsers: Array.isArray(parsed.config?.authorizedUsers)
            ? parsed.config!.authorizedUsers
            : [],
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

interface VerifiedUser {
  email: string;
  accessToken: string;
  role: UserRole;
  canOverrideAr: boolean;
  canApprove: boolean;
}

interface TokenCacheEntry {
  email: string;
  expiresAtMs: number;
}
const tokenInfoCache = new Map<string, TokenCacheEntry>();

function resolveUserPermissions(email: string): {
  role: UserRole;
  canOverrideAr: boolean;
  canApprove: boolean;
} {
  const norm = email.trim().toLowerCase();
  if (serverState.config.authorizedUsers.length === 0) {
    // Bootstrap first signed-in workspace user as Admin
    const bootstrapUser: UserPermissionEntry = {
      email: norm,
      role: 'Admin',
      canOverrideAr: true,
      canApprove: true,
      displayName: email,
    };
    serverState.config.authorizedUsers.push(bootstrapUser);
    saveServerState(serverState);
    return { role: 'Admin', canOverrideAr: true, canApprove: true };
  }

  const found = serverState.config.authorizedUsers.find(
    (u) => u.email.trim().toLowerCase() === norm
  );
  if (found) {
    return {
      role: found.role,
      canOverrideAr: found.canOverrideAr || found.role === 'Admin' || found.role === 'Supervisor',
      canApprove: found.canApprove || found.role === 'Admin' || found.role === 'Supervisor',
    };
  }

  return { role: 'Staff', canOverrideAr: false, canApprove: false };
}

async function verifyGoogleBearerToken(accessToken: string): Promise<VerifiedUser> {
  const hash = crypto.createHash('sha256').update(accessToken).digest('hex');
  const cached = tokenInfoCache.get(hash);
  let email = '';

  if (cached && cached.expiresAtMs > Date.now()) {
    email = cached.email;
  } else {
    const res = await fetch(
      `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(accessToken)}`
    );
    if (!res.ok) {
      throw new Error('โทเค็น Google OAuth หมดอายุหรือไม่ถูกต้อง กรุณาเข้าสู่ระบบใหม่');
    }
    const info = (await res.json()) as { email?: string; expires_in?: string };
    if (!info.email) {
      throw new Error('ไม่พบอีเมลผู้ใช้งานจากบัญชี Google');
    }
    email = info.email;
    const ttlSec = Math.min(300, Math.max(30, Number(info.expires_in) || 60));
    tokenInfoCache.set(hash, {
      email,
      expiresAtMs: Date.now() + ttlSec * 1000,
    });
  }

  const perms = resolveUserPermissions(email);
  return {
    email,
    accessToken,
    ...perms,
  };
}

interface AuthedRequest extends Request {
  verifiedUser?: VerifiedUser;
}

async function requireGoogleAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'กรุณาเข้าสู่ระบบด้วยบัญชี Google ก่อนดำเนินการ' });
    return;
  }
  const token = authHeader.slice(7).trim();
  if (!token) {
    res.status(401).json({ error: 'ไม่พบสิทธิ์การเข้าถึง Google Workspace' });
    return;
  }

  try {
    req.verifiedUser = await verifyGoogleBearerToken(token);
    next();
  } catch (err) {
    res.status(401).json({
      error: err instanceof Error ? err.message : 'การยืนยันตัวตนล้มเหลว',
    });
  }
}

function extractSpreadsheetId(input: string): string {
  const trimmed = input.trim();
  const urlMatch = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(trimmed);
  if (urlMatch) return urlMatch[1];
  if (/^[a-zA-Z0-9-_]{15,}$/.test(trimmed)) return trimmed;
  throw new Error('รูปแบบ Spreadsheet ID หรือ URL ของ Google Sheets ไม่ถูกต้อง');
}

function parseMaxRunningFromTransactions(
  transactions: RhpTransaction[],
  prefix: string,
  yymm: string
): number {
  let maxSeq = 0;
  const pattern = new RegExp(`^${prefix}-${yymm}-(\\d{6})$`);
  for (const tx of transactions) {
    const m = pattern.exec(tx.rhpContractId);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
    }
  }
  return maxSeq;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  // Current user profile & public non-secret workspace status
  app.get('/api/sheets/status', (_req: Request, res: Response) => {
    res.json({
      connected: Boolean(serverState.spreadsheetId),
      spreadsheetId: serverState.spreadsheetId,
      spreadsheetUrl: serverState.spreadsheetUrl,
      spreadsheetTitle: serverState.spreadsheetTitle,
      config: serverState.config,
    });
  });

  // Get authenticated user permissions
  app.get('/api/auth/me', requireGoogleAuth, (req: AuthedRequest, res: Response) => {
    const user = req.verifiedUser!;
    res.json({
      email: user.email,
      role: user.role,
      canOverrideAr: user.canOverrideAr,
      canApprove: user.canApprove,
    });
  });

  // Initialize or find RHP_Restructuring_Database spreadsheet in Google Drive/Sheets
  app.post('/api/sheets/init', requireGoogleAuth, async (req: AuthedRequest, res: Response) => {
    const user = req.verifiedUser!;
    try {
      const existing = await findExistingDatabaseSpreadsheet(user.accessToken);
      let meta;
      if (existing) {
        meta = await ensureHeadersAndDefaults(
          user.accessToken,
          existing.spreadsheetId,
          null,
          serverState.config,
          user.email
        );
      } else {
        meta = await createRhpDatabaseSpreadsheet(
          user.accessToken,
          serverState.config,
          user.email
        );
      }

      serverState.spreadsheetId = meta.spreadsheetId;
      serverState.spreadsheetUrl = meta.spreadsheetUrl;
      serverState.spreadsheetTitle = meta.properties.title;
      saveServerState(serverState);

      const dbData = await readAllDatabaseData(user.accessToken, meta.spreadsheetId, serverState.config);
      serverState.config = {
        ...dbData.config,
        companyLogoDataUrl: serverState.config.companyLogoDataUrl,
      };
      // Sync running numbers
      for (const [k, v] of Object.entries(dbData.config.runningNumbers || {})) {
        serverState.runningNumbers[k] = Math.max(serverState.runningNumbers[k] || 0, v);
      }
      saveServerState(serverState);

      res.json({
        connected: true,
        spreadsheetId: meta.spreadsheetId,
        spreadsheetUrl: meta.spreadsheetUrl,
        spreadsheetTitle: meta.properties.title,
        sheetsPresent: meta.sheets.map((s) => s.properties.title),
        ...dbData,
        config: serverState.config,
      });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'ไม่สามารถสร้างฐานข้อมูล Google Sheets ได้',
      });
    }
  });

  // Connect to a specific existing Spreadsheet ID or URL
  app.post('/api/sheets/connect', requireGoogleAuth, async (req: AuthedRequest, res: Response) => {
    const user = req.verifiedUser!;
    const rawId = String(req.body?.spreadsheetId || '');
    try {
      const spreadsheetId = extractSpreadsheetId(rawId);
      const meta = await ensureHeadersAndDefaults(
        user.accessToken,
        spreadsheetId,
        null,
        serverState.config,
        user.email
      );

      serverState.spreadsheetId = meta.spreadsheetId;
      serverState.spreadsheetUrl = meta.spreadsheetUrl;
      serverState.spreadsheetTitle = meta.properties.title;
      saveServerState(serverState);

      const dbData = await readAllDatabaseData(user.accessToken, meta.spreadsheetId, serverState.config);
      serverState.config = {
        ...dbData.config,
        companyLogoDataUrl: serverState.config.companyLogoDataUrl,
      };
      for (const [k, v] of Object.entries(dbData.config.runningNumbers || {})) {
        serverState.runningNumbers[k] = Math.max(serverState.runningNumbers[k] || 0, v);
      }
      saveServerState(serverState);

      res.json({
        connected: true,
        spreadsheetId: meta.spreadsheetId,
        spreadsheetUrl: meta.spreadsheetUrl,
        spreadsheetTitle: meta.properties.title,
        sheetsPresent: meta.sheets.map((s) => s.properties.title),
        ...dbData,
        config: serverState.config,
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'ไม่สามารถเชื่อมต่อ Google Sheets ID ที่ระบุได้',
      });
    }
  });

  app.post('/api/sheets/disconnect', requireGoogleAuth, (_req: AuthedRequest, res: Response) => {
    serverState.spreadsheetId = null;
    serverState.spreadsheetUrl = null;
    serverState.spreadsheetTitle = null;
    saveServerState(serverState);
    res.json({ connected: false });
  });

  // Connection diagnostics test endpoint
  app.post('/api/sheets/test', requireGoogleAuth, async (req: AuthedRequest, res: Response) => {
    const user = req.verifiedUser!;
    if (!serverState.spreadsheetId) {
      res.status(400).json({ error: 'ยังไม่ได้เชื่อมต่อไฟล์ Google Sheets' });
      return;
    }

    const startedAt = Date.now();
    try {
      const meta = await getSpreadsheetMetadata(user.accessToken, serverState.spreadsheetId);
      const dbData = await readAllDatabaseData(user.accessToken, serverState.spreadsheetId, serverState.config);
      const latencyMs = Date.now() - startedAt;

      res.json({
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
      });
    } catch (err) {
      res.status(502).json({
        ok: false,
        error: err instanceof Error ? err.message : 'การทดสอบการเชื่อมต่อ Google Sheets ล้มเหลว',
      });
    }
  });

  // Read live data from Google Sheets
  app.get('/api/sheets/data', requireGoogleAuth, async (req: AuthedRequest, res: Response) => {
    const user = req.verifiedUser!;
    if (!serverState.spreadsheetId) {
      res.status(400).json({ error: 'ยังไม่ได้เชื่อมต่อฐานข้อมูล Google Sheets' });
      return;
    }

    try {
      const meta = await getSpreadsheetMetadata(user.accessToken, serverState.spreadsheetId);
      const dbData = await readAllDatabaseData(user.accessToken, serverState.spreadsheetId, serverState.config);
      serverState.config = {
        ...dbData.config,
        companyLogoDataUrl: serverState.config.companyLogoDataUrl,
      };
      for (const [k, v] of Object.entries(dbData.config.runningNumbers || {})) {
        serverState.runningNumbers[k] = Math.max(serverState.runningNumbers[k] || 0, v);
      }
      saveServerState(serverState);

      res.json({
        connected: true,
        spreadsheetId: meta.spreadsheetId,
        spreadsheetUrl: meta.spreadsheetUrl,
        spreadsheetTitle: meta.properties.title,
        sheetsPresent: meta.sheets.map((s) => s.properties.title),
        ...dbData,
        config: serverState.config,
      });
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'ไม่สามารถโหลดข้อมูลจาก Google Sheets ได้',
      });
    }
  });

  // Atomic, concurrency-safe RHP Contract ID Generator (RHP-YYMM-XXXXXX)
  app.post('/api/contracts/reserve-id', async (req: AuthedRequest, res: Response) => {
    try {
      const authHeader = req.headers.authorization || '';
      let accessToken: string | null = null;
      let actorEmail = 'System';
      if (authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7).trim();
        if (token) {
          const verified = await verifyGoogleBearerToken(token);
          accessToken = verified.accessToken;
          actorEmail = verified.email;
        }
      }

      const result = await withAtomicLock(async () => {
        const now = new Date();
        const yymm = getBangkokYYMM(now);
        const prefix = serverState.config.contractIdPrefix || 'RHP';
        let currentMax = serverState.runningNumbers[yymm] || 0;

        if (serverState.spreadsheetId && accessToken) {
          try {
            const dbData = await readAllDatabaseData(
              accessToken,
              serverState.spreadsheetId,
              serverState.config
            );
            const sheetSeq = dbData.config.runningNumbers?.[yymm] || 0;
            const maxTxSeq = parseMaxRunningFromTransactions(dbData.transactions, prefix, yymm);
            currentMax = Math.max(currentMax, sheetSeq, maxTxSeq);
          } catch {
            // Fall back to local atomic sequence if sheet read momentarily fails
          }
        }

        const nextNumber = currentMax + 1;
        const contractId = `${prefix}-${yymm}-${String(nextNumber).padStart(6, '0')}`;

        serverState.runningNumbers[yymm] = nextNumber;
        serverState.config.runningNumbers = { ...serverState.runningNumbers };
        if (!serverState.reservedContractIds.includes(contractId)) {
          serverState.reservedContractIds.push(contractId);
        }
        saveServerState(serverState);

        if (serverState.spreadsheetId && accessToken) {
          try {
            await writeConfigToSheet(
              accessToken,
              serverState.spreadsheetId,
              serverState.config,
              actorEmail
            );
          } catch {
            // Local sequence already advanced atomically; sheet config syncs on save
          }
        }

        return {
          contractId,
          yymm,
          runningNumber: nextNumber,
          timestamp: formatBangkokTimestamp(now),
          transactionDate: formatBangkokDate(now),
        };
      });

      res.json(result);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'ไม่สามารถสร้างเลขที่สัญญา RHP ได้',
      });
    }
  });

  // Save new RHP Transaction to Google Sheets
  app.post('/api/sheets/transactions', requireGoogleAuth, async (req: AuthedRequest, res: Response) => {
    const user = req.verifiedUser!;
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

      if (!rhpContractId || !/^RHP-\d{4}-\d{6}$/.test(rhpContractId)) {
        res.status(400).json({ error: 'เลขที่สัญญา RHP ไม่ถูกต้องตามรูปแบบ RHP-YYMM-XXXXXX' });
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

      await withAtomicLock(async () => {
        await appendTransactionToSheet(
          user.accessToken,
          serverState.spreadsheetId!,
          newTx,
          calc.schedule,
          auditEntries
        );
      });

      res.json({
        transaction: newTx,
        schedule: calc.schedule,
        auditEntries,
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'ไม่สามารถบันทึกรายการลง Google Sheets ได้',
      });
    }
  });

  // Update / Approve / Amend an existing transaction with Audit Trail enforcement
  app.put(
    '/api/sheets/transactions/:contractId',
    requireGoogleAuth,
    async (req: AuthedRequest, res: Response) => {
      const user = req.verifiedUser!;
      if (!serverState.spreadsheetId) {
        res.status(400).json({ error: 'ยังไม่ได้เชื่อมต่อฐานข้อมูล Google Sheets' });
        return;
      }

      const contractId = req.params.contractId;
      try {
        const result = await withAtomicLock(async () => {
          const dbData = await readAllDatabaseData(
            user.accessToken,
            serverState.spreadsheetId!,
            serverState.config
          );
          const existingTx = dbData.transactions.find((t) => t.rhpContractId === contractId);
          if (!existingTx) {
            throw new Error(`ไม่พบเลขที่สัญญา ${contractId}`);
          }

          const body = req.body as {
            action?: 'approve' | 'update' | 'amend';
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

          if (body.action === 'approve') {
            if (!user.canApprove) {
              throw new Error('คุณไม่มีสิทธิ์อนุมัติรายการปรับโครงสร้างสัญญา');
            }
            const approvedTx: RhpTransaction = {
              ...existingTx,
              transactionStatus: 'Approved',
              approvedBy: user.email,
              lastUpdated: nowStr,
            };
            const existingSchedule = dbData.schedulesByContract[contractId] || [];
            auditEntries.push({
              timestamp: nowStr,
              actor: user.email,
              targetContractId: contractId,
              fieldChanged: 'Transaction Status',
              oldValue: existingTx.transactionStatus,
              newValue: 'Approved',
              reason: String(body.amendmentReason || 'อนุมัติสัญญาปรับโครงสร้างหนี้').trim(),
            });

            await updateTransactionInSheet(
              user.accessToken,
              serverState.spreadsheetId!,
              approvedTx,
              existingSchedule,
              auditEntries
            );
            return { transaction: approvedTx, schedule: existingSchedule, auditEntries };
          }

          // Update Draft or Authorized Post-Approval Amendment
          const reason = String(body.amendmentReason || '').trim();
          if (existingTx.transactionStatus === 'Approved') {
            if (!user.canApprove) {
              throw new Error('เฉพาะ Supervisor หรือ Admin เท่านั้นที่สามารถแก้ไขข้อมูลสัญญาที่อนุมัติแล้ว');
            }
            if (!reason) {
              throw new Error('กรุณาระบุเหตุผลในการแก้ไขข้อมูลสัญญาที่อนุมัติแล้ว');
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
            throw new Error('คุณไม่มีสิทธิ์ในการปรับแก้ยอด AR');
          }

          const updatedTx: RhpTransaction = {
            ...existingTx,
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
            user.accessToken,
            serverState.spreadsheetId!,
            updatedTx,
            calc.schedule,
            auditEntries
          );
          return { transaction: updatedTx, schedule: calc.schedule, auditEntries };
        });

        res.json(result);
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? err.message : 'ไม่สามารถอัปเดตข้อมูลสัญญาได้',
        });
      }
    }
  );

  // Admin: Update System Configuration (Interest policy, Company header/logo, User roles)
  app.post('/api/sheets/config', requireGoogleAuth, async (req: AuthedRequest, res: Response) => {
    const user = req.verifiedUser!;
    if (user.role !== 'Admin') {
      res.status(403).json({ error: 'เฉพาะผู้ดูแลระบบ (Admin) เท่านั้นที่สามารถแก้ไขค่ากำหนดระบบได้' });
      return;
    }

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

      const nextUsers: UserPermissionEntry[] = Array.isArray(incoming.authorizedUsers)
        ? incoming.authorizedUsers
            .filter((u) => u.email && u.email.trim())
            .map((u) => ({
              email: u.email.trim().toLowerCase(),
              role: (['Staff', 'Supervisor', 'Admin'].includes(u.role) ? u.role : 'Staff') as UserRole,
              canOverrideAr: Boolean(u.canOverrideAr || u.role === 'Admin' || u.role === 'Supervisor'),
              canApprove: Boolean(u.canApprove || u.role === 'Admin' || u.role === 'Supervisor'),
              displayName: u.displayName || u.email.trim(),
            }))
        : serverState.config.authorizedUsers;

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

      if (serverState.spreadsheetId) {
        await writeConfigToSheet(
          user.accessToken,
          serverState.spreadsheetId,
          serverState.config,
          user.email
        );
      }

      res.json({ config: serverState.config });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'ไม่สามารถบันทึกการตั้งค่าระบบได้',
      });
    }
  });

  // Generate Official Thai PDF Document (A4 Portrait, embedded Thai fonts)
  app.post('/api/pdf/generate', async (req: Request, res: Response) => {
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

      // Ensure financial numbers and schedule are consistent via server calculation
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
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
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
