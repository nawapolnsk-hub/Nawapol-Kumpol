import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface StoredOAuthTokens {
  uid: string;
  email: string;
  accessToken: string;
  expiresAtMs: number;
  refreshToken?: string;
  revoked: boolean;
  revokedReason?: string;
  updatedAtMs: number;
}

export interface SafeOAuthStatus {
  connected: boolean;
  hasAccessToken: boolean;
  expiresAtMs: number | null;
  hasRefreshToken: boolean;
  revoked: boolean;
  revokedReason?: string;
}

export class TokenVaultError extends Error {
  errorCode: 'ACCESS_TOKEN_EXPIRED' | 'REFRESH_TOKEN_REVOKED' | 'INVALID_TOKEN';
  statusCode: number;

  constructor(
    message: string,
    errorCode: 'ACCESS_TOKEN_EXPIRED' | 'REFRESH_TOKEN_REVOKED' | 'INVALID_TOKEN',
    statusCode = 401
  ) {
    super(message);
    this.errorCode = errorCode;
    this.statusCode = statusCode;
  }
}

const PROACTIVE_REFRESH_WINDOW_MS = 5 * 60 * 1000;

export interface TokenVaultOptions {
  vaultFilePath?: string | null;
  encryptionSecret?: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
  nowFn?: () => number;
  fetchFn?: typeof fetch;
}

export function createOAuthTokenVault(options: TokenVaultOptions = {}) {
  const vaultFilePath =
    options.vaultFilePath === undefined
      ? path.resolve(process.cwd(), 'data', 'oauth-vault.enc.json')
      : options.vaultFilePath;

  const nowFn = options.nowFn || (() => Date.now());
  const fetchFn = options.fetchFn || fetch;

  function resolveKeyMaterial(): Buffer {
    if (options.encryptionSecret) {
      return crypto.createHash('sha256').update(options.encryptionSecret).digest();
    }
    if (vaultFilePath) {
      try {
        const dir = path.dirname(vaultFilePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        const keyFile = path.join(dir, '.vault-master.key');
        if (fs.existsSync(keyFile)) {
          const hex = fs.readFileSync(keyFile, 'utf8').trim();
          if (/^[a-f0-9]{64}$/i.test(hex)) {
            return Buffer.from(hex, 'hex');
          }
        }
        const generated = crypto.randomBytes(32);
        fs.writeFileSync(keyFile, generated.toString('hex'), { encoding: 'utf8', mode: 0o600 });
        return generated;
      } catch {
        // Fallback to ephemeral key if filesystem is read-only
      }
    }
    return crypto.randomBytes(32);
  }

  const keyMaterial = resolveKeyMaterial();

  const memoryStore = new Map<string, StoredOAuthTokens>();
  const inFlightRefreshByUid = new Map<string, Promise<{ accessToken: string; expiresAtMs: number }>>();

  function encryptRecord(record: StoredOAuthTokens): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', keyMaterial, iv);
    const plaintext = JSON.stringify(record);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return JSON.stringify({
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: encrypted.toString('base64'),
    });
  }

  function decryptRecord(blob: string): StoredOAuthTokens | null {
    try {
      const parsed = JSON.parse(blob) as { iv: string; tag: string; data: string };
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        keyMaterial,
        Buffer.from(parsed.iv, 'base64')
      );
      decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(parsed.data, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      return JSON.parse(decrypted) as StoredOAuthTokens;
    } catch {
      return null;
    }
  }

  function loadFromDisk(): void {
    if (!vaultFilePath || !fs.existsSync(vaultFilePath)) return;
    try {
      const raw = fs.readFileSync(vaultFilePath, 'utf8');
      const mapObj = JSON.parse(raw) as Record<string, string>;
      for (const [uid, cipherText] of Object.entries(mapObj)) {
        const rec = decryptRecord(cipherText);
        if (rec && rec.uid) {
          memoryStore.set(uid, rec);
        }
      }
    } catch {
      // Ignore corrupt or differently-keyed vault file on restart
    }
  }

  function persistToDisk(): void {
    if (!vaultFilePath) return;
    try {
      const dir = path.dirname(vaultFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const serialized: Record<string, string> = {};
      for (const [uid, rec] of memoryStore.entries()) {
        serialized[uid] = encryptRecord(rec);
      }
      const tmp = `${vaultFilePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(serialized, null, 2), 'utf8');
      fs.renameSync(tmp, vaultFilePath);
    } catch {
      // Best-effort persistence; in-memory store remains active
    }
  }

  loadFromDisk();

  function getClientCreds() {
    return {
      clientId: options.oauthClientId ?? process.env.GOOGLE_OAUTH_CLIENT_ID ?? '',
      clientSecret: options.oauthClientSecret ?? process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '',
    };
  }

  function saveUserTokens(params: {
    uid: string;
    email: string;
    accessToken: string;
    expiresInSec?: number;
    expiresAtMs?: number;
    refreshToken?: string;
  }): StoredOAuthTokens {
    const existing = memoryStore.get(params.uid);
    const nowMs = nowFn();
    const resolvedExpiresAtMs =
      params.expiresAtMs && Number.isFinite(params.expiresAtMs)
        ? params.expiresAtMs
        : nowMs + Math.max(60, Number(params.expiresInSec) || 3500) * 1000;

    const record: StoredOAuthTokens = {
      uid: params.uid,
      email: params.email.trim().toLowerCase(),
      accessToken: params.accessToken,
      expiresAtMs: resolvedExpiresAtMs,
      refreshToken: params.refreshToken || existing?.refreshToken,
      revoked: false,
      revokedReason: undefined,
      updatedAtMs: nowMs,
    };

    memoryStore.set(params.uid, record);
    persistToDisk();
    return record;
  }

  function getUserStatus(uid: string): SafeOAuthStatus {
    const rec = memoryStore.get(uid);
    if (!rec) {
      return {
        connected: false,
        hasAccessToken: false,
        expiresAtMs: null,
        hasRefreshToken: false,
        revoked: false,
      };
    }
    const nowMs = nowFn();
    const isFresh = Boolean(rec.accessToken && !rec.revoked && nowMs < rec.expiresAtMs);
    return {
      connected: isFresh || Boolean(rec.refreshToken && !rec.revoked),
      hasAccessToken: isFresh,
      expiresAtMs: rec.expiresAtMs || null,
      hasRefreshToken: Boolean(rec.refreshToken && !rec.revoked),
      revoked: rec.revoked,
      revokedReason: rec.revokedReason,
    };
  }

  async function refreshUserAccessToken(uid: string): Promise<{
    accessToken: string;
    expiresAtMs: number;
  }> {
    const existingPromise = inFlightRefreshByUid.get(uid);
    if (existingPromise) {
      return existingPromise;
    }

    const promise = (async () => {
      const rec = memoryStore.get(uid);
      if (!rec) {
        throw new TokenVaultError(
          'ยังไม่ได้เชื่อมต่อสิทธิ์การเข้าถึง Google Sheets กรุณากดเชื่อมต่อ Google Sheets',
          'ACCESS_TOKEN_EXPIRED',
          401
        );
      }

      if (rec.revoked) {
        throw new TokenVaultError(
          rec.revokedReason ||
            'สิทธิ์การเข้าถึง Google Sheets ถูกเพิกถอนหรือหมดอายุ กรุณาเชื่อมต่อ Google Sheets ใหม่',
          'REFRESH_TOKEN_REVOKED',
          401
        );
      }

      const { clientId, clientSecret } = getClientCreds();
      if (!rec.refreshToken || !clientId || !clientSecret) {
        throw new TokenVaultError(
          'Token สำหรับ Google Sheets หมดอายุ กรุณากดปุ่ม Reconnect Google เพื่อขอสิทธิ์เชื่อมต่อบริการ Google Sheets ใหม่',
          'ACCESS_TOKEN_EXPIRED',
          401
        );
      }

      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: rec.refreshToken,
        grant_type: 'refresh_token',
      });

      const res = await fetchFn('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      const data = (await res.json().catch(() => ({}))) as {
        access_token?: string;
        expires_in?: number;
        refresh_token?: string;
        error?: string;
        error_description?: string;
      };

      if (!res.ok || !data.access_token) {
        if (data.error === 'invalid_grant' || res.status === 400 || res.status === 401) {
          rec.revoked = true;
          rec.accessToken = '';
          rec.refreshToken = undefined;
          rec.expiresAtMs = 0;
          rec.revokedReason =
            'สิทธิ์เชื่อมต่อ Google Sheets (Refresh Token) ถูกเพิกถอนหรือหมดอายุ กรุณาเชื่อมต่อบริการ Google Sheets ใหม่';
          rec.updatedAtMs = nowFn();
          memoryStore.set(uid, rec);
          persistToDisk();

          throw new TokenVaultError(rec.revokedReason, 'REFRESH_TOKEN_REVOKED', 401);
        }

        throw new TokenVaultError(
          data.error_description || 'ไม่สามารถต่ออายุ Token ของ Google Sheets ได้ชั่วคราว',
          'ACCESS_TOKEN_EXPIRED',
          503
        );
      }

      const nowMs = nowFn();
      const expiresInSec = Math.max(60, Number(data.expires_in) || 3500);
      const nextExpiresAtMs = nowMs + expiresInSec * 1000;

      rec.accessToken = data.access_token;
      rec.expiresAtMs = nextExpiresAtMs;
      if (data.refresh_token) {
        rec.refreshToken = data.refresh_token;
      }
      rec.revoked = false;
      rec.revokedReason = undefined;
      rec.updatedAtMs = nowMs;
      memoryStore.set(uid, rec);
      persistToDisk();

      return {
        accessToken: rec.accessToken,
        expiresAtMs: rec.expiresAtMs,
      };
    })().finally(() => {
      inFlightRefreshByUid.delete(uid);
    });

    inFlightRefreshByUid.set(uid, promise);
    return promise;
  }

  async function getValidAccessToken(
    uid: string,
    forceRefresh = false
  ): Promise<{ accessToken: string; expiresAtMs: number }> {
    const rec = memoryStore.get(uid);
    const nowMs = nowFn();

    if (
      !forceRefresh &&
      rec &&
      !rec.revoked &&
      rec.accessToken &&
      nowMs < rec.expiresAtMs - PROACTIVE_REFRESH_WINDOW_MS
    ) {
      return {
        accessToken: rec.accessToken,
        expiresAtMs: rec.expiresAtMs,
      };
    }

    // If token is within proactive window (but not yet hard-expired) and there's no server refresh token,
    // return the still-valid token if >5s left, letting client also refresh proactively in parallel.
    if (
      !forceRefresh &&
      rec &&
      !rec.revoked &&
      rec.accessToken &&
      !rec.refreshToken &&
      nowMs < rec.expiresAtMs - 5000
    ) {
      return {
        accessToken: rec.accessToken,
        expiresAtMs: rec.expiresAtMs,
      };
    }

    return refreshUserAccessToken(uid);
  }

  function markAccessTokenExpired(uid: string): void {
    const rec = memoryStore.get(uid);
    if (!rec) return;
    rec.expiresAtMs = 0;
    rec.accessToken = '';
    rec.updatedAtMs = nowFn();
    memoryStore.set(uid, rec);
    persistToDisk();
  }

  function clearUserTokens(uid: string): void {
    memoryStore.delete(uid);
    inFlightRefreshByUid.delete(uid);
    persistToDisk();
  }

  return {
    saveUserTokens,
    getUserStatus,
    getValidAccessToken,
    refreshUserAccessToken,
    markAccessTokenExpired,
    clearUserTokens,
    canOfflineRefresh: (uid: string): boolean => {
      const rec = memoryStore.get(uid);
      const { clientId, clientSecret } = getClientCreds();
      return Boolean(rec?.refreshToken && !rec.revoked && clientId && clientSecret);
    },
  };
}

export const defaultTokenVault = createOAuthTokenVault({
  encryptionSecret: process.env.TOKEN_VAULT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET || undefined,
});
