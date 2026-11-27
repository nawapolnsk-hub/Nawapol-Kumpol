export interface MappedAuthError {
  code: string;
  isSilentCancel: boolean;
  shouldRedirectFallback: boolean;
  userMessage: string;
}

export function extractFirebaseErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return '';
  }
  const maybeCode = (error as { code?: unknown }).code;
  if (typeof maybeCode === 'string' && maybeCode.trim()) {
    return maybeCode.trim();
  }
  const maybeMessage = (error as { message?: unknown }).message;
  if (typeof maybeMessage === 'string') {
    const match = /\((auth\/[a-z0-9-]+)\)/i.exec(maybeMessage);
    if (match) return match[1].toLowerCase();
  }
  return '';
}

export function mapFirebaseAuthError(error: unknown): MappedAuthError {
  const code = extractFirebaseErrorCode(error);

  switch (code) {
    case 'auth/cancelled-popup-request':
    case 'auth/popup-closed-by-user':
      return {
        code,
        isSilentCancel: true,
        shouldRedirectFallback: false,
        userMessage: '',
      };

    case 'auth/popup-blocked':
      return {
        code,
        isSilentCancel: false,
        shouldRedirectFallback: true,
        userMessage:
          'เบราว์เซอร์ปิดกั้นหน้าต่างเข้าสู่ระบบ (Popup) กำลังเปลี่ยนไปใช้วิธีเข้าสู่ระบบแบบ Redirect',
      };

    case 'auth/operation-not-supported-in-this-environment':
      return {
        code,
        isSilentCancel: false,
        shouldRedirectFallback: true,
        userMessage:
          'สภาพแวดล้อมเบราว์เซอร์ไม่รองรับ Popup กำลังเปลี่ยนไปใช้วิธีเข้าสู่ระบบแบบ Redirect',
      };

    case 'auth/network-request-failed':
      return {
        code,
        isSilentCancel: false,
        shouldRedirectFallback: false,
        userMessage:
          'ไม่สามารถเชื่อมต่อเครือข่ายเพื่อเข้าสู่ระบบได้ กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ตแล้วลองใหม่',
      };

    case 'auth/unauthorized-domain':
      return {
        code,
        isSilentCancel: false,
        shouldRedirectFallback: false,
        userMessage:
          'โดเมนปัจจุบันยังไม่ได้รับอนุญาตให้เข้าสู่ระบบ กรุณาติดต่อผู้ดูแลระบบ',
      };

    case 'auth/user-disabled':
      return {
        code,
        isSilentCancel: false,
        shouldRedirectFallback: false,
        userMessage: 'บัญชีผู้ใช้งานนี้ถูกระงับสิทธิ์ กรุณาติดต่อผู้ดูแลระบบ',
      };

    case 'auth/too-many-requests':
      return {
        code,
        isSilentCancel: false,
        shouldRedirectFallback: false,
        userMessage: 'มีการพยายามเข้าสู่ระบบหลายครั้งติดต่อกัน กรุณารอสักครู่แล้วลองใหม่อีกครั้ง',
      };

    case 'auth/account-exists-with-different-credential':
      return {
        code,
        isSilentCancel: false,
        shouldRedirectFallback: false,
        userMessage: 'อีเมลนี้ถูกผูกกับวิธีการเข้าสู่ระบบอื่นไว้แล้ว กรุณาตรวจสอบบัญชีที่ใช้',
      };

    case 'auth/email-already-in-use':
      return {
        code,
        isSilentCancel: false,
        shouldRedirectFallback: false,
        userMessage: 'อีเมลนี้ถูกลงทะเบียนในระบบไว้แล้ว กรุณาเข้าสู่ระบบด้วยอีเมลหรือบัญชี Google ที่เชื่อมไว้',
      };

    case 'auth/invalid-email':
      return {
        code,
        isSilentCancel: false,
        shouldRedirectFallback: false,
        userMessage: 'รูปแบบอีเมลไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง',
      };

    case 'auth/weak-password':
      return {
        code,
        isSilentCancel: false,
        shouldRedirectFallback: false,
        userMessage: 'รหัสผ่านต้องมีความยาวอย่างน้อย 6 ตัวอักษร',
      };

    case 'auth/wrong-password':
    case 'auth/invalid-credential':
    case 'auth/user-not-found':
      return {
        code,
        isSilentCancel: false,
        shouldRedirectFallback: false,
        userMessage: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง',
      };

    case 'auth/operation-not-allowed':
      return {
        code,
        isSilentCancel: false,
        shouldRedirectFallback: false,
        userMessage:
          'ระบบลงทะเบียนด้วย Email/Password ยังไม่ได้เปิดใช้งานใน Firebase Console กรุณาใช้วิธีลงชื่อด้วย Google หรือให้ Super Admin เปิด Email/Password Provider ใน Firebase Authentication',
      };

    default:
      return {
        code: code || 'auth/unknown',
        isSilentCancel: false,
        shouldRedirectFallback: false,
        userMessage: 'ไม่สามารถดำเนินการยืนยันตัวตนได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง',
      };
  }
}

/**
 * Single-flight concurrency guard helper for sign-in operations.
 * Ensures concurrent clicks share the exact same pending Promise instead of spawning duplicate popups.
 */
export function createSingleFlightGuard<T>() {
  let activePromise: Promise<T> | null = null;
  return {
    isBusy: () => activePromise !== null,
    run: (task: () => Promise<T>): Promise<T> => {
      if (activePromise) {
        return activePromise;
      }
      activePromise = Promise.resolve()
        .then(task)
        .finally(() => {
          activePromise = null;
        });
      return activePromise;
    },
  };
}
