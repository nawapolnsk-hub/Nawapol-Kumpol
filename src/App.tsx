import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  AlertTriangle,
  BarChart3,
  Bell,
  Building2,
  Calculator,
  ChevronDown,
  ClipboardCheck,
  Database,
  History,
  LogOut,
  Menu,
  RefreshCw,
  Settings,
  Shield,
  Table2,
  User as UserIcon,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import { AccountGateView } from './components/AccountGateView.tsx';
import { ApprovalCenterView } from './components/ApprovalCenterView.tsx';
import { AuditLogView } from './components/AuditLogView.tsx';
import { DashboardView } from './components/DashboardView.tsx';
import { PortalLoginView } from './components/PortalLoginView.tsx';
import { RhpCalculatorView } from './components/RhpCalculatorView.tsx';
import { SheetsSetupModal } from './components/SheetsSetupModal.tsx';
import { SystemSettingsView } from './components/SystemSettingsView.tsx';
import { TransactionDatabaseView } from './components/TransactionDatabaseView.tsx';
import { UserApprovalCenterView } from './components/UserApprovalCenterView.tsx';
import { UserManagementView } from './components/UserManagementView.tsx';
import {
  ApiClientError,
  apiClient,
  registerUserDisabledHandler,
  type SessionStatusResponse,
  type UserAuthProfile,
} from './services/apiClient.ts';
import {
  getCurrentFirebaseUser,
  googleSignIn,
  initAuth,
  logout,
  reconnectGoogleSheets,
  registerWithEmailPassword,
  sendPasswordReset,
  sheetsOAuthManager,
  signInWithEmailPassword,
} from './services/firebaseAuth.ts';
import type { SheetsOAuthSnapshot } from './services/sheetsOAuthManager.ts';
import type {
  AmortizationRow,
  AuditLogEntry,
  ConnectionStatus,
  RhpTransaction,
  SystemConfig,
} from './types/rhp.ts';

type PageId =
  | 'dashboard'
  | 'calculator'
  | 'database'
  | 'approval'
  | 'user-approval'
  | 'users'
  | 'audit'
  | 'settings';

const DEFAULT_CONFIG: SystemConfig = {
  contractIdPrefix: 'RHP',
  runningNumbers: {},
  defaultInterestMethod: 'Flat Rate',
  availableInstallmentPeriods: [12, 24, 36, 48, 60],
  downPaymentOptions: [0, 5, 10, 15],
  companyName: 'MAX SANY (Risk Control Department)',
  companyAddress: 'ฝ่ายควบคุมความเสี่ยงและปรับโครงสร้างหนี้ (Risk Control Department)',
  companyLogoDataUrl: null,
  authorizedUsers: [],
};

interface NotificationItem {
  id: string;
  title: string;
  description: string;
  tone: 'warning' | 'info' | 'error';
  actionLabel: string;
  onAction: () => void;
}

export default function App() {
  const [activePage, setActivePage] = useState<PageId>('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [setupModalOpen, setSetupModalOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);

  const notifRef = useRef<HTMLDivElement | null>(null);
  const profileRef = useRef<HTMLDivElement | null>(null);

  // Layer 1: Firebase Portal Authentication (independent of Google OAuth expiry)
  const [authResolved, setAuthResolved] = useState(false);
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [initialSetupRequired, setInitialSetupRequired] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<SessionStatusResponse | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [userProfile, setUserProfile] = useState<UserAuthProfile | null>(null);
  const [pendingUserCount, setPendingUserCount] = useState(0);

  // Layer 2: Google Sheets Authorization Snapshot
  const [oAuthSnapshot, setOAuthSnapshot] = useState<SheetsOAuthSnapshot>(() =>
    sheetsOAuthManager.getState()
  );
  const [reconnectLoading, setReconnectLoading] = useState(false);

  const [connection, setConnection] = useState<ConnectionStatus>({
    connected: false,
    spreadsheetId: null,
    spreadsheetUrl: null,
    spreadsheetTitle: null,
    sheetsPresent: [],
    lastSyncedAt: null,
    error: null,
    authMode: 'oauth',
    sheetsAuthStatus: 'disconnected',
  });

  const [config, setConfig] = useState<SystemConfig>(DEFAULT_CONFIG);
  const [transactions, setTransactions] = useState<RhpTransaction[]>([]);
  const [schedulesByContract, setSchedulesByContract] = useState<Record<string, AmortizationRow[]>>(
    {}
  );
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [dbLoading, setDbLoading] = useState(false);

  const handleSignOut = useCallback(async () => {
    setNotificationsOpen(false);
    setProfileMenuOpen(false);
    setMobileMenuOpen(false);
    await logout();
    setFirebaseUser(null);
    setAuthError(null);
    setSessionStatus(null);
    setUserProfile(null);
    setPendingUserCount(0);
    setTransactions([]);
    setSchedulesByContract({});
    setAuditLogs([]);
    setActivePage('dashboard');
  }, []);

  useEffect(() => {
    const unsubOAuth = sheetsOAuthManager.subscribe(setOAuthSnapshot);
    registerUserDisabledHandler((message) => {
      setAuthError(message);
      void handleSignOut();
    });
    return () => {
      unsubOAuth();
    };
  }, [handleSignOut]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (notifRef.current && !notifRef.current.contains(target)) {
        setNotificationsOpen(false);
      }
      if (profileRef.current && !profileRef.current.contains(target)) {
        setProfileMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const loadWorkspaceStatusAndData = useCallback(async () => {
    try {
      const status = await apiClient.getSheetsStatus();
      setConfig(status.config);
      setInitialSetupRequired(Boolean(status.initialSetupRequired));
      sheetsOAuthManager.setServerMetadata({
        authMode: status.authMode,
        serviceAccountEmail: status.serviceAccountEmail,
        offlineOAuthConfigured: status.offlineOAuthConfigured,
      });

      setConnection((prev) => ({
        ...prev,
        connected: status.connected,
        spreadsheetId: status.spreadsheetId,
        spreadsheetUrl: status.spreadsheetUrl,
        spreadsheetTitle: status.spreadsheetTitle,
        authMode: status.authMode,
        serviceAccountEmail: status.serviceAccountEmail,
        offlineOAuthConfigured: status.offlineOAuthConfigured,
      }));

      const portalUser = getCurrentFirebaseUser();
      if (!portalUser) {
        setSessionStatus(null);
        setUserProfile(null);
        setPendingUserCount(0);
        setTransactions([]);
        setSchedulesByContract({});
        setAuditLogs([]);
        return;
      }

      setSessionLoading(true);
      let session: SessionStatusResponse;
      try {
        session = await apiClient.getSessionStatus();
        setSessionStatus(session);
        setInitialSetupRequired(Boolean(session.initialSetupRequired));
      } finally {
        setSessionLoading(false);
      }

      // Gate: Do NOT load internal profile, Google Sheets data, or admin lists until verified + approved + MFA passed
      if (!session.canAccessPortal) {
        setUserProfile(null);
        setPendingUserCount(0);
        setTransactions([]);
        setSchedulesByContract({});
        setAuditLogs([]);
        return;
      }

      const profile = await apiClient.getAuthProfile();
      setUserProfile(profile);
      if (profile.config) {
        setConfig(profile.config);
      }
      sheetsOAuthManager.setServerMetadata({
        authMode: profile.authMode,
        serviceAccountEmail: profile.serviceAccountEmail,
        offlineOAuthConfigured: profile.offlineOAuthConfigured,
        oauthStatus: profile.oauthStatus,
      });

      const isSuperAdminAccount = profile.role === 'Super Admin';
      const canViewAuditLogs =
        isSuperAdminAccount || profile.role === 'Approver' || Boolean(profile.canApprove);

      if (isSuperAdminAccount) {
        try {
          const adminRes = await apiClient.getAdminUsers();
          setPendingUserCount(
            adminRes.users.filter((u) => u.accountStatus === 'Pending Approval' && !u.disabled).length
          );
        } catch {
          setPendingUserCount(0);
        }
      } else {
        setPendingUserCount(0);
      }

      const canUseSheets =
        profile.authMode === 'service_account' || sheetsOAuthManager.hasUsableSheetsAccess();

      let loadedSheetLogs: AuditLogEntry[] = [];
      if (status.connected && canUseSheets) {
        setDbLoading(true);
        try {
          const dbData = await apiClient.loadDatabase();
          setTransactions(dbData.transactions);
          setSchedulesByContract(dbData.schedulesByContract);
          loadedSheetLogs = dbData.auditLogs;
          setConfig(dbData.config);
          setConnection({
            connected: true,
            spreadsheetId: dbData.spreadsheetId,
            spreadsheetUrl: dbData.spreadsheetUrl,
            spreadsheetTitle: dbData.spreadsheetTitle,
            sheetsPresent: dbData.sheetsPresent,
            lastSyncedAt: new Date().toISOString(),
            error: null,
            authMode: dbData.authMode || profile.authMode,
            serviceAccountEmail: dbData.serviceAccountEmail ?? profile.serviceAccountEmail,
            offlineOAuthConfigured: profile.offlineOAuthConfigured,
          });
        } catch (dbErr) {
          // Google Sheets token expiry or API error MUST NOT log out Portal user
          setConnection((prev) => ({
            ...prev,
            error:
              dbErr instanceof Error
                ? dbErr.message
                : 'ไม่สามารถโหลดข้อมูลจาก Google Sheets ได้',
          }));
        } finally {
          setDbLoading(false);
        }
      } else if (!status.connected) {
        setTransactions([]);
        setSchedulesByContract({});
      }

      if (canViewAuditLogs) {
        try {
          const mergedRes = await apiClient.getMergedAuditLogs();
          setAuditLogs(mergedRes.auditLogs);
        } catch {
          setAuditLogs(loadedSheetLogs);
        }
      } else {
        setAuditLogs([]);
      }
    } catch (err) {
      if (err instanceof ApiClientError && err.errorCode === 'USER_DISABLED') {
        return;
      }
      setConnection((prev) => ({
        ...prev,
        error: err instanceof Error ? err.message : 'ไม่สามารถโหลดสถานะฐานข้อมูลได้',
      }));
    }
  }, []);

  useEffect(() => {
    void loadWorkspaceStatusAndData();
    const unsub = initAuth(
      (user) => {
        setFirebaseUser(user);
        setAuthError(null);
        setAuthResolved(true);
        void loadWorkspaceStatusAndData();
      },
      (errorMessage) => {
        setFirebaseUser(null);
        setSessionStatus(null);
        setUserProfile(null);
        setPendingUserCount(0);
        setAuthResolved(true);
        if (errorMessage) {
          setAuthError(errorMessage);
        }
      }
    );
    return () => unsub();
  }, [loadWorkspaceStatusAndData]);

  const handleGoogleSignIn = async () => {
    if (authLoading) return;
    setAuthLoading(true);
    setAuthError(null);
    try {
      const outcome = await googleSignIn();
      if (outcome.status === 'success') {
        setFirebaseUser(outcome.user);
        setAuthResolved(true);
        await loadWorkspaceStatusAndData();
      } else if (outcome.status === 'redirecting') {
        setAuthError(outcome.message);
      }
    } catch (err) {
      setAuthError(
        err instanceof Error
          ? err.message
          : 'ไม่สามารถเข้าสู่ระบบด้วยบัญชี Google ได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง'
      );
    } finally {
      setAuthLoading(false);
    }
  };

  const handleEmailSignIn = async (email: string, password: string) => {
    if (authLoading) return;
    setAuthLoading(true);
    setAuthError(null);
    try {
      const user = await signInWithEmailPassword(email, password);
      setFirebaseUser(user);
      setAuthResolved(true);
      await loadWorkspaceStatusAndData();
    } catch (err) {
      setAuthError(
        err instanceof Error
          ? err.message
          : 'ไม่สามารถเข้าสู่ระบบด้วยอีเมลและรหัสผ่านได้ กรุณาลองใหม่อีกครั้ง'
      );
    } finally {
      setAuthLoading(false);
    }
  };

  const handleEmailRegister = async (payload: {
    email: string;
    password: string;
    displayName: string;
    department: string;
    requestNote: string;
  }) => {
    if (authLoading) return;
    setAuthLoading(true);
    setAuthError(null);
    try {
      const user = await registerWithEmailPassword(
        payload.email,
        payload.password,
        payload.displayName
      );
      setFirebaseUser(user);
      setAuthResolved(true);
      await apiClient
        .registerRequest({
          displayName: payload.displayName,
          department: payload.department,
          requestNote: payload.requestNote,
        })
        .catch(() => undefined);
      await loadWorkspaceStatusAndData();
    } catch (err) {
      setAuthError(
        err instanceof Error ? err.message : 'ไม่สามารถสมัครขอสิทธิ์เข้าใช้งานได้ กรุณาลองใหม่อีกครั้ง'
      );
    } finally {
      setAuthLoading(false);
    }
  };

  const handleGoogleRegister = async (payload: { department: string; requestNote: string }) => {
    if (authLoading) return;
    setAuthLoading(true);
    setAuthError(null);
    try {
      const outcome = await googleSignIn();
      if (outcome.status === 'success') {
        setFirebaseUser(outcome.user);
        setAuthResolved(true);
        await apiClient
          .registerRequest({
            displayName: outcome.user.displayName || outcome.user.email || '',
            department: payload.department,
            requestNote: payload.requestNote,
          })
          .catch(() => undefined);
        await loadWorkspaceStatusAndData();
      } else if (outcome.status === 'redirecting') {
        setAuthError(outcome.message);
      }
    } catch (err) {
      setAuthError(
        err instanceof Error ? err.message : 'ไม่สามารถลงทะเบียนด้วย Google ได้ กรุณาลองใหม่อีกครั้ง'
      );
    } finally {
      setAuthLoading(false);
    }
  };

  const handlePasswordReset = async (email: string) => {
    setAuthError(null);
    await sendPasswordReset(email);
  };

  const handleReconnectSheets = async () => {
    if (reconnectLoading) return;
    setReconnectLoading(true);
    setAuthError(null);
    try {
      const outcome = await reconnectGoogleSheets();
      if (outcome.status === 'connected') {
        setConnection((prev) => ({ ...prev, error: null }));
        await loadWorkspaceStatusAndData();
      } else if (outcome.status === 'redirecting') {
        setAuthError(outcome.message);
      }
    } catch (err) {
      setAuthError(
        err instanceof Error
          ? err.message
          : 'ไม่สามารถเชื่อมต่อสิทธิ์ Google Sheets ใหม่ได้ กรุณาลองใหม่อีกครั้ง'
      );
    } finally {
      setReconnectLoading(false);
    }
  };

  const isPortalAuthenticated = Boolean(firebaseUser);
  const hasSheetsAccess =
    oAuthSnapshot.authMode === 'service_account' ||
    oAuthSnapshot.status === 'active' ||
    oAuthSnapshot.status === 'refreshing';

  const needsSheetsReconnect =
    isPortalAuthenticated &&
    oAuthSnapshot.authMode !== 'service_account' &&
    (oAuthSnapshot.status === 'needs_reauth' || oAuthSnapshot.status === 'revoked');

  const userRole = userProfile?.role || sessionStatus?.role || 'Viewer';
  const isSuperAdmin = userRole === 'Super Admin';
  const canApprove = Boolean(
    userProfile?.canApprove || isSuperAdmin || userRole === 'Approver'
  );
  const canCreateContract = Boolean(
    userProfile?.canCreateContract || isSuperAdmin || userRole === 'Risk Control'
  );
  const canViewAudit = isSuperAdmin || userRole === 'Approver' || canApprove;

  const navItems = useMemo(() => {
    const all: Array<{
      id: PageId;
      label: string;
      subtitle: string;
      icon: typeof BarChart3;
      visible: boolean;
    }> = [
      {
        id: 'dashboard',
        label: 'Dashboard',
        subtitle: 'ภาพรวมข้อมูลและสถิติ',
        icon: BarChart3,
        visible: true,
      },
      {
        id: 'calculator',
        label: 'RHP Calculator',
        subtitle: 'คำนวณและจัดทำสัญญา',
        icon: Calculator,
        visible: canCreateContract,
      },
      {
        id: 'database',
        label: 'Contract Database',
        subtitle: 'ฐานข้อมูลรายการสัญญา',
        icon: Table2,
        visible: true,
      },
      {
        id: 'approval',
        label: 'Approval Center',
        subtitle: 'ตรวจสอบและอนุมัติสัญญา',
        icon: ClipboardCheck,
        visible: canApprove,
      },
      {
        id: 'user-approval',
        label: 'User Approval Center',
        subtitle: 'ตรวจสอบและอนุมัติผู้สมัคร',
        icon: UserCheck,
        visible: isSuperAdmin,
      },
      {
        id: 'users',
        label: 'User Management',
        subtitle: 'จัดการบัญชีและสิทธิ์ RBAC',
        icon: Users,
        visible: isSuperAdmin,
      },
      {
        id: 'audit',
        label: 'Audit Log',
        subtitle: 'ประวัติการดำเนินการ',
        icon: History,
        visible: canViewAudit,
      },
      {
        id: 'settings',
        label: 'System Settings',
        subtitle: 'ตั้งค่าและจัดการระบบ',
        icon: Settings,
        visible: isSuperAdmin,
      },
    ];
    return all.filter((item) => item.visible);
  }, [canApprove, canCreateContract, canViewAudit, isSuperAdmin]);

  // Keep activePage valid if RBAC profile updates
  useEffect(() => {
    if (navItems.length > 0 && !navItems.some((item) => item.id === activePage)) {
      setActivePage('dashboard');
    }
  }, [activePage, navItems]);

  const pageMetaMap: Record<PageId, { title: string; subtitle: string }> = {
    dashboard: {
      title: 'Dashboard',
      subtitle: 'ภาพรวมข้อมูลและสถิติการปรับโครงสร้างหนี้',
    },
    calculator: {
      title: 'RHP Calculator',
      subtitle: 'ระบบคำนวณและจัดทำรายการปรับโครงสร้างหนี้',
    },
    database: {
      title: 'Contract Database',
      subtitle: 'ฐานข้อมูลรายการสัญญาปรับโครงสร้างหนี้',
    },
    approval: {
      title: 'Approval Center',
      subtitle: 'ระบบตรวจสอบและอนุมัติรายการปรับโครงสร้างหนี้',
    },
    'user-approval': {
      title: 'User Approval Center',
      subtitle: 'ศูนย์ตรวจสอบและอนุมัติผู้ขอเข้าใช้งานระบบโดย Super Admin',
    },
    users: {
      title: 'User Management',
      subtitle: 'ระบบจัดการบัญชีและสิทธิ์ผู้ใช้งาน (RBAC)',
    },
    audit: {
      title: 'Audit Log',
      subtitle: 'ประวัติการดำเนินการ ความปลอดภัย และเปลี่ยนแปลงข้อมูล',
    },
    settings: {
      title: 'System Settings',
      subtitle: 'ตั้งค่าและจัดการระบบ MAX SANY RHP PORTAL',
    },
  };

  const pendingDraftCount = useMemo(
    () =>
      transactions.filter((tx) => !tx.isDeleted && tx.transactionStatus === 'Draft').length,
    [transactions]
  );

  const notifications = useMemo<NotificationItem[]>(() => {
    const list: NotificationItem[] = [];

    if (isSuperAdmin && pendingUserCount > 0) {
      list.push({
        id: 'pending-users',
        title: `มีผู้สมัครรอ Super Admin อนุมัติ (${pendingUserCount} รายการ)`,
        description: 'ตรวจสอบอีเมลที่ยืนยันแล้วและกำหนด Role ก่อนอนุญาตให้เข้าสู่ระบบ',
        tone: 'info',
        actionLabel: 'เปิด User Approval Center',
        onAction: () => {
          setNotificationsOpen(false);
          setActivePage('user-approval');
        },
      });
    }

    if (needsSheetsReconnect) {
      list.push({
        id: 'oauth-reconnect',
        title: 'สิทธิ์เชื่อมต่อ Google Sheets หมดอายุชั่วคราว',
        description: 'กด Reconnect Google เพื่อต่ออายุสิทธิ์บันทึกและซิงก์ข้อมูลกับสเปรดชีต',
        tone: 'warning',
        actionLabel: 'Reconnect Google',
        onAction: () => {
          setNotificationsOpen(false);
          void handleReconnectSheets();
        },
      });
    }

    if (!connection.connected) {
      list.push({
        id: 'sheets-disconnected',
        title: 'ยังไม่ได้เชื่อมต่อฐานข้อมูล Google Sheets',
        description: 'เชื่อมต่อ RHP_Restructuring_Database เพื่อใช้งานฐานข้อมูลกลางของบริษัท',
        tone: 'error',
        actionLabel: isSuperAdmin ? 'ไปที่ System Settings' : 'ตั้งค่าการเชื่อมต่อ',
        onAction: () => {
          setNotificationsOpen(false);
          if (isSuperAdmin) {
            setActivePage('settings');
          } else {
            setSetupModalOpen(true);
          }
        },
      });
    }

    if (canApprove && pendingDraftCount > 0) {
      list.push({
        id: 'pending-approvals',
        title: `มีรายการสัญญารอตรวจสอบและอนุมัติ (${pendingDraftCount} รายการ)`,
        description: 'ตรวจสอบรายละเอียดทางการเงินและอนุมัติสัญญาใน Approval Center',
        tone: 'info',
        actionLabel: 'เปิด Approval Center',
        onAction: () => {
          setNotificationsOpen(false);
          setActivePage('approval');
        },
      });
    }

    return list;
  }, [
    canApprove,
    connection.connected,
    isSuperAdmin,
    needsSheetsReconnect,
    pendingDraftCount,
    pendingUserCount,
  ]);

  const employeeDisplayName = useMemo(() => {
    const matchedEntry = config.authorizedUsers.find(
      (u) => u.email.toLowerCase() === (userProfile?.email || firebaseUser?.email || '').toLowerCase()
    );
    return (
      userProfile?.displayName ||
      matchedEntry?.displayName ||
      sessionStatus?.displayName ||
      firebaseUser?.displayName ||
      userProfile?.email ||
      firebaseUser?.email ||
      'เจ้าหน้าที่'
    );
  }, [
    config.authorizedUsers,
    firebaseUser?.displayName,
    firebaseUser?.email,
    sessionStatus?.displayName,
    userProfile?.displayName,
    userProfile?.email,
  ]);

  const employeeEmail = userProfile?.email || firebaseUser?.email || '';

  // Wait briefly for Firebase Auth persistence state on initial load
  if (!authResolved) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
        <div className="rounded-xl border border-slate-200 bg-white px-8 py-7 text-center shadow-sm">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-lg bg-[#0F2942] font-mono text-sm font-bold text-white">
            MS
          </div>
          <p className="mt-3 text-sm font-bold text-[#0F2942]">MAX SANY RHP PORTAL</p>
          <p className="mt-1 text-xs text-slate-600">
            กำลังตรวจสอบสิทธิ์การเข้าใช้งานระบบ...
          </p>
        </div>
      </div>
    );
  }

  // Gate 1: Must sign in or register via Firebase Authentication
  if (!isPortalAuthenticated) {
    return (
      <PortalLoginView
        companyLogoDataUrl={config.companyLogoDataUrl}
        companyName={config.companyName}
        initialSetupRequired={initialSetupRequired}
        authLoading={authLoading}
        authError={authError}
        onGoogleSignIn={handleGoogleSignIn}
        onEmailSignIn={handleEmailSignIn}
        onEmailRegister={handleEmailRegister}
        onGoogleRegister={handleGoogleRegister}
        onPasswordReset={handlePasswordReset}
        onDismissError={() => setAuthError(null)}
      />
    );
  }

  // Gate 2: Must resolve backend session status (emailVerified, Approved status, MFA)
  if (!sessionStatus || (sessionLoading && !sessionStatus.canAccessPortal)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
        <div className="rounded-xl border border-slate-200 bg-white px-8 py-7 text-center shadow-sm">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-lg bg-[#0F2942] font-mono text-sm font-bold text-white">
            MS
          </div>
          <p className="mt-3 text-sm font-bold text-[#0F2942]">MAX SANY RHP PORTAL</p>
          <p className="mt-1 text-xs text-slate-600">
            กำลังตรวจสอบสถานะการยืนยันอีเมล การอนุมัติโดย Super Admin และ MFA...
          </p>
        </div>
      </div>
    );
  }

  // Gate 3: Block ALL internal workspace UI until email verified + Super Admin approved + MFA verified
  if (!sessionStatus.canAccessPortal) {
    return (
      <AccountGateView
        sessionStatus={sessionStatus}
        onRefreshSession={loadWorkspaceStatusAndData}
        onLogout={handleSignOut}
      />
    );
  }

  return (
    <div className="flex min-h-screen bg-slate-50 text-slate-900">
      {/* Desktop Sidebar */}
      <aside className="hidden w-68 shrink-0 flex-col border-r border-slate-200 bg-white lg:flex">
        {/* Sidebar Official Brand Block */}
        <div className="border-b border-slate-200 bg-[#0F2942] px-5 py-4 text-white">
          <div className="flex items-center gap-3">
            {config.companyLogoDataUrl ? (
              <img
                src={config.companyLogoDataUrl}
                alt="Company Logo"
                referrerPolicy="no-referrer"
                className="h-10 w-10 shrink-0 rounded-lg border border-white/20 bg-white object-contain p-1"
              />
            ) : (
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/20 bg-white/10">
                <Building2 className="h-5 w-5 text-white" />
              </div>
            )}
            <div className="min-w-0">
              <p className="truncate text-sm font-bold tracking-wide text-white">
                MAX SANY RHP PORTAL
              </p>
              <p className="truncate text-[11px] font-medium text-slate-200">
                By Risk Control Department
              </p>
            </div>
          </div>
          <p className="mt-2.5 border-t border-white/15 pt-2 text-[11px] leading-snug text-slate-200">
            ระบบคำนวณและบริหารจัดการสัญญาปรับโครงสร้างหนี้
          </p>
        </div>

        {/* RBAC Main Navigation Menu (Up to 7 Items) */}
        <nav className="flex-1 space-y-1 p-3.5" aria-label="เมนูหลัก">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activePage === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActivePage(item.id)}
                className={`flex w-full items-center justify-between gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors ${
                  active
                    ? 'bg-[#0F2942] text-white'
                    : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-semibold">{item.label}</span>
                    <span
                      className={`block truncate text-[10px] ${
                        active ? 'text-slate-200' : 'text-slate-500'
                      }`}
                    >
                      {item.subtitle}
                    </span>
                  </span>
                </span>
                {item.id === 'approval' && pendingDraftCount > 0 && (
                  <span
                    className={`shrink-0 font-mono text-[11px] font-bold tabular-nums ${
                      active ? 'text-amber-200' : 'text-amber-700'
                    }`}
                  >
                    {pendingDraftCount}
                  </span>
                )}
                {item.id === 'user-approval' && pendingUserCount > 0 && (
                  <span
                    className={`shrink-0 font-mono text-[11px] font-bold tabular-nums ${
                      active ? 'text-amber-200' : 'text-amber-700'
                    }`}
                  >
                    {pendingUserCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Sidebar Database Status Footer */}
        <div className="space-y-3 border-t border-slate-200 p-4">
          <div className="space-y-1 px-1">
            <p className="text-[11px] font-medium text-slate-500">ฐานข้อมูลกลางองค์กร</p>
            <p className="truncate text-xs font-semibold text-slate-800">
              {connection.connected
                ? connection.spreadsheetTitle || 'RHP_Restructuring_Database'
                : 'ยังไม่ได้เชื่อมต่อ Sheets'}
            </p>
            <p className="text-[11px] text-slate-500">
              {oAuthSnapshot.authMode === 'service_account'
                ? 'โหมด: Service Account'
                : needsSheetsReconnect
                  ? 'สิทธิ์ Sheets: ต้องเชื่อมต่อใหม่'
                  : hasSheetsAccess
                    ? 'สิทธิ์ Sheets: พร้อมใช้งาน'
                    : 'สิทธิ์ Sheets: รอการเชื่อมต่อ'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => (isSuperAdmin ? setActivePage('settings') : setSetupModalOpen(true))}
            className="flex w-full items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50"
          >
            <Database className="h-3.5 w-3.5 text-[#0F2942]" />
            {isSuperAdmin ? 'จัดการระบบและฐานข้อมูล' : 'สถานะ Google Sheets'}
          </button>
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div
            className="fixed inset-0 bg-slate-900/50"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative z-10 flex w-72 flex-col bg-white shadow-xl">
            <div className="border-b border-slate-200 bg-[#0F2942] px-4 py-4 text-white">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-white">MAX SANY RHP PORTAL</p>
                  <p className="truncate text-[11px] text-slate-200">By Risk Control Department</p>
                </div>
                <button
                  type="button"
                  onClick={() => setMobileMenuOpen(false)}
                  className="rounded-lg p-1.5 text-slate-200 hover:bg-white/10"
                  aria-label="ปิดเมนู"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <p className="mt-2 text-[11px] text-slate-200">
                ระบบคำนวณและบริหารจัดการสัญญาปรับโครงสร้างหนี้
              </p>
            </div>

            <nav className="flex-1 space-y-1 overflow-y-auto p-3.5">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = activePage === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActivePage(item.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`flex w-full items-center justify-between gap-2.5 rounded-lg px-3 py-2.5 text-left ${
                      active ? 'bg-[#0F2942] text-white' : 'text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-semibold">{item.label}</span>
                        <span
                          className={`block truncate text-[10px] ${
                            active ? 'text-slate-200' : 'text-slate-500'
                          }`}
                        >
                          {item.subtitle}
                        </span>
                      </span>
                    </span>
                    {item.id === 'approval' && pendingDraftCount > 0 && (
                      <span className="font-mono text-[11px] font-bold tabular-nums">
                        {pendingDraftCount}
                      </span>
                    )}
                    {item.id === 'user-approval' && pendingUserCount > 0 && (
                      <span className="font-mono text-[11px] font-bold tabular-nums">
                        {pendingUserCount}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>

            <div className="space-y-2 border-t border-slate-200 p-4 text-xs">
              <div className="rounded-lg bg-slate-50 p-3">
                <p className="truncate font-semibold text-slate-900">{employeeDisplayName}</p>
                <p className="truncate text-[11px] text-slate-600">
                  {userRole} · Risk Control Department
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleSignOut()}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800"
              >
                <LogOut className="h-3.5 w-3.5" />
                ออกจากระบบ
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Formal Corporate Top Header */}
        <header className="sticky top-0 z-30 border-b border-slate-200 bg-white px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between gap-4">
            {/* Header Zone 1: Mobile Menu + System Branding / Page Context */}
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                onClick={() => setMobileMenuOpen(true)}
                className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden"
                aria-label="เปิดเมนู"
              >
                <Menu className="h-5 w-5" />
              </button>

              {/* Show compact logo on mobile/tablet where sidebar is hidden */}
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 lg:hidden">
                {config.companyLogoDataUrl ? (
                  <img
                    src={config.companyLogoDataUrl}
                    alt="Company Logo"
                    referrerPolicy="no-referrer"
                    className="h-7 w-7 object-contain"
                  />
                ) : (
                  <Building2 className="h-4 w-4 text-[#0F2942]" />
                )}
              </div>

              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                  <span className="font-bold tracking-wide text-[#0F2942]">
                    MAX SANY RHP PORTAL
                  </span>
                  <span className="hidden text-slate-300 sm:inline" aria-hidden="true">
                    ·
                  </span>
                  <span className="hidden truncate text-slate-600 md:inline">
                    ระบบคำนวณและบริหารจัดการสัญญาปรับโครงสร้างหนี้
                  </span>
                  <span className="hidden text-slate-300 xl:inline" aria-hidden="true">
                    ·
                  </span>
                  <span className="hidden font-medium text-slate-500 xl:inline">
                    By Risk Control Department
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-2">
                  <h1 className="truncate text-sm font-semibold text-slate-900 sm:text-base">
                    {pageMetaMap[activePage].title}
                  </h1>
                  <span className="hidden text-xs text-slate-400 sm:inline" aria-hidden="true">
                    /
                  </span>
                  <span className="hidden truncate text-xs text-slate-500 sm:inline">
                    {pageMetaMap[activePage].subtitle}
                  </span>
                </div>
              </div>
            </div>

            {/* Header Zone 2: Notifications, Employee Info (Name / Role / Department), Profile Menu & Logout */}
            <div className="flex shrink-0 items-center gap-2.5 sm:gap-3">
              {needsSheetsReconnect && (
                <button
                  type="button"
                  onClick={() => void handleReconnectSheets()}
                  disabled={reconnectLoading}
                  className="hidden items-center gap-1.5 whitespace-nowrap rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50 md:inline-flex"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${reconnectLoading ? 'animate-spin' : ''}`} />
                  <span>Reconnect Google</span>
                </button>
              )}

              {/* 5. Notification Center */}
              <div className="relative" ref={notifRef}>
                <button
                  type="button"
                  onClick={() => {
                    setNotificationsOpen((prev) => !prev);
                    setProfileMenuOpen(false);
                  }}
                  className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                  aria-label="การแจ้งเตือน"
                  title="การแจ้งเตือนระบบ"
                >
                  <Bell className="h-4 w-4" />
                  {notifications.length > 0 && (
                    <span className="absolute -top-1 -right-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-amber-600 px-1 font-mono text-[10px] font-bold text-white tabular-nums">
                      {notifications.length}
                    </span>
                  )}
                </button>

                {notificationsOpen && (
                  <div className="absolute right-0 z-40 mt-2 w-80 rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
                    <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                      <span className="text-xs font-semibold text-slate-900">
                        การแจ้งเตือนระบบ (Notifications)
                      </span>
                      <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                        {notifications.length} รายการ
                      </span>
                    </div>

                    {notifications.length === 0 ? (
                      <p className="py-5 text-center text-xs text-slate-500">
                        ไม่มีรายการแจ้งเตือนค้างดำเนินการ ระบบพร้อมใช้งานปกติ
                      </p>
                    ) : (
                      <div className="mt-2 space-y-2">
                        {notifications.map((n) => (
                          <div
                            key={n.id}
                            className={`rounded-lg border p-2.5 text-xs ${
                              n.tone === 'error'
                                ? 'border-red-200 bg-red-50'
                                : n.tone === 'warning'
                                  ? 'border-amber-200 bg-amber-50'
                                  : 'border-slate-200 bg-slate-50'
                            }`}
                          >
                            <p className="font-semibold text-slate-900">{n.title}</p>
                            <p className="mt-0.5 text-[11px] leading-relaxed text-slate-600">
                              {n.description}
                            </p>
                            <button
                              type="button"
                              onClick={n.onAction}
                              className="mt-2 font-semibold text-[#0F2942] hover:underline"
                            >
                              {n.actionLabel}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* 2, 3, 4, 6. Employee Name, Role, Department & Profile Menu */}
              <div className="relative" ref={profileRef}>
                <button
                  type="button"
                  onClick={() => {
                    setProfileMenuOpen((prev) => !prev);
                    setNotificationsOpen(false);
                  }}
                  className="flex items-center gap-2.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-left hover:bg-slate-50"
                  aria-label="ข้อมูลบัญชีผู้ใช้งาน"
                >
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[#0F2942] text-white">
                    <UserIcon className="h-3.5 w-3.5" />
                  </div>
                  <div className="hidden min-w-0 sm:block">
                    <p className="max-w-[170px] truncate text-xs font-semibold text-slate-900">
                      {employeeDisplayName}
                    </p>
                    <p className="truncate text-[11px] text-slate-500">
                      {userRole} · Risk Control Department
                    </p>
                  </div>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                </button>

                {profileMenuOpen && (
                  <div className="absolute right-0 z-40 mt-2 w-72 rounded-xl border border-slate-200 bg-white p-4 shadow-lg">
                    <div className="border-b border-slate-100 pb-3">
                      <p className="text-xs font-semibold text-slate-900">{employeeDisplayName}</p>
                      <p className="mt-0.5 truncate font-mono text-[11px] text-slate-500">
                        {employeeEmail}
                      </p>
                      <div className="mt-2 space-y-1 text-[11px] text-slate-600">
                        <p>
                          ตำแหน่ง / บทบาท:{' '}
                          <span className="font-semibold text-[#0F2942]">{userRole}</span>
                        </p>
                        <p>
                          หน่วยงาน:{' '}
                          <span className="font-semibold text-slate-800">
                            Risk Control Department
                          </span>
                        </p>
                      </div>
                    </div>

                    <div className="space-y-1.5 border-b border-slate-100 py-3 text-[11px]">
                      <p className="flex items-center gap-1.5 font-semibold text-slate-700">
                        <Shield className="h-3.5 w-3.5 text-[#0F2942]" />
                        สิทธิ์การใช้งาน (RBAC)
                      </p>
                      <div className="flex items-center justify-between text-slate-600">
                        <span>สร้าง / คำนวณสัญญา</span>
                        <span className="font-semibold text-slate-900">
                          {canCreateContract ? 'อนุญาต' : 'ไม่อนุญาต'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-slate-600">
                        <span>ปรับแก้ยอด AR</span>
                        <span className="font-semibold text-slate-900">
                          {userProfile?.canOverrideAr ? 'อนุญาต' : 'ไม่อนุญาต'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-slate-600">
                        <span>อนุมัติ / ปฏิเสธสัญญา</span>
                        <span className="font-semibold text-slate-900">
                          {canApprove ? 'อนุญาต' : 'ไม่อนุญาต'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-slate-600">
                        <span>ลบ / กู้คืนรายการ</span>
                        <span className="font-semibold text-slate-900">
                          {userProfile?.canDelete ? 'อนุญาต' : 'ไม่อนุญาต'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-slate-600">
                        <span>MFA (TOTP)</span>
                        <span className="font-semibold text-slate-900">
                          {userProfile?.mfaRequired
                            ? userProfile?.mfaVerified
                              ? 'ยืนยันแล้ว'
                              : 'รอการยืนยัน'
                            : 'ไม่บังคับ'}
                        </span>
                      </div>
                    </div>

                    <div className="mt-3 space-y-1.5">
                      {isSuperAdmin && (
                        <button
                          type="button"
                          onClick={() => {
                            setProfileMenuOpen(false);
                            setActivePage('settings');
                          }}
                          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-100"
                        >
                          <Settings className="h-3.5 w-3.5 text-slate-500" />
                          ตั้งค่าระบบ (System Settings)
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void handleSignOut()}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs font-semibold text-red-700 hover:bg-red-50"
                      >
                        <LogOut className="h-3.5 w-3.5" />
                        ออกจากระบบ (Logout)
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* 7. Explicit Logout Button */}
              <button
                type="button"
                onClick={() => void handleSignOut()}
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                <LogOut className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">ออกจากระบบ</span>
              </button>
            </div>
          </div>
        </header>

        {authError && (
          <div className="flex items-center justify-between gap-4 border-b border-red-200 bg-red-50 px-6 py-2.5 text-xs text-red-900">
            <span>{authError}</span>
            <button
              type="button"
              onClick={() => setAuthError(null)}
              className="rounded p-0.5 text-red-700 hover:bg-red-100"
              aria-label="ปิดการแจ้งเตือน"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {needsSheetsReconnect && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-6 py-2.5 text-xs text-amber-950">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-700" />
              <span>
                {oAuthSnapshot.statusMessage ||
                  'สิทธิ์การเข้าถึง Google Sheets หมดอายุชั่วคราว (เซสชัน MAX SANY RHP PORTAL และข้อมูลที่คุณกรอกยังคงอยู่ครบถ้วน)'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => void handleReconnectSheets()}
              disabled={reconnectLoading}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-amber-700 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-amber-800 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${reconnectLoading ? 'animate-spin' : ''}`} />
              {reconnectLoading ? 'กำลังเชื่อมต่อใหม่...' : 'Reconnect Google'}
            </button>
          </div>
        )}

        {/* Page Viewport */}
        <main className="mx-auto w-full max-w-[1440px] flex-1 p-4 sm:p-6 lg:p-8">
          {activePage === 'dashboard' && (
            <DashboardView
              isPortalAuthenticated={isPortalAuthenticated}
              hasSheetsAccess={hasSheetsAccess}
              reconnectLoading={reconnectLoading}
              canApprove={canApprove}
              canCreateContract={canCreateContract}
              connection={connection}
              transactions={transactions}
              onRequireSetup={() =>
                isSuperAdmin ? setActivePage('settings') : setSetupModalOpen(true)
              }
              onReconnectSheets={handleReconnectSheets}
              onNavigateCalculator={() => setActivePage('calculator')}
              onNavigateApproval={() => setActivePage('approval')}
            />
          )}

          {/* Keep Calculator mounted ONLY for authorized creators so Approver/Viewer never reserve contract IDs */}
          {canCreateContract && (
            <div className={activePage === 'calculator' ? 'block' : 'hidden'}>
              <RhpCalculatorView
                isPortalAuthenticated={isPortalAuthenticated}
                hasSheetsAccess={hasSheetsAccess}
                reconnectLoading={reconnectLoading}
                userProfile={userProfile}
                connection={connection}
                config={config}
                transactions={transactions}
                onRequireSetup={() =>
                  isSuperAdmin ? setActivePage('settings') : setSetupModalOpen(true)
                }
                onReconnectSheets={handleReconnectSheets}
                onTransactionSaved={loadWorkspaceStatusAndData}
              />
            </div>
          )}

          {activePage === 'database' && (
            <TransactionDatabaseView
              isPortalAuthenticated={isPortalAuthenticated}
              hasSheetsAccess={hasSheetsAccess}
              reconnectLoading={reconnectLoading}
              userProfile={userProfile}
              connection={connection}
              transactions={transactions}
              schedulesByContract={schedulesByContract}
              auditLogs={auditLogs}
              loading={dbLoading}
              onRefresh={loadWorkspaceStatusAndData}
              onRequireSetup={() =>
                isSuperAdmin ? setActivePage('settings') : setSetupModalOpen(true)
              }
              onReconnectSheets={handleReconnectSheets}
            />
          )}

          {activePage === 'approval' && canApprove && (
            <ApprovalCenterView
              isPortalAuthenticated={isPortalAuthenticated}
              hasSheetsAccess={hasSheetsAccess}
              reconnectLoading={reconnectLoading}
              userProfile={userProfile}
              connection={connection}
              transactions={transactions}
              schedulesByContract={schedulesByContract}
              loading={dbLoading}
              onRefresh={loadWorkspaceStatusAndData}
              onRequireSetup={() =>
                isSuperAdmin ? setActivePage('settings') : setSetupModalOpen(true)
              }
              onReconnectSheets={handleReconnectSheets}
            />
          )}

          {activePage === 'user-approval' && isSuperAdmin && (
            <UserApprovalCenterView
              userProfile={userProfile}
              onUsersUpdated={loadWorkspaceStatusAndData}
            />
          )}

          {activePage === 'users' && isSuperAdmin && (
            <UserManagementView
              userProfile={userProfile}
              config={config}
              onConfigUpdated={(nextCfg) => setConfig(nextCfg)}
              onNavigateApprovalCenter={() => setActivePage('user-approval')}
            />
          )}

          {activePage === 'audit' && canViewAudit && (
            <AuditLogView
              isPortalAuthenticated={isPortalAuthenticated}
              hasSheetsAccess={hasSheetsAccess}
              reconnectLoading={reconnectLoading}
              userProfile={userProfile}
              connection={connection}
              auditLogs={auditLogs}
              loading={dbLoading}
              onRefresh={loadWorkspaceStatusAndData}
              onRequireSetup={() =>
                isSuperAdmin ? setActivePage('settings') : setSetupModalOpen(true)
              }
              onReconnectSheets={handleReconnectSheets}
            />
          )}

          {activePage === 'settings' && isSuperAdmin && (
            <SystemSettingsView
              hasSheetsAccess={hasSheetsAccess}
              oAuthSnapshot={oAuthSnapshot}
              reconnectLoading={reconnectLoading}
              userProfile={userProfile}
              connection={connection}
              config={config}
              onReconnectSheets={handleReconnectSheets}
              onDatabaseReady={loadWorkspaceStatusAndData}
              onConfigUpdated={(nextCfg) => setConfig(nextCfg)}
              onOpenSetupModal={() => setSetupModalOpen(true)}
            />
          )}
        </main>
      </div>

      <SheetsSetupModal
        open={setupModalOpen}
        onClose={() => setSetupModalOpen(false)}
        isPortalAuthenticated={isPortalAuthenticated}
        hasSheetsAccess={hasSheetsAccess}
        oAuthSnapshot={oAuthSnapshot}
        reconnectLoading={reconnectLoading}
        authLoading={authLoading}
        userProfile={userProfile}
        onSignIn={handleGoogleSignIn}
        onReconnectSheets={handleReconnectSheets}
        connection={connection}
        config={config}
        onDatabaseReady={loadWorkspaceStatusAndData}
        onConfigUpdated={(nextCfg) => setConfig(nextCfg)}
      />
    </div>
  );
}
