import type {
  AmortizationRow,
  AuditLogEntry,
  InterestMethod,
  InstallmentPeriod,
  RhpTransaction,
  SystemConfig,
  TransactionStatus,
  UserPermissionEntry,
} from '../types/rhp.ts';
import { formatBangkokTimestamp } from '../utils/rhpCalculator.ts';
import { normalizeUserEntry } from '../utils/transactionLifecycle.ts';

export const SPREADSHEET_NAME = 'RHP_Restructuring_Database';

export const SHEET_NAMES = {
  TRANSACTIONS: 'Transaction_Records',
  AMORTIZATION: 'Amortization_Schedule',
  CONFIG: 'System_Configuration',
  AUDIT: 'Audit_Log',
} as const;

export const TRANSACTION_HEADERS = [
  'Timestamp',
  'Transaction Date',
  'RHP Contract ID',
  'Customer ID',
  'Customer Name',
  'Machine Serial Number',
  'Original Contract Number',
  'Machine Cost',
  'Additional Processing Fee',
  'AR',
  'Interest Rate',
  'Interest Method',
  'Installment Period',
  'Down Payment Percentage',
  'Down Payment Amount',
  'Financed Principal',
  'Total Interest',
  'Total Repayment',
  'Monthly Installment',
  'Transaction Status',
  'Created By',
  'Approved By',
  'Last Updated',
  'Is Deleted',
  'Deleted At',
  'Deleted By',
  'Deletion Reason',
  'Previous Status',
];

export const AMORTIZATION_HEADERS = [
  'RHP Contract ID',
  'Installment No',
  'Beginning Principal',
  'Principal Paid',
  'Interest Paid',
  'Monthly Payment',
  'Ending Principal',
];

export const CONFIG_HEADERS = [
  'Config Key',
  'Config Value',
  'Description',
  'Updated At',
  'Updated By',
];

export const AUDIT_HEADERS = [
  'Timestamp',
  'Actor',
  'Target Contract ID',
  'Field Changed',
  'Old Value',
  'New Value',
  'Reason',
];

interface SheetApiErrorPayload {
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

export class SheetsApiError extends Error {
  status: number;
  errorCode:
    | 'ACCESS_TOKEN_EXPIRED'
    | 'INSUFFICIENT_PERMISSION'
    | 'SHEETS_API_UNAVAILABLE'
    | 'NETWORK_ERROR'
    | 'UNKNOWN_ERROR';

  constructor(
    message: string,
    status: number,
    errorCode:
      | 'ACCESS_TOKEN_EXPIRED'
      | 'INSUFFICIENT_PERMISSION'
      | 'SHEETS_API_UNAVAILABLE'
      | 'NETWORK_ERROR'
      | 'UNKNOWN_ERROR'
  ) {
    super(message);
    this.status = status;
    this.errorCode = errorCode;
  }
}

async function sheetsFetch<T>(url: string, accessToken: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
    });
  } catch {
    throw new SheetsApiError(
      'ไม่สามารถเชื่อมต่อ Google Sheets API ได้ กรุณาตรวจสอบการเชื่อมต่อเครือข่าย',
      503,
      'NETWORK_ERROR'
    );
  }

  const text = await res.text();
  let json: unknown = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }

  if (!res.ok) {
    const errPayload = json as SheetApiErrorPayload;
    const rawMsg = errPayload?.error?.message || `Google Sheets API Error (${res.status})`;

    if (res.status === 401) {
      throw new SheetsApiError(
        'สิทธิ์เชื่อมต่อ Google Sheets หมดอายุหรือไม่ถูกต้อง กรุณากด Reconnect Google (เซสชัน RHP Portal และข้อมูลที่กรอกยังคงอยู่)',
        401,
        'ACCESS_TOKEN_EXPIRED'
      );
    }

    if (res.status === 403) {
      throw new SheetsApiError(
        `ไม่มีสิทธิ์เข้าถึงไฟล์ Google Sheets นี้ (${rawMsg}) กรุณาตรวจสอบสิทธิ์การแชร์ไฟล์หรือบัญชีผู้ใช้งาน`,
        403,
        'INSUFFICIENT_PERMISSION'
      );
    }

    if (res.status === 429 || res.status >= 500) {
      throw new SheetsApiError(
        'บริการ Google Sheets ไม่พร้อมใช้งานชั่วคราว กรุณาลองใหม่อีกครั้ง',
        res.status >= 500 ? 503 : 429,
        'SHEETS_API_UNAVAILABLE'
      );
    }

    throw new SheetsApiError(rawMsg, res.status, 'UNKNOWN_ERROR');
  }

  return json as T;
}

export interface SpreadsheetMetadata {
  spreadsheetId: string;
  spreadsheetUrl: string;
  properties: { title: string };
  sheets: Array<{
    properties: {
      sheetId: number;
      title: string;
    };
  }>;
}

export async function findExistingDatabaseSpreadsheet(accessToken: string): Promise<{
  spreadsheetId: string;
  name: string;
} | null> {
  const q = encodeURIComponent(
    `name = '${SPREADSHEET_NAME}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`
  );
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=5`;
  const data = await sheetsFetch<{ files?: Array<{ id: string; name: string }> }>(url, accessToken);
  if (data.files && data.files.length > 0) {
    return { spreadsheetId: data.files[0].id, name: data.files[0].name };
  }
  return null;
}

export async function createRhpDatabaseSpreadsheet(
  accessToken: string,
  initialConfig: SystemConfig,
  actorEmail: string
): Promise<SpreadsheetMetadata> {
  const payload = {
    properties: {
      title: SPREADSHEET_NAME,
      locale: 'th_TH',
      timeZone: 'Asia/Bangkok',
    },
    sheets: [
      { properties: { title: SHEET_NAMES.TRANSACTIONS, gridProperties: { frozenRowCount: 1 } } },
      { properties: { title: SHEET_NAMES.AMORTIZATION, gridProperties: { frozenRowCount: 1 } } },
      { properties: { title: SHEET_NAMES.CONFIG, gridProperties: { frozenRowCount: 1 } } },
      { properties: { title: SHEET_NAMES.AUDIT, gridProperties: { frozenRowCount: 1 } } },
    ],
  };

  const created = await sheetsFetch<SpreadsheetMetadata>(
    'https://sheets.googleapis.com/v4/spreadsheets',
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );

  await ensureHeadersAndDefaults(accessToken, created.spreadsheetId, created, initialConfig, actorEmail);
  return created;
}

export async function getSpreadsheetMetadata(
  accessToken: string,
  spreadsheetId: string
): Promise<SpreadsheetMetadata> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
    spreadsheetId
  )}?fields=spreadsheetId,spreadsheetUrl,properties.title,sheets.properties(sheetId,title)`;
  return sheetsFetch<SpreadsheetMetadata>(url, accessToken);
}

export async function ensureHeadersAndDefaults(
  accessToken: string,
  spreadsheetId: string,
  metadataInput: SpreadsheetMetadata | null,
  defaultConfig: SystemConfig,
  actorEmail: string
): Promise<SpreadsheetMetadata> {
  const meta = metadataInput || (await getSpreadsheetMetadata(accessToken, spreadsheetId));
  const existingTitles = new Set(meta.sheets.map((s) => s.properties.title));

  const requiredTabs = [
    SHEET_NAMES.TRANSACTIONS,
    SHEET_NAMES.AMORTIZATION,
    SHEET_NAMES.CONFIG,
    SHEET_NAMES.AUDIT,
  ];

  const missingTabs = requiredTabs.filter((t) => !existingTitles.has(t));
  if (missingTabs.length > 0) {
    await sheetsFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
      accessToken,
      {
        method: 'POST',
        body: JSON.stringify({
          requests: missingTabs.map((title) => ({
            addSheet: {
              properties: { title, gridProperties: { frozenRowCount: 1 } },
            },
          })),
        }),
      }
    );
  }

  const updatedMeta = missingTabs.length > 0 ? await getSpreadsheetMetadata(accessToken, spreadsheetId) : meta;

  // Check first row of each tab (including extended soft-delete columns A1:AD1)
  const ranges = requiredTabs.map((t) => `${t}!A1:AD1`).join('&ranges=');
  const batchGet = await sheetsFetch<{
    valueRanges?: Array<{ range: string; values?: string[][] }>;
  }>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values:batchGet?ranges=${ranges}`,
    accessToken
  );

  const expectedHeaders: Record<string, string[]> = {
    [SHEET_NAMES.TRANSACTIONS]: TRANSACTION_HEADERS,
    [SHEET_NAMES.AMORTIZATION]: AMORTIZATION_HEADERS,
    [SHEET_NAMES.CONFIG]: CONFIG_HEADERS,
    [SHEET_NAMES.AUDIT]: AUDIT_HEADERS,
  };

  const valueUpdates: Array<{ range: string; values: unknown[][] }> = [];
  const formatRequests: unknown[] = [];

  for (let i = 0; i < requiredTabs.length; i++) {
    const tab = requiredTabs[i];
    const existingRow = batchGet.valueRanges?.[i]?.values?.[0];
    if (!existingRow || existingRow.length < expectedHeaders[tab].length) {
      valueUpdates.push({
        range: `${tab}!A1`,
        values: [expectedHeaders[tab]],
      });
      const sheetObj = updatedMeta.sheets.find((s) => s.properties.title === tab);
      if (sheetObj) {
        formatRequests.push({
          repeatCell: {
            range: {
              sheetId: sheetObj.properties.sheetId,
              startRowIndex: 0,
              endRowIndex: 1,
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.059, green: 0.161, blue: 0.259 },
                textFormat: {
                  foregroundColor: { red: 1, green: 1, blue: 1 },
                  bold: true,
                },
              },
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat)',
          },
        });
      }
    }
  }

  // Ensure System_Configuration has default rows if empty
  const configRead = await sheetsFetch<{ values?: string[][] }>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values/${SHEET_NAMES.CONFIG}!A2:E20`,
    accessToken
  );

  if (!configRead.values || configRead.values.length === 0) {
    const now = formatBangkokTimestamp();
    valueUpdates.push({
      range: `${SHEET_NAMES.CONFIG}!A2`,
      values: buildConfigRows(defaultConfig, now, actorEmail),
    });
  }

  if (valueUpdates.length > 0) {
    await sheetsFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values:batchUpdate`,
      accessToken,
      {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'USER_ENTERED',
          data: valueUpdates,
        }),
      }
    );
  }

  if (formatRequests.length > 0) {
    await sheetsFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}:batchUpdate`,
      accessToken,
      {
        method: 'POST',
        body: JSON.stringify({ requests: formatRequests }),
      }
    );
  }

  return updatedMeta;
}

function buildConfigRows(config: SystemConfig, timestamp: string, actor: string): string[][] {
  return [
    ['Contract ID Prefix', config.contractIdPrefix, 'Prefix for generated RHP contracts', timestamp, actor],
    ['Running Number', JSON.stringify(config.runningNumbers), 'Annual/legacy sequence map by YYYY / YYMM', timestamp, actor],
    ['Default Interest Method', config.defaultInterestMethod, 'Company default interest method', timestamp, actor],
    ['Available Installment Periods', JSON.stringify(config.availableInstallmentPeriods), 'Allowed installment months', timestamp, actor],
    ['Down Payment Options', JSON.stringify(config.downPaymentOptions), 'Preset down payment percentages', timestamp, actor],
    ['Company Name', config.companyName, 'Company title shown on RHP PDF header', timestamp, actor],
    ['Company Address', config.companyAddress, 'Company address shown on RHP PDF header', timestamp, actor],
    ['Authorized Users', JSON.stringify(config.authorizedUsers), 'Role and permission registry', timestamp, actor],
  ];
}

export async function readAllDatabaseData(
  accessToken: string,
  spreadsheetId: string,
  fallbackConfig: SystemConfig
): Promise<{
  transactions: RhpTransaction[];
  schedulesByContract: Record<string, AmortizationRow[]>;
  config: SystemConfig;
  auditLogs: AuditLogEntry[];
}> {
  const ranges = [
    `${SHEET_NAMES.TRANSACTIONS}!A2:AB`,
    `${SHEET_NAMES.AMORTIZATION}!A2:G`,
    `${SHEET_NAMES.CONFIG}!A2:E`,
    `${SHEET_NAMES.AUDIT}!A2:G`,
  ]
    .map((r) => `ranges=${encodeURIComponent(r)}`)
    .join('&');

  const data = await sheetsFetch<{
    valueRanges?: Array<{ values?: string[][] }>;
  }>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values:batchGet?${ranges}`,
    accessToken
  );

  const txRows = data.valueRanges?.[0]?.values || [];
  const amortRows = data.valueRanges?.[1]?.values || [];
  const cfgRows = data.valueRanges?.[2]?.values || [];
  const auditRows = data.valueRanges?.[3]?.values || [];

  const transactions: RhpTransaction[] = txRows
    .filter((r) => r[2])
    .map((r) => {
      const rawStatus = String(r[19] || '').trim();
      const isDeletedCol = String(r[23] || '').trim().toUpperCase() === 'TRUE';
      const isDeleted = isDeletedCol || rawStatus === 'Deleted';
      const transactionStatus: TransactionStatus = isDeleted
        ? 'Deleted'
        : rawStatus === 'Approved'
          ? 'Approved'
          : rawStatus === 'Rejected'
            ? 'Rejected'
            : rawStatus === 'Revision Required'
              ? 'Revision Required'
              : 'Draft';
      const prevStatusRaw = String(r[27] || '').trim();
      const previousStatus =
        prevStatusRaw === 'Approved'
          ? 'Approved'
          : prevStatusRaw === 'Draft'
            ? 'Draft'
            : undefined;

      return {
        timestamp: r[0] || '',
        transactionDate: r[1] || '',
        rhpContractId: r[2] || '',
        customerId: r[3] || '',
        customerName: r[4] || '',
        machineSerialNumber: r[5] || '',
        originalContractNumber: r[6] || '',
        machineCost: Number(r[7]) || 0,
        processingFee: Number(r[8]) || 0,
        ar: Number(r[9]) || 0,
        interestRate: Number(r[10]) || 0,
        interestMethod: (r[11] === 'Reducing Balance' ? 'Reducing Balance' : 'Flat Rate') as InterestMethod,
        installmentPeriod: (Number(r[12]) || 12) as InstallmentPeriod,
        downPaymentPercentage: Number(r[13]) || 0,
        downPaymentAmount: Number(r[14]) || 0,
        financedPrincipal: Number(r[15]) || 0,
        totalInterest: Number(r[16]) || 0,
        totalRepayment: Number(r[17]) || 0,
        monthlyInstallment: Number(r[18]) || 0,
        transactionStatus,
        createdBy: r[20] || '',
        approvedBy: r[21] || '',
        lastUpdated: r[22] || '',
        isDeleted,
        deletedAt: r[24] || undefined,
        deletedBy: r[25] || undefined,
        deletionReason: r[26] || undefined,
        previousStatus,
      };
    });

  const schedulesByContract: Record<string, AmortizationRow[]> = {};
  for (const r of amortRows) {
    const cid = r[0];
    if (!cid) continue;
    if (!schedulesByContract[cid]) schedulesByContract[cid] = [];
    schedulesByContract[cid].push({
      installmentNo: Number(r[1]) || 0,
      beginningPrincipal: Number(r[2]) || 0,
      principalPaid: Number(r[3]) || 0,
      interestPaid: Number(r[4]) || 0,
      monthlyPayment: Number(r[5]) || 0,
      endingPrincipal: Number(r[6]) || 0,
    });
  }

  for (const cid of Object.keys(schedulesByContract)) {
    schedulesByContract[cid].sort((a, b) => a.installmentNo - b.installmentNo);
  }

  const config: SystemConfig = { ...fallbackConfig };
  for (const r of cfgRows) {
    const key = r[0];
    const val = r[1] ?? '';
    if (!key) continue;
    if (key === 'Contract ID Prefix' && val) config.contractIdPrefix = val;
    if (key === 'Running Number' && val) {
      try {
        config.runningNumbers = JSON.parse(val) as Record<string, number>;
      } catch {
        // ignore invalid json
      }
    }
    if (key === 'Default Interest Method') {
      config.defaultInterestMethod = val === 'Reducing Balance' ? 'Reducing Balance' : 'Flat Rate';
    }
    if (key === 'Available Installment Periods' && val) {
      try {
        config.availableInstallmentPeriods = JSON.parse(val) as InstallmentPeriod[];
      } catch {
        // ignore
      }
    }
    if (key === 'Down Payment Options' && val) {
      try {
        config.downPaymentOptions = JSON.parse(val) as number[];
      } catch {
        // ignore
      }
    }
    if (key === 'Company Name' && val) config.companyName = val;
    if (key === 'Company Address') config.companyAddress = val;
    if (key === 'Authorized Users' && val) {
      try {
        const parsed = JSON.parse(val) as Partial<UserPermissionEntry>[];
        config.authorizedUsers = Array.isArray(parsed)
          ? parsed.map((u) => normalizeUserEntry(u))
          : [];
      } catch {
        // ignore
      }
    }
  }

  const auditLogs: AuditLogEntry[] = auditRows
    .filter((r) => r[0] || r[2])
    .map((r) => ({
      timestamp: r[0] || '',
      actor: r[1] || '',
      targetContractId: r[2] || '',
      fieldChanged: r[3] || '',
      oldValue: r[4] || '',
      newValue: r[5] || '',
      reason: r[6] || '',
    }))
    .reverse();

  return { transactions, schedulesByContract, config, auditLogs };
}

function transactionToRow(tx: RhpTransaction): Array<string | number> {
  return [
    tx.timestamp,
    tx.transactionDate,
    tx.rhpContractId,
    tx.customerId,
    tx.customerName,
    tx.machineSerialNumber,
    tx.originalContractNumber,
    tx.machineCost,
    tx.processingFee,
    tx.ar,
    tx.interestRate,
    tx.interestMethod,
    tx.installmentPeriod,
    tx.downPaymentPercentage,
    tx.downPaymentAmount,
    tx.financedPrincipal,
    tx.totalInterest,
    tx.totalRepayment,
    tx.monthlyInstallment,
    tx.transactionStatus,
    tx.createdBy,
    tx.approvedBy,
    tx.lastUpdated,
    tx.isDeleted ? 'TRUE' : 'FALSE',
    tx.deletedAt || '',
    tx.deletedBy || '',
    tx.deletionReason || '',
    tx.previousStatus || '',
  ];
}

export async function appendTransactionToSheet(
  accessToken: string,
  spreadsheetId: string,
  tx: RhpTransaction,
  schedule: AmortizationRow[],
  auditEntries: AuditLogEntry[]
): Promise<void> {
  // Duplicate check before insert
  const existing = await sheetsFetch<{ values?: string[][] }>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values/${SHEET_NAMES.TRANSACTIONS}!C2:C`,
    accessToken
  );

  const ids = new Set((existing.values || []).map((r) => r[0]));
  if (ids.has(tx.rhpContractId)) {
    throw new Error(`พบเลขที่สัญญา ${tx.rhpContractId} ในฐานข้อมูลแล้ว ไม่สามารถบันทึกซ้ำได้`);
  }

  await sheetsFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values/${SHEET_NAMES.TRANSACTIONS}!A:AB:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify({
        values: [transactionToRow(tx)],
      }),
    }
  );

  if (schedule.length > 0) {
    const amortValues = schedule.map((row) => [
      tx.rhpContractId,
      row.installmentNo,
      row.beginningPrincipal,
      row.principalPaid,
      row.interestPaid,
      row.monthlyPayment,
      row.endingPrincipal,
    ]);

    await sheetsFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values/${SHEET_NAMES.AMORTIZATION}!A:G:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      accessToken,
      {
        method: 'POST',
        body: JSON.stringify({ values: amortValues }),
      }
    );
  }

  if (auditEntries.length > 0) {
    await appendAuditLogsToSheet(accessToken, spreadsheetId, auditEntries);
  }
}

export async function updateTransactionInSheet(
  accessToken: string,
  spreadsheetId: string,
  updatedTx: RhpTransaction,
  newSchedule: AmortizationRow[],
  auditEntries: AuditLogEntry[]
): Promise<void> {
  const existing = await sheetsFetch<{ values?: string[][] }>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values/${SHEET_NAMES.TRANSACTIONS}!C2:C`,
    accessToken
  );

  const rows = existing.values || [];
  const rowIndex = rows.findIndex((r) => r[0] === updatedTx.rhpContractId);
  if (rowIndex === -1) {
    throw new Error(`ไม่พบเลขที่สัญญา ${updatedTx.rhpContractId} ใน Google Sheets`);
  }

  const sheetRowNumber = rowIndex + 2;
  await sheetsFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values/${SHEET_NAMES.TRANSACTIONS}!A${sheetRowNumber}:AB${sheetRowNumber}?valueInputOption=USER_ENTERED`,
    accessToken,
    {
      method: 'PUT',
      body: JSON.stringify({
        values: [transactionToRow(updatedTx)],
      }),
    }
  );

  // Replace Amortization rows for this contract cleanly
  const amortRead = await sheetsFetch<{ values?: string[][] }>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values/${SHEET_NAMES.AMORTIZATION}!A2:G`,
    accessToken
  );

  const retainedRows = (amortRead.values || []).filter((r) => r[0] !== updatedTx.rhpContractId);
  const newAmortRows = newSchedule.map((row) => [
    updatedTx.rhpContractId,
    row.installmentNo,
    row.beginningPrincipal,
    row.principalPaid,
    row.interestPaid,
    row.monthlyPayment,
    row.endingPrincipal,
  ]);
  const combinedAmort = [...retainedRows, ...newAmortRows];

  await sheetsFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values/${SHEET_NAMES.AMORTIZATION}!A2:G:clear`,
    accessToken,
    { method: 'POST', body: JSON.stringify({}) }
  );

  if (combinedAmort.length > 0) {
    await sheetsFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
        spreadsheetId
      )}/values/${SHEET_NAMES.AMORTIZATION}!A2?valueInputOption=USER_ENTERED`,
      accessToken,
      {
        method: 'PUT',
        body: JSON.stringify({ values: combinedAmort }),
      }
    );
  }

  if (auditEntries.length > 0) {
    await appendAuditLogsToSheet(accessToken, spreadsheetId, auditEntries);
  }
}

/**
 * Updates only the transaction row in Transaction_Records and appends Audit_Log entries.
 * Preserves Amortization_Schedule rows completely untouched (used for Soft Delete & Restore).
 */
export async function updateTransactionStatusOnlyInSheet(
  accessToken: string,
  spreadsheetId: string,
  updatedTx: RhpTransaction,
  auditEntries: AuditLogEntry[]
): Promise<void> {
  const existing = await sheetsFetch<{ values?: string[][] }>(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values/${SHEET_NAMES.TRANSACTIONS}!C2:C`,
    accessToken
  );

  const rows = existing.values || [];
  const rowIndex = rows.findIndex((r) => r[0] === updatedTx.rhpContractId);
  if (rowIndex === -1) {
    throw new Error(`ไม่พบเลขที่สัญญา ${updatedTx.rhpContractId} ใน Google Sheets`);
  }

  const sheetRowNumber = rowIndex + 2;
  await sheetsFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values/${SHEET_NAMES.TRANSACTIONS}!A${sheetRowNumber}:AB${sheetRowNumber}?valueInputOption=USER_ENTERED`,
    accessToken,
    {
      method: 'PUT',
      body: JSON.stringify({
        values: [transactionToRow(updatedTx)],
      }),
    }
  );

  if (auditEntries.length > 0) {
    await appendAuditLogsToSheet(accessToken, spreadsheetId, auditEntries);
  }
}

export async function appendAuditLogsToSheet(
  accessToken: string,
  spreadsheetId: string,
  entries: AuditLogEntry[]
): Promise<void> {
  if (entries.length === 0) return;
  await sheetsFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values/${SHEET_NAMES.AUDIT}!A:G:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify({
        values: entries.map((e) => [
          e.timestamp,
          e.actor,
          e.targetContractId,
          e.fieldChanged,
          e.oldValue,
          e.newValue,
          e.reason,
        ]),
      }),
    }
  );
}

export async function writeConfigToSheet(
  accessToken: string,
  spreadsheetId: string,
  config: SystemConfig,
  actorEmail: string
): Promise<void> {
  const now = formatBangkokTimestamp();
  const rows = buildConfigRows(config, now, actorEmail);
  await sheetsFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values/${SHEET_NAMES.CONFIG}!A2:E${rows.length + 1}?valueInputOption=USER_ENTERED`,
    accessToken,
    {
      method: 'PUT',
      body: JSON.stringify({ values: rows }),
    }
  );
}
