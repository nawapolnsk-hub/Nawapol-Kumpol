import type { SheetsAuthMode, SheetsAuthStatus } from '../types/rhp.ts';
import { createSingleFlightGuard } from './authErrorMapper.ts';

declare global {
  interface Window {
    google?: {
      accounts?: {
        oauth2?: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            prompt?: string;
            login_hint?: string;
            callback: (response: {
              access_token?: string;
              expires_in?: number;
              error?: string;
              error_description?: string;
            }) => void;
            error_callback?: (error: { type?: string; message?: string }) => void;
          }) => {
            requestAccessToken: (overrideConfig?: { prompt?: string; login_hint?: string }) => void;
          };
        };
      };
    };
  }
}

export interface SheetsOAuthSnapshot {
  authMode: SheetsAuthMode;
  status: SheetsAuthStatus;
  expiresAtMs: number | null;
  hasRefreshToken: boolean;
  serviceAccountEmail: string | null;
  offlineOAuthConfigured: boolean;
  statusMessage: string | null;
}

const PROACTIVE_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const WORKSPACE_SCOPE_STR =
  'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file';

export interface SheetsOAuthManagerOptions {
  oAuthClientId: string;
  getPortalIdToken: (forceRefresh?: boolean) => Promise<string | null>;
  getUserEmail: () => string | null;
  fetchFn?: typeof fetch;
  nowFn?: () => number;
}

export function createSheetsOAuthManager(options: SheetsOAuthManagerOptions) {
  const fetchFn = options.fetchFn || fetch;
  const nowFn = options.nowFn || (() => Date.now());

  // Strictly in-memory token state (never localStorage or sessionStorage)
  let accessToken: string | null = null;
  let expiresAtMs: number | null = null;
  let serverHasValidAccessToken = false;
  let authMode: SheetsAuthMode = 'oauth';
  let status: SheetsAuthStatus = 'disconnected';
  let hasRefreshToken = false;
  let serviceAccountEmail: string | null = null;
  let offlineOAuthConfigured = false;
  let statusMessage: string | null = null;
  let proactiveTimer: ReturnType<typeof setTimeout> | null = null;

  const listeners = new Set<(snapshot: SheetsOAuthSnapshot) => void>();
  const refreshGuard = createSingleFlightGuard<string | null>();

  function getSnapshot(): SheetsOAuthSnapshot {
    return {
      authMode,
      status,
      expiresAtMs,
      hasRefreshToken,
      serviceAccountEmail,
      offlineOAuthConfigured,
      statusMessage,
    };
  }

  function notify() {
    const snap = getSnapshot();
    for (const listener of listeners) {
      listener(snap);
    }
  }

  function clearTimer() {
    if (proactiveTimer) {
      clearTimeout(proactiveTimer);
      proactiveTimer = null;
    }
  }

  function scheduleProactiveRefresh() {
    clearTimer();
    if (authMode === 'service_account' || !expiresAtMs) return;

    const delayMs = expiresAtMs - nowFn() - PROACTIVE_REFRESH_BUFFER_MS;
    if (delayMs <= 0) return;

    // Clamp max setTimeout to 24 days to avoid 32-bit overflow
    const safeDelay = Math.min(delayMs, 20 * 24 * 3600 * 1000);
    proactiveTimer = setTimeout(() => {
      void ensureValidAccessToken(true);
    }, safeDelay);
  }

  async function syncTokenToBackendVault(token: string, expMs: number): Promise<void> {
    try {
      const idToken = await options.getPortalIdToken(false);
      if (!idToken) return;
      const res = await fetchFn('/api/oauth/session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          accessToken: token,
          expiresAtMs: expMs,
        }),
      });
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          hasRefreshToken?: boolean;
        };
        if (typeof data.hasRefreshToken === 'boolean') {
          hasRefreshToken = data.hasRefreshToken;
          notify();
        }
      }
    } catch {
      // Non-fatal: in-memory token still attaches via header
    }
  }

  async function tryBackendRefresh(): Promise<'ok' | 'revoked' | 'failed'> {
    try {
      const idToken = await options.getPortalIdToken(false);
      if (!idToken) return 'failed';

      const res = await fetchFn('/api/oauth/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
      });

      const data = (await res.json().catch(() => ({}))) as {
        refreshed?: boolean;
        authMode?: SheetsAuthMode;
        expiresAtMs?: number;
        errorCode?: string;
        error?: string;
      };

      if (res.ok && data.refreshed) {
        if (data.authMode === 'service_account') {
          authMode = 'service_account';
          status = 'service_account';
          expiresAtMs = data.expiresAtMs || null;
          statusMessage = null;
          notify();
          return 'ok';
        }
        // Backend holds refreshed accessToken in encrypted vault; mark active
        serverHasValidAccessToken = true;
        expiresAtMs = data.expiresAtMs || nowFn() + 3500 * 1000;
        hasRefreshToken = true;
        status = 'active';
        statusMessage = null;
        scheduleProactiveRefresh();
        notify();
        return 'ok';
      }

      if (data.errorCode === 'REFRESH_TOKEN_REVOKED') {
        accessToken = null;
        expiresAtMs = null;
        serverHasValidAccessToken = false;
        hasRefreshToken = false;
        status = 'revoked';
        statusMessage =
          data.error ||
          'สิทธิ์การเข้าถึง Google Sheets ถูกเพิกถอน กรุณากด Reconnect Google เพื่อเชื่อมต่อใหม่';
        clearTimer();
        notify();
        return 'revoked';
      }

      return 'failed';
    } catch {
      return 'failed';
    }
  }

  async function trySilentGisTokenRefresh(): Promise<string | null> {
    if (typeof window === 'undefined') return null;
    const oauth2 = window.google?.accounts?.oauth2;
    const clientId = options.oAuthClientId;
    if (!oauth2 || !clientId) return null;

    const email = options.getUserEmail();
    if (!email) return null;

    return new Promise<string | null>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      }, 5000);

      try {
        const client = oauth2.initTokenClient({
          client_id: clientId,
          scope: WORKSPACE_SCOPE_STR,
          prompt: '',
          login_hint: email,
          callback: (resp) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (resp.access_token) {
              const expiresInSec = Math.max(60, Number(resp.expires_in) || 3500);
              setOAuthToken(resp.access_token, expiresInSec);
              resolve(resp.access_token);
            } else {
              resolve(null);
            }
          },
          error_callback: () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(null);
          },
        });
        client.requestAccessToken({ prompt: '', login_hint: email });
      } catch {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(null);
        }
      }
    });
  }

  function setOAuthToken(token: string, expiresInSec = 3500, customExpiresAtMs?: number): void {
    accessToken = token;
    serverHasValidAccessToken = true;
    expiresAtMs =
      customExpiresAtMs && Number.isFinite(customExpiresAtMs)
        ? customExpiresAtMs
        : nowFn() + Math.max(60, expiresInSec) * 1000;
    if (authMode !== 'service_account') {
      status = 'active';
    }
    statusMessage = null;
    scheduleProactiveRefresh();
    notify();
    void syncTokenToBackendVault(token, expiresAtMs);
  }

  function setServerMetadata(meta: {
    authMode?: SheetsAuthMode;
    serviceAccountEmail?: string | null;
    offlineOAuthConfigured?: boolean;
    oauthStatus?: {
      connected?: boolean;
      hasAccessToken?: boolean;
      expiresAtMs?: number | null;
      hasRefreshToken?: boolean;
      revoked?: boolean;
      revokedReason?: string;
    };
  }): void {
    if (meta.authMode) authMode = meta.authMode;
    if (meta.serviceAccountEmail !== undefined) serviceAccountEmail = meta.serviceAccountEmail;
    if (meta.offlineOAuthConfigured !== undefined) {
      offlineOAuthConfigured = meta.offlineOAuthConfigured;
    }

    if (authMode === 'service_account') {
      status = 'service_account';
      statusMessage = null;
      clearTimer();
      notify();
      return;
    }

    if (meta.oauthStatus) {
      hasRefreshToken = Boolean(meta.oauthStatus.hasRefreshToken);
      const serverExp = meta.oauthStatus.expiresAtMs || null;
      const serverTokenUnexpired = Boolean(
        meta.oauthStatus.hasAccessToken && serverExp && nowFn() < serverExp - 5000
      );
      serverHasValidAccessToken = serverTokenUnexpired;

      if (meta.oauthStatus.revoked) {
        accessToken = null;
        expiresAtMs = null;
        serverHasValidAccessToken = false;
        status = 'revoked';
        statusMessage =
          meta.oauthStatus.revokedReason ||
          'สิทธิ์การเข้าถึง Google Sheets ถูกเพิกถอน กรุณาเชื่อมต่อใหม่';
        clearTimer();
      } else if (serverTokenUnexpired || meta.oauthStatus.hasRefreshToken) {
        if ((!expiresAtMs || serverExp) && serverExp) {
          expiresAtMs = serverExp;
        }
        status = 'active';
        statusMessage = null;
        scheduleProactiveRefresh();
      } else if (!accessToken) {
        status = options.getUserEmail() ? 'needs_reauth' : 'disconnected';
      }
    }

    notify();
  }

  function markNeedsReauth(revoked = false, message?: string): void {
    if (authMode === 'service_account') return;
    accessToken = null;
    expiresAtMs = null;
    serverHasValidAccessToken = false;
    if (revoked) {
      hasRefreshToken = false;
      status = 'revoked';
    } else {
      status = 'needs_reauth';
    }
    statusMessage =
      message ||
      (revoked
        ? 'สิทธิ์เชื่อมต่อ Google Sheets ถูกเพิกถอน กรุณากด Reconnect Google'
        : 'สิทธิ์เชื่อมต่อ Google Sheets หมดอายุ กรุณากด Reconnect Google เพื่อซิงก์ข้อมูลต่อ');
    clearTimer();
    notify();
  }

  function clearOAuthTokens(): void {
    accessToken = null;
    expiresAtMs = null;
    serverHasValidAccessToken = false;
    hasRefreshToken = false;
    status = authMode === 'service_account' ? 'service_account' : 'disconnected';
    statusMessage = null;
    clearTimer();
    notify();
  }

  async function ensureValidAccessToken(forceRefresh = false): Promise<string | null> {
    if (authMode === 'service_account') {
      return null;
    }

    const nowMs = nowFn();
    if (
      !forceRefresh &&
      (accessToken || serverHasValidAccessToken) &&
      expiresAtMs &&
      nowMs < expiresAtMs - PROACTIVE_REFRESH_BUFFER_MS
    ) {
      return accessToken;
    }

    return refreshGuard.run(async () => {
      const innerNow = nowFn();
      if (
        !forceRefresh &&
        (accessToken || serverHasValidAccessToken) &&
        expiresAtMs &&
        innerNow < expiresAtMs - PROACTIVE_REFRESH_BUFFER_MS
      ) {
        return accessToken;
      }

      const prevStatus = status;
      status = 'refreshing';
      notify();

      // 1. Check backend vault / Refresh Token first
      const backendOutcome = await tryBackendRefresh();
      if (backendOutcome === 'ok') {
        return accessToken;
      }

      // If backend explicitly marked revoked, don't retry silently
      if (backendOutcome === 'revoked') {
        return null;
      }

      // 2. Attempt silent GIS refresh in browser if Google session is active
      const silentToken = await trySilentGisTokenRefresh();
      if (silentToken) {
        return silentToken;
      }

      // 3. If token in client or server vault is still unexpired (> 5s left), keep using it gracefully
      if (
        !forceRefresh &&
        (accessToken || serverHasValidAccessToken) &&
        expiresAtMs &&
        nowFn() < expiresAtMs - 5000
      ) {
        status = prevStatus === 'active' ? 'active' : 'needs_reauth';
        notify();
        return accessToken;
      }

      // 4. Require user to click Reconnect Google (never force logout Firebase Auth!)
      if (options.getUserEmail()) {
        markNeedsReauth(false);
      } else {
        clearOAuthTokens();
      }
      return null;
    });
  }

  function getHeaderTokenSnapshot(): { accessToken: string | null; expiresAtMs: number | null } {
    return { accessToken, expiresAtMs };
  }

  function hasUsableSheetsAccess(): boolean {
    if (authMode === 'service_account') return true;
    if (
      status === 'needs_reauth' ||
      status === 'revoked' ||
      status === 'disconnected' ||
      status === 'error'
    ) {
      return false;
    }
    if (status === 'active') return true;
    if (hasRefreshToken) return true;
    if (accessToken && expiresAtMs && nowFn() < expiresAtMs) return true;
    return false;
  }

  return {
    subscribe: (listener: (snapshot: SheetsOAuthSnapshot) => void) => {
      listeners.add(listener);
      listener(getSnapshot());
      return () => {
        listeners.delete(listener);
      };
    },
    getState: getSnapshot,
    setOAuthToken,
    setServerMetadata,
    markNeedsReauth,
    clearOAuthTokens,
    ensureValidAccessToken,
    getHeaderTokenSnapshot,
    hasUsableSheetsAccess,
  };
}
