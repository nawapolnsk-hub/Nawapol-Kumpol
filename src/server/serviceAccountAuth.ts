import crypto from 'crypto';

export interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const SERVICE_ACCOUNT_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
].join(' ');

const PROACTIVE_REFRESH_WINDOW_MS = 5 * 60 * 1000;

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function parseServiceAccountEnv(rawInput: string | undefined): ServiceAccountCredentials | null {
  if (!rawInput || !rawInput.trim()) return null;
  const trimmed = rawInput.trim();

  let jsonStr = trimmed;
  if (!trimmed.startsWith('{')) {
    try {
      jsonStr = Buffer.from(trimmed, 'base64').toString('utf8');
    } catch {
      return null;
    }
  }

  try {
    const parsed = JSON.parse(jsonStr) as Partial<ServiceAccountCredentials>;
    if (!parsed.client_email || !parsed.private_key) {
      return null;
    }
    return {
      client_email: parsed.client_email.trim(),
      private_key: parsed.private_key.replace(/\\n/g, '\n'),
      token_uri: parsed.token_uri || 'https://oauth2.googleapis.com/token',
    };
  } catch {
    return null;
  }
}

export function createServiceAccountJwtAssertion(
  creds: ServiceAccountCredentials,
  nowSec = Math.floor(Date.now() / 1000)
): string {
  const tokenUri = creds.token_uri || 'https://oauth2.googleapis.com/token';
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claimSet = base64UrlEncode(
    JSON.stringify({
      iss: creds.client_email,
      scope: SERVICE_ACCOUNT_SCOPES,
      aud: tokenUri,
      iat: nowSec,
      exp: nowSec + 3600,
    })
  );

  const signingInput = `${header}.${claimSet}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = base64UrlEncode(signer.sign(creds.private_key));
  return `${signingInput}.${signature}`;
}

export interface ServiceAccountManagerOptions {
  credentials: ServiceAccountCredentials | null;
  nowFn?: () => number;
  fetchFn?: typeof fetch;
}

export function createServiceAccountTokenManager(options: ServiceAccountManagerOptions) {
  const creds = options.credentials;
  const nowFn = options.nowFn || (() => Date.now());
  const fetchFn = options.fetchFn || fetch;

  let cachedToken: string | null = null;
  let expiresAtMs = 0;
  let inFlightRefresh: Promise<string> | null = null;

  async function refreshToken(): Promise<string> {
    if (!creds) {
      throw new Error('ไม่ได้ตั้งค่า Google Service Account Credentials');
    }

    if (inFlightRefresh) {
      return inFlightRefresh;
    }

    inFlightRefresh = (async () => {
      const nowMs = nowFn();
      const assertion = createServiceAccountJwtAssertion(creds, Math.floor(nowMs / 1000));
      const tokenUri = creds.token_uri || 'https://oauth2.googleapis.com/token';

      const body = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      });

      const res = await fetchFn(tokenUri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      const data = (await res.json().catch(() => ({}))) as {
        access_token?: string;
        expires_in?: number;
        error?: string;
        error_description?: string;
      };

      if (!res.ok || !data.access_token) {
        cachedToken = null;
        expiresAtMs = 0;
        const detail = data.error_description || data.error || `HTTP ${res.status}`;
        throw new Error(`Service Account ไม่สามารถขอ Access Token ได้: ${detail}`);
      }

      const expiresInSec = Math.max(60, Number(data.expires_in) || 3600);
      cachedToken = data.access_token;
      expiresAtMs = nowFn() + expiresInSec * 1000;
      return cachedToken;
    })().finally(() => {
      inFlightRefresh = null;
    });

    return inFlightRefresh;
  }

  return {
    isConfigured: (): boolean => Boolean(creds),
    getServiceAccountEmail: (): string | null => creds?.client_email || null,
    getExpiresAtMs: (): number => expiresAtMs,
    getAccessToken: async (forceRefresh = false): Promise<string> => {
      if (!creds) {
        throw new Error('ไม่ได้ตั้งค่า Google Service Account Credentials');
      }
      const nowMs = nowFn();
      if (!forceRefresh && cachedToken && nowMs < expiresAtMs - PROACTIVE_REFRESH_WINDOW_MS) {
        return cachedToken;
      }
      return refreshToken();
    },
    clearCache: (): void => {
      cachedToken = null;
      expiresAtMs = 0;
    },
  };
}

export const defaultServiceAccountManager = createServiceAccountTokenManager({
  credentials: parseServiceAccountEnv(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
});
