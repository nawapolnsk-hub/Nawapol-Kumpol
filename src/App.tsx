import { useCallback, useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import {
  BarChart3,
  Calculator,
  Database,
  LogOut,
  Menu,
  Settings,
  Table2,
  X,
} from 'lucide-react';
import { DashboardView } from './components/DashboardView.tsx';
import { GoogleSignInButton } from './components/GoogleSignInButton.tsx';
import { RhpCalculatorView } from './components/RhpCalculatorView.tsx';
import { SheetsSetupModal } from './components/SheetsSetupModal.tsx';
import { TransactionDatabaseView } from './components/TransactionDatabaseView.tsx';
import { apiClient, type UserAuthProfile } from './services/apiClient.ts';
import { getAccessToken, googleSignIn, initAuth, logout } from './services/firebaseAuth.ts';
import type {
  AmortizationRow,
  AuditLogEntry,
  ConnectionStatus,
  RhpTransaction,
  SystemConfig,
} from './types/rhp.ts';

type PageId = 'calculator' | 'database' | 'dashboard';

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

export default function App() {
  const [activePage, setActivePage] = useState<PageId>('calculator');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [setupModalOpen, setSetupModalOpen] = useState(false);

  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [hasOAuthToken, setHasOAuthToken] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [userProfile, setUserProfile] = useState<UserAuthProfile | null>(null);

  const [connection, setConnection] = useState<ConnectionStatus>({
    connected: false,
    spreadsheetId: null,
    spreadsheetUrl: null,
    spreadsheetTitle: null,
    sheetsPresent: [],
    lastSyncedAt: null,
    error: null,
  });

  const [config, setConfig] = useState<SystemConfig>(DEFAULT_CONFIG);
  const [transactions, setTransactions] = useState<RhpTransaction[]>([]);
  const [schedulesByContract, setSchedulesByContract] = useState<Record<string, AmortizationRow[]>>(
    {}
  );
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [dbLoading, setDbLoading] = useState(false);

  const loadWorkspaceStatusAndData = useCallback(async () => {
    try {
      const status = await apiClient.getSheetsStatus();
      setConfig(status.config);
      setConnection((prev) => ({
        ...prev,
        connected: status.connected,
        spreadsheetId: status.spreadsheetId,
        spreadsheetUrl: status.spreadsheetUrl,
        spreadsheetTitle: status.spreadsheetTitle,
      }));

      const token = getAccessToken();
      if (!token) {
        setHasOAuthToken(false);
        return;
      }

      setHasOAuthToken(true);
      const profile = await apiClient.getAuthProfile();
      setUserProfile(profile);

      if (status.connected) {
        setDbLoading(true);
        try {
          const dbData = await apiClient.loadDatabase();
          setTransactions(dbData.transactions);
          setSchedulesByContract(dbData.schedulesByContract);
          setAuditLogs(dbData.auditLogs);
          setConfig(dbData.config);
          setConnection({
            connected: true,
            spreadsheetId: dbData.spreadsheetId,
            spreadsheetUrl: dbData.spreadsheetUrl,
            spreadsheetTitle: dbData.spreadsheetTitle,
            sheetsPresent: dbData.sheetsPresent,
            lastSyncedAt: new Date().toISOString(),
            error: null,
          });
        } finally {
          setDbLoading(false);
        }
      } else {
        setTransactions([]);
        setSchedulesByContract({});
        setAuditLogs([]);
      }
    } catch (err) {
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
        setHasOAuthToken(true);
        void loadWorkspaceStatusAndData();
      },
      (user) => {
        setFirebaseUser(user);
        setHasOAuthToken(Boolean(getAccessToken()));
        setUserProfile(null);
      }
    );
    return () => unsub();
  }, [loadWorkspaceStatusAndData]);

  const handleSignIn = async () => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      const res = await googleSignIn();
      if (res) {
        setFirebaseUser(res.user);
        setHasOAuthToken(true);
        await loadWorkspaceStatusAndData();
      }
    } catch (err) {
      setAuthError(
        err instanceof Error ? err.message : 'การเข้าสู่ระบบ Google ไม่สำเร็จ กรุณาลองใหม่'
      );
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSignOut = async () => {
    await logout();
    setFirebaseUser(null);
    setHasOAuthToken(false);
    setUserProfile(null);
    setTransactions([]);
    setSchedulesByContract({});
    setAuditLogs([]);
  };

  const navItems: Array<{ id: PageId; label: string; icon: typeof Calculator }> = [
    { id: 'calculator', label: 'RHP Calculator', icon: Calculator },
    { id: 'database', label: 'Transaction Database', icon: Table2 },
    { id: 'dashboard', label: 'Dashboard', icon: BarChart3 },
  ];

  const pageTitleMap: Record<PageId, string> = {
    calculator: 'RHP Calculator',
    database: 'RHP Transaction Database',
    dashboard: 'Dashboard',
  };

  const isAuthenticated = Boolean(firebaseUser && hasOAuthToken);

  return (
    <div className="flex min-h-screen bg-slate-50 text-slate-900">
      {/* Desktop Sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-slate-200 bg-white lg:flex">
        <div className="flex h-16 items-center border-b border-slate-200 px-6">
          <span className="whitespace-nowrap text-base font-bold tracking-tight text-[#0F2942]">
            RHP Management
          </span>
        </div>

        <nav className="flex-1 space-y-1 p-4" aria-label="เมนูหลัก">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activePage === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActivePage(item.id)}
                className={`flex w-full items-center gap-3 whitespace-nowrap rounded-lg px-3.5 py-2.5 text-sm font-medium transition-colors ${
                  active
                    ? 'bg-[#0F2942] text-white'
                    : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="space-y-3 border-t border-slate-200 p-4">
          <div className="space-y-1 px-1">
            <p className="text-[11px] font-medium text-slate-500">ฐานข้อมูลกลาง</p>
            <p className="truncate text-xs font-semibold text-slate-800">
              {connection.connected
                ? connection.spreadsheetTitle || 'RHP_Restructuring_Database'
                : 'ยังไม่ได้เชื่อมต่อ Sheets'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setSetupModalOpen(true)}
            className="flex w-full items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800 hover:bg-slate-50"
          >
            <Settings className="h-3.5 w-3.5" />
            ตั้งค่าระบบและฐานข้อมูล
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
          <aside className="relative z-10 flex w-64 flex-col bg-white shadow-xl">
            <div className="flex h-16 items-center justify-between border-b border-slate-200 px-5">
              <span className="text-base font-bold text-[#0F2942]">RHP Management</span>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="flex-1 space-y-1 p-4">
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
                    className={`flex w-full items-center gap-3 whitespace-nowrap rounded-lg px-3.5 py-2.5 text-sm font-medium ${
                      active ? 'bg-[#0F2942] text-white' : 'text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
            <div className="border-t border-slate-200 p-4">
              <button
                type="button"
                onClick={() => {
                  setMobileMenuOpen(false);
                  setSetupModalOpen(true);
                }}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-800"
              >
                <Settings className="h-3.5 w-3.5" />
                ตั้งค่าระบบและฐานข้อมูล
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top Bar */}
        <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden"
              aria-label="เปิดเมนู"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <span className="hidden text-slate-400 sm:inline">Risk Control</span>
              <span className="hidden text-slate-300 sm:inline">/</span>
              <h1 className="truncate font-semibold text-slate-900">
                {pageTitleMap[activePage]}
              </h1>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setSetupModalOpen(true)}
              className="hidden items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 sm:inline-flex"
            >
              <Database className="h-3.5 w-3.5 text-[#0F2942]" />
              <span>{connection.connected ? 'Google Sheets เชื่อมต่อแล้ว' : 'ตั้งค่า Google Sheets'}</span>
            </button>

            {isAuthenticated ? (
              <div className="flex items-center gap-3">
                <div className="hidden text-right sm:block">
                  <p className="max-w-[180px] truncate text-xs font-semibold text-slate-900">
                    {firebaseUser?.email}
                  </p>
                  <p className="text-[11px] text-slate-500">
                    Role: {userProfile?.role || 'Staff'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleSignOut()}
                  className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  ออกจากระบบ
                </button>
              </div>
            ) : (
              <GoogleSignInButton onClick={() => void handleSignIn()} disabled={authLoading} />
            )}
          </div>
        </header>

        {authError && (
          <div className="border-b border-red-200 bg-red-50 px-6 py-2.5 text-xs text-red-700">
            {authError}
          </div>
        )}

        {/* Page Viewport */}
        <main className="mx-auto w-full max-w-[1440px] flex-1 p-4 sm:p-6 lg:p-8">
          {activePage === 'calculator' && (
            <RhpCalculatorView
              isAuthenticated={isAuthenticated}
              userProfile={userProfile}
              connection={connection}
              config={config}
              transactions={transactions}
              onRequireSetup={() => setSetupModalOpen(true)}
              onTransactionSaved={loadWorkspaceStatusAndData}
            />
          )}

          {activePage === 'database' && (
            <TransactionDatabaseView
              isAuthenticated={isAuthenticated}
              userProfile={userProfile}
              connection={connection}
              transactions={transactions}
              schedulesByContract={schedulesByContract}
              auditLogs={auditLogs}
              loading={dbLoading}
              onRefresh={loadWorkspaceStatusAndData}
              onRequireSetup={() => setSetupModalOpen(true)}
            />
          )}

          {activePage === 'dashboard' && (
            <DashboardView
              isAuthenticated={isAuthenticated}
              connection={connection}
              transactions={transactions}
              onRequireSetup={() => setSetupModalOpen(true)}
              onNavigateCalculator={() => setActivePage('calculator')}
            />
          )}
        </main>
      </div>

      <SheetsSetupModal
        open={setupModalOpen}
        onClose={() => setSetupModalOpen(false)}
        isAuthenticated={isAuthenticated}
        userProfile={userProfile}
        onSignIn={handleSignIn}
        connection={connection}
        config={config}
        onDatabaseReady={loadWorkspaceStatusAndData}
        onConfigUpdated={(nextCfg) => setConfig(nextCfg)}
      />
    </div>
  );
}
