import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import QRCode from 'qrcode';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const MFA_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours per Firebase authTime session

interface StoredUserMfaRecord {
  uid: string;
  email: string;
  enabled: boolean;
  secret?: string;
  pendingSecret?: string;
  enrolledAt?: string;
  verifiedSessions: Record<string, number>; // authTime -> verifiedUntilMs
  updatedAtMs: number;
}

function resolveVaultDir(): string {
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

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpCode(secretBase32: string, stepCounter: number): string {
  const key = base32Decode(secretBase32);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(stepCounter), 0);
  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const codeInt =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(codeInt % 1_000_000).padStart(6, '0');
}

export function verifyTotpCode(
  secretBase32: string,
  submittedCode: string,
  nowMs = Date.now(),
  windowSteps = 1
): boolean {
  const cleanCode = submittedCode.replace(/\s+/g, '').trim();
  if (!/^\d{6}$/.test(cleanCode)) {
    return false;
  }
  const currentStep = Math.floor(nowMs / 1000 / 30);
  const submittedBuf = Buffer.from(cleanCode, 'utf8');

  for (let delta = -windowSteps; delta <= windowSteps; delta++) {
    const expected = generateTotpCode(secretBase32, currentStep + delta);
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (crypto.timingSafeEqual(submittedBuf, expectedBuf)) {
      return true;
    }
  }
  return false;
}

export function createMfaService(options?: { vaultDir?: string | null; encryptionSecret?: string }) {
  const dir = options?.vaultDir === undefined ? resolveVaultDir() : options.vaultDir;
  const vaultFilePath = dir ? path.join(dir, 'mfa-vault.enc.json') : null;

  function resolveKeyMaterial(): Buffer {
    if (options?.encryptionSecret) {
      return crypto.createHash('sha256').update(options.encryptionSecret).digest();
    }
    if (dir) {
      try {
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
        // Fallback to ephemeral key
      }
    }
    return crypto.randomBytes(32);
  }

  const keyMaterial = resolveKeyMaterial();
  const store = new Map<string, StoredUserMfaRecord>();

  function encryptRecord(rec: StoredUserMfaRecord): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', keyMaterial, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(rec), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return JSON.stringify({
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: encrypted.toString('base64'),
    });
  }

  function decryptRecord(blob: string): StoredUserMfaRecord | null {
    try {
      const parsed = JSON.parse(blob) as { iv: string; tag: string; data: string };
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        keyMaterial,
        Buffer.from(parsed.iv, 'base64')
      );
      decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(parsed.data, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      return JSON.parse(plaintext) as StoredUserMfaRecord;
    } catch {
      return null;
    }
  }

  function loadFromDisk(): void {
    if (!vaultFilePath || !fs.existsSync(vaultFilePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(vaultFilePath, 'utf8')) as Record<string, string>;
      for (const [key, blob] of Object.entries(raw)) {
        const rec = decryptRecord(blob);
        if (rec) {
          store.set(key, rec);
        }
      }
    } catch {
      // ignore corrupted file
    }
  }

  function persistToDisk(): void {
    if (!vaultFilePath) return;
    try {
      const dirPath = path.dirname(vaultFilePath);
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
      const out: Record<string, string> = {};
      for (const [key, rec] of store.entries()) {
        out[key] = encryptRecord(rec);
      }
      const tmp = `${vaultFilePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, vaultFilePath);
    } catch {
      // ignore read-only fs
    }
  }

  loadFromDisk();

  function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  return {
    getUserMfaState(email: string, authTime: number): {
      mfaEnrolled: boolean;
      mfaVerified: boolean;
      enrolledAt?: string;
    } {
      const key = normalizeEmail(email);
      const rec = store.get(key);
      if (!rec || !rec.enabled || !rec.secret) {
        return { mfaEnrolled: false, mfaVerified: false };
      }
      const sessionKey = String(authTime);
      const validUntil = rec.verifiedSessions?.[sessionKey] || 0;
      return {
        mfaEnrolled: true,
        mfaVerified: validUntil > Date.now(),
        enrolledAt: rec.enrolledAt,
      };
    },

    async beginEnrollment(uid: string, email: string): Promise<{
      secretBase32: string;
      otpAuthUri: string;
      qrDataUrl: string;
    }> {
      const key = normalizeEmail(email);
      const existing = store.get(key);
      const secretBase32 = base32Encode(crypto.randomBytes(20));
      const issuer = 'MAX SANY RHP PORTAL';
      const label = encodeURIComponent(`${issuer}:${key}`);
      const otpAuthUri = `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(
        issuer
      )}&algorithm=SHA1&digits=6&period=30`;

      const nextRec: StoredUserMfaRecord = {
        uid,
        email: key,
        enabled: existing?.enabled ?? false,
        secret: existing?.secret,
        pendingSecret: secretBase32,
        enrolledAt: existing?.enrolledAt,
        verifiedSessions: existing?.verifiedSessions || {},
        updatedAtMs: Date.now(),
      };
      store.set(key, nextRec);
      persistToDisk();

      const qrDataUrl = await QRCode.toDataURL(otpAuthUri, {
        width: 220,
        margin: 1,
        color: { dark: '#0F2942', light: '#FFFFFF' },
      });

      return { secretBase32, otpAuthUri, qrDataUrl };
    },

    confirmEnrollment(
      uid: string,
      email: string,
      authTime: number,
      code: string,
      enrolledAtIso: string
    ): boolean {
      const key = normalizeEmail(email);
      const rec = store.get(key);
      if (!rec || !rec.pendingSecret) {
        return false;
      }
      if (!verifyTotpCode(rec.pendingSecret, code)) {
        return false;
      }

      const nextSessions = { ...(rec.verifiedSessions || {}) };
      nextSessions[String(authTime)] = Date.now() + MFA_SESSION_TTL_MS;

      store.set(key, {
        uid,
        email: key,
        enabled: true,
        secret: rec.pendingSecret,
        pendingSecret: undefined,
        enrolledAt: enrolledAtIso,
        verifiedSessions: nextSessions,
        updatedAtMs: Date.now(),
      });
      persistToDisk();
      return true;
    },

    verifyLoginCode(uid: string, email: string, authTime: number, code: string): boolean {
      const key = normalizeEmail(email);
      const rec = store.get(key);
      if (!rec || !rec.enabled || !rec.secret) {
        return false;
      }
      if (!verifyTotpCode(rec.secret, code)) {
        return false;
      }

      const now = Date.now();
      const cleanedSessions: Record<string, number> = {};
      for (const [k, exp] of Object.entries(rec.verifiedSessions || {})) {
        if (exp > now) cleanedSessions[k] = exp;
      }
      cleanedSessions[String(authTime)] = now + MFA_SESSION_TTL_MS;

      store.set(key, {
        ...rec,
        uid,
        verifiedSessions: cleanedSessions,
        updatedAtMs: now,
      });
      persistToDisk();
      return true;
    },

    clearSessionVerification(email: string): void {
      const key = normalizeEmail(email);
      const rec = store.get(key);
      if (!rec) return;
      rec.verifiedSessions = {};
      rec.updatedAtMs = Date.now();
      store.set(key, rec);
      persistToDisk();
    },

    resetUserMfa(email: string): void {
      const key = normalizeEmail(email);
      store.delete(key);
      persistToDisk();
    },
  };
}

export const defaultMfaService = createMfaService();
