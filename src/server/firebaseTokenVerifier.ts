import crypto from 'crypto';

const SECURE_TOKEN_CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

export interface VerifiedFirebaseClaims {
  uid: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  signInProvider?: string;
  exp: number;
  iat: number;
  authTime: number;
}

export class FirebaseTokenError extends Error {
  errorCode: 'PORTAL_AUTH_REQUIRED' | 'PORTAL_SESSION_EXPIRED' | 'INVALID_TOKEN';
  statusCode: number;

  constructor(
    message: string,
    errorCode: 'PORTAL_AUTH_REQUIRED' | 'PORTAL_SESSION_EXPIRED' | 'INVALID_TOKEN',
    statusCode = 401
  ) {
    super(message);
    this.errorCode = errorCode;
    this.statusCode = statusCode;
  }
}

interface CertCache {
  certs: Record<string, string>;
  expiresAtMs: number;
}

let certCache: CertCache | null = null;
let certFetchInFlight: Promise<Record<string, string>> | null = null;

function parseMaxAgeMs(cacheControl: string | null): number {
  if (!cacheControl) return 3600 * 1000;
  const m = /max-age=(\d+)/i.exec(cacheControl);
  if (!m) return 3600 * 1000;
  const sec = Number(m[1]);
  return Number.isFinite(sec) && sec > 60 ? sec * 1000 : 3600 * 1000;
}

async function getFirebasePublicCerts(forceRefresh = false): Promise<Record<string, string>> {
  const now = Date.now();
  if (!forceRefresh && certCache && certCache.expiresAtMs > now) {
    return certCache.certs;
  }
  if (certFetchInFlight) {
    return certFetchInFlight;
  }

  certFetchInFlight = (async () => {
    const res = await fetch(SECURE_TOKEN_CERTS_URL);
    if (!res.ok) {
      throw new FirebaseTokenError(
        'ไม่สามารถตรวจสอบใบรับรองความปลอดภัยของ Firebase Auth ได้ชั่วคราว',
        'INVALID_TOKEN',
        503
      );
    }
    const certs = (await res.json()) as Record<string, string>;
    const ttlMs = parseMaxAgeMs(res.headers.get('cache-control'));
    certCache = { certs, expiresAtMs: Date.now() + ttlMs };
    return certs;
  })().finally(() => {
    certFetchInFlight = null;
  });

  return certFetchInFlight;
}

function decodeBase64UrlJson<T>(segment: string): T {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const raw = Buffer.from(padded, 'base64').toString('utf8');
  return JSON.parse(raw) as T;
}

function base64UrlToBuffer(segment: string): Buffer {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

export function verifyJwtWithPublicKeys(
  idToken: string,
  publicKeysByKid: Record<string, string>,
  projectId: string,
  nowSec = Math.floor(Date.now() / 1000)
): VerifiedFirebaseClaims {
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new FirebaseTokenError('รูปแบบ Session Token ไม่ถูกต้อง', 'INVALID_TOKEN', 401);
  }

  const [headerB64, payloadB64, signatureB64] = parts;
  let header: { alg?: string; kid?: string };
  let payload: {
    aud?: string;
    iss?: string;
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    firebase?: { sign_in_provider?: string };
    exp?: number;
    iat?: number;
    auth_time?: number;
  };

  try {
    header = decodeBase64UrlJson(headerB64);
    payload = decodeBase64UrlJson(payloadB64);
  } catch {
    throw new FirebaseTokenError('ไม่สามารถอ่านข้อมูล Session Token ได้', 'INVALID_TOKEN', 401);
  }

  if (header.alg !== 'RS256' || !header.kid) {
    throw new FirebaseTokenError('อัลกอริทึมหรือ Key ID ของ Session Token ไม่ถูกต้อง', 'INVALID_TOKEN', 401);
  }

  const publicKeyPem = publicKeysByKid[header.kid];
  if (!publicKeyPem) {
    throw new FirebaseTokenError('ไม่พบใบรับรองสาธารณะสำหรับ Session Token นี้', 'INVALID_TOKEN', 401);
  }

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();

  const signatureBuf = base64UrlToBuffer(signatureB64);
  const validSignature = verifier.verify(publicKeyPem, signatureBuf);
  if (!validSignature) {
    throw new FirebaseTokenError('ลายเซ็นของ Session Token ไม่ถูกต้อง', 'INVALID_TOKEN', 401);
  }

  if (payload.aud !== projectId) {
    throw new FirebaseTokenError('Session Token ไม่ตรงกับโปรเจกต์ที่กำหนด', 'INVALID_TOKEN', 401);
  }

  const expectedIssuer = `https://securetoken.google.com/${projectId}`;
  if (payload.iss !== expectedIssuer) {
    throw new FirebaseTokenError('ผู้ออก Session Token ไม่ถูกต้อง', 'INVALID_TOKEN', 401);
  }

  if (!payload.sub || typeof payload.sub !== 'string' || payload.sub.length > 128) {
    throw new FirebaseTokenError('ไม่พบรหัสผู้ใช้งานใน Session Token', 'INVALID_TOKEN', 401);
  }

  if (!payload.email || typeof payload.email !== 'string') {
    throw new FirebaseTokenError('ไม่พบอีเมลผู้ใช้งานใน Session Token', 'INVALID_TOKEN', 401);
  }

  const exp = Number(payload.exp || 0);
  const iat = Number(payload.iat || 0);
  const authTime = Number(payload.auth_time || iat);

  if (exp <= nowSec - 30) {
    throw new FirebaseTokenError(
      'Session การเข้าสู่ระบบ RHP Portal หมดอายุ กรุณารีเฟรชหรือเข้าสู่ระบบใหม่',
      'PORTAL_SESSION_EXPIRED',
      401
    );
  }

  if (iat > nowSec + 300 || authTime > nowSec + 300) {
    throw new FirebaseTokenError('เวลาที่ออก Session Token ไม่ถูกต้อง', 'INVALID_TOKEN', 401);
  }

  return {
    uid: payload.sub,
    email: payload.email.trim().toLowerCase(),
    emailVerified: Boolean(payload.email_verified),
    name: payload.name,
    signInProvider: payload.firebase?.sign_in_provider,
    exp,
    iat,
    authTime,
  };
}

export async function verifyFirebaseIdToken(
  idToken: string,
  projectId: string
): Promise<VerifiedFirebaseClaims> {
  if (!idToken || !idToken.trim()) {
    throw new FirebaseTokenError('กรุณาเข้าสู่ระบบ RHP Portal ก่อนดำเนินการ', 'PORTAL_AUTH_REQUIRED', 401);
  }

  const trimmed = idToken.trim();
  const certs = await getFirebasePublicCerts(false);

  try {
    return verifyJwtWithPublicKeys(trimmed, certs, projectId);
  } catch (err) {
    // If key ID rotated, refresh certificates once and retry verification
    if (err instanceof FirebaseTokenError && err.message.includes('ไม่พบใบรับรองสาธารณะ')) {
      const freshCerts = await getFirebasePublicCerts(true);
      return verifyJwtWithPublicKeys(trimmed, freshCerts, projectId);
    }
    throw err;
  }
}
