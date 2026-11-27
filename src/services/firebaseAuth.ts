import { initializeApp, getApps } from 'firebase/app';
import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  reauthenticateWithPopup,
  sendEmailVerification,
  sendPasswordResetEmail,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  updateProfile,
  type User,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';
import { createSingleFlightGuard, mapFirebaseAuthError } from './authErrorMapper.ts';
import { createSheetsOAuthManager } from './sheetsOAuthManager.ts';

const app = getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
const auth = getAuth(app);

export const WORKSPACE_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
];

function createGoogleProvider(promptMode: 'select_account' | 'consent', loginHint?: string | null) {
  const p = new GoogleAuthProvider();
  for (const scope of WORKSPACE_SCOPES) {
    p.addScope(scope);
  }
  const params: Record<string, string> = {
    prompt: promptMode,
  };
  if (loginHint) {
    params.login_hint = loginHint;
  }
  p.setCustomParameters(params);
  return p;
}

// Enforce LOCAL persistence for personal authorized devices so refresh & browser reopen keep session
const persistencePromise = setPersistence(auth, browserLocalPersistence).catch(() => {
  // Fallback gracefully if storage persistence is restricted
});

const signInGuard = createSingleFlightGuard<GoogleSignInOutcome>();
const emailAuthGuard = createSingleFlightGuard<User>();
const reconnectGuard = createSingleFlightGuard<GoogleSheetsReconnectOutcome>();

export const sheetsOAuthManager = createSheetsOAuthManager({
  oAuthClientId: firebaseConfig.oAuthClientId || '',
  getPortalIdToken: (forceRefresh = false) => getFirebaseIdToken(forceRefresh),
  getUserEmail: () => auth.currentUser?.email || null,
});

let redirectChecked = false;
let redirectResultPromise: Promise<void> | null = null;

export type GoogleSignInOutcome =
  | { status: 'success'; user: User; accessToken: string | null }
  | { status: 'cancelled' }
  | { status: 'redirecting'; message: string };

export type GoogleSheetsReconnectOutcome =
  | { status: 'connected' }
  | { status: 'cancelled' }
  | { status: 'redirecting'; message: string };

export async function getFirebaseIdToken(forceRefresh = false): Promise<string | null> {
  if (!auth.currentUser) return null;
  try {
    return await auth.currentUser.getIdToken(forceRefresh);
  } catch {
    return null;
  }
}

async function resolvePendingRedirect(): Promise<{
  user: User | null;
  errorMessage: string | null;
}> {
  await persistencePromise;
  try {
    const result = await getRedirectResult(auth);
    if (result) {
      const credential = GoogleAuthProvider.credentialFromResult(result);
      if (credential?.accessToken) {
        sheetsOAuthManager.setOAuthToken(credential.accessToken, 3500);
      }
      return { user: result.user, errorMessage: null };
    }
    return { user: null, errorMessage: null };
  } catch (err) {
    const mapped = mapFirebaseAuthError(err);
    return {
      user: null,
      errorMessage: mapped.isSilentCancel ? null : mapped.userMessage,
    };
  } finally {
    redirectChecked = true;
  }
}

function ensureRedirectChecked(): Promise<void> {
  if (redirectChecked) return Promise.resolve();
  if (!redirectResultPromise) {
    redirectResultPromise = resolvePendingRedirect().then(() => undefined);
  }
  return redirectResultPromise;
}

/**
 * Portal Authentication Listener (Layer 1):
 * Strictly driven by Firebase Auth state so Google OAuth token expiry NEVER logs out the user.
 */
export const initAuth = (
  onPortalUserAuthenticated?: (user: User) => void,
  onPortalUserSignedOut?: (errorMessage?: string | null) => void
) => {
  let disposed = false;

  if (!redirectResultPromise) {
    redirectResultPromise = resolvePendingRedirect().then((res) => {
      if (disposed) return;
      if (res.user) {
        onPortalUserAuthenticated?.(res.user);
      } else if (res.errorMessage) {
        onPortalUserSignedOut?.(res.errorMessage);
      }
    });
  }

  const unsub = onAuthStateChanged(auth, (user: User | null) => {
    void (async () => {
      await ensureRedirectChecked();
      if (disposed) return;

      if (user) {
        onPortalUserAuthenticated?.(user);
      } else {
        sheetsOAuthManager.clearOAuthTokens();
        onPortalUserSignedOut?.(null);
      }
    })();
  });

  return () => {
    disposed = true;
    unsub();
  };
};

export const isAuthInProgress = (): boolean =>
  signInGuard.isBusy() || emailAuthGuard.isBusy() || reconnectGuard.isBusy();

export const registerWithEmailPassword = async (
  email: string,
  password: string,
  displayName?: string
): Promise<User> => {
  return emailAuthGuard.run(async () => {
    await persistencePromise;
    await ensureRedirectChecked();

    try {
      const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
      if (displayName && displayName.trim()) {
        await updateProfile(cred.user, { displayName: displayName.trim() }).catch(() => undefined);
      }
      await sendEmailVerification(cred.user).catch(() => undefined);
      return cred.user;
    } catch (err) {
      const mapped = mapFirebaseAuthError(err);
      throw new Error(mapped.userMessage);
    }
  });
};

export const signInWithEmailPassword = async (email: string, password: string): Promise<User> => {
  return emailAuthGuard.run(async () => {
    await persistencePromise;
    await ensureRedirectChecked();

    try {
      const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
      return cred.user;
    } catch (err) {
      const mapped = mapFirebaseAuthError(err);
      throw new Error(mapped.userMessage);
    }
  });
};

export const resendVerificationEmail = async (): Promise<void> => {
  if (!auth.currentUser) {
    throw new Error('กรุณาเข้าสู่ระบบด้วยอีเมลของคุณก่อนส่งลิงก์ยืนยันอีกครั้ง');
  }
  try {
    await sendEmailVerification(auth.currentUser);
  } catch (err) {
    const mapped = mapFirebaseAuthError(err);
    throw new Error(mapped.userMessage);
  }
};

export const reloadFirebaseUserAndToken = async (): Promise<User | null> => {
  if (!auth.currentUser) return null;
  await auth.currentUser.reload();
  await auth.currentUser.getIdToken(true);
  return auth.currentUser;
};

export const sendPasswordReset = async (email: string): Promise<void> => {
  const cleanEmail = email.trim();
  if (!cleanEmail || !cleanEmail.includes('@')) {
    throw new Error('กรุณากรอกอีเมลที่ถูกต้องเพื่อรับลิงก์ตั้งรหัสผ่านใหม่');
  }
  try {
    await sendPasswordResetEmail(auth, cleanEmail);
  } catch (err) {
    const mapped = mapFirebaseAuthError(err);
    throw new Error(mapped.userMessage);
  }
};

export const googleSignIn = async (): Promise<GoogleSignInOutcome> => {
  return signInGuard.run(async () => {
    await persistencePromise;
    await ensureRedirectChecked();

    if (auth.currentUser) {
      return {
        status: 'success',
        user: auth.currentUser,
        accessToken: sheetsOAuthManager.getHeaderTokenSnapshot().accessToken,
      };
    }

    const provider = createGoogleProvider('select_account');
    try {
      const result = await signInWithPopup(auth, provider);
      const credential = GoogleAuthProvider.credentialFromResult(result);
      if (credential?.accessToken) {
        sheetsOAuthManager.setOAuthToken(credential.accessToken, 3500);
      }
      return {
        status: 'success',
        user: result.user,
        accessToken: credential?.accessToken || null,
      };
    } catch (err) {
      const mapped = mapFirebaseAuthError(err);
      if (mapped.isSilentCancel) {
        return { status: 'cancelled' };
      }
      if (mapped.shouldRedirectFallback) {
        try {
          await signInWithRedirect(auth, provider);
          return { status: 'redirecting', message: mapped.userMessage };
        } catch (redirectErr) {
          const redirectMapped = mapFirebaseAuthError(redirectErr);
          if (redirectMapped.isSilentCancel) {
            return { status: 'cancelled' };
          }
          throw new Error(redirectMapped.userMessage);
        }
      }
      throw new Error(mapped.userMessage);
    }
  });
};

/**
 * Layer 2 (Google Sheets Authorization only):
 * Refreshes or re-authorizes Google Sheets access WITHOUT altering or ending the Firebase Portal session.
 */
export const reconnectGoogleSheets = async (): Promise<GoogleSheetsReconnectOutcome> => {
  return reconnectGuard.run(async () => {
    await persistencePromise;
    if (!auth.currentUser) {
      throw new Error('กรุณาเข้าสู่ระบบ RHP Portal ก่อนเชื่อมต่อ Google Sheets');
    }

    // Try backend refresh / silent GIS refresh first
    const silentToken = await sheetsOAuthManager.ensureValidAccessToken(true);
    if (silentToken || sheetsOAuthManager.hasUsableSheetsAccess()) {
      return { status: 'connected' };
    }

    const provider = createGoogleProvider('consent', auth.currentUser.email);
    try {
      const result = await reauthenticateWithPopup(auth.currentUser, provider);
      const credential = GoogleAuthProvider.credentialFromResult(result);
      if (!credential?.accessToken) {
        throw new Error('ไม่สามารถรับสิทธิ์เข้าถึง Google Sheets ได้ กรุณาลองใหม่อีกครั้ง');
      }
      sheetsOAuthManager.setOAuthToken(credential.accessToken, 3500);
      return { status: 'connected' };
    } catch (err) {
      const mapped = mapFirebaseAuthError(err);
      if (mapped.isSilentCancel) {
        return { status: 'cancelled' };
      }
      if (mapped.shouldRedirectFallback) {
        try {
          await signInWithRedirect(auth, provider);
          return { status: 'redirecting', message: mapped.userMessage };
        } catch (redirectErr) {
          const redirectMapped = mapFirebaseAuthError(redirectErr);
          if (redirectMapped.isSilentCancel) {
            return { status: 'cancelled' };
          }
          throw new Error(redirectMapped.userMessage);
        }
      }
      if (err instanceof Error && err.message.includes('Google Sheets')) {
        throw err;
      }
      throw new Error(mapped.userMessage);
    }
  });
};

export const getAccessToken = (): string | null => {
  return sheetsOAuthManager.getHeaderTokenSnapshot().accessToken;
};

export const getCurrentFirebaseUser = (): User | null => {
  return auth.currentUser;
};

export const logout = async (): Promise<void> => {
  try {
    const idToken = await getFirebaseIdToken(false);
    if (idToken) {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}` },
      }).catch(() => undefined);
    }
  } finally {
    sheetsOAuthManager.clearOAuthTokens();
    await signOut(auth);
  }
};
