import React, { useState, useEffect, useRef } from 'react';
import {
  Activity,
  Zap,
  Droplets,
  Thermometer,
  ShieldAlert,
  Download,
  RotateCcw,
  CheckCircle2,
  AlertTriangle,
  Code2,
  Sliders,
  FileSpreadsheet,
  Cpu,
  Power,
  Wind,
  LogOut,
  LogIn,
  Lock,
  Sun,
  Moon,
  MessageSquare,
  Smartphone,
  Send,
  Bell,
  Trash2,
  Server,
  Check,
  Menu,
  X,
  LayoutDashboard,
  SlidersHorizontal,
  Layers,
  FileText,
  ChevronLeft,
  ChevronRight,
  Wifi,
  Terminal,
  Usb,
  Copy,
  ExternalLink,
  Radio,
  RefreshCw,
  Eye,
  EyeOff,
  UserPlus,
  WifiOff
} from 'lucide-react';
import {
  testConnection as testFirebaseConnection,
  auth as firebaseAuth,
  fbSignOut,
  onAuthStateChanged,
  User as FirebaseUser
} from './firebase';




/**
 * ============================================================================
 * AQUAPLANT: Web Application Dashboard & Hardware Telemetry Hub
 * ============================================================================
 * 
 * Features:
 * 1. Real-time Telemetry: Live 5-sensor monitoring (TDS, pH, Temp, Water Level, Humidity).
 * 2. Hardware Heartbeat: 3-minute freshness check displaying ESP32 connection state.
 * 3. Actuator Control: Real-time toggles for Circulation Pump, Flush Solenoid, Refill Valve, Auto Mode.
 * 4. Failsafe Manual Flush: Executes emergency drain and refill sequence with atomic audit logging.
 * 5. High-Performance Canvas Graph: Zero-dependency 2D HTML5 canvas rendering multi-series
 *    time-series curves for TDS, pH, temperature, water level, and humidity.
 * 6. Built-in Hardware Simulator: Allows capstone committee to simulate adverse pH or high TDS
 *    conditions to observe autonomous auto-flush trigger reactions in real time.
 * 7. Capstone Defense Hub: Embedded view & 1-click download of Arduino firmware & MySQL schema.
 */

interface SensorReading {
  id: number;
  tds: number;
  ph: number;
  temperature: number;
  water_level: number;
  humidity: number;
  recorded_at: string;
  device_ip?: string;
}

interface ControlStates {
  water_pump: number;
  solution_pump: number;
  flush_pump: number;
  auto_mode: number;
  pump?: number;
  flush_valve?: number;
  refill_valve?: number;
}

interface SystemLog {
  id: number;
  message: string;
  level: 'INFO' | 'WARN' | 'ALERT' | 'SUCCESS' | 'ERROR';
  source: string;
  created_at: string;
}

export interface SmsAlertSetting {
  id: number;
  recipient_phone: string;
  is_enabled: number;
  alert_flush_triggered: number;
  alert_low_ph: number;
  alert_high_ph: number;
  alert_low_tds: number;
  alert_high_tds: number;
  alert_low_water: number;
  cooldown_minutes: number;
  sms_provider?: 'SEMAPHORE' | 'TWILIO' | 'WEBHOOK' | 'SIMULATOR';
  semaphore_api_key?: string;
  semaphore_sender_name?: string;
  last_updated?: string;
}

export interface SmsLog {
  id: number;
  recipient_phone: string;
  event_type: string;
  message: string;
  status: 'QUEUED' | 'SENT' | 'SIMULATED' | 'FAILED';
  gateway_sid?: string;
  created_at: string;
}

export interface CloudDbStatus {
  connected: boolean;
  provider: string;
  host: string;
  database: string;
  ssl: boolean;
  latency_ms: number;
  tables_count: number;
  message: string;
  connection_source: 'DATABASE_URL' | 'DB_HOST_CONFIG' | 'IN_MEMORY_FALLBACK';
}

export default function App() {
  // Authentication & Session state (defaults to authorized operator in preview)
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('aquaplant_auth_token'));

  const [user, setUser] = useState<{ username: string; role: string } | null>(() => {
    try {
      const u = localStorage.getItem('aquaplant_auth_user');
      return u ? JSON.parse(u) : { username: 'Operator', role: 'admin' };
    } catch {
      return { username: 'Operator', role: 'admin' };
    }
  });

  // Telemetry & Hardware State
  const [latestReading, setLatestReading] = useState<SensorReading | null>({
    id: 1,
    tds: 745.2,
    ph: 6.08,
    temperature: 24.2,
    water_level: 86.5,
    humidity: 64.5,
    recorded_at: new Date().toISOString()
  });

  const [esp32Status, setEsp32Status] = useState<{ is_online: boolean; last_seen_ago: string }>({
    is_online: true,
    last_seen_ago: 'Online now'
  });

  const [controls, setControls] = useState<ControlStates>({
    water_pump: 1,
    solution_pump: 0,
    flush_pump: 0,
    auto_mode: 1
  });

  const [timeRange, setTimeRange] = useState<'1h' | '6h' | '12h' | '24h'>('24h');
  const [historyData, setHistoryData] = useState<SensorReading[]>([]);
  const [logs, setLogs] = useState<SystemLog[]>([]);
  const [logFilter, setLogFilter] = useState('ALL');

  // SMS Alerts States
  const [showSmsModal, setShowSmsModal] = useState(false);
  const [smsSettings, setSmsSettings] = useState<SmsAlertSetting | null>({
    id: 1,
    recipient_phone: '+1-555-0199',
    is_enabled: 1,
    alert_flush_triggered: 1,
    alert_low_ph: 1,
    alert_high_ph: 1,
    alert_low_tds: 1,
    alert_high_tds: 1,
    alert_low_water: 1,
    cooldown_minutes: 5
  });
  const [smsLogs, setSmsLogs] = useState<SmsLog[]>([]);
  const [cloudDbStatus, setCloudDbStatus] = useState<CloudDbStatus | null>(null);
  const [testSmsLoading, setTestSmsLoading] = useState(false);
  const [testSmsStatus, setTestSmsStatus] = useState<{ success: boolean; message: string; sid?: string } | null>(null);
  const [savingSms, setSavingSms] = useState(false);
  const [smsFeedback, setSmsFeedback] = useState<string | null>(null);
  const [semaphoreBalance, setSemaphoreBalance] = useState<{ credit_balance?: number; status?: string; account_name?: string } | null>(null);
  const [checkingBalance, setCheckingBalance] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);

  const fetchSemaphoreBalance = async (keyOverride?: string) => {
    setCheckingBalance(true);
    setBalanceError(null);
    try {
      const k = keyOverride || smsSettings?.semaphore_api_key;
      const url = k ? `/api/sms/semaphore/account?apikey=${encodeURIComponent(k)}` : '/api/sms/semaphore/account';
      const res = await fetch(url);
      const data = await res.json();
      if (res.ok && data.success) {
        setSemaphoreBalance(data);
      } else {
        setSemaphoreBalance(null);
        setBalanceError(data.error || 'Failed to check balance');
      }
    } catch {
      setSemaphoreBalance(null);
      setBalanceError('Network error checking Semaphore balance');
    } finally {
      setCheckingBalance(false);
    }
  };


  // Theme Mode State: 'dark' (industrial default) or 'light' (clean laboratory mode)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      const saved = localStorage.getItem('aquaplant_theme');
      if (saved === 'light' || saved === 'dark') return saved;
      return 'dark';
    } catch {
      return 'dark';
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('aquaplant_theme', theme);
      if (theme === 'dark') {
        document.documentElement.classList.add('dark');
        document.documentElement.setAttribute('data-theme', 'dark');
        document.body.classList.remove('light-mode');
        document.body.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
        document.documentElement.setAttribute('data-theme', 'light');
        document.body.classList.remove('dark');
        document.body.classList.add('light-mode');
      }
    } catch {
      // ignore
    }
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  const isDark = theme === 'dark';

  // Clock
  const [clockString, setClockString] = useState('');

  // Menu Sidebar State
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activeSection, setActiveSection] = useState<'overview' | 'telemetry' | 'actuators' | 'audit-logs'>('overview');

  const scrollToSection = (sectionId: 'overview' | 'telemetry' | 'actuators' | 'audit-logs') => {
    setActiveSection(sectionId);
    setSidebarOpen(false);
    const el = document.getElementById(sectionId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  // Modals & Auth State
  const [showConnectModal, setShowConnectModal] = useState(false);
  const [connectTab, setConnectTab] = useState<'cloud' | 'serial' | 'wifi' | 'arduino'>('cloud');
  const [esp32Config, setEsp32Config] = useState<{
    server_url: string;
    telemetry_endpoint: string;
    controls_poll_endpoint: string;
    device_key: string;
    poll_interval_ms: number;
    headers: Record<string, string>;
    pinout: Record<string, string>;
  } | null>(null);
  const [handshakeLoading, setHandshakeLoading] = useState(false);
  const [handshakeResult, setHandshakeResult] = useState<{ success: boolean; valid?: boolean; message: string; latency_ms?: number } | null>(null);
  const [testTelemetryLoading, setTestTelemetryLoading] = useState(false);
  const [testTelemetryResult, setTestTelemetryResult] = useState<string | null>(null);
  const [showDeviceKey, setShowDeviceKey] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // Web Serial API State
  const [serialPort, setSerialPort] = useState<any>(null);
  const [serialReader, setSerialReader] = useState<any>(null);
  const [serialConnected, setSerialConnected] = useState(false);
  const [serialLogs, setSerialLogs] = useState<string[]>([
    '[INIT] ESP32 Web Serial Monitor initialized. Ready to connect via USB COM port at 115200 baud.'
  ]);
  const [serialCommand, setSerialCommand] = useState('');

  // Local Network LAN Probe & WiFi Config State
  const [lanIp, setLanIp] = useState('192.168.1.184');
  const [lanProbing, setLanProbing] = useState(false);
  const [lanProbeResult, setLanProbeResult] = useState<{ online: boolean; ip: string; message: string } | null>(null);
  const [wifiSsid, setWifiSsid] = useState(() => {
    try {
      return localStorage.getItem('aquaplant_wifi_ssid') || 'AQUAPLANT_NETWORK';
    } catch {
      return 'AQUAPLANT_NETWORK';
    }
  });
  const [wifiPassword, setWifiPassword] = useState(() => {
    try {
      return localStorage.getItem('aquaplant_wifi_pass') || 'hydroponics2026';
    } catch {
      return 'hydroponics2026';
    }
  });
  const [wifiBackupSsid, setWifiBackupSsid] = useState(() => {
    try {
      return localStorage.getItem('aquaplant_wifi_backup_ssid') || 'Field_Hotspot';
    } catch {
      return 'Field_Hotspot';
    }
  });
  const [wifiBackupPassword, setWifiBackupPassword] = useState(() => {
    try {
      return localStorage.getItem('aquaplant_wifi_backup_pass') || 'field12345';
    } catch {
      return 'field12345';
    }
  });
  const [showWifiPassword, setShowWifiPassword] = useState(false);
  const [showBackupPassword, setShowBackupPassword] = useState(false);
  const [wifiSaving, setWifiSaving] = useState(false);
  const [wifiSaveFeedback, setWifiSaveFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [pushingWifiSerial, setPushingWifiSerial] = useState(false);

  const [showSimulator, setShowSimulator] = useState(false);
  const [showFirmwareModal, setShowFirmwareModal] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [hasExplicitlyLoggedOut, setHasExplicitlyLoggedOut] = useState<boolean>(() => {
    try {
      return localStorage.getItem('aquaplant_explicit_logout') === 'true';
    } catch {
      return false;
    }
  });
  const [guestReadOnly, setGuestReadOnly] = useState(false);
  const [loginUsername, setLoginUsername] = useState('admin');
  const [loginPassword, setLoginPassword] = useState('admin123');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [authScreen, setAuthScreen] = useState<'login' | 'register'>('login');
  const [regUsername, setRegUsername] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regConfirm, setRegConfirm] = useState('');
  const [regLoading, setRegLoading] = useState(false);
  const [isOfflineMode, setIsOfflineMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem('aquaplant_offline_mode') === 'true';
    } catch {
      return false;
    }
  });
  const [isBrowserOnline, setIsBrowserOnline] = useState<boolean>(() => {
    return typeof navigator !== 'undefined' ? navigator.onLine : true;
  });
  const [isFirstVisit, setIsFirstVisit] = useState<boolean>(() => {
    try {
      return !localStorage.getItem('aquaplant_mode_chosen') && !localStorage.getItem('aquaplant_auth_token') && !localStorage.getItem('aquaplant_offline_mode');
    } catch {
      return true;
    }
  });
  const [loginAuthTab, setLoginAuthTab] = useState<'offline' | 'wifi' | 'online'>(() => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return 'offline';
    try {
      const chosen = localStorage.getItem('aquaplant_mode_chosen');
      if (!chosen) return 'wifi'; // First time opening: prompt Wi-Fi Setup or Offline choice!
    } catch {}
    return 'online';
  });
  const [preLoginView, setPreLoginView] = useState<'setup' | 'login'>(() => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return 'setup';
    try {
      if (localStorage.getItem('aquaplant_explicit_logout') === 'true') return 'login';
      const chosen = localStorage.getItem('aquaplant_mode_chosen');
      if (!chosen) return 'setup'; // First time opening: show dedicated Wi-Fi Setup & ESP32 Connection Dashboard!
    } catch {}
    return 'setup';
  });
  const [offlineStationName, setOfflineStationName] = useState('Greenhouse Alpha (Station #1)');
  const [offlineOperatorName, setOfflineOperatorName] = useState('Field Operator');

  // Firebase Firestore & Auth States
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [firebaseStatus, setFirebaseStatus] = useState<{ connected: boolean; message: string; tested: boolean }>({
    connected: false,
    message: 'Connecting to Cloud Firestore...',
    tested: false
  });

  // Simulator Form State
  const [simTds, setSimTds] = useState(750);
  const [simPh, setSimPh] = useState(6.1);
  const [simTemp, setSimTemp] = useState(24.5);
  const [simLevel, setSimLevel] = useState(85);
  const [simHumidity, setSimHumidity] = useState(65);

  // Code Display Cache
  const [firmwareCode, setFirmwareCode] = useState<string>('Loading firmware source...');

  // Canvas Reference
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hoverData, setHoverData] = useState<{ x: number; y: number; item: SensorReading } | null>(null);

  // Boot Effect: Test Firestore Connection & Listen for Firebase Auth per skill directives
  useEffect(() => {
    testFirebaseConnection()
      .then((res) => {
        setFirebaseStatus({
          connected: res.connected,
          message: res.message || (res.connected ? 'Connected to Cloud Firestore' : 'Firestore offline'),
          tested: true
        });
      })
      .catch((err) => {
        setFirebaseStatus({
          connected: false,
          message: 'Connection check failed: ' + String(err),
          tested: true
        });
      });

    const unsubscribe = onAuthStateChanged(firebaseAuth, (currentUser) => {
      setFirebaseUser(currentUser);
      if (currentUser) {
        const u = {
          username: currentUser.displayName || currentUser.email?.split('@')[0] || 'Firebase Operator',
          role: 'admin'
        };
        setUser(u);
        setToken('firebase-' + currentUser.uid);
        localStorage.setItem('aquaplant_auth_token', 'firebase-' + currentUser.uid);
        localStorage.setItem('aquaplant_auth_user', JSON.stringify(u));
        setHasExplicitlyLoggedOut(false);
      }
    });

    return () => unsubscribe();
  }, []);

  // Clock interval
  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setClockString(now.toLocaleTimeString() + ' | ' + now.toLocaleDateString());
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  // Network connectivity listener for instant offline mode detection
  useEffect(() => {
    const handleOnline = () => setIsBrowserOnline(true);
    const handleOffline = () => {
      setIsBrowserOnline(false);
      setLoginAuthTab('offline');
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Ensure default demo token if absent so web app is accessible immediately
  // (Only if user is online, not on first visit, not explicitly logged out, and not in offline/guest mode)
  useEffect(() => {
    if (!token && !hasExplicitlyLoggedOut && !isOfflineMode && !guestReadOnly && isBrowserOnline && !isFirstVisit) {
      fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin123' })
      })
        .then((res) => res.json())
        .then((data) => {
          if (data.token) {
            setToken(data.token);
            setUser(data.user);
            localStorage.setItem('aquaplant_auth_token', data.token);
            localStorage.setItem('aquaplant_auth_user', JSON.stringify(data.user));
          }
        })
        .catch(() => {});
    }
  }, [token, hasExplicitlyLoggedOut, isOfflineMode, guestReadOnly, isBrowserOnline, isFirstVisit]);

  // Log Out Handler (supports local session, offline mode, and Firebase sign out)
  // When pressed, operator session is terminated and user is brought directly to the Login Dashboard
  const handleLogout = async () => {
    try {
      if (firebaseAuth.currentUser) {
        await fbSignOut(firebaseAuth);
      }
    } catch (e) {
      console.warn('Firebase signout error', e);
    }
    setFirebaseUser(null);
    setToken(null);
    setUser(null);
    setIsOfflineMode(false);
    setGuestReadOnly(false);
    localStorage.removeItem('aquaplant_auth_token');
    localStorage.removeItem('aquaplant_auth_user');
    localStorage.removeItem('aquaplant_offline_mode');
    localStorage.setItem('aquaplant_explicit_logout', 'true');
    setHasExplicitlyLoggedOut(true);
    setShowLoginModal(false);
    setLoginError('');
  };

  // Enter Standalone Offline Field Mode
  const handleEnterOfflineMode = (stationName?: string, opName?: string) => {
    const operator = opName?.trim() || offlineOperatorName.trim() || 'Field Station Operator';
    const station = stationName?.trim() || offlineStationName.trim() || 'Greenhouse Station #1';
    const offlineUser = {
      username: `${operator} [Offline Station]`,
      role: 'admin'
    };
    const offlineToken = 'offline-field-' + Date.now();
    setIsOfflineMode(true);
    setToken(offlineToken);
    setUser(offlineUser);
    localStorage.setItem('aquaplant_offline_mode', 'true');
    localStorage.setItem('aquaplant_auth_token', offlineToken);
    localStorage.setItem('aquaplant_auth_user', JSON.stringify(offlineUser));
    localStorage.setItem('aquaplant_mode_chosen', 'true');
    setIsFirstVisit(false);
    localStorage.removeItem('aquaplant_explicit_logout');
    setHasExplicitlyLoggedOut(false);
    setGuestReadOnly(false);
    setShowLoginModal(false);
    setLoginError('');

    const offlineLog: SystemLog = {
      id: Date.now(),
      level: 'INFO',
      source: 'OFFLINE_GATEWAY',
      message: `Offline mode initialized for ${operator} at ${station}. Local closed-loop controls, manual pump relays, and USB Serial interface armed.`,
      created_at: new Date().toISOString()
    };
    setLogs((prev) => [offlineLog, ...prev]);
  };

  // Switch back to Online Cloud Server Mode
  const handleSwitchToOnlineMode = async () => {
    setIsOfflineMode(false);
    localStorage.removeItem('aquaplant_offline_mode');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin123' })
      });
      const data = await res.json();
      if (data.token) {
        setToken(data.token);
        setUser(data.user);
        localStorage.setItem('aquaplant_auth_token', data.token);
        localStorage.setItem('aquaplant_auth_user', JSON.stringify(data.user));
        localStorage.setItem('aquaplant_mode_chosen', 'true');
        setIsFirstVisit(false);
      }
    } catch {
      // offline fallback
    }
    fetchAllData();
  };

  // Save Wi-Fi credentials and immediately launch into selected dashboard mode
  const handleSaveWifiAndEnterDashboard = async (targetMode: 'offline' | 'online') => {
    await handleSaveWifiConfig(false);
    localStorage.setItem('aquaplant_mode_chosen', 'true');
    setIsFirstVisit(false);
    if (targetMode === 'offline') {
      handleEnterOfflineMode(offlineStationName, offlineOperatorName);
    } else {
      handleQuickDemoLogin();
    }
  };

  // Sign In Submission Handler
  const handleLoginSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!loginUsername.trim() || !loginPassword) {
      setLoginError('Please enter username and password.');
      return;
    }
    setLoginLoading(true);
    setLoginError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: loginUsername.trim(), password: loginPassword })
      });
      const data = await res.json();
      if (!res.ok) {
        setLoginError(data.error || 'Authentication failed. Please verify credentials.');
        setLoginLoading(false);
        return;
      }
      setToken(data.token);
      setUser(data.user);
      localStorage.setItem('aquaplant_auth_token', data.token);
      localStorage.setItem('aquaplant_auth_user', JSON.stringify(data.user));
      localStorage.setItem('aquaplant_mode_chosen', 'true');
      setIsFirstVisit(false);
      localStorage.removeItem('aquaplant_explicit_logout');
      setHasExplicitlyLoggedOut(false);
      setGuestReadOnly(false);
      setShowLoginModal(false);
      setLoginLoading(false);
      fetchAllData();
    } catch (err: any) {
      setLoginError('Network error connecting to backend auth service.');
      setLoginLoading(false);
    }
  };

  // 1-Click Quick Demo Sign In
  const handleQuickDemoLogin = async () => {
    setLoginUsername('admin');
    setLoginPassword('admin123');
    setLoginLoading(true);
    setLoginError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin123' })
      });
      const data = await res.json();
      if (data.token) {
        setToken(data.token);
        setUser(data.user);
        localStorage.setItem('aquaplant_auth_token', data.token);
        localStorage.setItem('aquaplant_auth_user', JSON.stringify(data.user));
        localStorage.setItem('aquaplant_mode_chosen', 'true');
        setIsFirstVisit(false);
        localStorage.removeItem('aquaplant_explicit_logout');
        setHasExplicitlyLoggedOut(false);
        setGuestReadOnly(false);
        setShowLoginModal(false);
        fetchAllData();
      } else {
        setLoginError(data.error || 'Demo login failed');
      }
    } catch (e) {
      setLoginError('Demo login connection failed.');
    } finally {
      setLoginLoading(false);
    }
  };

  // Register New Operator Account
  const handleRegisterSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const username = regUsername.trim();
    const email = regEmail.trim();

    if (!username || !email || !regPassword) {
      setLoginError('Username, email and password are all required.');
      return;
    }
    if (regPassword.length < 6) {
      setLoginError('Password must be at least 6 characters long.');
      return;
    }
    if (regPassword !== regConfirm) {
      setLoginError('The two passwords do not match.');
      return;
    }

    setRegLoading(true);
    setLoginError('');
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, password: regPassword })
      });
      const data = await res.json();
      if (!res.ok) {
        setLoginError(data.error || 'Registration failed. Please try a different username.');
        setRegLoading(false);
        return;
      }
      setToken(data.token);
      setUser(data.user);
      localStorage.setItem('aquaplant_auth_token', data.token);
      localStorage.setItem('aquaplant_auth_user', JSON.stringify(data.user));
      localStorage.setItem('aquaplant_mode_chosen', 'true');
      setIsFirstVisit(false);
      localStorage.removeItem('aquaplant_explicit_logout');
      setHasExplicitlyLoggedOut(false);
      setGuestReadOnly(false);
      setShowLoginModal(false);
      setRegLoading(false);
      setRegUsername('');
      setRegEmail('');
      setRegPassword('');
      setRegConfirm('');
      setAuthScreen('login');
      fetchAllData();
    } catch (err: any) {
      setLoginError('Network error connecting to registration service.');
      setRegLoading(false);
    }
  };


  // Telemetry, Controls, and Logs Polling
  const fetchAllData = async () => {
    if (isOfflineMode) {
      // Standalone field mode: keep local telemetry active with gentle sensor fluctuations
      setLatestReading((prev) => {
        if (!prev) return prev;
        const driftTds = (Math.random() - 0.5) * 3;
        const driftPh = (Math.random() - 0.5) * 0.03;
        const driftTemp = (Math.random() - 0.5) * 0.1;
        const driftLevel = (Math.random() - 0.5) * 0.1;
        return {
          ...prev,
          tds: Math.max(650, Math.min(880, +(prev.tds + driftTds).toFixed(1))),
          ph: Math.max(5.85, Math.min(6.45, +(prev.ph + driftPh).toFixed(2))),
          temperature: Math.max(22.0, Math.min(26.5, +(prev.temperature + driftTemp).toFixed(1))),
          water_level: Math.max(70, Math.min(95, +(prev.water_level + driftLevel).toFixed(1))),
          recorded_at: new Date().toISOString()
        };
      });
      return;
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const curToken = token || localStorage.getItem('aquaplant_auth_token');
    if (curToken) {
      headers['Authorization'] = `Bearer ${curToken}`;
    }

    try {
      // Latest Telemetry
      const latestRes = await fetch('/api/sensors/latest', { headers });
      if (latestRes.ok) {
        const data = await latestRes.json();
        if (data.reading) setLatestReading(data.reading);
        if (data.esp32_status) setEsp32Status(data.esp32_status);
      }

      // Controls
      const ctrlRes = await fetch('/api/controls', { headers });
      if (ctrlRes.ok) {
        const ctrlData = await ctrlRes.json();
        setControls(ctrlData);
      }

      // History
      const histRes = await fetch(`/api/sensors/history?range=${timeRange}`, { headers });
      if (histRes.ok) {
        const histData = await histRes.json();
        if (histData.readings) setHistoryData(histData.readings);
      }

      // Logs
      const logsUrl = logFilter !== 'ALL' ? `/api/logs?limit=40&level=${logFilter}` : '/api/logs?limit=40';
      const logsRes = await fetch(logsUrl, { headers });
      if (logsRes.ok) {
        const logsData = await logsRes.json();
        if (logsData.logs) setLogs(logsData.logs);
      }

      // SMS Settings & Outbox Logs
      const smsRes = await fetch('/api/sms/settings', { headers });
      if (smsRes.ok) {
        const smsData = await smsRes.json();
        if (smsData.settings) setSmsSettings(smsData.settings);
      }

      const smsLogsRes = await fetch('/api/sms/logs?limit=30', { headers });
      if (smsLogsRes.ok) {
        const smsLogsData = await smsLogsRes.json();
        if (smsLogsData.logs) setSmsLogs(smsLogsData.logs);
      }

      // Cloud Database Status
      const dbRes = await fetch('/api/database/status', { headers });
      if (dbRes.ok) {
        const dbData = await dbRes.json();
        setCloudDbStatus(dbData);
      }
    } catch (e) {
      console.warn('Sync interval error:', e);
    }
  };

  // SMS Settings Update Handler
  const handleSaveSmsSetting = async (updates: Partial<SmsAlertSetting>) => {
    if (!smsSettings) return;
    const newSettings = { ...smsSettings, ...updates };
    setSmsSettings(newSettings);
    setSavingSms(true);
    setSmsFeedback(null);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch('/api/sms/settings', {
        method: 'POST',
        headers,
        body: JSON.stringify(newSettings)
      });
      if (res.ok) {
        const data = await res.json();
        if (data.settings) setSmsSettings(data.settings);
        setSmsFeedback('✓ Configuration saved & synced with SMS gateway');
        setTimeout(() => setSmsFeedback(null), 3500);
      } else {
        setSmsFeedback('Failed to save SMS preferences.');
      }
    } catch (e) {
      setSmsFeedback('Network error updating SMS preferences.');
    } finally {
      setSavingSms(false);
    }
  };

  // Send Live / Simulated Test SMS Alert
  const handleSendTestSms = async () => {
    setTestSmsLoading(true);
    setTestSmsStatus(null);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch('/api/sms/test', {
        method: 'POST',
        headers,
        body: JSON.stringify({ phone: smsSettings?.recipient_phone })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setTestSmsStatus({
          success: true,
          message: data.message || 'SMS alert dispatched successfully.',
          sid: data.sid
        });
        // Refresh SMS logs
        const logsRes = await fetch('/api/sms/logs?limit=30', { headers });
        if (logsRes.ok) {
          const lData = await logsRes.json();
          if (lData.logs) setSmsLogs(lData.logs);
        }
      } else {
        setTestSmsStatus({
          success: false,
          message: data.error || 'Failed to dispatch test SMS alert.'
        });
      }
    } catch (e: any) {
      setTestSmsStatus({
        success: false,
        message: 'Network error calling SMS dispatch API.'
      });
    } finally {
      setTestSmsLoading(false);
    }
  };

  // Clear SMS Outbox Logs
  const handleClearSmsLogs = async () => {
    try {
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch('/api/sms/logs', { method: 'DELETE', headers });
      if (res.ok) {
        setSmsLogs([]);
      }
    } catch (e) {
      console.warn('Error clearing SMS logs', e);
    }
  };

  // Fetch ESP32 Connection Configuration
  const fetchEsp32Config = async () => {
    try {
      const headers: Record<string, string> = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch('/api/esp32/config', { headers });
      if (res.ok) {
        const data = await res.json();
        setEsp32Config(data);
      }
    } catch (e) {
      console.warn('Error fetching ESP32 config:', e);
    }
  };

  // Copy helper
  const handleCopy = (text: string, fieldName: string) => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setCopiedField(fieldName);
      setTimeout(() => setCopiedField(null), 2200);
    }
  };

  // ESP32 Handshake Key Validation Test
  const handleTestHandshake = async () => {
    setHandshakeLoading(true);
    setHandshakeResult(null);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch('/api/esp32/handshake', {
        method: 'POST',
        headers,
        body: JSON.stringify({ device_key: esp32Config?.device_key })
      });
      const data = await res.json();
      setHandshakeResult(data);
      fetchAllData();
    } catch (e) {
      setHandshakeResult({ success: false, message: 'Network connection error.' });
    } finally {
      setHandshakeLoading(false);
    }
  };

  // ESP32 Test Telemetry Dispatch
  const handleSendTestTelemetry = async () => {
    setTestTelemetryLoading(true);
    setTestTelemetryResult(null);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch('/api/esp32/test-telemetry', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          tds: 760,
          ph: 6.22,
          temperature: 24.6,
          water_level: 87.5,
          humidity: 64.0
        })
      });
      const data = await res.json();
      if (data.success) {
        setTestTelemetryResult('✓ Verified! Test telemetry packet recorded and logged.');
        fetchAllData();
      } else {
        setTestTelemetryResult('Failed to dispatch test packet.');
      }
    } catch (e) {
      setTestTelemetryResult('Network error sending telemetry.');
    } finally {
      setTestTelemetryLoading(false);
    }
  };

  // Web Serial: Connect via USB Cable
  const handleConnectUsbSerial = async () => {
    if (!('serial' in navigator)) {
      setSerialLogs((prev) => [
        ...prev,
        '[WARN] Web Serial API is not supported in this browser. Please use Google Chrome, Edge, or Opera over HTTPS/localhost.'
      ]);
      return;
    }

    try {
      const port = await (navigator as any).serial.requestPort();
      await port.open({ baudRate: 115200 });
      setSerialPort(port);
      setSerialConnected(true);
      setSerialLogs((prev) => [
        ...prev,
        `[LINK] Connected to ESP32 on USB Serial at 115200 baud (${new Date().toLocaleTimeString()}).`
      ]);

      const textDecoder = new TextDecoderStream();
      port.readable.pipeTo(textDecoder.writable).catch(() => {});
      const reader = textDecoder.readable.getReader();
      setSerialReader(reader);

      (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
              const lines = value.split('\n').filter((l: string) => l.trim().length > 0);
              setSerialLogs((prev) => [...prev.slice(-120), ...lines]);
            }
          }
        } catch (err: any) {
          if (err.name !== 'AbortError') {
            setSerialLogs((prev) => [...prev, `[SERIAL STREAM ENDED] ${err.message || ''}`]);
          }
        }
      })();
    } catch (err: any) {
      setSerialLogs((prev) => [...prev, `[USB ERROR] Connection aborted or failed: ${err.message || err}`]);
    }
  };

  // Web Serial: Disconnect
  const handleDisconnectUsbSerial = async () => {
    try {
      if (serialReader) {
        await serialReader.cancel();
        setSerialReader(null);
      }
      if (serialPort) {
        await serialPort.close();
        setSerialPort(null);
      }
      setSerialConnected(false);
      setSerialLogs((prev) => [...prev, `[LINK] USB Serial port disconnected.`]);
    } catch (err: any) {
      console.warn('Error disconnecting serial:', err);
    }
  };

  // Web Serial: Send ASCII Command
  const handleSendSerialCommand = async () => {
    if (!serialPort || !serialCommand.trim()) return;
    try {
      const encoder = new TextEncoder();
      const writer = serialPort.writable.getWriter();
      await writer.write(encoder.encode(serialCommand.trim() + '\n'));
      writer.releaseLock();
      setSerialLogs((prev) => [...prev, `[TX] > ${serialCommand.trim()}`]);
      setSerialCommand('');
    } catch (err: any) {
      setSerialLogs((prev) => [...prev, `[TX ERR] Failed to transmit: ${err.message}`]);
    }
  };

  // LAN Probe: Test Local IP
  const handleProbeLan = async () => {
    setLanProbing(true);
    setLanProbeResult(null);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch('/api/esp32/lan-probe', {
        method: 'POST',
        headers,
        body: JSON.stringify({ ip: lanIp })
      });
      const data = await res.json();
      setLanProbeResult(data);
    } catch (e) {
      setLanProbeResult({ online: false, ip: lanIp, message: 'Probe request failed over network.' });
    } finally {
      setLanProbing(false);
    }
  };

  // Wi-Fi Configuration: Save to Server & Local Storage
  const handleSaveWifiConfig = async (pushOta = false) => {
    setWifiSaving(true);
    setWifiSaveFeedback(null);
    try {
      localStorage.setItem('aquaplant_wifi_ssid', wifiSsid);
      localStorage.setItem('aquaplant_wifi_pass', wifiPassword);
      localStorage.setItem('aquaplant_wifi_backup_ssid', wifiBackupSsid);
      localStorage.setItem('aquaplant_wifi_backup_pass', wifiBackupPassword);

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch('/api/esp32/wifi-config', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          primary_ssid: wifiSsid,
          primary_password: wifiPassword,
          backup_ssid: wifiBackupSsid,
          backup_password: wifiBackupPassword,
          push_ota: pushOta
        })
      });

      const data = await res.json();
      if (res.ok) {
        setWifiSaveFeedback({
          type: 'success',
          message: pushOta
            ? `✓ Wi-Fi saved & queued for Over-the-Air ESP32 update on next poll cycle (3s)!`
            : `✓ Wi-Fi credentials saved to station storage. Ready to connect or flash.`
        });
      } else {
        setWifiSaveFeedback({
          type: 'error',
          message: data.error || 'Failed to save Wi-Fi configuration.'
        });
      }
    } catch (err: any) {
      setWifiSaveFeedback({
        type: 'success',
        message: '✓ Wi-Fi settings saved in local station storage.'
      });
    } finally {
      setWifiSaving(false);
    }
  };

  // Push Wi-Fi to ESP32 over USB Web Serial (Works 100% when Wi-Fi is DOWN!)
  const handlePushWifiOverSerial = async () => {
    setPushingWifiSerial(true);
    setWifiSaveFeedback(null);
    try {
      let activePort = serialPort;
      if (!activePort) {
        if (!(navigator as any).serial) {
          setWifiSaveFeedback({
            type: 'error',
            message: 'Web Serial not supported in this browser. Please use Chrome or Edge.'
          });
          setPushingWifiSerial(false);
          return;
        }
        activePort = await (navigator as any).serial.requestPort();
        await activePort.open({ baudRate: 115200 });
        setSerialPort(activePort);
        setSerialConnected(true);
      }

      const cmd = `SET_WIFI:${wifiSsid.trim()},${wifiPassword.trim()},${wifiBackupSsid.trim()},${wifiBackupPassword.trim()}\n`;
      const encoder = new TextEncoder();
      const writer = activePort.writable.getWriter();
      await writer.write(encoder.encode(cmd));
      writer.releaseLock();

      setSerialLogs((prev) => [
        ...prev,
        `[WIFI_USB] Pushed Wi-Fi credentials to ESP32: SSID="${wifiSsid.trim()}", Backup="${wifiBackupSsid.trim()}"`
      ]);

      setWifiSaveFeedback({
        type: 'success',
        message: `⚡ Wi-Fi sent to ESP32 over USB cable! Microcontroller saved to flash memory and is connecting to "${wifiSsid.trim()}".`
      });
    } catch (err: any) {
      setWifiSaveFeedback({
        type: 'error',
        message: `USB transmission failed: ${err.message}`
      });
    } finally {
      setPushingWifiSerial(false);
    }
  };

  // 1-Click Download of Firmware pre-populated with configured Wi-Fi
  const handleDownloadCustomFirmware = () => {
    const url = `/api/download/firmware?ssid=${encodeURIComponent(wifiSsid)}&pass=${encodeURIComponent(wifiPassword)}&backup_ssid=${encodeURIComponent(wifiBackupSsid)}&backup_pass=${encodeURIComponent(wifiBackupPassword)}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = 'aquaplant_esp32.ino';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };



  useEffect(() => {
    fetchAllData();
    const interval = setInterval(fetchAllData, 4000);
    return () => clearInterval(interval);
  }, [token, timeRange, logFilter]);

  // Load firmware preview on modal open
  useEffect(() => {
    if (showFirmwareModal) {
      fetch('/firmware/aquaplant_esp32.ino')
        .then((r) => r.text())
        .then(setFirmwareCode)
        .catch(() => setFirmwareCode('Failed to load firmware code.'));
    }
  }, [showFirmwareModal]);

  // Render Canvas Chart (NO external libraries!)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.resetTransform();
    ctx.scale(dpr, dpr);

    const width = rect.width;
    const height = rect.height;

    ctx.clearRect(0, 0, width, height);

    // Canvas Background (Theme-aware)
    ctx.fillStyle = isDark ? '#020710' : '#ffffff';
    ctx.fillRect(0, 0, width, height);

    if (!historyData || historyData.length < 2) {
      ctx.fillStyle = isDark ? '#55708e' : '#64748b';
      ctx.font = '14px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('Collecting hydroponic telemetry data...', width / 2, height / 2);
      return;
    }

    const padding = { top: 25, right: 65, bottom: 40, left: 65 };
    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;

    const tdsMin = 300;
    const tdsMax = 1300;
    const phMin = 4.0;
    const phMax = 9.0;

    // Target TDS Shading (600 - 900 ppm)
    const targetTdsTopY = padding.top + chartH * (1 - (900 - tdsMin) / (tdsMax - tdsMin));
    const targetTdsBottomY = padding.top + chartH * (1 - (600 - tdsMin) / (tdsMax - tdsMin));
    ctx.fillStyle = isDark ? 'rgba(0, 242, 254, 0.05)' : 'rgba(2, 132, 199, 0.08)';
    ctx.fillRect(padding.left, targetTdsTopY, chartW, targetTdsBottomY - targetTdsTopY);

    // Target pH Shading outline
    ctx.strokeStyle = isDark ? 'rgba(0, 242, 254, 0.2)' : 'rgba(2, 132, 199, 0.25)';
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(padding.left, targetTdsTopY, chartW, targetTdsBottomY - targetTdsTopY);
    ctx.setLineDash([]);

    // Grid Lines
    const gridSteps = 5;
    for (let i = 0; i <= gridSteps; i++) {
      const y = padding.top + (chartH / gridSteps) * i;
      ctx.strokeStyle = isDark ? '#0d1e33' : '#e2e8f0';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + chartW, y);
      ctx.stroke();

      // Left Labels (TDS)
      const tdsVal = Math.round(tdsMax - (i / gridSteps) * (tdsMax - tdsMin));
      ctx.fillStyle = isDark ? '#6e8ba8' : '#475569';
      ctx.font = '11px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`${tdsVal} ppm`, padding.left - 8, y + 4);

      // Right Labels (pH)
      const phVal = (phMax - (i / gridSteps) * (phMax - phMin)).toFixed(1);
      ctx.fillStyle = isDark ? '#b8860b' : '#b45309';
      ctx.textAlign = 'left';
      ctx.fillText(`${phVal} pH`, padding.left + chartW + 8, y + 4);
    }

    // X-Axis Time Labels
    const count = historyData.length;
    const timeSteps = Math.min(6, count);
    for (let i = 0; i < timeSteps; i++) {
      const idx = Math.floor((i / (timeSteps - 1 || 1)) * (count - 1));
      const item = historyData[idx];
      if (!item) continue;
      const x = padding.left + (idx / (count - 1)) * chartW;
      const timeStr = new Date(item.recorded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      ctx.fillStyle = isDark ? '#55708e' : '#64748b';
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(timeStr, x, padding.top + chartH + 20);
    }

    // Coordinate Normalization Functions:
    // Transforms raw physical sensor values (ppm, pH, °C, % RH) into pixel coordinates [X, Y]
    const getX = (idx: number) => padding.left + (idx / (count - 1)) * chartW;
    const getY_TDS = (val: number) => padding.top + chartH * (1 - Math.max(0, Math.min(1, (val - tdsMin) / (tdsMax - tdsMin))));
    const getY_PH = (val: number) => padding.top + chartH * (1 - Math.max(0, Math.min(1, (val - phMin) / (phMax - phMin))));
    const getY_TEMP = (val: number) => padding.top + chartH * (1 - Math.max(0, Math.min(1, (val - 15) / 20)));
    const getY_HUMIDITY = (val: number) => padding.top + chartH * (1 - Math.max(0, Math.min(1, (val - 20) / 80)));

    // 1. Draw TDS Curve (Cyan)
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = isDark ? '#00f2fe' : '#0284c7';
    ctx.shadowColor = isDark ? 'rgba(0, 242, 254, 0.4)' : 'rgba(2, 132, 199, 0.2)';
    ctx.shadowBlur = isDark ? 6 : 2;
    ctx.beginPath();
    historyData.forEach((d, idx) => {
      const x = getX(idx);
      const y = getY_TDS(d.tds);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // 2. Draw pH Curve (Magenta)
    ctx.strokeStyle = isDark ? '#e056fd' : '#a855f7';
    ctx.shadowColor = isDark ? 'rgba(224, 86, 253, 0.4)' : 'rgba(168, 85, 247, 0.2)';
    ctx.beginPath();
    historyData.forEach((d, idx) => {
      const x = getX(idx);
      const y = getY_PH(d.ph);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // 3. Draw Temperature Curve (Amber)
    ctx.strokeStyle = isDark ? '#f0932b' : '#d97706';
    ctx.shadowColor = isDark ? 'rgba(240, 147, 43, 0.4)' : 'rgba(217, 119, 6, 0.2)';
    ctx.beginPath();
    historyData.forEach((d, idx) => {
      const x = getX(idx);
      const y = getY_TEMP(d.temperature);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // 4. Draw Humidity Curve (Emerald Green)
    ctx.strokeStyle = isDark ? '#00e676' : '#16a34a';
    ctx.shadowColor = isDark ? 'rgba(0, 230, 118, 0.4)' : 'rgba(22, 163, 74, 0.2)';
    ctx.beginPath();
    historyData.forEach((d, idx) => {
      const x = getX(idx);
      const y = getY_HUMIDITY(d.humidity || 65);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.shadowBlur = 0;

    // Interactive Hover Crosshair
    if (hoverData) {
      ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.35)' : 'rgba(15, 23, 42, 0.35)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(hoverData.x, padding.top);
      ctx.lineTo(hoverData.x, padding.top + chartH);
      ctx.stroke();
      ctx.setLineDash([]);

      const pts = [
        { y: getY_TDS(hoverData.item.tds), color: isDark ? '#00f2fe' : '#0284c7' },
        { y: getY_PH(hoverData.item.ph), color: isDark ? '#e056fd' : '#a855f7' },
        { y: getY_TEMP(hoverData.item.temperature), color: isDark ? '#f0932b' : '#d97706' },
        { y: getY_HUMIDITY(hoverData.item.humidity || 65), color: isDark ? '#00e676' : '#16a34a' }
      ];

      pts.forEach((p) => {
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(hoverData.x, p.y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = isDark ? '#ffffff' : '#0f172a';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });

      // Tooltip Box
      const boxW = 190;
      const boxH = 106;
      let tx = hoverData.x + 12;
      if (tx + boxW > width - padding.right) tx = hoverData.x - boxW - 12;
      const ty = padding.top + 8;

      ctx.fillStyle = isDark ? 'rgba(4, 14, 28, 0.95)' : 'rgba(255, 255, 255, 0.97)';
      ctx.strokeStyle = isDark ? '#00f2fe' : '#0284c7';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(tx, ty, boxW, boxH, 6);
      ctx.fill();
      ctx.stroke();

      const timeStr = new Date(hoverData.item.recorded_at).toLocaleTimeString();
      ctx.fillStyle = isDark ? '#8ca2ba' : '#64748b';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`🕒 ${timeStr}`, tx + 10, ty + 18);

      ctx.fillStyle = isDark ? '#00f2fe' : '#0284c7';
      ctx.font = 'bold 12px monospace';
      ctx.fillText(`TDS:   ${hoverData.item.tds.toFixed(1)} ppm`, tx + 10, ty + 38);

      ctx.fillStyle = isDark ? '#e056fd' : '#a855f7';
      ctx.fillText(`pH:    ${hoverData.item.ph.toFixed(2)}`, tx + 10, ty + 56);

      ctx.fillStyle = isDark ? '#f0932b' : '#d97706';
      ctx.fillText(`Temp:  ${hoverData.item.temperature.toFixed(1)} °C`, tx + 10, ty + 74);

      ctx.fillStyle = isDark ? '#00e676' : '#16a34a';
      ctx.fillText(`Humid: ${(hoverData.item.humidity || 65).toFixed(1)} % RH`, tx + 10, ty + 92);
    }
  }, [historyData, hoverData, theme]);

  // Canvas Mouse Move
  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !historyData.length) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const paddingLeft = 65;
    const paddingRight = 65;
    const chartW = rect.width - paddingLeft - paddingRight;

    if (mouseX >= paddingLeft && mouseX <= paddingLeft + chartW) {
      const ratio = (mouseX - paddingLeft) / chartW;
      const idx = Math.round(ratio * (historyData.length - 1));
      const item = historyData[idx];
      if (item) {
        const xPos = paddingLeft + (idx / (historyData.length - 1)) * chartW;
        setHoverData({ x: xPos, y: e.clientY - rect.top, item });
      }
    } else {
      setHoverData(null);
    }
  };

  // Toggle Actuator
  const toggleActuator = async (device: string, newState: number) => {
    if (!token) {
      setLoginError('Operator authentication required to toggle actuators.');
      setShowLoginModal(true);
      return;
    }

    // Immediately update local controls state for instant UI response
    setControls((prev) => ({
      ...prev,
      [device]: newState
    }));

    // If USB Web Serial is connected, dispatch direct serial command to ESP32
    if (serialConnected && serialPort) {
      try {
        const encoder = new TextEncoder();
        const writer = serialPort.writable.getWriter();
        const cmd = `SET_${device.toUpperCase()}_${newState}`;
        await writer.write(encoder.encode(cmd + '\n'));
        writer.releaseLock();
        setSerialLogs((prev) => [...prev, `[TX LOCAL] > ${cmd}`]);
      } catch (err: any) {
        console.warn('Serial direct command failed:', err);
      }
    }

    if (isOfflineMode) {
      const auditLog: SystemLog = {
        id: Date.now(),
        level: 'INFO',
        source: 'OFFLINE_RELAY',
        message: `Offline manual toggle: ${device.toUpperCase()} set to ${newState === 1 ? 'ON / ACTIVE' : 'OFF / IDLE'}`,
        created_at: new Date().toISOString()
      };
      setLogs((prev) => [auditLog, ...prev]);
      return;
    }

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      };

      const res = await fetch(`/api/controls/${device}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ state: newState })
      });
      if (res.ok) {
        const data = await res.json();
        setControls(data.controls);
        fetchAllData();
      }
    } catch (err) {
      console.warn('Actuator update error; maintaining local state');
    }
  };

  // Trigger Manual Flush
  const triggerManualFlush = async () => {
    if (!token) {
      setLoginError('Operator authentication required to trigger emergency flush.');
      setShowLoginModal(true);
      return;
    }
    if (!window.confirm('Trigger emergency/manual reservoir flush cycle?')) return;

    if (isOfflineMode) {
      setControls((prev) => ({
        ...prev,
        flush_pump: 1,
        water_pump: 1,
        solution_pump: 0
      }));

      if (serialConnected && serialPort) {
        try {
          const encoder = new TextEncoder();
          const writer = serialPort.writable.getWriter();
          await writer.write(encoder.encode('FLUSH_ON\n'));
          writer.releaseLock();
          setSerialLogs((prev) => [...prev, '[TX LOCAL] > FLUSH_ON']);
        } catch (e) {}
      }

      const auditLog: SystemLog = {
        id: Date.now(),
        level: 'ALERT',
        source: 'OFFLINE_EMERGENCY',
        message: 'Emergency 3-pump reservoir flush cycle initiated by Field Operator in Offline Mode.',
        created_at: new Date().toISOString()
      };
      setLogs((prev) => [auditLog, ...prev]);

      setTimeout(() => {
        setControls((prev) => ({ ...prev, flush_pump: 0 }));
      }, 5000);
      return;
    }

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      };

      await fetch('/api/controls/manual_flush', { method: 'POST', headers });
      fetchAllData();
    } catch (e) {
      alert('Manual flush failed');
    }
  };


  // Inject Simulated Telemetry
  const handleSimulateSubmit = async () => {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      await fetch('/api/simulator/reading', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          tds: simTds,
          ph: simPh,
          temperature: simTemp,
          water_level: simLevel,
          humidity: simHumidity
        })
      });
      setShowSimulator(false);
      fetchAllData();
    } catch (err) {
      alert('Simulation injection failed');
    }
  };

  // Export Excel
  const handleExportExcel = async () => {
    try {
      const curToken = token || localStorage.getItem('aquaplant_auth_token');
      const response = await fetch('/api/export/excel', {
        headers: { Authorization: `Bearer ${curToken}` }
      });
      if (!response.ok) throw new Error('Export failed');
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `AQUAPLANT_Export_${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (e: any) {
      alert('Excel export error: ' + e.message);
    }
  };

  // Health Status Logic
  const isAnomaly =
    latestReading &&
    (latestReading.tds < 600 || latestReading.tds > 900 || latestReading.ph < 5.5 || latestReading.ph > 6.5);

  // Theme-aware style helpers
  const themeCardBg = isDark ? 'bg-[#081528] border-[#163252]' : 'bg-white border-slate-200 shadow-sm';
  const themeTextMain = isDark ? 'text-white' : 'text-slate-900';
  const themeTextMuted = isDark ? 'text-[#8ca2ba]' : 'text-slate-500';
  const themeTextDim = isDark ? 'text-[#55708e]' : 'text-slate-400';
  const themeInnerBg = isDark ? 'bg-[#020710] border-[#163252]' : 'bg-slate-50 border-slate-200';

  // Check if we should render the dedicated Login Dashboard
  // This triggers when the user clicks Log Out (hasExplicitlyLoggedOut) OR when there is no active token/offline session
  const showLoginDashboard = hasExplicitlyLoggedOut || (!token && !isOfflineMode && !guestReadOnly);

  if (showLoginDashboard) {
    return (
      <div className={`min-h-screen ${isDark ? 'bg-[#030a16] text-[#f0f6fc]' : 'bg-[#f4f7fb] text-slate-800'} flex flex-col justify-between font-sans transition-colors duration-200 selection:bg-[#00f2fe] selection:text-[#030a16]`}>
        {/* Navigation & Status Header */}
        <header className={`px-4 sm:px-6 py-3.5 flex flex-wrap items-center justify-between gap-3 border-b ${
          isDark ? 'border-[#163252] bg-[#061222]/90' : 'border-slate-200 bg-white/90'
        } backdrop-blur-md sticky top-0 z-40`}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-emerald-500/20 to-[#00f2fe]/20 border border-[#00f2fe]/30 flex items-center justify-center text-lg text-emerald-400 font-bold shadow-sm">
              🌱
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className={`font-black text-sm tracking-wide ${isDark ? 'text-white' : 'text-slate-900'}`}>
                  AQUAPLANT
                </span>
                <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border font-semibold ${
                  preLoginView === 'setup'
                    ? 'bg-[#00f2fe]/10 text-[#00f2fe] border-[#00f2fe]/30'
                    : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                }`}>
                  {preLoginView === 'setup' ? 'Hardware & Wi-Fi Gateway' : 'Operator Login'}
                </span>
              </div>
              <p className={`text-[11px] ${themeTextMuted} hidden sm:block`}>
                ESP32 Automated Hydroponics Monitoring & Nutrient Control Station
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            {/* View Switcher Button */}
            {preLoginView === 'setup' ? (
              <button
                type="button"
                onClick={() => setPreLoginView('login')}
                className="px-3 py-1.5 rounded-lg bg-[#00f2fe]/10 hover:bg-[#00f2fe]/20 text-[#00f2fe] border border-[#00f2fe]/30 text-xs font-bold transition flex items-center gap-1.5 cursor-pointer shadow-sm"
              >
                <Lock className="w-3.5 h-3.5" />
                <span>Operator Login →</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setPreLoginView('setup')}
                className="px-3 py-1.5 rounded-lg bg-amber-400/10 hover:bg-amber-400/20 text-amber-400 border border-amber-400/30 text-xs font-bold transition flex items-center gap-1.5 cursor-pointer shadow-sm"
              >
                <Wifi className="w-3.5 h-3.5" />
                <span>← Wi-Fi Setup & ESP32</span>
              </button>
            )}

            <div className={`font-mono text-xs px-2.5 py-1 rounded border hidden md:block ${isDark ? 'bg-[#030a16] border-[#163252] text-[#00f2fe]' : 'bg-slate-100 border-slate-300 text-slate-700'}`}>
              {clockString || '--:--:--'}
            </div>

            <button
              type="button"
              onClick={toggleTheme}
              className={`p-2 rounded-xl border transition cursor-pointer ${
                isDark ? 'border-[#163252] bg-[#061222] text-amber-400 hover:text-white' : 'border-slate-300 bg-white text-slate-600 hover:text-slate-900 shadow-sm'
              }`}
              title={isDark ? "Switch to Light Mode" : "Switch to Dark Mode"}
            >
              {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
        </header>

        {/* =========================================================================
            VIEW 1: DEDICATED PRE-LOGIN WI-FI SETUP & ESP32 CONNECTION DASHBOARD
           ========================================================================= */}
        {preLoginView === 'setup' ? (
          <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto space-y-6">
            {/* Top Offline / Welcome Banner */}
            <div className={`p-4 sm:p-5 rounded-2xl border flex flex-col md:flex-row items-start md:items-center justify-between gap-4 shadow-sm ${
              !isBrowserOnline
                ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                : (isDark ? 'bg-[#061222] border-[#163252]' : 'bg-white border-slate-200')
            }`}>
              <div className="flex items-start sm:items-center gap-3">
                <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 text-xl ${
                  !isBrowserOnline ? 'bg-amber-500/20 text-amber-400' : 'bg-[#00f2fe]/10 text-[#00f2fe]'
                }`}>
                  {!isBrowserOnline ? <WifiOff className="w-6 h-6" /> : <Radio className="w-6 h-6" />}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className={`text-sm sm:text-base font-bold ${themeTextMain}`}>
                      {!isBrowserOnline
                        ? 'Operating Without Wi-Fi / Local Station Mode'
                        : 'Station Setup & Microcontroller Connection Gateway'}
                    </h2>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 font-semibold">
                      Offline Ready
                    </span>
                  </div>
                  <p className={`text-xs mt-0.5 ${themeTextMuted} max-w-2xl leading-relaxed`}>
                    Configure your greenhouse 2.4GHz Wi-Fi, push credentials to the ESP32 via USB cable, or launch directly into 100% Offline Mode without network credentials.
                  </p>
                </div>
              </div>

              {/* Fast Action Launch Bar */}
              <div className="flex flex-wrap items-center gap-2.5 shrink-0 w-full sm:w-auto">
                <button
                  type="button"
                  onClick={() => handleEnterOfflineMode(offlineStationName, offlineOperatorName)}
                  className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-amber-400 to-amber-500 hover:from-amber-500 hover:to-amber-600 text-slate-950 font-bold text-xs shadow-md transition active:scale-95 flex items-center gap-2 cursor-pointer"
                  title="Launch the full hydroponics telemetry and 3-pump relay control dashboard locally without Wi-Fi"
                >
                  <Zap className="w-4 h-4 fill-slate-950" />
                  <span>🚀 Launch Offline Dashboard</span>
                </button>

                <button
                  type="button"
                  onClick={() => setPreLoginView('login')}
                  className={`px-3.5 py-2.5 rounded-xl border text-xs font-semibold transition active:scale-95 flex items-center gap-1.5 cursor-pointer ${
                    isDark ? 'border-[#163252] bg-[#030a16] text-slate-200 hover:text-white' : 'border-slate-300 bg-slate-50 text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  <LogIn className="w-3.5 h-3.5" />
                  <span>Operator Login</span>
                </button>
              </div>
            </div>

            {/* Notification Feedback if any */}
            {wifiSaveFeedback && (
              <div className={`p-3.5 rounded-xl text-xs font-mono flex items-start gap-2.5 border transition ${
                wifiSaveFeedback.type === 'success'
                  ? 'bg-emerald-950/40 border-emerald-500/50 text-emerald-300'
                  : 'bg-rose-950/40 border-rose-500/50 text-rose-300'
              }`}>
                {wifiSaveFeedback.type === 'success' ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                ) : (
                  <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                )}
                <div className="flex-1 font-sans">
                  <p className="font-semibold">{wifiSaveFeedback.message}</p>
                </div>
              </div>
            )}

            {/* Main 2-Column Hardware Setup Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* =========================================================
                  COLUMN 1 (7 Cols): WI-FI NETWORK & FAILOVER MANAGER
                 ========================================================= */}
              <div className="lg:col-span-7 space-y-5">
                {/* Dual Network Card */}
                <div className={`p-5 rounded-2xl border ${themeCardBg} space-y-4`}>
                  <div className="flex items-center justify-between border-b pb-3 border-slate-700/30">
                    <div className="flex items-center gap-2">
                      <Wifi className="w-5 h-5 text-[#00f2fe]" />
                      <h3 className={`text-sm font-bold ${themeTextMain}`}>
                        Wi-Fi Network & Failover Manager
                      </h3>
                    </div>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/30">
                      2.4 GHz Only
                    </span>
                  </div>

                  <p className={`text-xs ${themeTextMuted} leading-relaxed`}>
                    Enter your greenhouse Wi-Fi network and a personal hotspot backup. When the Wi-Fi is down, you can push these credentials to the ESP32 over a USB data cable without needing internet.
                  </p>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {/* Primary Network */}
                    <div className={`p-3.5 rounded-xl border ${themeInnerBg} space-y-2.5`}>
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-mono font-bold text-cyan-400 uppercase tracking-wider flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
                          Primary Wi-Fi
                        </span>
                        <span className={`text-[10px] ${themeTextDim}`}>Main Router</span>
                      </div>

                      <div>
                        <label className={`block text-[11px] font-medium mb-1 ${themeTextMuted}`}>
                          Network SSID
                        </label>
                        <input
                          type="text"
                          value={wifiSsid}
                          onChange={(e) => setWifiSsid(e.target.value)}
                          placeholder="e.g. GreenHouse_2.4G"
                          className={`w-full px-3 py-2 rounded-lg text-xs font-mono border outline-none ${
                            isDark ? 'bg-[#061222] border-[#163252] text-white focus:border-[#00f2fe]' : 'bg-white border-slate-300 text-slate-900 focus:border-cyan-600'
                          }`}
                        />
                      </div>

                      <div>
                        <label className={`block text-[11px] font-medium mb-1 ${themeTextMuted}`}>
                          Network Password
                        </label>
                        <div className="relative">
                          <input
                            type={showWifiPassword ? 'text' : 'password'}
                            value={wifiPassword}
                            onChange={(e) => setWifiPassword(e.target.value)}
                            placeholder="Password"
                            className={`w-full px-3 py-2 pr-9 rounded-lg text-xs font-mono border outline-none ${
                              isDark ? 'bg-[#061222] border-[#163252] text-white focus:border-[#00f2fe]' : 'bg-white border-slate-300 text-slate-900 focus:border-cyan-600'
                            }`}
                          />
                          <button
                            type="button"
                            onClick={() => setShowWifiPassword(!showWifiPassword)}
                            className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-white cursor-pointer"
                          >
                            {showWifiPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Backup / Mobile Hotspot */}
                    <div className={`p-3.5 rounded-xl border ${themeInnerBg} space-y-2.5`}>
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-mono font-bold text-amber-400 uppercase tracking-wider flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-amber-400" />
                          Backup Hotspot
                        </span>
                        <span className={`text-[10px] ${themeTextDim}`}>Auto-Failover</span>
                      </div>

                      <div>
                        <label className={`block text-[11px] font-medium mb-1 ${themeTextMuted}`}>
                          Hotspot SSID
                        </label>
                        <input
                          type="text"
                          value={wifiBackupSsid}
                          onChange={(e) => setWifiBackupSsid(e.target.value)}
                          placeholder="e.g. MyPhoneHotspot"
                          className={`w-full px-3 py-2 rounded-lg text-xs font-mono border outline-none ${
                            isDark ? 'bg-[#061222] border-[#163252] text-white focus:border-[#00f2fe]' : 'bg-white border-slate-300 text-slate-900 focus:border-cyan-600'
                          }`}
                        />
                      </div>

                      <div>
                        <label className={`block text-[11px] font-medium mb-1 ${themeTextMuted}`}>
                          Hotspot Password
                        </label>
                        <div className="relative">
                          <input
                            type={showBackupPassword ? 'text' : 'password'}
                            value={wifiBackupPassword}
                            onChange={(e) => setWifiBackupPassword(e.target.value)}
                            placeholder="Password"
                            className={`w-full px-3 py-2 pr-9 rounded-lg text-xs font-mono border outline-none ${
                              isDark ? 'bg-[#061222] border-[#163252] text-white focus:border-[#00f2fe]' : 'bg-white border-slate-300 text-slate-900 focus:border-cyan-600'
                            }`}
                          />
                          <button
                            type="button"
                            onClick={() => setShowBackupPassword(!showBackupPassword)}
                            className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-white cursor-pointer"
                          >
                            {showBackupPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Actions Toolbar */}
                  <div className="pt-2 flex flex-wrap items-center gap-2.5 border-t border-slate-700/30">
                    <button
                      type="button"
                      onClick={handlePushWifiOverSerial}
                      disabled={pushingWifiSerial}
                      className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-[#030a16] font-bold text-xs shadow transition active:scale-95 disabled:opacity-50 flex items-center gap-2 cursor-pointer"
                      title="Transmits SET_WIFI directly via USB Web Serial cable. Works 100% offline even if Wi-Fi is completely down!"
                    >
                      <Usb className={`w-4 h-4 ${pushingWifiSerial ? 'animate-pulse' : ''}`} />
                      <span>{pushingWifiSerial ? 'Pushing to ESP32...' : '⚡ Push to ESP32 via USB (Offline Fix)'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => handleSaveWifiAndEnterDashboard('offline')}
                      disabled={wifiSaving}
                      className="px-4 py-2.5 rounded-xl bg-[#00f2fe] hover:bg-[#4facfe] text-[#030a16] font-bold text-xs shadow transition active:scale-95 disabled:opacity-50 flex items-center gap-2 cursor-pointer"
                    >
                      <Check className="w-4 h-4" />
                      <span>{wifiSaving ? 'Saving...' : '💾 Save & Launch Offline Dashboard'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={handleDownloadCustomFirmware}
                      className={`px-3 py-2.5 rounded-xl border text-xs font-mono font-medium transition flex items-center gap-1.5 cursor-pointer ${
                        isDark ? 'border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
                      }`}
                      title="Download aquaplant_esp32.ino with these exact credentials pre-filled"
                    >
                      <Download className="w-3.5 h-3.5 text-[#00f2fe]" />
                      <span>Download .ino</span>
                    </button>
                  </div>
                </div>

                {/* Emergency Wi-Fi Down Guide Card */}
                <div className={`p-4 sm:p-5 rounded-2xl border ${themeCardBg} space-y-3`}>
                  <div className="flex items-center gap-2">
                    <WifiOff className="w-4 h-4 text-amber-400" />
                    <h4 className={`text-xs font-mono font-bold uppercase tracking-wider ${themeTextMain}`}>
                      How to Change Wi-Fi If Network is Down
                    </h4>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className={`p-3 rounded-xl border ${themeInnerBg}`}>
                      <div className="text-amber-400 font-bold text-xs font-mono mb-1 flex items-center gap-1">
                        <Usb className="w-3 h-3" />
                        <span>1. USB Cable</span>
                      </div>
                      <p className="text-[11px] text-slate-300 leading-relaxed">
                        Plug standard USB data cable from PC into ESP32 and click <strong className="text-amber-300">Push to ESP32 via USB</strong> above.
                      </p>
                    </div>

                    <div className={`p-3 rounded-xl border ${themeInnerBg}`}>
                      <div className="text-[#00f2fe] font-bold text-xs font-mono mb-1 flex items-center gap-1">
                        <Radio className="w-3 h-3" />
                        <span>2. ESP32 Hotspot</span>
                      </div>
                      <p className="text-[11px] text-slate-300 leading-relaxed">
                        Connect phone/PC to Wi-Fi <strong className="text-cyan-300">AQUAPLANT-HOTSPOT</strong> (pass: <strong className="text-cyan-300">aquaplant123</strong>) and open <strong className="text-cyan-300">192.168.4.1</strong>.
                      </p>
                    </div>

                    <div className={`p-3 rounded-xl border ${themeInnerBg}`}>
                      <div className="text-emerald-400 font-bold text-xs font-mono mb-1 flex items-center gap-1">
                        <Smartphone className="w-3 h-3" />
                        <span>3. Phone Hotspot</span>
                      </div>
                      <p className="text-[11px] text-slate-300 leading-relaxed">
                        Turn on phone hotspot matching your Backup SSID. ESP32 auto-links within 10s of router failure.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* =========================================================
                  COLUMN 2 (5 Cols): ESP32 DIRECT USB SERIAL & LAN PROBE
                 ========================================================= */}
              <div className="lg:col-span-5 space-y-5">
                {/* Direct USB Web Serial Console */}
                <div className={`p-5 rounded-2xl border ${themeCardBg} space-y-3`}>
                  <div className="flex items-center justify-between border-b pb-3 border-slate-700/30">
                    <div className="flex items-center gap-2">
                      <Terminal className="w-4 h-4 text-[#00f2fe]" />
                      <h4 className={`text-sm font-bold ${themeTextMain}`}>
                        ESP32 Direct USB Web Serial Link
                      </h4>
                    </div>
                    <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full font-bold border ${
                      serialConnected
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                        : 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                    }`}>
                      {serialConnected ? '● CONNECTED' : '○ DISCONNECTED'}
                    </span>
                  </div>

                  <p className={`text-xs ${themeTextMuted}`}>
                    Direct hardware connection via browser Web Serial API. 100% offline at 115200 baud.
                  </p>

                  <div className="flex items-center gap-2">
                    {!serialConnected ? (
                      <button
                        type="button"
                        onClick={handleConnectUsbSerial}
                        className="flex-1 py-2 rounded-xl bg-[#00f2fe] hover:bg-[#4facfe] text-[#030a16] font-bold text-xs shadow transition active:scale-95 flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        <Usb className="w-3.5 h-3.5" />
                        <span>Connect ESP32 USB Port</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={handleDisconnectUsbSerial}
                        className="flex-1 py-2 rounded-xl bg-rose-500 hover:bg-rose-600 text-white font-bold text-xs shadow transition active:scale-95 flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        <Power className="w-3.5 h-3.5" />
                        <span>Disconnect Port</span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => setSerialLogs(['[LOGS CLEARED]'])}
                      className={`px-3 py-2 rounded-xl border text-xs font-mono transition cursor-pointer ${
                        isDark ? 'border-[#163252] bg-[#020710] text-slate-400 hover:text-white' : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-100'
                      }`}
                    >
                      Clear
                    </button>
                  </div>

                  {/* Terminal Box */}
                  <div className="rounded-xl border border-[#163252] bg-[#020710] overflow-hidden">
                    <div className="p-3 font-mono text-xs h-48 overflow-y-auto space-y-1 text-slate-300">
                      {serialLogs.map((log, idx) => (
                        <div key={idx} className={
                          log.startsWith('[ERR') || log.startsWith('[WARN')
                            ? 'text-rose-400'
                            : log.startsWith('[TX')
                            ? 'text-amber-300'
                            : log.startsWith('[LINK')
                            ? 'text-emerald-400 font-bold'
                            : 'text-slate-300'
                        }>
                          {log}
                        </div>
                      ))}
                    </div>

                    {/* Serial Command Input Bar */}
                    <div className="p-2 bg-[#030d1a] border-t border-[#163252] flex items-center gap-2">
                      <input
                        type="text"
                        value={serialCommand}
                        onChange={(e) => setSerialCommand(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSendSerialCommand()}
                        placeholder={serialConnected ? "Type command (e.g. STATUS, GET_WIFI)..." : "Connect USB port to send commands..."}
                        disabled={!serialConnected}
                        className={`flex-1 px-3 py-1.5 text-xs font-mono rounded bg-[#020710] border border-[#163252] text-white focus:outline-none focus:border-[#00f2fe] ${!serialConnected ? 'opacity-50 cursor-not-allowed' : ''}`}
                      />
                      <button
                        type="button"
                        onClick={handleSendSerialCommand}
                        disabled={!serialConnected || !serialCommand.trim()}
                        className="px-3 py-1.5 rounded bg-[#00f2fe] text-[#030a16] font-bold text-xs shadow hover:opacity-90 disabled:opacity-40 cursor-pointer"
                      >
                        Send
                      </button>
                    </div>
                  </div>

                  {/* Quick Command Chips */}
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    <span className={`text-[10px] font-mono ${themeTextDim}`}>Quick:</span>
                    {['STATUS', 'GET_WIFI', 'SCAN_WIFI'].map((cmd) => (
                      <button
                        key={cmd}
                        type="button"
                        disabled={!serialConnected}
                        onClick={async () => {
                          if (serialConnected && serialPort) {
                            try {
                              const encoder = new TextEncoder();
                              const writer = serialPort.writable.getWriter();
                              await writer.write(encoder.encode(cmd + '\n'));
                              writer.releaseLock();
                              setSerialLogs((prev) => [...prev, `[TX] > ${cmd}`]);
                            } catch (e) {}
                          }
                        }}
                        className={`text-[10px] font-mono px-2 py-0.5 rounded border transition cursor-pointer disabled:opacity-40 ${
                          isDark ? 'border-slate-700 bg-slate-800 text-cyan-300 hover:bg-slate-700' : 'border-slate-300 bg-slate-100 text-slate-700 hover:bg-slate-200'
                        }`}
                      >
                        {cmd}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Subnet LAN IP Direct Probe */}
                <div className={`p-4 sm:p-5 rounded-2xl border ${themeCardBg} space-y-3`}>
                  <div className="flex items-center gap-2">
                    <Radio className="w-4 h-4 text-emerald-400" />
                    <h4 className={`text-xs font-mono font-bold uppercase tracking-wider ${themeTextMain}`}>
                      Probe Subnet Router IP
                    </h4>
                  </div>

                  <p className={`text-[11px] ${themeTextMuted}`}>
                    Test if ESP32 is already assigned an IP on your greenhouse router subnet.
                  </p>

                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={lanIp}
                      onChange={(e) => setLanIp(e.target.value)}
                      placeholder="192.168.1.184 or aquaplant.local"
                      className={`flex-1 px-3 py-2 rounded-lg text-xs font-mono border outline-none ${
                        isDark ? 'bg-[#061222] border-[#163252] text-white focus:border-[#00f2fe]' : 'bg-white border-slate-300 text-slate-900 focus:border-emerald-600'
                      }`}
                    />
                    <button
                      type="button"
                      onClick={handleProbeLan}
                      disabled={lanProbing}
                      className="px-3.5 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white font-bold text-xs shadow active:scale-95 transition cursor-pointer disabled:opacity-50 flex items-center gap-1.5 shrink-0"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${lanProbing ? 'animate-spin' : ''}`} />
                      <span>{lanProbing ? 'Probing...' : 'Probe'}</span>
                    </button>
                  </div>

                  {lanProbeResult && (
                    <div className={`p-2.5 rounded-lg text-xs font-mono border ${
                      lanProbeResult.online
                        ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-400'
                        : 'bg-amber-950/30 border-amber-500/40 text-amber-300'
                    }`}>
                      {lanProbeResult.message}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </main>
        ) : (
          /* =========================================================================
              VIEW 2: DEDICATED OPERATOR LOGIN DASHBOARD
             ========================================================================= */
          <main className="flex-1 flex flex-col items-center justify-center p-4 sm:p-6 w-full max-w-md mx-auto">
            {/* Post-Logout Notice */}
            {hasExplicitlyLoggedOut && (
              <div className="w-full mb-4 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center justify-between gap-2 shadow-sm">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>You have logged out successfully.</span>
                </div>
                <button
                  type="button"
                  onClick={() => setHasExplicitlyLoggedOut(false)}
                  className="text-[11px] text-emerald-400 hover:text-emerald-200 underline font-mono cursor-pointer"
                >
                  ✕
                </button>
              </div>
            )}

            {/* Back to Setup Link */}
            <div className="w-full mb-3 flex items-center justify-between">
              <button
                type="button"
                onClick={() => setPreLoginView('setup')}
                className="text-xs text-[#00f2fe] hover:underline flex items-center gap-1.5 cursor-pointer font-medium"
              >
                <ChevronLeft className="w-4 h-4" />
                <span>Wi-Fi Setup & ESP32 Connection Dashboard</span>
              </button>
            </div>

            <div className={`w-full ${themeCardBg} rounded-2xl p-6 sm:p-8 border shadow-xl relative overflow-hidden backdrop-blur-md`}>
              {/* Header / Logo */}
              <div className="text-center mb-6">
                <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-emerald-500/20 to-[#00f2fe]/20 border border-[#00f2fe]/30 mx-auto flex items-center justify-center text-2xl shadow-inner mb-3">
                  🌱
                </div>
                <h1 className={`text-xl font-black tracking-tight ${isDark ? 'text-white' : 'text-slate-900'}`}>
                  AQUAPLANT
                </h1>
                <p className={`text-xs ${themeTextMuted} mt-1`}>
                  Operator Authentication & Cloud Access
                </p>
              </div>

              {loginError && (
                <div className="mb-4 p-3 rounded-xl bg-rose-500/15 border border-rose-500/40 text-rose-400 text-xs flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>{loginError}</span>
                </div>
              )}

              {authScreen === 'login' ? (
              <>
              <form onSubmit={handleLoginSubmit} className="space-y-4">
                <div>
                  <label className={`block text-xs font-semibold ${themeTextMuted} mb-1.5`}>
                    Operator Username or Email
                  </label>
                  <input
                    type="text"
                    value={loginUsername}
                    onChange={(e) => setLoginUsername(e.target.value)}
                    placeholder="admin"
                    required
                    className={`w-full ${isDark ? 'bg-[#020710] border-[#163252] text-white placeholder-gray-500 focus:border-[#00f2fe]' : 'bg-slate-50 border-slate-300 text-slate-900 placeholder-slate-400 focus:border-cyan-600 focus:bg-white'} border rounded-xl px-3.5 py-2.5 text-xs outline-none transition`}
                  />
                </div>

                <div>
                  <label className={`block text-xs font-semibold ${themeTextMuted} mb-1.5`}>
                    Password
                  </label>
                  <input
                    type="password"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                    className={`w-full ${isDark ? 'bg-[#020710] border-[#163252] text-white placeholder-gray-500 focus:border-[#00f2fe]' : 'bg-slate-50 border-slate-300 text-slate-900 placeholder-slate-400 focus:border-cyan-600 focus:bg-white'} border rounded-xl px-3.5 py-2.5 text-xs outline-none transition`}
                  />
                </div>

                <button
                  type="submit"
                  disabled={loginLoading}
                  className="w-full py-2.5 rounded-xl font-bold text-xs bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#030a16] hover:opacity-90 active:scale-98 transition cursor-pointer shadow-md disabled:opacity-50 flex items-center justify-center gap-1.5"
                >
                  <Lock className="w-3.5 h-3.5" />
                  <span>{loginLoading ? 'Signing in...' : 'Sign In'}</span>
                </button>

                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={handleQuickDemoLogin}
                    disabled={loginLoading}
                    className={`w-full py-2 rounded-xl text-xs font-bold border transition cursor-pointer ${
                      isDark ? 'border-[#163252] bg-[#020710] text-[#00f2fe] hover:bg-[#0d223a]' : 'border-slate-300 bg-slate-50 text-cyan-800 hover:bg-slate-100'
                    }`}
                    title="1-Click Demo Login (admin / admin123)"
                  >
                    🚀 1-Click Demo Login
                  </button>
                </div>
              </form>

              <div className="pt-4 mt-4 border-t border-slate-700/30 text-center">
                <p className={`text-xs ${themeTextMuted}`}>
                  No account yet?{' '}
                  <button
                    type="button"
                    onClick={() => { setLoginError(''); setAuthScreen('register'); }}
                    className="font-bold text-[#00f2fe] hover:underline cursor-pointer"
                  >
                    Register as Operator
                  </button>
                </p>
              </div>
              </>
              ) : (
              <>
              <form onSubmit={handleRegisterSubmit} className="space-y-4">
                <div>
                  <label className={`block text-xs font-semibold ${themeTextMuted} mb-1.5`}>
                    Operator Username
                  </label>
                  <input
                    type="text"
                    value={regUsername}
                    onChange={(e) => setRegUsername(e.target.value)}
                    placeholder="e.g. researcher1"
                    required
                    autoComplete="username"
                    className={`w-full ${isDark ? 'bg-[#020710] border-[#163252] text-white placeholder-gray-500 focus:border-[#00f2fe]' : 'bg-slate-50 border-slate-300 text-slate-900 placeholder-slate-400 focus:border-cyan-600 focus:bg-white'} border rounded-xl px-3.5 py-2.5 text-xs outline-none transition`}
                  />
                </div>

                <div>
                  <label className={`block text-xs font-semibold ${themeTextMuted} mb-1.5`}>
                    Email Address
                  </label>
                  <input
                    type="email"
                    value={regEmail}
                    onChange={(e) => setRegEmail(e.target.value)}
                    placeholder="operator@university.edu"
                    required
                    autoComplete="email"
                    className={`w-full ${isDark ? 'bg-[#020710] border-[#163252] text-white placeholder-gray-500 focus:border-[#00f2fe]' : 'bg-slate-50 border-slate-300 text-slate-900 placeholder-slate-400 focus:border-cyan-600 focus:bg-white'} border rounded-xl px-3.5 py-2.5 text-xs outline-none transition`}
                  />
                </div>

                <div>
                  <label className={`block text-xs font-semibold ${themeTextMuted} mb-1.5`}>
                    Password (min 6 characters)
                  </label>
                  <input
                    type="password"
                    value={regPassword}
                    onChange={(e) => setRegPassword(e.target.value)}
                    placeholder="••••••••"
                    minLength={6}
                    required
                    autoComplete="new-password"
                    className={`w-full ${isDark ? 'bg-[#020710] border-[#163252] text-white placeholder-gray-500 focus:border-[#00f2fe]' : 'bg-slate-50 border-slate-300 text-slate-900 placeholder-slate-400 focus:border-cyan-600 focus:bg-white'} border rounded-xl px-3.5 py-2.5 text-xs outline-none transition`}
                  />
                </div>

                <div>
                  <label className={`block text-xs font-semibold ${themeTextMuted} mb-1.5`}>
                    Confirm Password
                  </label>
                  <input
                    type="password"
                    value={regConfirm}
                    onChange={(e) => setRegConfirm(e.target.value)}
                    placeholder="••••••••"
                    minLength={6}
                    required
                    autoComplete="new-password"
                    className={`w-full ${isDark ? 'bg-[#020710] border-[#163252] text-white placeholder-gray-500 focus:border-[#00f2fe]' : 'bg-slate-50 border-slate-300 text-slate-900 placeholder-slate-400 focus:border-cyan-600 focus:bg-white'} border rounded-xl px-3.5 py-2.5 text-xs outline-none transition`}
                  />
                </div>

                <button
                  type="submit"
                  disabled={regLoading}
                  className="w-full py-2.5 rounded-xl font-bold text-xs bg-gradient-to-r from-emerald-400 to-[#00f2fe] text-[#030a16] hover:opacity-90 active:scale-98 transition cursor-pointer shadow-md disabled:opacity-50 flex items-center justify-center gap-1.5"
                >
                  <UserPlus className="w-3.5 h-3.5" />
                  <span>{regLoading ? 'Creating account...' : 'Create Operator Account'}</span>
                </button>
              </form>

              <div className="pt-4 mt-4 border-t border-slate-700/30 text-center">
                <p className={`text-xs ${themeTextMuted}`}>
                  Already have an account?{' '}
                  <button
                    type="button"
                    onClick={() => { setLoginError(''); setAuthScreen('login'); }}
                    className="font-bold text-[#00f2fe] hover:underline cursor-pointer"
                  >
                    Sign In
                  </button>
                </p>
              </div>
              </>
              )}

              {/* Fast Offline Jump */}
              <div className="pt-4 border-t border-slate-700/30 mt-4 text-center space-y-2">
                <button
                  type="button"
                  onClick={() => handleEnterOfflineMode(offlineStationName, offlineOperatorName)}
                  className="w-full py-2 rounded-xl text-xs font-bold bg-amber-400 hover:bg-amber-500 text-slate-950 transition cursor-pointer flex items-center justify-center gap-1.5"
                >
                  <Zap className="w-3.5 h-3.5 fill-slate-950" />
                  <span>⚡ Launch in Offline Mode (No Login)</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setGuestReadOnly(true);
                    setHasExplicitlyLoggedOut(false);
                  }}
                  className={`text-xs font-semibold ${isDark ? 'text-slate-400 hover:text-white' : 'text-slate-600 hover:text-slate-900'} transition cursor-pointer inline-flex items-center gap-1.5`}
                >
                  <Eye className="w-3.5 h-3.5" />
                  <span>View Dashboard as Guest (Read-Only)</span>
                </button>
              </div>
            </div>
          </main>
        )}

        {/* Minimal Footer */}
        <footer className={`py-4 px-6 text-center text-xs text-slate-500 border-t ${isDark ? 'border-[#163252]' : 'border-slate-200'}`}>
          🌱 AQUAPLANT • ESP32 Automated Hydroponics Monitoring & Control
        </footer>
      </div>
    );
  }

  return (
    <div className={`min-h-screen ${isDark ? 'bg-[#030a16] text-[#f0f6fc]' : 'bg-[#f4f7fb] text-slate-800'} flex font-sans transition-colors duration-200 selection:bg-[#00f2fe] selection:text-[#030a16]`}>
      {/* Mobile Drawer Backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-slate-950/70 backdrop-blur-sm lg:hidden transition-opacity"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* =========================================================================
          MENU SIDEBAR (Fixed/Sticky on Desktop, Slide-over on Mobile)
         ========================================================================= */}
      <aside
        className={`fixed lg:sticky top-0 h-screen z-50 flex flex-col justify-between border-r transition-all duration-200 shrink-0 ${
          isDark ? 'bg-[#061222] border-[#163252]' : 'bg-white border-slate-200 shadow-sm'
        } ${
          sidebarOpen ? 'translate-x-0 w-64' : '-translate-x-full lg:translate-x-0'
        } ${
          sidebarCollapsed ? 'lg:w-[72px]' : 'lg:w-64'
        }`}
      >
        {/* Top: Station Brand Lockup */}
        <div className={`p-4 border-b flex items-center justify-between ${isDark ? 'border-[#163252]' : 'border-slate-200'}`}>
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-lg text-emerald-400 font-bold shadow-sm shrink-0">
              🌱
            </div>
            {!sidebarCollapsed && (
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className={`font-black text-sm tracking-wide truncate ${isDark ? 'text-white' : 'text-slate-900'}`}>
                    AQUAPLANT
                  </span>
                  <span className="text-[10px] font-mono px-1 py-0.2 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 font-semibold">
                    v2.4
                  </span>
                </div>
                <div className={`text-[10px] truncate ${themeTextDim}`}>
                  Station Control Unit
                </div>
              </div>
            )}
          </div>

          {/* Desktop Collapse / Mobile Close Button */}
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              className="p-1 rounded text-slate-400 hover:text-white lg:hidden cursor-pointer"
              title="Close menu"
            >
              <X className="w-5 h-5" />
            </button>
            <button
              type="button"
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              className={`p-1.5 rounded-md hover:bg-slate-800/40 text-slate-400 hover:text-white hidden lg:flex cursor-pointer transition ${isDark ? 'hover:bg-[#0d223a]' : 'hover:bg-slate-100'}`}
              title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {sidebarCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Middle: Scrollable Navigation Menu Groups */}
        <div className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
          {/* Group 1: Monitoring & Real-time Telemetry */}
          <div>
            {!sidebarCollapsed && (
              <div className={`text-[10px] font-mono font-bold uppercase tracking-wider px-3 mb-2 ${themeTextDim}`}>
                AQUAPLANT Monitoring
              </div>
            )}
            <nav className="space-y-1">
              <button
                type="button"
                onClick={() => scrollToSection('overview')}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-semibold transition cursor-pointer ${
                  activeSection === 'overview'
                    ? (isDark ? 'bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 font-bold' : 'bg-cyan-50 text-cyan-900 border border-cyan-200 font-bold')
                    : (isDark ? 'text-slate-300 hover:bg-[#0d223a] hover:text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900')
                }`}
                title="AQUAPLANT Station Overview"
              >
                <LayoutDashboard className="w-4 h-4 shrink-0" />
                {!sidebarCollapsed && <span className="truncate">Station Overview</span>}
              </button>

              <button
                type="button"
                onClick={() => scrollToSection('telemetry')}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-semibold transition cursor-pointer ${
                  activeSection === 'telemetry'
                    ? (isDark ? 'bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 font-bold' : 'bg-cyan-50 text-cyan-900 border border-cyan-200 font-bold')
                    : (isDark ? 'text-slate-300 hover:bg-[#0d223a] hover:text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900')
                }`}
                title="AQUAPLANT Continuous Telemetry"
              >
                <Activity className="w-4 h-4 shrink-0 text-[#00f2fe]" />
                {!sidebarCollapsed && <span className="truncate">AQUAPLANT Telemetry</span>}
              </button>

              <button
                type="button"
                onClick={() => scrollToSection('actuators')}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-semibold transition cursor-pointer ${
                  activeSection === 'actuators'
                    ? (isDark ? 'bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 font-bold' : 'bg-cyan-50 text-cyan-900 border border-cyan-200 font-bold')
                    : (isDark ? 'text-slate-300 hover:bg-[#0d223a] hover:text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900')
                }`}
                title="Submersible Pump Array"
              >
                <Sliders className="w-4 h-4 shrink-0 text-emerald-400" />
                {!sidebarCollapsed && <span className="truncate">Pump Actuators</span>}
              </button>

              <button
                type="button"
                onClick={() => scrollToSection('audit-logs')}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-semibold transition cursor-pointer ${
                  activeSection === 'audit-logs'
                    ? (isDark ? 'bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 font-bold' : 'bg-cyan-50 text-cyan-900 border border-cyan-200 font-bold')
                    : (isDark ? 'text-slate-300 hover:bg-[#0d223a] hover:text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900')
                }`}
                title="Operational Audit Logs"
              >
                <FileText className="w-4 h-4 shrink-0 text-amber-400" />
                {!sidebarCollapsed && <span className="truncate">System Audit Logs</span>}
              </button>
            </nav>
          </div>

          {/* Group 2: Automation & Cellular Alerts */}
          <div>
            {!sidebarCollapsed && (
              <div className={`text-[10px] font-mono font-bold uppercase tracking-wider px-3 mb-2 ${themeTextDim}`}>
                Alerts & Controls
              </div>
            )}
            <nav className="space-y-1">
              <button
                type="button"
                onClick={() => {
                  setShowSmsModal(true);
                  if (smsSettings?.semaphore_api_key) fetchSemaphoreBalance(smsSettings.semaphore_api_key);
                  setSidebarOpen(false);
                }}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-semibold transition cursor-pointer ${
                  isDark ? 'text-slate-300 hover:bg-[#0d223a] hover:text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
                title="SMS Carrier Alert Gateway"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Smartphone className="w-4 h-4 shrink-0 text-emerald-400" />
                  {!sidebarCollapsed && <span className="truncate">SMS Alert Gateway</span>}
                </div>
                {!sidebarCollapsed && (
                  <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                    smsSettings?.is_enabled
                      ? 'bg-emerald-500/20 text-emerald-400 font-bold'
                      : 'bg-slate-800 text-slate-400'
                  }`}>
                    {smsSettings?.is_enabled ? 'ARMED' : 'OFF'}
                  </span>
                )}
              </button>

              <button
                type="button"
                onClick={() => toggleActuator('auto_mode', controls.auto_mode ? 0 : 1)}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-semibold transition cursor-pointer ${
                  isDark ? 'text-slate-300 hover:bg-[#0d223a] hover:text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
                title="Toggle Autonomous Closed-Loop Feedback"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Power className="w-4 h-4 shrink-0 text-cyan-400" />
                  {!sidebarCollapsed && <span className="truncate">Closed-Loop Auto</span>}
                </div>
                {!sidebarCollapsed && (
                  <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded font-bold ${
                    controls.auto_mode
                      ? 'bg-cyan-500/20 text-cyan-300'
                      : 'bg-rose-500/20 text-rose-300'
                  }`}>
                    {controls.auto_mode ? 'ACTIVE' : 'MANUAL'}
                  </span>
                )}
              </button>

              <button
                type="button"
                onClick={triggerManualFlush}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-semibold text-rose-400 hover:bg-rose-500/10 hover:text-rose-300 transition cursor-pointer"
                title="Trigger Emergency 3-Pump Flush Sequence"
              >
                <ShieldAlert className="w-4 h-4 shrink-0" />
                {!sidebarCollapsed && <span className="truncate">Emergency Flush</span>}
              </button>
            </nav>
          </div>

          {/* Group 3: Diagnostics & Station Tools */}
          <div>
            {!sidebarCollapsed && (
              <div className={`text-[10px] font-mono font-bold uppercase tracking-wider px-3 mb-2 ${themeTextDim}`}>
                Station Tools
              </div>
            )}
            <nav className="space-y-1">
              <button
                type="button"
                onClick={() => {
                  setShowConnectModal(true);
                  fetchEsp32Config();
                  setSidebarOpen(false);
                }}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-semibold transition cursor-pointer ${
                  isDark ? 'text-slate-300 hover:bg-[#0d223a] hover:text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
                title="Connect & Provision ESP32 Microcontroller"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Cpu className="w-4 h-4 shrink-0 text-[#00f2fe]" />
                  {!sidebarCollapsed && <span className="truncate">Connect to ESP32</span>}
                </div>
                {!sidebarCollapsed && (
                  <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded font-bold ${
                    esp32Status.is_online ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'
                  }`}>
                    {esp32Status.is_online ? 'LINKED' : 'PAIR'}
                  </span>
                )}
              </button>

              <button
                type="button"
                onClick={() => {
                  setConnectTab('wifi');
                  setShowConnectModal(true);
                  fetchEsp32Config();
                  setSidebarOpen(false);
                }}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-semibold transition cursor-pointer ${
                  isDark ? 'text-slate-300 hover:bg-[#0d223a] hover:text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
                title="Configure ESP32 Wi-Fi & Hotspot Failover"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Wifi className="w-4 h-4 shrink-0 text-amber-400" />
                  {!sidebarCollapsed && <span className="truncate">Wi-Fi & Failover Setup</span>}
                </div>
                {!sidebarCollapsed && (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded font-bold bg-amber-500/20 text-amber-400">
                    SSID
                  </span>
                )}
              </button>

              <button
                type="button"
                onClick={() => {
                  setShowSimulator(true);
                  setSidebarOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-semibold transition cursor-pointer ${
                  isDark ? 'text-slate-300 hover:bg-[#0d223a] hover:text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
                title="Station Diagnostics & Sensor Calibration"
              >
                <SlidersHorizontal className="w-4 h-4 shrink-0 text-[#00f2fe]" />
                {!sidebarCollapsed && <span className="truncate">Diagnostics & Calibration</span>}
              </button>

              <button
                type="button"
                onClick={() => {
                  setShowFirmwareModal(true);
                  setSidebarOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-semibold transition cursor-pointer ${
                  isDark ? 'text-slate-300 hover:bg-[#0d223a] hover:text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
                title="View ESP32 Microcontroller Firmware"
              >
                <Code2 className="w-4 h-4 shrink-0 text-purple-400" />
                {!sidebarCollapsed && <span className="truncate">ESP32 Firmware (.ino)</span>}
              </button>

              <button
                type="button"
                onClick={handleExportExcel}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-semibold transition cursor-pointer ${
                  isDark ? 'text-slate-300 hover:bg-[#0d223a] hover:text-white' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
                title="Export Historical Telemetry to Excel (.xlsx)"
              >
                <FileSpreadsheet className="w-4 h-4 shrink-0 text-emerald-400" />
                {!sidebarCollapsed && <span className="truncate">Export to Excel (.xlsx)</span>}
              </button>
            </nav>
          </div>
        </div>

        {/* Bottom: Hardware Status & Operator Profile */}
        <div className={`p-3 border-t space-y-3 ${isDark ? 'border-[#163252] bg-[#040e1b]' : 'border-slate-200 bg-slate-50'}`}>
          {/* Hardware Heartbeat */}
          <button
            type="button"
            onClick={() => {
              setShowConnectModal(true);
              fetchEsp32Config();
              setSidebarOpen(false);
            }}
            className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-mono font-medium transition cursor-pointer ${
              esp32Status.is_online
                ? (isDark ? 'bg-emerald-950/30 text-emerald-400 hover:bg-emerald-950/50' : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100')
                : (isDark ? 'bg-rose-950/30 text-rose-400 hover:bg-rose-950/50' : 'bg-rose-50 text-rose-700 hover:bg-rose-100')
            }`}
            title="Click to Open ESP32 Connection Center"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className={`w-2 h-2 rounded-full shrink-0 ${esp32Status.is_online ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}`} />
              {!sidebarCollapsed && (
                <span className="truncate">{esp32Status.is_online ? 'ESP32 Linked' : esp32Status.last_seen_ago}</span>
              )}
            </div>
            {!sidebarCollapsed && (
              <span className="text-[10px] uppercase font-bold tracking-wider opacity-70">Link</span>
            )}
          </button>

          {/* Theme & Operator Controls */}
          <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-700/30">
            {token && user ? (
              <div className="flex items-center justify-between w-full">
                {!sidebarCollapsed && (
                  <div className="min-w-0 pr-2">
                    <div className={`text-xs font-bold truncate ${isDark ? 'text-white' : 'text-slate-900'}`}>{user.username}</div>
                    <div className="text-[10px] text-slate-400 font-mono uppercase flex items-center gap-1">
                      {isOfflineMode ? (
                        <span className="text-amber-400 font-bold flex items-center gap-1">
                          <WifiOff className="w-2.5 h-2.5" /> OFFLINE FIELD
                        </span>
                      ) : (
                        <span>{user.role || 'OPERATOR'}</span>
                      )}
                    </div>
                  </div>
                )}
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={toggleTheme}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-white cursor-pointer"
                    title={isDark ? "Switch to Light Mode" : "Switch to Dark Mode"}
                  >
                    {isDark ? <Sun className="w-3.5 h-3.5 text-amber-400" /> : <Moon className="w-3.5 h-3.5 text-slate-600" />}
                  </button>
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="p-1.5 rounded-lg text-rose-400 hover:bg-rose-500/20 cursor-pointer"
                    title="Log Out"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowLoginModal(true)}
                className="w-full py-2 px-3 rounded-lg bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#030a16] font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer shadow-sm"
              >
                <LogIn className="w-3.5 h-3.5" />
                {!sidebarCollapsed && <span>Operator Sign In</span>}
              </button>
            )}
          </div>
        </div>
      </aside>

      {/* =========================================================================
          RIGHT CONTENT COLUMN (Header + Main Dashboard + Footer)
         ========================================================================= */}
      <div className="flex-1 flex flex-col min-w-0 min-h-screen overflow-x-hidden">
        {/* Slim Top Navigation Bar */}
        <header className={`border-b ${isDark ? 'border-[#163252] bg-[#061222]/90' : 'border-slate-200 bg-white/95 shadow-sm'} px-4 sm:px-6 py-3 sticky top-0 z-30 backdrop-blur-md flex items-center justify-between gap-4 transition-colors`}>
          <div className="flex items-center gap-3">
            {/* Hamburger Button for Mobile */}
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              className="p-2 rounded-lg text-slate-400 hover:text-white lg:hidden cursor-pointer"
              title="Open Navigation Menu"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div>
              <div className="text-[11px] font-mono text-emerald-400 uppercase tracking-wider font-semibold flex items-center gap-1.5">
                <span className="text-[#00f2fe] font-black tracking-wider">AQUAPLANT</span>
                <span className="text-slate-500">•</span>
                <span>Closed-Loop Station</span>
              </div>
              <div className={`text-sm font-bold ${isDark ? 'text-white' : 'text-slate-900'} capitalize`}>
                {activeSection === 'telemetry'
                  ? 'AQUAPLANT Telemetry'
                  : activeSection === 'overview'
                  ? 'AQUAPLANT Overview'
                  : activeSection.replace('-', ' ')}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            {/* System Clock */}
            <div className={`font-mono text-xs px-2.5 py-1 rounded border hidden sm:block ${isDark ? 'bg-[#030a16] border-[#163252] text-[#00f2fe]' : 'bg-slate-100 border-slate-300 text-slate-700'}`}>
              {clockString || '--:--:--'}
            </div>

            {/* Offline Mode Indicator Badge & Switcher */}
            {isOfflineMode ? (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border bg-amber-500/15 border-amber-500/40 text-amber-300 text-xs font-mono font-bold animate-pulse">
                <WifiOff className="w-3.5 h-3.5" />
                <span className="hidden md:inline">OFFLINE FIELD MODE</span>
                <span className="md:hidden">OFFLINE</span>
                <button
                  type="button"
                  onClick={handleSwitchToOnlineMode}
                  className="ml-1 text-[10px] px-2 py-0.5 rounded bg-amber-400 text-black font-sans font-extrabold hover:bg-amber-300 transition cursor-pointer"
                  title="Reconnect to Cloud Server"
                >
                  Go Online
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => handleEnterOfflineMode()}
                className={`hidden xl:flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-lg border font-mono transition cursor-pointer ${
                  isDark ? 'border-[#163252] bg-[#030a16] text-slate-400 hover:text-amber-300 hover:border-amber-500/40' : 'border-slate-300 bg-slate-100 text-slate-600 hover:text-amber-700'
                }`}
                title="Switch Station to Offline Field Mode (No Internet Required)"
              >
                <WifiOff className="w-3 h-3 text-amber-400" />
                <span>Offline Mode</span>
              </button>
            )}

            {/* Quick Emergency Flush Button */}
            <button
              type="button"
              onClick={triggerManualFlush}
              className="hidden sm:flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg bg-gradient-to-r from-[#eb3b5a] to-[#fa8231] text-white shadow hover:opacity-90 active:scale-95 transition cursor-pointer"
              title="Initiate Emergency 3-Pump Flush Sequence"
            >
              <ShieldAlert className="w-3.5 h-3.5" />
              <span>Emergency Flush</span>
            </button>

            {/* Quick SMS Gateway Button */}
            <button
              type="button"
              onClick={() => {
                setShowSmsModal(true);
                if (smsSettings?.semaphore_api_key) fetchSemaphoreBalance(smsSettings.semaphore_api_key);
              }}
              className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition cursor-pointer ${
                smsSettings?.is_enabled
                  ? (isDark ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-400' : 'bg-emerald-50 border-emerald-300 text-emerald-700')
                  : (isDark ? 'bg-slate-900 border-slate-700 text-slate-400' : 'bg-slate-100 border-slate-300 text-slate-700')
              }`}
            >
              <Smartphone className="w-3.5 h-3.5" />
              <span className="hidden md:inline">SMS Gateway</span>
              <span className={`w-2 h-2 rounded-full ${smsSettings?.is_enabled ? 'bg-emerald-400 animate-pulse' : 'bg-slate-500'}`} />
            </button>

            {/* Connect to ESP32 Button */}
            <button
              type="button"
              onClick={() => {
                setShowConnectModal(true);
                fetchEsp32Config();
              }}
              className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition cursor-pointer ${
                esp32Status.is_online
                  ? (isDark ? 'bg-[#00f2fe]/10 border-[#00f2fe]/40 text-[#00f2fe]' : 'bg-cyan-50 border-cyan-300 text-cyan-800')
                  : (isDark ? 'bg-slate-900 border-slate-700 text-slate-300 hover:text-white hover:border-[#00f2fe]/30' : 'bg-slate-100 border-slate-300 text-slate-700 hover:text-slate-900')
              }`}
              title="Connect & Pair ESP32 Microcontroller"
            >
              <Cpu className="w-3.5 h-3.5 text-[#00f2fe]" />
              <span className="hidden sm:inline">Connect to ESP32</span>
              <span className="sm:hidden">ESP32</span>
              <span className={`w-2 h-2 rounded-full ${esp32Status.is_online ? 'bg-emerald-400 animate-pulse' : 'bg-rose-500'}`} />
            </button>

            {/* Operator Session & Log Out in Top Navigation Header */}
            {token && user ? (
              <div className="flex items-center gap-1.5 pl-2 border-l border-slate-700/40">
                <div className="hidden xl:block text-right">
                  <div className={`text-xs font-bold leading-tight ${isDark ? 'text-white' : 'text-slate-900'} truncate max-w-[120px]`}>
                    {user.username}
                  </div>
                  <div className="text-[10px] text-slate-400 font-mono">
                    {isOfflineMode ? 'OFFLINE' : (user.role || 'OPERATOR')}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="flex items-center gap-1.5 text-xs font-bold px-2.5 py-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 active:scale-95 transition cursor-pointer"
                  title="Log Out and return to Login Dashboard"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Log Out</span>
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setGuestReadOnly(false);
                  setHasExplicitlyLoggedOut(true);
                }}
                className="flex items-center gap-1.5 text-xs font-bold px-2.5 py-1.5 rounded-lg bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#030a16] hover:opacity-90 active:scale-95 transition cursor-pointer shadow-sm"
                title="Return to Login Dashboard"
              >
                <LogIn className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Sign In Portal</span>
              </button>
            )}
          </div>
        </header>

        {/* Main Full-Width Desktop Web Workspace */}
        <main className="max-w-[1560px] w-full mx-auto p-4 sm:p-6 flex-1 flex flex-col gap-6">
        {/* Top Status Banner: System Health, Closed-Loop Mode, Reservoir Gauge */}
        <section id="overview" className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {/* 1. Overall System Status */}
          <div className={`${themeCardBg} rounded-2xl p-5 shadow-lg relative overflow-hidden transition-colors duration-200`}>
            <div className={`flex items-center justify-between text-xs font-bold uppercase tracking-wider ${themeTextMuted} mb-3`}>
              <span>AQUAPLANT System Status</span>
              <span className={isDark ? 'text-[#00f2fe]' : 'text-cyan-700 font-bold'}>FEEDBACK MONITOR ACTIVE</span>
            </div>
            <div className="flex items-center gap-4">
              <div
                className={`w-14 h-14 rounded-xl flex items-center justify-center text-2xl font-bold border ${
                  isAnomaly
                    ? 'bg-[#ff5252]/15 border-[#ff5252]/40 text-[#ff5252]'
                    : 'bg-[#00e676]/15 border-[#00e676]/40 text-[#00e676]'
                }`}
              >
                {isAnomaly ? <AlertTriangle className="w-7 h-7" /> : <CheckCircle2 className="w-7 h-7" />}
              </div>
              <div>
                <div
                  className={`text-2xl font-extrabold ${isAnomaly ? 'text-[#ff5252]' : themeTextMain}`}
                >
                  {isAnomaly ? 'FEEDBACK ALERT' : 'OPERATIONAL NORMAL'}
                </div>
                <div className={`text-xs ${themeTextMuted}`}>
                  {isAnomaly
                    ? 'Nutrient parameter breached setpoint; auto-flush triggered'
                    : 'All chemical setpoints stabilized within biological bands'}
                </div>
              </div>
            </div>
          </div>

          {/* 2. Operational Mode Card */}
          <div className={`${themeCardBg} rounded-2xl p-5 shadow-lg flex flex-col justify-between transition-colors duration-200`}>
            <div className={`flex items-center justify-between text-xs font-bold uppercase tracking-wider ${themeTextMuted}`}>
              <span>Control Mode</span>
              <span className={isDark ? 'text-[#00f2fe]' : 'text-cyan-700 font-bold'}>AUTONOMOUS STATE MACHINE</span>
            </div>
            <div className="flex items-center justify-between mt-2">
              <div>
                <div className={`text-2xl font-extrabold ${isDark ? 'text-[#00f2fe]' : 'text-cyan-800'}`}>
                  {controls.auto_mode ? 'AUTO (CLOSED LOOP)' : 'MANUAL OVERRIDE'}
                </div>
                <div className={`text-xs ${themeTextMuted}`}>
                  {controls.auto_mode
                    ? 'TDS/pH feedback commands relay actuation automatically'
                    : 'Operator has taken manual command of relays'}
                </div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(controls.auto_mode)}
                  onChange={(e) => toggleActuator('auto_mode', e.target.checked ? 1 : 0)}
                  className="sr-only peer"
                />
                <div className={`w-14 h-7 ${isDark ? 'bg-[#0b1a2f] border-[#163252]' : 'bg-slate-200 border-slate-300'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-7 peer-checked:after:border-white after:content-[''] after:absolute after:top-[3px] after:left-[4px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#008ba3] peer-checked:border-[#00f2fe]`} />
              </label>
            </div>
          </div>

          {/* 3. Reservoir Water Capacity Bar */}
          <div className={`${themeCardBg} rounded-2xl p-5 shadow-lg flex flex-col justify-between transition-colors duration-200`}>
            <div className={`flex items-center justify-between text-xs font-bold uppercase tracking-wider ${themeTextMuted}`}>
              <span>Reservoir Liquid Capacity</span>
              <span className={isDark ? 'text-[#00e676]' : 'text-emerald-700 font-bold'}>TARGET ≥ 70%</span>
            </div>
            <div className="mt-2">
              <div className="flex justify-between items-baseline mb-1">
                <span className={`text-xs ${themeTextMuted}`}>Current Depth Level</span>
                <span className={`font-mono text-xl font-bold ${isDark ? 'text-[#00f2fe]' : 'text-cyan-800'}`}>
                  {latestReading ? latestReading.water_level.toFixed(1) : '85.0'}%
                </span>
              </div>
              <div className={`w-full h-4 ${isDark ? 'bg-[#030d1a] border-[#163252]' : 'bg-slate-100 border-slate-200'} border rounded-full overflow-hidden p-0.5`}>
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    (latestReading?.water_level || 85) < 70
                      ? 'bg-gradient-to-r from-[#ff5252] to-[#ffa502]'
                      : 'bg-gradient-to-r from-[#00c9a7] via-[#00f2fe] to-[#4facfe]'
                  }`}
                  style={{ width: `${Math.min(100, Math.max(0, latestReading?.water_level || 85))}%` }}
                />
              </div>
              <div className={`flex justify-between text-[10px] ${themeTextDim} mt-1`}>
                <span>0% Empty</span>
                <span>Drain Low-Water (30%)</span>
                <span>100% Full</span>
              </div>
            </div>
          </div>
        </section>

        {/* AQUAPLANT Real-Time Sensor Telemetry Cards Grid */}
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className={`text-xs font-mono uppercase font-bold tracking-wider ${themeTextMuted} flex items-center gap-2`}>
              <Activity className="w-4 h-4 text-[#00f2fe]" />
              AQUAPLANT Sensor Telemetry
            </h2>
            <span className={`text-[11px] font-mono ${themeTextDim}`}>5 Continuous Analog Probes</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
          {/* TDS Card */}
          <div
            className={`${themeCardBg} rounded-2xl p-5 shadow-lg transition-all relative overflow-hidden ${
              (latestReading?.tds || 750) < 600 || (latestReading?.tds || 750) > 900
                ? (isDark ? 'border-[#ff5252] shadow-[0_0_20px_rgba(255,82,82,0.15)]' : 'border-rose-400 ring-2 ring-rose-200 bg-rose-50/20')
                : (isDark ? 'hover:border-[#285788]' : 'hover:border-slate-300')
            }`}
          >
            <div className="flex justify-between items-center mb-3">
              <span className={`text-xs font-bold ${themeTextMuted} flex items-center gap-1.5`}>
                <Zap className="w-4 h-4 text-[#00f2fe]" /> Total Dissolved Solids
              </span>
              <span
                className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded ${
                  (latestReading?.tds || 750) < 600
                    ? (isDark ? 'bg-[#ff5252]/20 text-[#ff5252] border border-[#ff5252]/40' : 'bg-rose-100 text-rose-700 border border-rose-300')
                    : (latestReading?.tds || 750) > 900
                    ? (isDark ? 'bg-[#ff5252]/20 text-[#ff5252] border border-[#ff5252]/40' : 'bg-rose-100 text-rose-700 border border-rose-300')
                    : (isDark ? 'bg-[#00e676]/15 text-[#00e676] border border-[#00e676]/40' : 'bg-emerald-100 text-emerald-800 border border-emerald-300')
                }`}
              >
                {(latestReading?.tds || 750) < 600
                  ? 'Low Nutrient'
                  : (latestReading?.tds || 750) > 900
                  ? 'Salt Buildup'
                  : 'Optimal'}
              </span>
            </div>
            <div className="flex items-baseline gap-2 mb-2">
              <span className={`font-mono text-4xl font-extrabold ${themeTextMain} tracking-tight`}>
                {latestReading ? latestReading.tds.toFixed(1) : '750.0'}
              </span>
              <span className={`text-sm font-semibold ${themeTextMuted}`}>ppm</span>
            </div>
            <div className={`pt-2 border-t ${isDark ? 'border-[#163252]/80 text-[#55708e]' : 'border-slate-200 text-slate-500'} flex justify-between text-xs`}>
              <span>Set Target:</span>
              <span className={`font-semibold ${isDark ? 'text-[#00f2fe]' : 'text-cyan-700'}`}>600 – 900 ppm</span>
            </div>
          </div>

          {/* pH Card */}
          <div
            className={`${themeCardBg} rounded-2xl p-5 shadow-lg transition-all relative overflow-hidden ${
              (latestReading?.ph || 6.1) < 5.5 || (latestReading?.ph || 6.1) > 6.5
                ? (isDark ? 'border-[#ff5252] shadow-[0_0_20px_rgba(255,82,82,0.15)]' : 'border-rose-400 ring-2 ring-rose-200 bg-rose-50/20')
                : (isDark ? 'hover:border-[#285788]' : 'hover:border-slate-300')
            }`}
          >
            <div className="flex justify-between items-center mb-3">
              <span className={`text-xs font-bold ${themeTextMuted} flex items-center gap-1.5`}>
                <Activity className="w-4 h-4 text-[#e056fd]" /> Nutrient Acidity / pH
              </span>
              <span
                className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded ${
                  (latestReading?.ph || 6.1) < 5.5
                    ? (isDark ? 'bg-[#ff5252]/20 text-[#ff5252] border border-[#ff5252]/40' : 'bg-rose-100 text-rose-700 border border-rose-300')
                    : (latestReading?.ph || 6.1) > 6.5
                    ? (isDark ? 'bg-[#ff5252]/20 text-[#ff5252] border border-[#ff5252]/40' : 'bg-rose-100 text-rose-700 border border-rose-300')
                    : (isDark ? 'bg-[#00e676]/15 text-[#00e676] border border-[#00e676]/40' : 'bg-emerald-100 text-emerald-800 border border-emerald-300')
                }`}
              >
                {(latestReading?.ph || 6.1) < 5.5
                  ? 'Acidic'
                  : (latestReading?.ph || 6.1) > 6.5
                  ? 'Alkaline'
                  : 'Optimal'}
              </span>
            </div>
            <div className="flex items-baseline gap-2 mb-2">
              <span className={`font-mono text-4xl font-extrabold ${themeTextMain} tracking-tight`}>
                {latestReading ? latestReading.ph.toFixed(2) : '6.08'}
              </span>
              <span className={`text-sm font-semibold ${themeTextMuted}`}>pH</span>
            </div>
            <div className={`pt-2 border-t ${isDark ? 'border-[#163252]/80 text-[#55708e]' : 'border-slate-200 text-slate-500'} flex justify-between text-xs`}>
              <span>Set Target:</span>
              <span className={`font-semibold ${isDark ? 'text-[#e056fd]' : 'text-purple-700'}`}>5.50 – 6.50 pH</span>
            </div>
          </div>

          {/* Temperature Card */}
          <div className={`${themeCardBg} rounded-2xl p-5 shadow-lg transition-all relative overflow-hidden ${isDark ? 'hover:border-[#285788]' : 'hover:border-slate-300'}`}>
            <div className="flex justify-between items-center mb-3">
              <span className={`text-xs font-bold ${themeTextMuted} flex items-center gap-1.5`}>
                <Thermometer className="w-4 h-4 text-[#f0932b]" /> Water Temperature
              </span>
              <span className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded ${isDark ? 'bg-[#00e676]/15 text-[#00e676] border border-[#00e676]/40' : 'bg-emerald-100 text-emerald-800 border border-emerald-300'}`}>
                Optimal
              </span>
            </div>
            <div className="flex items-baseline gap-2 mb-2">
              <span className={`font-mono text-4xl font-extrabold ${themeTextMain} tracking-tight`}>
                {latestReading ? latestReading.temperature.toFixed(1) : '24.2'}
              </span>
              <span className={`text-sm font-semibold ${themeTextMuted}`}>°C</span>
            </div>
            <div className={`pt-2 border-t ${isDark ? 'border-[#163252]/80 text-[#55708e]' : 'border-slate-200 text-slate-500'} flex justify-between text-xs`}>
              <span>Set Target:</span>
              <span className={`font-semibold ${isDark ? 'text-[#f0932b]' : 'text-amber-700'}`}>20.0 – 28.0 °C</span>
            </div>
          </div>

          {/* Liquid Level Card */}
          <div className={`${themeCardBg} rounded-2xl p-5 shadow-lg transition-all relative overflow-hidden ${isDark ? 'hover:border-[#285788]' : 'hover:border-slate-300'}`}>
            <div className="flex justify-between items-center mb-3">
              <span className={`text-xs font-bold ${themeTextMuted} flex items-center gap-1.5`}>
                <Droplets className="w-4 h-4 text-[#00f2fe]" /> Reservoir Liquid Level
              </span>
              <span className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded ${isDark ? 'bg-[#00e676]/15 text-[#00e676] border border-[#00e676]/40' : 'bg-emerald-100 text-emerald-800 border border-emerald-300'}`}>
                Optimal
              </span>
            </div>
            <div className="flex items-baseline gap-2 mb-2">
              <span className={`font-mono text-4xl font-extrabold ${themeTextMain} tracking-tight`}>
                {latestReading ? latestReading.water_level.toFixed(1) : '85.0'}
              </span>
              <span className={`text-sm font-semibold ${themeTextMuted}`}>%</span>
            </div>
            <div className={`pt-2 border-t ${isDark ? 'border-[#163252]/80 text-[#55708e]' : 'border-slate-200 text-slate-500'} flex justify-between text-xs`}>
              <span>Set Target:</span>
              <span className={`font-semibold ${isDark ? 'text-[#00e676]' : 'text-emerald-700'}`}>70 – 100 %</span>
            </div>
          </div>

          {/* Humidity Card */}
          <div
            className={`${themeCardBg} rounded-2xl p-5 shadow-lg transition-all relative overflow-hidden ${
              (latestReading?.humidity || 65) < 50 || (latestReading?.humidity || 65) > 70
                ? (isDark ? 'border-[#ffa502] shadow-[0_0_15px_rgba(255,165,2,0.15)]' : 'border-amber-400 ring-2 ring-amber-200 bg-amber-50/20')
                : (isDark ? 'hover:border-[#285788]' : 'hover:border-slate-300')
            }`}
          >
            <div className="flex justify-between items-center mb-3">
              <span className={`text-xs font-bold ${themeTextMuted} flex items-center gap-1.5`}>
                <Wind className="w-4 h-4 text-[#00e676]" /> Canopy Humidity
              </span>
              <span
                className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded ${
                  (latestReading?.humidity || 65) < 50
                    ? (isDark ? 'bg-[#ffa502]/20 text-[#ffa502] border border-[#ffa502]/40' : 'bg-amber-100 text-amber-800 border border-amber-300')
                    : (latestReading?.humidity || 65) > 70
                    ? (isDark ? 'bg-[#ffa502]/20 text-[#ffa502] border border-[#ffa502]/40' : 'bg-amber-100 text-amber-800 border border-amber-300')
                    : (isDark ? 'bg-[#00e676]/15 text-[#00e676] border border-[#00e676]/40' : 'bg-emerald-100 text-emerald-800 border border-emerald-300')
                }`}
              >
                {(latestReading?.humidity || 65) < 50
                  ? 'Dry Air'
                  : (latestReading?.humidity || 65) > 70
                  ? 'High Humidity'
                  : 'Optimal'}
              </span>
            </div>
            <div className="flex items-baseline gap-2 mb-2">
              <span className={`font-mono text-4xl font-extrabold ${themeTextMain} tracking-tight`}>
                {latestReading ? latestReading.humidity.toFixed(1) : '64.5'}
              </span>
              <span className={`text-sm font-semibold ${themeTextMuted}`}>% RH</span>
            </div>
            <div className={`pt-2 border-t ${isDark ? 'border-[#163252]/80 text-[#55708e]' : 'border-slate-200 text-slate-500'} flex justify-between text-xs`}>
              <span>Set Target:</span>
              <span className={`font-semibold ${isDark ? 'text-[#00e676]' : 'text-emerald-700'}`}>50.0 – 70.0 %</span>
            </div>
          </div>
          </div>
        </section>

        {/* Real-Time HTML5 Canvas Chart Section */}
        <section id="telemetry" className={`${themeCardBg} rounded-2xl p-6 shadow-xl transition-colors duration-200`}>
          <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
            <div>
              <h2 className={`text-lg font-bold ${themeTextMain} flex items-center gap-2`}>
                <Activity className="w-5 h-5 text-[#00f2fe]" />
                AQUAPLANT Continuous Telemetry Feedback (TDS / pH / Temp / Humidity)
              </h2>
              <p className={`text-xs ${themeTextMuted}`}>
                High-precision HTML5 Canvas time-series synchronized with ESP32 REST telemetry
              </p>
            </div>

            {/* Range Selector & Manual Refresh */}
            <div className="flex items-center gap-3">
              <div className={`flex ${isDark ? 'bg-[#040e1b] border-[#163252]' : 'bg-slate-100 border-slate-200'} rounded-lg p-1`}>
                {(['1h', '6h', '12h', '24h'] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setTimeRange(r)}
                    className={`px-3 py-1 text-xs font-bold rounded cursor-pointer transition ${
                      timeRange === r
                        ? 'bg-[#00f2fe] text-[#030a16] shadow-sm font-bold'
                        : isDark
                        ? 'text-[#8ca2ba] hover:text-white'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {r.toUpperCase()}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={fetchAllData}
                className={`p-1.5 ${isDark ? 'bg-[#0d223a] border-[#163252] text-[#8ca2ba] hover:text-[#00f2fe]' : 'bg-white border-slate-200 text-slate-600 hover:text-cyan-700 shadow-sm'} rounded-lg transition cursor-pointer`}
                title="Refresh time-series"
              >
                <RotateCcw className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* HTML5 Canvas Rendering */}
          <div className={`w-full h-[380px] ${isDark ? 'bg-[#020710] border-[#163252]' : 'bg-white border-slate-200 shadow-inner'} rounded-xl overflow-hidden relative cursor-crosshair`}>
            <canvas
              ref={canvasRef}
              className="w-full h-full block"
              onMouseMove={handleCanvasMouseMove}
              onMouseLeave={() => setHoverData(null)}
            />
          </div>

          {/* Chart Legend */}
          <div className={`flex flex-wrap items-center justify-center gap-6 mt-4 text-xs ${themeTextMuted}`}>
            <div className="flex items-center gap-2">
              <span className="w-3.5 h-1 rounded bg-[#00f2fe] shadow-[0_0_6px_#00f2fe]" />
              <span>TDS (ppm) [Target 600-900]</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-3.5 h-1 rounded bg-[#e056fd] shadow-[0_0_6px_#e056fd]" />
              <span>pH [Target 5.50-6.50]</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-3.5 h-1 rounded bg-[#f0932b] shadow-[0_0_6px_#f0932b]" />
              <span>Temperature (°C) [Target 20-28]</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-3.5 h-1 rounded bg-[#00e676] shadow-[0_0_6px_#00e676]" />
              <span>Humidity (% RH) [Target 50-70]</span>
            </div>
            <div className="flex items-center gap-2 opacity-70">
              <span className={`w-3.5 h-3 rounded ${isDark ? 'bg-[rgba(0,242,254,0.08)] border-[rgba(0,242,254,0.3)]' : 'bg-cyan-100 border-cyan-300'} border border-dashed`} />
              <span>Optimal Biological Safe Zone</span>
            </div>
          </div>
        </section>

        {/* System Actuators & 3 Submersible Pumps Control Section */}
        <section id="actuators" className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* 3 Submersible Pump Relays (Left 2 cols) */}
          <div className={`lg:col-span-2 ${themeCardBg} rounded-2xl p-6 shadow-xl transition-colors duration-200`}>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className={`text-base font-bold ${themeTextMain} flex items-center gap-2`}>
                  <Sliders className="w-4 h-4 text-[#00f2fe]" />
                  ESP32 3 Submersible Pumps Array (Hardware Polled Every 3s)
                </h3>
                <p className={`text-xs ${themeTextMuted}`}>
                  Optoisolated Active-LOW 5V relays commanding 3 dedicated 12V submersible pumps: Fresh Water, Solutioned Water, and Flushing
                </p>
              </div>
              <span className={`text-[11px] font-mono px-2 py-0.5 rounded border ${isDark ? 'text-[#00e676] bg-[#00e676]/10 border-[#00e676]/30' : 'text-emerald-700 bg-emerald-50 border-emerald-300'}`}>
                3s FAST POLL
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Submersible Pump 1: Pumping Fresh Water */}
              <div
                className={`p-4 rounded-xl border transition-all flex flex-col justify-between gap-4 ${
                  (controls.water_pump ?? controls.pump)
                    ? (isDark ? 'bg-[#06152a] border-[#00f2fe]/40 shadow-[0_0_15px_rgba(0,242,254,0.12)]' : 'bg-cyan-50/80 border-cyan-400 shadow-sm')
                    : (isDark ? 'bg-[#051020] border-[#163252]' : 'bg-slate-50 border-slate-200')
                }`}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className={`flex items-center gap-1.5 text-sm font-bold ${themeTextMain}`}>
                      <Droplets className="w-4 h-4 text-[#00f2fe]" />
                      Fresh Water Pump
                    </div>
                    <div className={`text-[11px] ${themeTextDim} mt-0.5`}>GPIO 25 (Submersible #1)</div>
                    <div className={`text-[10px] ${isDark ? 'text-[#00f2fe]/80' : 'text-cyan-800 font-semibold'} font-medium mt-1`}>Responsible for: Pumping Water</div>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(controls.water_pump ?? controls.pump)}
                      onChange={(e) => toggleActuator('water_pump', e.target.checked ? 1 : 0)}
                      className="sr-only peer"
                    />
                    <div className={`w-11 h-6 ${isDark ? 'bg-[#0b1a2f] border-[#163252]' : 'bg-slate-200 border-slate-300'} rounded-full peer peer-checked:after:translate-x-5 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#008ba3] peer-checked:border-[#00f2fe]`} />
                  </label>
                </div>
                <div className={`flex justify-between items-center text-xs pt-2 border-t ${isDark ? 'border-[#163252]/60' : 'border-slate-200'}`}>
                  <span className={themeTextMuted}>Hardware State:</span>
                  <span
                    className={`font-bold flex items-center gap-1 ${
                      (controls.water_pump ?? controls.pump)
                        ? (isDark ? 'text-[#00e676]' : 'text-emerald-700 font-bold')
                        : themeTextMuted
                    }`}
                  >
                    {(controls.water_pump ?? controls.pump) ? 'ACTIVE (PUMPING)' : 'STANDBY (IDLE)'}
                  </span>
                </div>
              </div>

              {/* Submersible Pump 2: Pumping Solutioned Water */}
              <div
                className={`p-4 rounded-xl border transition-all flex flex-col justify-between gap-4 ${
                  controls.solution_pump
                    ? (isDark ? 'bg-[#1a1226] border-[#e056fd]/40 shadow-[0_0_15px_rgba(224,86,253,0.12)]' : 'bg-purple-50/80 border-purple-400 shadow-sm')
                    : (isDark ? 'bg-[#051020] border-[#163252]' : 'bg-slate-50 border-slate-200')
                }`}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className={`flex items-center gap-1.5 text-sm font-bold ${themeTextMain}`}>
                      <Zap className="w-4 h-4 text-[#e056fd]" />
                      Solutioned Water Pump
                    </div>
                    <div className={`text-[11px] ${themeTextDim} mt-0.5`}>GPIO 26 (Submersible #2)</div>
                    <div className={`text-[10px] ${isDark ? 'text-[#e056fd]/80' : 'text-purple-800 font-semibold'} font-medium mt-1`}>Responsible for: Pumping Solution</div>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(controls.solution_pump)}
                      onChange={(e) => toggleActuator('solution_pump', e.target.checked ? 1 : 0)}
                      className="sr-only peer"
                    />
                    <div className={`w-11 h-6 ${isDark ? 'bg-[#0b1a2f] border-[#163252]' : 'bg-slate-200 border-slate-300'} rounded-full peer peer-checked:after:translate-x-5 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#8e44ad] peer-checked:border-[#e056fd]`} />
                  </label>
                </div>
                <div className={`flex justify-between items-center text-xs pt-2 border-t ${isDark ? 'border-[#163252]/60' : 'border-slate-200'}`}>
                  <span className={themeTextMuted}>Hardware State:</span>
                  <span
                    className={`font-bold flex items-center gap-1 ${
                      controls.solution_pump
                        ? (isDark ? 'text-[#e056fd]' : 'text-purple-700 font-bold')
                        : themeTextMuted
                    }`}
                  >
                    {controls.solution_pump ? 'ACTIVE (PUMPING)' : 'STANDBY (IDLE)'}
                  </span>
                </div>
              </div>

              {/* Submersible Pump 3: Flushing Pump */}
              <div
                className={`p-4 rounded-xl border transition-all flex flex-col justify-between gap-4 ${
                  (controls.flush_pump ?? controls.flush_valve)
                    ? (isDark ? 'bg-[#1f0e15] border-[#ff5252]/40 shadow-[0_0_15px_rgba(255,82,82,0.12)]' : 'bg-rose-50/80 border-rose-400 shadow-sm')
                    : (isDark ? 'bg-[#051020] border-[#163252]' : 'bg-slate-50 border-slate-200')
                }`}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className={`flex items-center gap-1.5 text-sm font-bold ${themeTextMain}`}>
                      <RotateCcw className="w-4 h-4 text-[#ff5252]" />
                      Flushing Pump
                    </div>
                    <div className={`text-[11px] ${themeTextDim} mt-0.5`}>GPIO 27 (Submersible #3)</div>
                    <div className={`text-[10px] ${isDark ? 'text-[#ff7675]/80' : 'text-rose-800 font-semibold'} font-medium mt-1`}>Responsible for: Flushing & Drain</div>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(controls.flush_pump ?? controls.flush_valve)}
                      onChange={(e) => toggleActuator('flush_pump', e.target.checked ? 1 : 0)}
                      className="sr-only peer"
                    />
                    <div className={`w-11 h-6 ${isDark ? 'bg-[#0b1a2f] border-[#163252]' : 'bg-slate-200 border-slate-300'} rounded-full peer peer-checked:after:translate-x-5 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#c0392b] peer-checked:border-[#ff5252]`} />
                  </label>
                </div>
                <div className={`flex justify-between items-center text-xs pt-2 border-t ${isDark ? 'border-[#163252]/60' : 'border-slate-200'}`}>
                  <span className={themeTextMuted}>Hardware State:</span>
                  <span
                    className={`font-bold flex items-center gap-1 ${
                      (controls.flush_pump ?? controls.flush_valve)
                        ? (isDark ? 'text-[#ff5252]' : 'text-rose-700 font-bold')
                        : themeTextMuted
                    }`}
                  >
                    {(controls.flush_pump ?? controls.flush_valve) ? 'ACTIVE (FLUSHING)' : 'STANDBY (IDLE)'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Emergency / Manual Flush Cycle (Right 1 col) */}
          <div className={`${isDark ? 'bg-gradient-to-br from-[#121024] to-[#1e1333] border-[#3d276b]' : 'bg-gradient-to-br from-rose-50/90 to-amber-50/70 border-rose-200 shadow-sm'} border rounded-2xl p-6 shadow-xl flex flex-col justify-between transition-colors duration-200`}>
            <div>
              <div className={`flex items-center gap-2 text-sm font-bold uppercase tracking-wider mb-2 ${isDark ? 'text-[#ff7675]' : 'text-rose-700'}`}>
                <ShieldAlert className="w-5 h-5" /> Emergency 3-Pump Flush Sequence
              </div>
              <p className={`text-xs ${isDark ? 'text-[#d1c4e9]' : 'text-slate-700'} leading-relaxed mb-4`}>
                Autonomous 3-pump coordination: engages the <strong>Flushing Submersible Pump</strong> to evacuate spent reservoir solution, then activates the <strong>Fresh Water Pump</strong> and <strong>Solutioned Water Pump</strong> to reconstitute biological target TDS & pH safe zones.
              </p>
            </div>
            <button
              type="button"
              onClick={triggerManualFlush}
              className="w-full py-3 px-4 rounded-xl font-bold text-sm bg-gradient-to-r from-[#eb3b5a] to-[#fa8231] text-white shadow-lg hover:opacity-90 active:scale-95 transition flex items-center justify-center gap-2 cursor-pointer"
            >
              <Power className="w-4 h-4" /> Trigger 3-Pump Flush Sequence
            </button>
          </div>
        </section>

        {/* System Audit Logs & Export to Excel */}
        <section id="audit-logs" className={`${themeCardBg} rounded-2xl p-6 shadow-xl transition-colors duration-200`}>
          <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
            <div>
              <h3 className={`text-base font-bold ${themeTextMain} flex items-center gap-2`}>
                📜 Operational System Audit Logs
              </h3>
              <p className={`text-xs ${themeTextMuted}`}>
                Real-time chronological events, closed-loop feedback triggers, and operator actuator actions
              </p>
            </div>

            <div className="flex items-center gap-3">
              {/* Level Filter */}
              <select
                value={logFilter}
                onChange={(e) => setLogFilter(e.target.value)}
                className={`${isDark ? 'bg-[#040e1b] border-[#163252] text-white' : 'bg-white border-slate-300 text-slate-800'} text-xs rounded-lg px-3 py-1.5 focus:border-[#00f2fe] outline-none shadow-sm cursor-pointer`}
              >
                <option value="ALL">All Event Levels</option>
                <option value="INFO">INFO Only</option>
                <option value="WARN">WARN Only</option>
                <option value="ALERT">ALERT Only</option>
                <option value="SUCCESS">SUCCESS Only</option>
              </select>

              {/* Export to Excel (.xlsx) */}
              <button
                type="button"
                onClick={handleExportExcel}
                className="flex items-center gap-1.5 text-xs font-bold px-3.5 py-1.5 rounded-lg bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#030a16] shadow-[0_2px_10px_rgba(0,242,254,0.3)] hover:opacity-95 transition cursor-pointer"
              >
                <FileSpreadsheet className="w-4 h-4" />
                <span>Export to Excel (.xlsx)</span>
              </button>
            </div>
          </div>

          <div className={`max-h-[320px] overflow-y-auto rounded-xl border ${isDark ? 'border-[#163252] bg-[#020710]' : 'border-slate-200 bg-white shadow-sm'}`}>
            <table className="w-full text-left text-xs border-collapse">
              <thead className={`sticky top-0 ${isDark ? 'bg-[#081628] border-b border-[#163252] text-[#8ca2ba]' : 'bg-slate-100 border-b border-slate-200 text-slate-700'} uppercase text-[10px] tracking-wider font-bold`}>
                <tr>
                  <th className="py-2.5 px-4 w-44">Timestamp</th>
                  <th className="py-2.5 px-4 w-24">Level</th>
                  <th className="py-2.5 px-4 w-32">Source</th>
                  <th className="py-2.5 px-4">Event Audit Message</th>
                </tr>
              </thead>
              <tbody className={`divide-y ${isDark ? 'divide-[#0c1f36]' : 'divide-slate-200'}`}>
                {logs.length === 0 ? (
                  <tr>
                    <td colSpan={4} className={`py-6 text-center ${themeTextDim}`}>
                      No events matching current filter.
                    </td>
                  </tr>
                ) : (
                  logs.map((log) => (
                    <tr key={log.id} className={isDark ? 'hover:bg-[#00f2fe]/[0.02]' : 'hover:bg-slate-50'}>
                      <td className={`py-2.5 px-4 font-mono ${themeTextMuted}`}>
                        {new Date(log.created_at).toLocaleString()}
                      </td>
                      <td className="py-2.5 px-4">
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                            log.level === 'ALERT'
                              ? (isDark ? 'bg-[#ff5252]/20 text-[#ff5252]' : 'bg-rose-100 text-rose-700 border border-rose-300')
                              : log.level === 'WARN'
                              ? (isDark ? 'bg-[#ffa502]/20 text-[#ffa502]' : 'bg-amber-100 text-amber-800 border border-amber-300')
                              : log.level === 'SUCCESS'
                              ? (isDark ? 'bg-[#00e676]/20 text-[#00e676]' : 'bg-emerald-100 text-emerald-800 border border-emerald-300')
                              : (isDark ? 'bg-[#4facfe]/20 text-[#4facfe]' : 'bg-blue-100 text-blue-700 border border-blue-300')
                          }`}
                        >
                          {log.level}
                        </span>
                      </td>
                      <td className={`py-2.5 px-4 font-semibold ${isDark ? 'text-[#7ec8e3]' : 'text-cyan-800'}`}>{log.source}</td>
                      <td className={`py-2.5 px-4 ${themeTextMain}`}>{log.message}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      {/* Operational Dashboard Footer */}
      <footer className={`border-t ${isDark ? 'border-[#163252] bg-[#020710] text-[#55708e]' : 'border-slate-200 bg-white text-slate-500'} py-4 px-6 text-xs flex flex-wrap items-center justify-between gap-3 max-w-[1560px] w-full mx-auto transition-colors duration-200`}>
        <div className="flex items-center gap-2">
          🌱 <strong>AQUAPLANT Systems</strong>
          <span className={isDark ? 'text-[#163252]' : 'text-slate-300'}>|</span>
          <span>Industrial Automated Hydroponic Reservoir Closed-Loop Control System</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5 text-[#00e676]">
            <span className="w-2 h-2 rounded-full bg-[#00e676] animate-pulse" />
            System Live
          </span>
          <span className={isDark ? 'text-[#163252]' : 'text-slate-300'}>|</span>
          <span>ESP32 Hardware Linked</span>
          <span className={isDark ? 'text-[#163252]' : 'text-slate-300'}>|</span>
          <span>v2.4.0 Production</span>
        </div>
      </footer>
    </div>

      {/* MODAL 1: Telemetry & Anomaly Simulator */}
      {showSimulator && (
        <div className={`fixed inset-0 z-50 ${isDark ? 'bg-[#02060e]/85' : 'bg-slate-900/60'} backdrop-blur-sm flex items-center justify-center p-4`}>
          <div className={`${isDark ? 'bg-[#081528] border border-[#00f2fe] shadow-[0_0_40px_rgba(0,242,254,0.25)]' : 'bg-white border border-slate-200 shadow-2xl'} max-w-xl w-full p-6 rounded-2xl transition-colors`}>
            <div className={`flex justify-between items-center mb-4 pb-3 border-b ${isDark ? 'border-[#163252]' : 'border-slate-200'}`}>
              <h3 className={`text-lg font-bold ${isDark ? 'text-[#00f2fe]' : 'text-cyan-800'} flex items-center gap-2`}>
                <Sliders className="w-5 h-5 text-emerald-400" /> Station Diagnostics & Sensor Calibration
              </h3>
              <button
                type="button"
                onClick={() => setShowSimulator(false)}
                className={`${isDark ? 'text-gray-400 hover:text-white' : 'text-slate-400 hover:text-slate-800'} text-xl font-bold cursor-pointer`}
              >
                &times;
              </button>
            </div>
            <p className={`text-xs ${themeTextMuted} mb-4`}>
              Calibrate sensor zero-points, test biological threshold alarms, and verify autonomous relay response:
            </p>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
              <div>
                <label className={`text-xs font-semibold ${themeTextMuted} block mb-1`}>TDS (ppm)</label>
                <input
                  type="number"
                  value={simTds}
                  onChange={(e) => setSimTds(Number(e.target.value))}
                  className={`w-full ${isDark ? 'bg-[#040e1c] border-[#163252] text-white focus:border-[#00f2fe]' : 'bg-slate-50 border-slate-300 text-slate-900 focus:border-cyan-600 focus:bg-white'} border rounded-lg p-2 font-mono text-sm outline-none transition`}
                />
                <span className={`text-[10px] ${themeTextDim}`}>Safe target: 600 - 900</span>
              </div>
              <div>
                <label className={`text-xs font-semibold ${themeTextMuted} block mb-1`}>pH Level</label>
                <input
                  type="number"
                  step="0.05"
                  value={simPh}
                  onChange={(e) => setSimPh(Number(e.target.value))}
                  className={`w-full ${isDark ? 'bg-[#040e1c] border-[#163252] text-white focus:border-[#00f2fe]' : 'bg-slate-50 border-slate-300 text-slate-900 focus:border-cyan-600 focus:bg-white'} border rounded-lg p-2 font-mono text-sm outline-none transition`}
                />
                <span className={`text-[10px] ${themeTextDim}`}>Safe target: 5.50 - 6.50</span>
              </div>
              <div>
                <label className={`text-xs font-semibold ${themeTextMuted} block mb-1`}>Temperature (°C)</label>
                <input
                  type="number"
                  step="0.1"
                  value={simTemp}
                  onChange={(e) => setSimTemp(Number(e.target.value))}
                  className={`w-full ${isDark ? 'bg-[#040e1c] border-[#163252] text-white focus:border-[#00f2fe]' : 'bg-slate-50 border-slate-300 text-slate-900 focus:border-cyan-600 focus:bg-white'} border rounded-lg p-2 font-mono text-sm outline-none transition`}
                />
                <span className={`text-[10px] ${themeTextDim}`}>Safe target: 20 - 28 °C</span>
              </div>
              <div>
                <label className={`text-xs font-semibold ${themeTextMuted} block mb-1`}>Water Depth (%)</label>
                <input
                  type="number"
                  value={simLevel}
                  onChange={(e) => setSimLevel(Number(e.target.value))}
                  className={`w-full ${isDark ? 'bg-[#040e1c] border-[#163252] text-white focus:border-[#00f2fe]' : 'bg-slate-50 border-slate-300 text-slate-900 focus:border-cyan-600 focus:bg-white'} border rounded-lg p-2 font-mono text-sm outline-none transition`}
                />
                <span className={`text-[10px] ${themeTextDim}`}>Safe target: 70 - 100%</span>
              </div>
              <div>
                <label className={`text-xs font-semibold ${themeTextMuted} block mb-1`}>Humidity (% RH)</label>
                <input
                  type="number"
                  step="0.5"
                  value={simHumidity}
                  onChange={(e) => setSimHumidity(Number(e.target.value))}
                  className={`w-full ${isDark ? 'bg-[#040e1c] border-[#163252] text-white focus:border-[#00f2fe]' : 'bg-slate-50 border-slate-300 text-slate-900 focus:border-cyan-600 focus:bg-white'} border rounded-lg p-2 font-mono text-sm outline-none transition`}
                />
                <span className={`text-[10px] ${themeTextDim}`}>Safe target: 50 - 70%</span>
              </div>
            </div>

            {/* Operational Test Presets */}
            <div className="mb-5">
              <span className={`text-xs font-bold ${themeTextMuted} block mb-2`}>Operational Condition Presets:</span>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setSimTds(740);
                    setSimPh(6.05);
                    setSimTemp(24.2);
                    setSimLevel(88);
                    setSimHumidity(64.5);
                  }}
                  className={`px-2.5 py-1 text-xs rounded border transition cursor-pointer ${
                    isDark
                      ? 'bg-[#0d223a] border-[#163252] text-[#00e676] hover:border-[#00e676]'
                      : 'bg-emerald-50 border-emerald-300 text-emerald-800 hover:bg-emerald-100'
                  }`}
                >
                  🌿 Normal Setpoint
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSimTds(1180);
                    setSimPh(6.1);
                  }}
                  className={`px-2.5 py-1 text-xs rounded border transition cursor-pointer ${
                    isDark
                      ? 'bg-[#ff5252]/10 border-[#ff5252]/40 text-[#ff5252] hover:bg-[#ff5252]/20'
                      : 'bg-rose-50 border-rose-300 text-rose-700 hover:bg-rose-100'
                  }`}
                >
                  ⚠️ High TDS (Salt Buildup)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSimTds(420);
                  }}
                  className={`px-2.5 py-1 text-xs rounded border transition cursor-pointer ${
                    isDark
                      ? 'bg-[#ff5252]/10 border-[#ff5252]/40 text-[#ff5252] hover:bg-[#ff5252]/20'
                      : 'bg-rose-50 border-rose-300 text-rose-700 hover:bg-rose-100'
                  }`}
                >
                  ⚠️ Low TDS (Depleted)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSimPh(4.8);
                  }}
                  className={`px-2.5 py-1 text-xs rounded border transition cursor-pointer ${
                    isDark
                      ? 'bg-[#ff5252]/10 border-[#ff5252]/40 text-[#ff5252] hover:bg-[#ff5252]/20'
                      : 'bg-purple-50 border-purple-300 text-purple-700 hover:bg-purple-100'
                  }`}
                >
                  🧪 Acidic Lockout (&lt;5.5)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSimHumidity(36.0);
                  }}
                  className={`px-2.5 py-1 text-xs rounded border transition cursor-pointer ${
                    isDark
                      ? 'bg-[#ffa502]/10 border-[#ffa502]/40 text-[#ffa502] hover:bg-[#ffa502]/20'
                      : 'bg-amber-50 border-amber-300 text-amber-800 hover:bg-amber-100'
                  }`}
                >
                  💨 Low Humidity (&lt;50% Dry)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSimHumidity(88.0);
                  }}
                  className={`px-2.5 py-1 text-xs rounded border transition cursor-pointer ${
                    isDark
                      ? 'bg-[#ffa502]/10 border-[#ffa502]/40 text-[#ffa502] hover:bg-[#ffa502]/20'
                      : 'bg-amber-50 border-amber-300 text-amber-800 hover:bg-amber-100'
                  }`}
                >
                  🌧️ High Humidity (&gt;70% Mold Risk)
                </button>
              </div>
            </div>

            <div className={`flex justify-end gap-3 pt-3 border-t ${isDark ? 'border-[#163252]' : 'border-slate-200'}`}>
              <button
                type="button"
                onClick={() => setShowSimulator(false)}
                className={`px-4 py-2 text-xs font-semibold rounded-lg ${
                  isDark ? 'bg-[#0d223a] text-gray-300 hover:text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                } cursor-pointer transition`}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSimulateSubmit}
                className="px-4 py-2 text-xs font-bold rounded-lg bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#030a16] shadow-md hover:opacity-95 cursor-pointer transition"
              >
                Apply Diagnostic Calibration
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 2: Firmware Code Viewer */}
      {showFirmwareModal && (
        <div className={`fixed inset-0 z-50 ${isDark ? 'bg-[#02060e]/85' : 'bg-slate-900/60'} backdrop-blur-sm flex items-center justify-center p-4`}>
          <div className={`${isDark ? 'bg-[#081528] border border-[#00f2fe] shadow-[0_0_40px_rgba(0,242,254,0.25)]' : 'bg-white border border-slate-200 shadow-2xl'} max-w-4xl w-full p-6 flex flex-col max-h-[88vh] rounded-2xl transition-colors`}>
            <div className={`flex justify-between items-center mb-3 pb-3 border-b ${isDark ? 'border-[#163252]' : 'border-slate-200'}`}>
              <h3 className={`text-lg font-bold ${isDark ? 'text-[#00f2fe]' : 'text-cyan-800'} flex items-center gap-2`}>
                <Code2 className="w-5 h-5" /> ESP32 Arduino C++ Firmware (aquaplant_esp32.ino)
              </h3>
              <button
                type="button"
                onClick={() => setShowFirmwareModal(false)}
                className={`${isDark ? 'text-gray-400 hover:text-white' : 'text-slate-400 hover:text-slate-800'} text-xl font-bold cursor-pointer`}
              >
                &times;
              </button>
            </div>
            <p className={`text-xs ${themeTextMuted} mb-3`}>
              Arduino DevKit V1 compatible. Includes FreeRTOS tasks, Station + SoftAP fallback (192.168.4.1), mDNS aquaplant.local, and auto-flush feedback loop.
            </p>
            <pre className={`flex-1 overflow-auto ${isDark ? 'bg-[#020710] border-[#163252] text-[#79c0ff]' : 'bg-slate-900 border-slate-800 text-cyan-300'} border rounded-xl p-4 font-mono text-xs leading-relaxed`}>
              {firmwareCode}
            </pre>
            <div className={`flex justify-between items-center mt-4 pt-3 border-t ${isDark ? 'border-[#163252]' : 'border-slate-200'}`}>
              <a
                href="/api/download/firmware"
                download="aquaplant_esp32.ino"
                className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#030a16] font-bold text-xs rounded-lg shadow cursor-pointer hover:opacity-95 transition"
              >
                <Download className="w-4 h-4" /> Download .INO File
              </a>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(firmwareCode);
                  alert('Firmware code copied to clipboard!');
                }}
                className={`px-4 py-2 ${isDark ? 'bg-[#0d223a] border-[#163252] text-white hover:border-[#00f2fe]' : 'bg-slate-100 border-slate-300 text-slate-800 hover:bg-slate-200'} border text-xs font-semibold rounded-lg cursor-pointer transition`}
              >
                Copy to Clipboard
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 3: Operator Sign In Modal (with Offline Field Mode Option) */}
      {showLoginModal && (
        <div className={`fixed inset-0 z-50 ${isDark ? 'bg-[#02060e]/85' : 'bg-slate-900/60'} backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto`}>
          <div className={`${isDark ? 'bg-[#081528] border border-[#00f2fe]/60 shadow-[0_0_40px_rgba(0,242,254,0.3)]' : 'bg-white border border-slate-200 shadow-2xl'} max-w-lg w-full p-6 flex flex-col rounded-2xl transition-colors max-h-[92vh] overflow-y-auto`}>
            {/* Modal Header */}
            <div className={`flex justify-between items-center mb-4 pb-3 border-b ${isDark ? 'border-[#163252]' : 'border-slate-200'}`}>
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-[#00f2fe]/15 border border-[#00f2fe]/40 flex items-center justify-center text-[#00f2fe]">
                  {loginAuthTab === 'offline' ? <WifiOff className="w-4 h-4 text-amber-400" /> : <Lock className="w-4 h-4" />}
                </div>
                <div>
                  <h3 className={`text-base font-bold ${isDark ? 'text-[#00f2fe]' : 'text-cyan-800'}`}>
                    Station Operator Access
                  </h3>
                  <div className="text-[11px] text-slate-400">
                    AQUAPLANT Hydroponics Control Center
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowLoginModal(false)}
                className={`${isDark ? 'text-gray-400 hover:text-white' : 'text-slate-400 hover:text-slate-800'} text-2xl font-bold cursor-pointer`}
                title="Continue in read-only observation mode"
              >
                &times;
              </button>
            </div>

            {/* Auth Mode Tabs: Online Cloud Server vs. Offline Field Station */}
            <div className="flex items-center gap-2 mb-4 p-1 rounded-xl bg-[#030a16] border border-[#163252]">
              <button
                type="button"
                onClick={() => setLoginAuthTab('online')}
                className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs font-bold transition cursor-pointer ${
                  loginAuthTab === 'online'
                    ? 'bg-[#00f2fe] text-[#030a16] shadow-sm'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <Server className="w-3.5 h-3.5" />
                <span>Online Cloud Server</span>
              </button>

              <button
                type="button"
                onClick={() => setLoginAuthTab('offline')}
                className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs font-bold transition cursor-pointer ${
                  loginAuthTab === 'offline'
                    ? 'bg-amber-400 text-black shadow-sm'
                    : 'text-slate-400 hover:text-amber-300'
                }`}
              >
                <WifiOff className="w-3.5 h-3.5" />
                <span>⚡ Offline Field Station</span>
              </button>
            </div>

            {/* TAB 1: ONLINE CLOUD SERVER AUTHENTICATION */}
            {loginAuthTab === 'online' && (
              <div>
                <p className={`text-xs ${themeTextMuted} mb-4`}>
                  Sign in with authorized station credentials to unlock write access for actuator relays,
                  closed-loop schedules, and cloud-synced SMS notifications.
                </p>

                {loginError && (
                  <div className="mb-4 p-3 rounded-xl bg-[#ff5252]/15 border border-[#ff5252]/40 text-[#ff5252] text-xs flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                    <span>{loginError}</span>
                  </div>
                )}

                <form onSubmit={handleLoginSubmit} className="space-y-3.5">
                  <div>
                    <label className={`block text-xs font-semibold ${themeTextMuted} mb-1`}>
                      Operator Username / Email
                    </label>
                    <input
                      type="text"
                      value={loginUsername}
                      onChange={(e) => setLoginUsername(e.target.value)}
                      placeholder="admin"
                      required
                      className={`w-full ${isDark ? 'bg-[#020710] border-[#163252] text-white placeholder-gray-600 focus:border-[#00f2fe]' : 'bg-slate-50 border-slate-300 text-slate-900 placeholder-slate-400 focus:border-cyan-600 focus:bg-white'} border rounded-xl px-3.5 py-2.5 text-xs outline-none transition`}
                    />
                  </div>

                  <div>
                    <label className={`block text-xs font-semibold ${themeTextMuted} mb-1`}>
                      Password
                    </label>
                    <input
                      type="password"
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                      placeholder="••••••••"
                      required
                      className={`w-full ${isDark ? 'bg-[#020710] border-[#163252] text-white placeholder-gray-600 focus:border-[#00f2fe]' : 'bg-slate-50 border-slate-300 text-slate-900 placeholder-slate-400 focus:border-cyan-600 focus:bg-white'} border rounded-xl px-3.5 py-2.5 text-xs outline-none transition`}
                    />
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    <button
                      type="submit"
                      disabled={loginLoading}
                      className="flex-1 py-2.5 rounded-xl font-bold text-xs bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#030a16] hover:opacity-90 transition cursor-pointer shadow-md disabled:opacity-50 flex items-center justify-center gap-1.5"
                    >
                      <Lock className="w-3.5 h-3.5" />
                      <span>{loginLoading ? 'Authenticating...' : 'Sign In (Online Server)'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={handleQuickDemoLogin}
                      disabled={loginLoading}
                      className={`px-3 py-2.5 rounded-xl text-xs font-bold border transition cursor-pointer ${
                        isDark ? 'border-[#163252] bg-[#0d223a] text-[#00f2fe] hover:bg-[#163252]' : 'border-slate-300 bg-slate-100 text-cyan-800 hover:bg-slate-200'
                      }`}
                      title="1-Click Demo Login"
                    >
                      Demo (1-Click)
                    </button>
                  </div>
                </form>

                {/* Standalone Offline Option Banner */}
                <div className={`mt-4 p-3.5 rounded-xl border ${
                  isDark ? 'bg-[#030a16] border-amber-500/30' : 'bg-amber-50/80 border-amber-300'
                }`}>
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-lg bg-amber-500/15 border border-amber-500/40 flex items-center justify-center text-amber-400 shrink-0 mt-0.5">
                      <WifiOff className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-1 mb-1">
                        <span className={`text-xs font-bold ${isDark ? 'text-amber-300' : 'text-amber-900'}`}>
                          Offline Mode (Field / Standalone)
                        </span>
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 font-bold">
                          STANDALONE
                        </span>
                      </div>
                      <p className={`text-[11px] leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-600'} mb-2.5`}>
                        Working in an off-grid greenhouse, farm tunnel, or direct USB cable link? Launch station immediately without internet or cloud authentication.
                      </p>
                      <button
                        type="button"
                        onClick={() => handleEnterOfflineMode()}
                        className="w-full py-2 px-3 rounded-lg text-xs font-bold bg-amber-400 hover:bg-amber-500 text-black shadow flex items-center justify-center gap-1.5 transition cursor-pointer active:scale-95"
                      >
                        <Zap className="w-3.5 h-3.5" />
                        <span>Continue in Offline Mode</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* TAB 2: OFFLINE FIELD STATION CONFIGURATION */}
            {loginAuthTab === 'offline' && (
              <div className="space-y-4">
                <div className={`p-3.5 rounded-xl border ${isDark ? 'bg-[#030a16] border-amber-500/30' : 'bg-amber-50 border-amber-200'}`}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-base">⚡</span>
                    <span className={`text-xs font-bold ${isDark ? 'text-amber-300' : 'text-amber-900'}`}>
                      Standalone Field Station Session
                    </span>
                  </div>
                  <p className={`text-xs ${themeTextMuted} leading-relaxed`}>
                    No internet connection or backend server is required. This mode stores settings locally in browser storage and provides write authorization to all pump relays and ESP32 USB hardware links.
                  </p>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className={`block text-xs font-semibold ${themeTextMuted} mb-1`}>
                      Field Operator Call-sign / Name
                    </label>
                    <input
                      type="text"
                      value={offlineOperatorName}
                      onChange={(e) => setOfflineOperatorName(e.target.value)}
                      placeholder="e.g. Field Operator 1"
                      className={`w-full ${isDark ? 'bg-[#020710] border-[#163252] text-white focus:border-amber-400' : 'bg-slate-50 border-slate-300 text-slate-900 focus:border-amber-600 focus:bg-white'} border rounded-xl px-3.5 py-2.5 text-xs outline-none transition`}
                    />
                  </div>

                  <div>
                    <label className={`block text-xs font-semibold ${themeTextMuted} mb-1`}>
                      Greenhouse / Station Location
                    </label>
                    <input
                      type="text"
                      value={offlineStationName}
                      onChange={(e) => setOfflineStationName(e.target.value)}
                      placeholder="e.g. Greenhouse Alpha (Station #1)"
                      className={`w-full ${isDark ? 'bg-[#020710] border-[#163252] text-white focus:border-amber-400' : 'bg-slate-50 border-slate-300 text-slate-900 focus:border-amber-600 focus:bg-white'} border rounded-xl px-3.5 py-2.5 text-xs outline-none transition`}
                    />
                  </div>
                </div>

                {/* Offline Feature Verification List */}
                <div className={`p-3 rounded-xl border text-[11px] space-y-1.5 ${isDark ? 'bg-[#020710] border-[#163252] text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-700'}`}>
                  <div className="font-bold font-mono text-emerald-400 flex items-center gap-1.5">
                    <Check className="w-3.5 h-3.5" /> Direct manual pump toggles (Circulation, Water, Flush)
                  </div>
                  <div className="font-bold font-mono text-emerald-400 flex items-center gap-1.5">
                    <Check className="w-3.5 h-3.5" /> Web Serial direct USB cable control (115200 baud)
                  </div>
                  <div className="font-bold font-mono text-emerald-400 flex items-center gap-1.5">
                    <Check className="w-3.5 h-3.5" /> Offline biological simulation and local telemetry caching
                  </div>
                  <div className="font-bold font-mono text-emerald-400 flex items-center gap-1.5">
                    <Check className="w-3.5 h-3.5" /> 1-Click "Go Online" anytime connection is restored
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => handleEnterOfflineMode(offlineStationName, offlineOperatorName)}
                  className="w-full py-3 rounded-xl font-bold text-xs bg-gradient-to-r from-amber-400 to-amber-500 hover:from-amber-500 hover:to-amber-600 text-slate-950 transition cursor-pointer shadow-md flex items-center justify-center gap-2 active:scale-95"
                >
                  <Zap className="w-4 h-4 fill-slate-950" />
                  <span>Launch Station in Offline Field Mode</span>
                </button>
              </div>
            )}

            {/* Footer Navigation */}
            <div className={`mt-4 pt-3 border-t ${isDark ? 'border-[#163252]' : 'border-slate-200'} flex items-center justify-between text-[11px] ${themeTextDim}`}>
              <a
                href="/login.html"
                className={`hover:${isDark ? 'text-[#00f2fe]' : 'text-cyan-700'} transition underline underline-offset-2 flex items-center gap-1`}
              >
                <span>Standalone Operator Portal →</span>
              </a>
              <button
                type="button"
                onClick={() => setShowLoginModal(false)}
                className={`hover:${isDark ? 'text-white' : 'text-slate-900'} transition cursor-pointer`}
              >
                Continue in View-Only Mode
              </button>
            </div>
          </div>
        </div>
      )}
      {/* MODAL 4: SMS Alert Notifications Management */}
      {showSmsModal && (
        <div className={`fixed inset-0 z-50 ${isDark ? 'bg-[#02060e]/85' : 'bg-slate-900/60'} backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto`}>
          <div className={`${isDark ? 'bg-[#081528] border border-[#00e676]/50 shadow-[0_0_40px_rgba(0,230,118,0.25)]' : 'bg-white border border-slate-200 shadow-2xl'} max-w-4xl w-full p-6 flex flex-col rounded-2xl transition-colors max-h-[90vh] overflow-y-auto`}>
            {/* Header */}
            <div className={`flex justify-between items-center pb-4 border-b ${isDark ? 'border-[#163252]' : 'border-slate-200'} mb-5`}>
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-xl ${isDark ? 'bg-[#00e676]/15 border border-[#00e676]/40 text-[#00e676]' : 'bg-emerald-50 border border-emerald-300 text-emerald-700'} flex items-center justify-center`}>
                  <Smartphone className="w-5 h-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className={`text-lg font-black tracking-wide ${themeTextMain}`}>
                      Autonomous SMS Alert Gateway
                    </h2>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${smsSettings?.is_enabled ? (isDark ? 'bg-[#00e676]/20 text-[#00e676] border border-[#00e676]/40' : 'bg-emerald-100 text-emerald-800') : 'bg-slate-200 text-slate-600'}`}>
                      {smsSettings?.is_enabled ? 'SMS ENGINE ACTIVE' : 'DISPATCH PAUSED'}
                    </span>
                  </div>
                  <p className={`text-xs ${themeTextMuted}`}>
                    Dispatches instant SMS messages to operator cellphones on reservoir flushes, critical low/high pH, and TDS anomalies.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowSmsModal(false)}
                className={`${isDark ? 'text-gray-400 hover:text-white' : 'text-slate-400 hover:text-slate-800'} text-2xl font-bold cursor-pointer`}
              >
                &times;
              </button>
            </div>

            {/* Notification Feedback Banner */}
            {smsFeedback && (
              <div className={`mb-4 p-3 rounded-xl text-xs font-semibold flex items-center gap-2 border ${
                smsFeedback.includes('✓')
                  ? (isDark ? 'bg-[#00e676]/15 border-[#00e676]/40 text-[#00e676]' : 'bg-emerald-50 border-emerald-300 text-emerald-700')
                  : (isDark ? 'bg-[#ff5252]/15 border-[#ff5252]/40 text-[#ff5252]' : 'bg-rose-50 border-rose-300 text-rose-700')
              }`}>
                <span>{smsFeedback}</span>
              </div>
            )}

            {/* Main SMS Config Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mb-6">
              {/* Left Column: Phone & Anti-Spam Controls (7 cols) */}
              <div className="lg:col-span-7 space-y-4">
                {/* Provider Selection Card */}
                <div className={`${themeInnerBg} rounded-xl p-4 border space-y-3`}>
                  <div className="flex items-center justify-between">
                    <div>
                      <span className={`text-xs font-bold uppercase tracking-wider ${themeTextDim}`}>
                        Cellular Gateway Provider
                      </span>
                      <p className={`text-xs ${themeTextMuted}`}>
                        Choose your SMS transmission gateway
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 p-1 bg-slate-900/60 rounded-lg border border-slate-700/50">
                      <button
                        type="button"
                        onClick={() => handleSaveSmsSetting({ sms_provider: 'SEMAPHORE' })}
                        className={`px-2.5 py-1 text-xs font-bold rounded cursor-pointer transition ${
                          smsSettings?.sms_provider === 'SEMAPHORE' || !smsSettings?.sms_provider
                            ? 'bg-emerald-500 text-slate-950 shadow-sm'
                            : 'text-slate-400 hover:text-white'
                        }`}
                      >
                        Semaphore (₱0.50/SMS)
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSaveSmsSetting({ sms_provider: 'TWILIO' })}
                        className={`px-2.5 py-1 text-xs font-bold rounded cursor-pointer transition ${
                          smsSettings?.sms_provider === 'TWILIO'
                            ? 'bg-cyan-500 text-slate-950 shadow-sm'
                            : 'text-slate-400 hover:text-white'
                        }`}
                      >
                        Twilio (Global)
                      </button>
                    </div>
                  </div>

                  {/* Semaphore Specific Configuration */}
                  {(smsSettings?.sms_provider === 'SEMAPHORE' || !smsSettings?.sms_provider) && (
                    <div className="p-3 rounded-lg border border-emerald-500/30 bg-emerald-950/20 space-y-3">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold text-emerald-400 flex items-center gap-1.5">
                          <span>🇵🇭 Semaphore API (Best for ₱500 Budget)</span>
                        </span>
                        <a
                          href="https://semaphore.co"
                          target="_blank"
                          rel="noreferrer"
                          className="text-[11px] text-emerald-400 hover:underline"
                        >
                          semaphore.co (GCash / Maya) ↗
                        </a>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <div className="sm:col-span-2">
                          <label className={`block text-[11px] font-semibold ${themeTextMuted} mb-1`}>
                            Semaphore API Key
                          </label>
                          <input
                            type="password"
                            value={smsSettings?.semaphore_api_key || ''}
                            onChange={(e) => setSmsSettings((prev) => prev ? { ...prev, semaphore_api_key: e.target.value } : null)}
                            onBlur={(e) => handleSaveSmsSetting({ semaphore_api_key: e.target.value })}
                            placeholder="Enter your Semaphore API key"
                            className={`w-full font-mono text-xs px-2.5 py-1.5 rounded border outline-none ${
                              isDark ? 'bg-[#030a16] border-[#163252] text-white focus:border-emerald-400' : 'bg-white border-slate-300 text-slate-900 focus:border-emerald-600'
                            }`}
                          />
                        </div>
                        <div>
                          <label className={`block text-[11px] font-semibold ${themeTextMuted} mb-1`}>
                            Account Balance
                          </label>
                          <button
                            type="button"
                            onClick={() => fetchSemaphoreBalance()}
                            disabled={checkingBalance}
                            className="w-full py-1.5 px-2 bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 rounded text-xs font-semibold hover:bg-emerald-500/30 transition cursor-pointer flex items-center justify-center gap-1"
                          >
                            {checkingBalance ? 'Checking...' : 'Check Balance'}
                          </button>
                        </div>
                      </div>

                      {semaphoreBalance && (
                        <div className="p-2 rounded bg-emerald-900/30 border border-emerald-500/30 text-xs flex items-center justify-between font-mono">
                          <span className="text-emerald-300">{semaphoreBalance.account_name || 'Account Active'}</span>
                          <span className="font-bold text-white">
                            Balance: ₱{Number(semaphoreBalance.credit_balance || 0).toFixed(2)} ({Math.floor((semaphoreBalance.credit_balance || 0) / 0.5)} SMS credits)
                          </span>
                        </div>
                      )}
                      {balanceError && (
                        <div className="text-[11px] text-amber-400 font-mono">
                          {balanceError}
                        </div>
                      )}
                      <p className={`text-[10px] ${themeTextDim}`}>
                        A ₱500 reload on Semaphore delivers ~1,000 real-time SMS alerts to Smart, Globe, TM, TNT, and DITO with non-expiring credits.
                      </p>
                    </div>
                  )}

                  {/* Master Switch & Recipient Phone */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                    <div>
                      <label className={`block text-xs font-semibold ${themeTextMuted} mb-1`}>
                        Recipient Cellphone (+63 / 09xx)
                      </label>
                      <input
                        type="text"
                        value={smsSettings?.recipient_phone || ''}
                        onChange={(e) => setSmsSettings((prev) => prev ? { ...prev, recipient_phone: e.target.value } : null)}
                        onBlur={(e) => handleSaveSmsSetting({ recipient_phone: e.target.value })}
                        placeholder="09171234567 or +639171234567"
                        className={`w-full font-mono text-xs px-3 py-2 rounded-lg border outline-none ${
                          isDark
                            ? 'bg-[#030a16] border-[#163252] text-[#00f2fe] focus:border-[#00e676]'
                            : 'bg-white border-slate-300 text-slate-900 focus:border-emerald-600'
                        }`}
                      />
                      <span className={`text-[10px] ${themeTextDim} mt-0.5 block`}>
                        Recipient for automatic threshold alarm SMS
                      </span>
                    </div>

                    <div>
                      <label className={`block text-xs font-semibold ${themeTextMuted} mb-1`}>
                        Anti-Spam Alert Cooldown
                      </label>
                      <select
                        value={smsSettings?.cooldown_minutes || 5}
                        onChange={(e) => handleSaveSmsSetting({ cooldown_minutes: parseInt(e.target.value, 10) })}
                        className={`w-full text-xs px-3 py-2 rounded-lg border outline-none cursor-pointer ${
                          isDark
                            ? 'bg-[#030a16] border-[#163252] text-white focus:border-[#00e676]'
                            : 'bg-white border-slate-300 text-slate-900 focus:border-emerald-600'
                        }`}
                      >
                        <option value={1}>1 Minute (Testing Mode)</option>
                        <option value={5}>5 Minutes (Recommended)</option>
                        <option value={15}>15 Minutes (Conserve Credits)</option>
                        <option value={30}>30 Minutes (Low Frequency)</option>
                        <option value={60}>60 Minutes (Max 1 SMS/Hour)</option>
                      </select>
                      <span className={`text-[10px] ${themeTextDim} mt-0.5 block`}>
                        Prevents duplicate texts while reading stays out of band
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-slate-700/30">
                    <span className={`text-xs ${themeTextMuted}`}>
                      Cellular Carrier Alert Dispatching:
                    </span>
                    <button
                      type="button"
                      onClick={() => handleSaveSmsSetting({ is_enabled: smsSettings?.is_enabled ? 0 : 1 })}
                      disabled={savingSms}
                      className={`px-3 py-1 rounded-md text-xs font-bold cursor-pointer transition flex items-center gap-1.5 ${
                        smsSettings?.is_enabled
                          ? 'bg-[#00e676] text-[#030a16] shadow-sm'
                          : (isDark ? 'bg-[#163252] text-slate-300 hover:bg-[#20456e]' : 'bg-slate-300 text-slate-700 hover:bg-slate-400')
                      }`}
                    >
                      <Power className="w-3 h-3" />
                      <span>{smsSettings?.is_enabled ? 'DISPATCH ENABLED' : 'DISPATCH PAUSED'}</span>
                    </button>
                  </div>
                </div>

                {/* Subscribed Automated Events Checklist */}
                <div className={`${themeInnerBg} rounded-xl p-4 border`}>
                  <div className="flex items-center justify-between mb-3">
                    <span className={`text-xs font-bold uppercase tracking-wider ${themeTextDim}`}>
                      Autonomous Alert Subscriptions
                    </span>
                    <span className={`text-[10px] ${themeTextMuted}`}>
                      Check events that trigger cellular SMS
                    </span>
                  </div>

                  <div className="space-y-2.5">
                    {/* 1. Flush Alert */}
                    <div className={`p-3 rounded-xl border flex items-center justify-between gap-3 transition ${
                      smsSettings?.alert_flush_triggered
                        ? (isDark ? 'bg-[#00f2fe]/10 border-[#00f2fe]/40' : 'bg-cyan-50 border-cyan-200')
                        : (isDark ? 'bg-[#030a16] border-[#163252] opacity-60' : 'bg-slate-100 border-slate-200 opacity-60')
                    }`}>
                      <div className="flex items-center gap-2.5">
                        <span className="text-lg">🌊</span>
                        <div>
                          <div className={`text-xs font-bold ${themeTextMain}`}>
                            Reservoir Flushed & Refilled
                          </div>
                          <div className={`text-[11px] ${themeTextMuted}`}>
                            Dispatches when automated or operator-triggered flushing cycle occurs
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleSaveSmsSetting({ alert_flush_triggered: smsSettings?.alert_flush_triggered ? 0 : 1 })}
                        className={`text-xs px-2.5 py-1 rounded-md font-bold cursor-pointer transition ${
                          smsSettings?.alert_flush_triggered
                            ? 'bg-[#00f2fe] text-[#030a16]'
                            : (isDark ? 'bg-[#163252] text-slate-400' : 'bg-slate-300 text-slate-600')
                        }`}
                      >
                        {smsSettings?.alert_flush_triggered ? 'ACTIVE' : 'OFF'}
                      </button>
                    </div>

                    {/* 2. Low pH Alert */}
                    <div className={`p-3 rounded-xl border flex items-center justify-between gap-3 transition ${
                      smsSettings?.alert_low_ph
                        ? (isDark ? 'bg-amber-500/10 border-amber-500/40' : 'bg-amber-50 border-amber-200')
                        : (isDark ? 'bg-[#030a16] border-[#163252] opacity-60' : 'bg-slate-100 border-slate-200 opacity-60')
                    }`}>
                      <div className="flex items-center gap-2.5">
                        <span className="text-lg">🧪</span>
                        <div>
                          <div className={`text-xs font-bold ${themeTextMain}`}>
                            Critical Low pH Alert (&lt; 5.50)
                          </div>
                          <div className={`text-[11px] ${themeTextMuted}`}>
                            Acidic lockout warning; triggers nutrient solution balance sequence
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleSaveSmsSetting({ alert_low_ph: smsSettings?.alert_low_ph ? 0 : 1 })}
                        className={`text-xs px-2.5 py-1 rounded-md font-bold cursor-pointer transition ${
                          smsSettings?.alert_low_ph
                            ? 'bg-amber-500 text-black'
                            : (isDark ? 'bg-[#163252] text-slate-400' : 'bg-slate-300 text-slate-600')
                        }`}
                      >
                        {smsSettings?.alert_low_ph ? 'ACTIVE' : 'OFF'}
                      </button>
                    </div>

                    {/* 3. High pH Alert */}
                    <div className={`p-3 rounded-xl border flex items-center justify-between gap-3 transition ${
                      smsSettings?.alert_high_ph
                        ? (isDark ? 'bg-purple-500/10 border-purple-500/40' : 'bg-purple-50 border-purple-200')
                        : (isDark ? 'bg-[#030a16] border-[#163252] opacity-60' : 'bg-slate-100 border-slate-200 opacity-60')
                    }`}>
                      <div className="flex items-center gap-2.5">
                        <span className="text-lg">🧪</span>
                        <div>
                          <div className={`text-xs font-bold ${themeTextMain}`}>
                            Critical High pH Alert (&gt; 6.50)
                          </div>
                          <div className={`text-[11px] ${themeTextMuted}`}>
                            Alkaline precipitate warning; risks iron and phosphorus lockout
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleSaveSmsSetting({ alert_high_ph: smsSettings?.alert_high_ph ? 0 : 1 })}
                        className={`text-xs px-2.5 py-1 rounded-md font-bold cursor-pointer transition ${
                          smsSettings?.alert_high_ph
                            ? 'bg-purple-500 text-white'
                            : (isDark ? 'bg-[#163252] text-slate-400' : 'bg-slate-300 text-slate-600')
                        }`}
                      >
                        {smsSettings?.alert_high_ph ? 'ACTIVE' : 'OFF'}
                      </button>
                    </div>

                    {/* 4. Low TDS Alert */}
                    <div className={`p-3 rounded-xl border flex items-center justify-between gap-3 transition ${
                      smsSettings?.alert_low_tds
                        ? (isDark ? 'bg-cyan-500/10 border-cyan-500/40' : 'bg-cyan-50 border-cyan-200')
                        : (isDark ? 'bg-[#030a16] border-[#163252] opacity-60' : 'bg-slate-100 border-slate-200 opacity-60')
                    }`}>
                      <div className="flex items-center gap-2.5">
                        <span className="text-lg">⚡</span>
                        <div>
                          <div className={`text-xs font-bold ${themeTextMain}`}>
                            Low Nutrient TDS Alert (&lt; 600 ppm)
                          </div>
                          <div className={`text-[11px] ${themeTextMuted}`}>
                            Nutrient dilution; triggers Solution Pump (GPIO 26) dosing
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleSaveSmsSetting({ alert_low_tds: smsSettings?.alert_low_tds ? 0 : 1 })}
                        className={`text-xs px-2.5 py-1 rounded-md font-bold cursor-pointer transition ${
                          smsSettings?.alert_low_tds
                            ? 'bg-cyan-500 text-black'
                            : (isDark ? 'bg-[#163252] text-slate-400' : 'bg-slate-300 text-slate-600')
                        }`}
                      >
                        {smsSettings?.alert_low_tds ? 'ACTIVE' : 'OFF'}
                      </button>
                    </div>

                    {/* 5. High TDS Alert */}
                    <div className={`p-3 rounded-xl border flex items-center justify-between gap-3 transition ${
                      smsSettings?.alert_high_tds
                        ? (isDark ? 'bg-rose-500/10 border-rose-500/40' : 'bg-rose-50 border-rose-200')
                        : (isDark ? 'bg-[#030a16] border-[#163252] opacity-60' : 'bg-slate-100 border-slate-200 opacity-60')
                    }`}>
                      <div className="flex items-center gap-2.5">
                        <span className="text-lg">⚡</span>
                        <div>
                          <div className={`text-xs font-bold ${themeTextMain}`}>
                            High TDS Toxic Burn Warning (&gt; 900 ppm)
                          </div>
                          <div className={`text-[11px] ${themeTextMuted}`}>
                            Excess salt buildup; triggers Fresh Water Pump (GPIO 25) dilution
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleSaveSmsSetting({ alert_high_tds: smsSettings?.alert_high_tds ? 0 : 1 })}
                        className={`text-xs px-2.5 py-1 rounded-md font-bold cursor-pointer transition ${
                          smsSettings?.alert_high_tds
                            ? 'bg-rose-500 text-white'
                            : (isDark ? 'bg-[#163252] text-slate-400' : 'bg-slate-300 text-slate-600')
                        }`}
                      >
                        {smsSettings?.alert_high_tds ? 'ACTIVE' : 'OFF'}
                      </button>
                    </div>

                    {/* 6. Low Reservoir Level */}
                    <div className={`p-3 rounded-xl border flex items-center justify-between gap-3 transition ${
                      smsSettings?.alert_low_water
                        ? (isDark ? 'bg-blue-500/10 border-blue-500/40' : 'bg-blue-50 border-blue-200')
                        : (isDark ? 'bg-[#030a16] border-[#163252] opacity-60' : 'bg-slate-100 border-slate-200 opacity-60')
                    }`}>
                      <div className="flex items-center gap-2.5">
                        <span className="text-lg">💧</span>
                        <div>
                          <div className={`text-xs font-bold ${themeTextMain}`}>
                            Low Reservoir Depth Level (&lt; 30%)
                          </div>
                          <div className={`text-[11px] ${themeTextMuted}`}>
                            Critically low reservoir reserve; pump dry-run protection trigger
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleSaveSmsSetting({ alert_low_water: smsSettings?.alert_low_water ? 0 : 1 })}
                        className={`text-xs px-2.5 py-1 rounded-md font-bold cursor-pointer transition ${
                          smsSettings?.alert_low_water
                            ? 'bg-blue-500 text-white'
                            : (isDark ? 'bg-[#163252] text-slate-400' : 'bg-slate-300 text-slate-600')
                        }`}
                      >
                        {smsSettings?.alert_low_water ? 'ACTIVE' : 'OFF'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Right Column: Live Mobile Smartphone Preview & Dispatch Test (5 cols) */}
              <div className="lg:col-span-5 flex flex-col justify-between space-y-4">
                {/* Smartphone Preview Card */}
                <div className={`${themeInnerBg} rounded-2xl p-4 border flex flex-col items-center shadow-lg relative overflow-hidden`}>
                  <div className="w-full flex items-center justify-between mb-3 px-1">
                    <span className={`text-[10px] font-bold uppercase tracking-wider ${themeTextDim}`}>
                      Operator Phone Live Preview
                    </span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 font-mono">
                      Carrier Ready
                    </span>
                  </div>

                  {/* Smartphone Frame */}
                  <div className="w-[260px] bg-slate-950 border-4 border-slate-700 rounded-[36px] p-3 shadow-2xl relative">
                    {/* Notch / Speaker */}
                    <div className="w-20 h-3.5 bg-slate-800 rounded-b-xl mx-auto mb-3 flex items-center justify-center">
                      <div className="w-8 h-1 bg-slate-600 rounded-full" />
                    </div>

                    {/* Messages App Header */}
                    <div className="text-center pb-2 border-b border-slate-800 mb-3">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-cyan-500 to-emerald-500 mx-auto flex items-center justify-center text-xs font-bold text-black mb-1">
                        AP
                      </div>
                      <div className="text-white text-xs font-bold">AQUAPLANT-SYSTEM</div>
                      <div className="text-slate-400 text-[9px]">Automated Hydroponics Bot</div>
                    </div>

                    {/* SMS Bubble */}
                    <div className="space-y-2 mb-4 min-h-[140px] flex flex-col justify-end">
                      <div className="text-[9px] text-center text-slate-500">
                        Today at {clockString.split('|')[0]?.trim() || '12:00:00 PM'}
                      </div>
                      <div className="bg-emerald-600 text-white rounded-2xl rounded-bl-sm p-3 text-[11px] leading-relaxed shadow-md">
                        <div className="font-bold text-[10px] uppercase tracking-wide text-emerald-100 flex items-center gap-1 mb-1">
                          <Bell className="w-3 h-3" />
                          <span>AQUAPLANT ALERT</span>
                        </div>
                        {smsLogs.length > 0 ? (
                          smsLogs[0].message
                        ) : (
                          <span>
                            [AQUAPLANT] Hydroponics reservoir flush completed successfully. Fresh water refilled to 86%, TDS 745 ppm, pH 6.08. System operational.
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Home Bar */}
                    <div className="w-20 h-1 bg-slate-600 rounded-full mx-auto mt-2" />
                  </div>
                </div>

                {/* Instant Test Dispatch Card */}
                <div className={`${themeInnerBg} rounded-xl p-4 border`}>
                  <div className="flex items-center gap-2 mb-2">
                    <Send className={`w-4 h-4 ${isDark ? 'text-[#00e676]' : 'text-emerald-700'}`} />
                    <span className={`text-xs font-bold ${themeTextMain}`}>
                      Test SMS Delivery Verification
                    </span>
                  </div>
                  <p className={`text-xs ${themeTextMuted} mb-3`}>
                    Triggers an instant alert to <strong className={themeTextMain}>{smsSettings?.recipient_phone || 'your phone'}</strong> verifying carrier gateway integration.
                  </p>

                  {testSmsStatus && (
                    <div className={`mb-3 p-2.5 rounded-lg text-xs border ${
                      testSmsStatus.success
                        ? (isDark ? 'bg-[#00e676]/15 border-[#00e676]/40 text-[#00e676]' : 'bg-emerald-50 border-emerald-300 text-emerald-700')
                        : (isDark ? 'bg-[#ff5252]/15 border-[#ff5252]/40 text-[#ff5252]' : 'bg-rose-50 border-rose-300 text-rose-700')
                    }`}>
                      <div className="font-bold">{testSmsStatus.message}</div>
                      {testSmsStatus.sid && (
                        <div className="text-[10px] font-mono mt-0.5 opacity-80">
                          SID: {testSmsStatus.sid}
                        </div>
                      )}
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={handleSendTestSms}
                    disabled={testSmsLoading}
                    className="w-full py-2.5 rounded-xl font-bold text-xs bg-gradient-to-r from-[#00e676] to-[#00f2fe] text-[#030a16] hover:opacity-95 transition cursor-pointer shadow-md disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {testSmsLoading ? (
                      <>
                        <span className="w-3.5 h-3.5 border-2 border-[#030a16] border-t-transparent rounded-full animate-spin" />
                        <span>Dispatching SMS to Carrier...</span>
                      </>
                    ) : (
                      <>
                        <Send className="w-3.5 h-3.5" />
                        <span>Dispatch Test SMS Alert Now</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>

            {/* Bottom: SMS Outbox Dispatch History Audit Log */}
            <div className={`${themeInnerBg} rounded-xl p-4 border`}>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <MessageSquare className="w-4 h-4 text-[#00f2fe]" />
                  <span className={`text-xs font-bold uppercase tracking-wider ${themeTextMain}`}>
                    SMS Outbox & Transmission Audit Log ({smsLogs.length})
                  </span>
                </div>
                {smsLogs.length > 0 && (
                  <button
                    type="button"
                    onClick={handleClearSmsLogs}
                    className="flex items-center gap-1 text-[11px] text-rose-500 hover:text-rose-400 font-semibold cursor-pointer"
                  >
                    <Trash2 className="w-3 h-3" />
                    <span>Clear Outbox</span>
                  </button>
                )}
              </div>

              {smsLogs.length === 0 ? (
                <div className={`text-center py-6 text-xs ${themeTextMuted}`}>
                  No SMS alerts dispatched yet. Click "Dispatch Test SMS Alert Now" above or trigger a flush cycle.
                </div>
              ) : (
                <div className="overflow-x-auto max-h-48 overflow-y-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className={`border-b ${isDark ? 'border-[#163252] text-[#8ca2ba]' : 'border-slate-200 text-slate-500'}`}>
                        <th className="py-1.5 px-2 font-mono">Timestamp</th>
                        <th className="py-1.5 px-2">Event</th>
                        <th className="py-1.5 px-2">Recipient</th>
                        <th className="py-1.5 px-2">Message Content</th>
                        <th className="py-1.5 px-2">Delivery Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/40 font-mono">
                      {smsLogs.map((log) => (
                        <tr key={log.id} className={isDark ? 'hover:bg-slate-900/40' : 'hover:bg-slate-100'}>
                          <td className={`py-2 px-2 text-[11px] ${themeTextDim}`}>
                            {new Date(log.created_at).toLocaleTimeString()}
                          </td>
                          <td className="py-2 px-2">
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                              log.event_type === 'FLUSH_TRIGGERED'
                                ? 'bg-cyan-500/20 text-cyan-400'
                                : log.event_type.includes('PH')
                                ? 'bg-amber-500/20 text-amber-400'
                                : log.event_type.includes('TDS')
                                ? 'bg-rose-500/20 text-rose-400'
                                : 'bg-emerald-500/20 text-emerald-400'
                            }`}>
                              {log.event_type}
                            </span>
                          </td>
                          <td className={`py-2 px-2 text-[11px] ${themeTextMain}`}>
                            {log.recipient_phone}
                          </td>
                          <td className={`py-2 px-2 text-[11px] font-sans ${themeTextMuted} max-w-xs truncate`} title={log.message}>
                            {log.message}
                          </td>
                          <td className="py-2 px-2">
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                              log.status === 'SENT' || log.status === 'SIMULATED'
                                ? 'bg-[#00e676]/20 text-[#00e676]'
                                : 'bg-rose-500/20 text-rose-400'
                            }`}>
                              {log.status === 'SIMULATED' ? '✓ SIMULATED' : '✓ DELIVERED'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {/* =========================================================================
          CONNECT TO ESP32 MODAL (Cloud REST / USB Web Serial / LAN WiFi / Firmware)
         ========================================================================= */}
      {showConnectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-sm overflow-y-auto">
          <div className={`max-w-4xl w-full my-auto rounded-2xl shadow-2xl border flex flex-col max-h-[92vh] overflow-hidden transition-all duration-200 ${
            isDark ? 'bg-[#061222] border-[#163252]' : 'bg-white border-slate-200'
          }`}>
            {/* Modal Header */}
            <div className={`p-4 sm:p-5 border-b flex items-center justify-between gap-3 ${
              isDark ? 'border-[#163252] bg-[#030a16]' : 'border-slate-200 bg-slate-50'
            }`}>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-[#00f2fe]/10 border border-[#00f2fe]/30 flex items-center justify-center text-[#00f2fe] shrink-0">
                  <Cpu className="w-5 h-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className={`text-base sm:text-lg font-bold ${themeTextMain}`}>
                      Connect to ESP32
                    </h2>
                    <span className={`text-[11px] font-mono font-bold px-2 py-0.5 rounded-full border ${
                      esp32Status.is_online
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                        : 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                    }`}>
                      {esp32Status.is_online ? '● LINKED' : '○ DISCONNECTED'}
                    </span>
                  </div>
                  <p className={`text-xs ${themeTextMuted}`}>
                    AQUAPLANT Microcontroller Gateway & Hardware Pairing Station
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => {
                  setShowConnectModal(false);
                  if (serialConnected) handleDisconnectUsbSerial();
                }}
                className={`p-2 rounded-lg text-slate-400 hover:text-white transition cursor-pointer ${
                  isDark ? 'hover:bg-[#0d223a]' : 'hover:bg-slate-200 text-slate-500'
                }`}
                title="Close dialog"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Tabs Bar */}
            <div className={`flex items-center gap-1 px-4 sm:px-5 pt-3 border-b overflow-x-auto ${
              isDark ? 'border-[#163252] bg-[#040e1b]' : 'border-slate-200 bg-slate-100/60'
            }`}>
              <button
                type="button"
                onClick={() => setConnectTab('cloud')}
                className={`flex items-center gap-2 px-3.5 py-2.5 text-xs font-bold rounded-t-lg border-b-2 transition cursor-pointer shrink-0 ${
                  connectTab === 'cloud'
                    ? 'border-[#00f2fe] text-[#00f2fe] bg-[#00f2fe]/10'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <Server className="w-3.5 h-3.5" />
                <span>REST / Cloud API</span>
              </button>

              <button
                type="button"
                onClick={() => setConnectTab('serial')}
                className={`flex items-center gap-2 px-3.5 py-2.5 text-xs font-bold rounded-t-lg border-b-2 transition cursor-pointer shrink-0 ${
                  connectTab === 'serial'
                    ? 'border-[#00f2fe] text-[#00f2fe] bg-[#00f2fe]/10'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <Usb className="w-3.5 h-3.5" />
                <span>USB Web Serial</span>
                {serialConnected && (
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                )}
              </button>

              <button
                type="button"
                onClick={() => setConnectTab('wifi')}
                className={`flex items-center gap-2 px-3.5 py-2.5 text-xs font-bold rounded-t-lg border-b-2 transition cursor-pointer shrink-0 ${
                  connectTab === 'wifi'
                    ? 'border-[#00f2fe] text-[#00f2fe] bg-[#00f2fe]/10'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <Wifi className="w-3.5 h-3.5" />
                <span>WiFi & Local LAN</span>
              </button>

              <button
                type="button"
                onClick={() => setConnectTab('arduino')}
                className={`flex items-center gap-2 px-3.5 py-2.5 text-xs font-bold rounded-t-lg border-b-2 transition cursor-pointer shrink-0 ${
                  connectTab === 'arduino'
                    ? 'border-[#00f2fe] text-[#00f2fe] bg-[#00f2fe]/10'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <Code2 className="w-3.5 h-3.5" />
                <span>Arduino Code & Pinout</span>
              </button>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">
              {/* =============================================================
                  TAB 1: REST / CLOUD API PROVISIONING
                 ============================================================= */}
              {connectTab === 'cloud' && (
                <div className="space-y-6">
                  {/* Status & Test Handshake Card */}
                  <div className={`p-4 sm:p-5 rounded-xl border flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 ${
                    esp32Status.is_online
                      ? (isDark ? 'bg-emerald-950/20 border-emerald-500/30' : 'bg-emerald-50 border-emerald-200')
                      : (isDark ? 'bg-[#030a16] border-[#163252]' : 'bg-slate-50 border-slate-200')
                  }`}>
                    <div className="flex items-center gap-3">
                      <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-xl shrink-0 ${
                        esp32Status.is_online
                          ? 'bg-emerald-500/20 text-emerald-400'
                          : 'bg-rose-500/20 text-rose-400'
                      }`}>
                        {esp32Status.is_online ? <CheckCircle2 className="w-6 h-6" /> : <AlertTriangle className="w-6 h-6" />}
                      </div>
                      <div>
                        <div className={`text-sm font-bold ${themeTextMain} flex items-center gap-2`}>
                          <span>{esp32Status.is_online ? 'ESP32 Actively Transmitting' : 'ESP32 Waiting for First Transmission'}</span>
                        </div>
                        <div className={`text-xs ${themeTextMuted} font-mono mt-0.5`}>
                          Heartbeat: {esp32Status.last_seen_ago} • Target Interval: 3000ms
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
                      <button
                        type="button"
                        onClick={handleTestHandshake}
                        disabled={handshakeLoading}
                        className="flex-1 sm:flex-none flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-[#00f2fe] text-[#030a16] font-bold text-xs shadow hover:opacity-95 active:scale-95 transition cursor-pointer disabled:opacity-50"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${handshakeLoading ? 'animate-spin' : ''}`} />
                        <span>{handshakeLoading ? 'Testing...' : 'Test Handshake'}</span>
                      </button>

                      <button
                        type="button"
                        onClick={handleSendTestTelemetry}
                        disabled={testTelemetryLoading}
                        className={`flex-1 sm:flex-none flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-semibold transition cursor-pointer ${
                          isDark ? 'border-[#163252] bg-[#0a1b2e] text-[#8ca2ba] hover:text-white' : 'border-slate-300 bg-white text-slate-700 hover:text-slate-900'
                        }`}
                        title="Simulate incoming ESP32 reading to test dashboard"
                      >
                        <Radio className={`w-3.5 h-3.5 ${testTelemetryLoading ? 'animate-pulse text-[#00f2fe]' : ''}`} />
                        <span>Send Test Packet</span>
                      </button>
                    </div>
                  </div>

                  {/* Handshake Result Feedback */}
                  {handshakeResult && (
                    <div className={`p-3 rounded-lg text-xs font-mono flex items-center justify-between border ${
                      handshakeResult.success
                        ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-400'
                        : 'bg-rose-950/30 border-rose-500/40 text-rose-400'
                    }`}>
                      <div className="flex items-center gap-2">
                        {handshakeResult.success ? <Check className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
                        <span>{handshakeResult.message}</span>
                      </div>
                      {handshakeResult.latency_ms !== undefined && (
                        <span className="font-bold opacity-80">{handshakeResult.latency_ms}ms latency</span>
                      )}
                    </div>
                  )}

                  {testTelemetryResult && (
                    <div className="p-3 rounded-lg text-xs font-mono bg-emerald-950/30 border border-emerald-500/40 text-emerald-400 flex items-center gap-2">
                      <Check className="w-4 h-4 shrink-0" />
                      <span>{testTelemetryResult}</span>
                    </div>
                  )}

                  {/* Provisioning Parameters Grid */}
                  <div>
                    <h3 className={`text-xs font-mono font-bold uppercase tracking-wider mb-3 ${themeTextDim}`}>
                      Hardware Provisioning Parameters
                    </h3>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {/* Server Host URL */}
                      <div className={`p-3.5 rounded-xl border ${isDark ? 'bg-[#030a16] border-[#163252]' : 'bg-slate-50 border-slate-200'}`}>
                        <div className="flex items-center justify-between text-xs mb-1">
                          <span className={themeTextMuted}>Server Base URL</span>
                          <button
                            type="button"
                            onClick={() => handleCopy(esp32Config?.server_url || window.location.origin, 'server_url')}
                            className="text-[#00f2fe] text-[11px] font-semibold flex items-center gap-1 hover:underline cursor-pointer"
                          >
                            <Copy className="w-3 h-3" />
                            <span>{copiedField === 'server_url' ? 'Copied!' : 'Copy'}</span>
                          </button>
                        </div>
                        <div className={`font-mono text-xs font-bold truncate ${themeTextMain}`}>
                          {esp32Config?.server_url || window.location.origin}
                        </div>
                      </div>

                      {/* Device Key */}
                      <div className={`p-3.5 rounded-xl border ${isDark ? 'bg-[#030a16] border-[#163252]' : 'bg-slate-50 border-slate-200'}`}>
                        <div className="flex items-center justify-between text-xs mb-1">
                          <div className="flex items-center gap-1.5">
                            <span className={themeTextMuted}>X-Device-Key Header</span>
                            <button
                              type="button"
                              onClick={() => setShowDeviceKey(!showDeviceKey)}
                              className="text-slate-400 hover:text-white cursor-pointer"
                              title={showDeviceKey ? 'Hide key' : 'Show key'}
                            >
                              {showDeviceKey ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                            </button>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleCopy(esp32Config?.device_key || 'aquaplant_esp32_device_key_secret_2026', 'device_key')}
                            className="text-[#00f2fe] text-[11px] font-semibold flex items-center gap-1 hover:underline cursor-pointer"
                          >
                            <Copy className="w-3 h-3" />
                            <span>{copiedField === 'device_key' ? 'Copied!' : 'Copy'}</span>
                          </button>
                        </div>
                        <div className={`font-mono text-xs font-bold truncate ${themeTextMain}`}>
                          {showDeviceKey
                            ? (esp32Config?.device_key || 'aquaplant_esp32_device_key_secret_2026')
                            : '••••••••••••••••••••••••••••••••'}
                        </div>
                      </div>

                      {/* Telemetry Ingestion Endpoint */}
                      <div className={`p-3.5 rounded-xl border ${isDark ? 'bg-[#030a16] border-[#163252]' : 'bg-slate-50 border-slate-200'}`}>
                        <div className="flex items-center justify-between text-xs mb-1">
                          <span className={themeTextMuted}>Telemetry Ingestion Route</span>
                          <button
                            type="button"
                            onClick={() => handleCopy('/api/sensors', 'telemetry_endpoint')}
                            className="text-[#00f2fe] text-[11px] font-semibold flex items-center gap-1 hover:underline cursor-pointer"
                          >
                            <Copy className="w-3 h-3" />
                            <span>{copiedField === 'telemetry_endpoint' ? 'Copied!' : 'Copy'}</span>
                          </button>
                        </div>
                        <div className="font-mono text-xs font-bold text-emerald-400">
                          POST /api/sensors
                        </div>
                        <div className={`text-[10px] ${themeTextDim} mt-0.5`}>
                          Body: {`{ "tds": 750, "ph": 6.1, "temperature": 24.5, "water_level": 85, "humidity": 65 }`}
                        </div>
                      </div>

                      {/* Actuator Poll Endpoint */}
                      <div className={`p-3.5 rounded-xl border ${isDark ? 'bg-[#030a16] border-[#163252]' : 'bg-slate-50 border-slate-200'}`}>
                        <div className="flex items-center justify-between text-xs mb-1">
                          <span className={themeTextMuted}>Actuators State Poll Route</span>
                          <button
                            type="button"
                            onClick={() => handleCopy('/api/controls/device', 'poll_endpoint')}
                            className="text-[#00f2fe] text-[11px] font-semibold flex items-center gap-1 hover:underline cursor-pointer"
                          >
                            <Copy className="w-3 h-3" />
                            <span>{copiedField === 'poll_endpoint' ? 'Copied!' : 'Copy'}</span>
                          </button>
                        </div>
                        <div className="font-mono text-xs font-bold text-cyan-400">
                          GET /api/controls/device
                        </div>
                        <div className={`text-[10px] ${themeTextDim} mt-0.5`}>
                          Returns 3 pump relay states (0=OFF, 1=ON) and trigger_flush flags
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* =============================================================
                  TAB 2: DIRECT USB WEB SERIAL MONITOR
                 ============================================================= */}
              {connectTab === 'serial' && (
                <div className="space-y-4">
                  <div className={`p-4 rounded-xl border ${isDark ? 'bg-[#030a16] border-[#163252]' : 'bg-slate-50 border-slate-200'}`}>
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div>
                        <h4 className={`text-sm font-bold ${themeTextMain} flex items-center gap-2`}>
                          <Usb className="w-4 h-4 text-[#00f2fe]" />
                          Web Serial Direct Cable Link
                        </h4>
                        <p className={`text-xs ${themeTextMuted} mt-0.5`}>
                          Connect micro-USB or USB-C cable from your computer to the ESP32 to monitor live debugging at 115200 baud.
                        </p>
                      </div>

                      <div>
                        {serialConnected ? (
                          <button
                            type="button"
                            onClick={handleDisconnectUsbSerial}
                            className="px-3.5 py-1.5 rounded-lg bg-rose-500/20 text-rose-400 border border-rose-500/40 text-xs font-bold shadow hover:bg-rose-500/30 transition cursor-pointer"
                          >
                            Disconnect Port
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={handleConnectUsbSerial}
                            className="px-4 py-2 rounded-lg bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#030a16] text-xs font-bold shadow hover:opacity-90 active:scale-95 transition cursor-pointer flex items-center gap-1.5"
                          >
                            <Usb className="w-3.5 h-3.5" />
                            <span>Connect via USB Serial</span>
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Quick Command Action Chips */}
                    <div className="flex flex-wrap items-center gap-2 mt-4 pt-3 border-t border-slate-700/30">
                      <span className={`text-[11px] ${themeTextMuted}`}>Quick Commands:</span>
                      {(['PING', 'STATUS', 'RELAY_TEST', 'FLUSH_ON', 'FLUSH_OFF'] as const).map((cmd) => (
                        <button
                          key={cmd}
                          type="button"
                          onClick={() => {
                            setSerialCommand(cmd);
                            if (serialConnected) {
                              const encoder = new TextEncoder();
                              const writer = serialPort.writable.getWriter();
                              writer.write(encoder.encode(cmd + '\n')).then(() => writer.releaseLock());
                              setSerialLogs((prev) => [...prev, `[TX] > ${cmd}`]);
                            }
                          }}
                          className={`px-2 py-0.5 rounded text-[11px] font-mono border transition cursor-pointer ${
                            isDark ? 'border-[#163252] bg-[#0a1b2e] text-cyan-300 hover:text-white' : 'border-slate-300 bg-white text-slate-700 hover:text-slate-900'
                          }`}
                        >
                          {cmd}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Serial Console Output Screen */}
                  <div className="rounded-xl overflow-hidden border border-[#163252] bg-[#020710] shadow-inner">
                    <div className="px-3 py-1.5 bg-[#030d1a] border-b border-[#163252] flex items-center justify-between text-[11px] font-mono text-slate-400">
                      <div className="flex items-center gap-2">
                        <Terminal className="w-3.5 h-3.5 text-[#00f2fe]" />
                        <span>SERIAL CONSOLE (115200 BAUD)</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSerialLogs(['[LOGS CLEARED]'])}
                        className="text-slate-400 hover:text-white cursor-pointer"
                      >
                        Clear
                      </button>
                    </div>

                    <div className="p-3 font-mono text-xs h-64 overflow-y-auto space-y-1 text-slate-300">
                      {serialLogs.map((log, idx) => (
                        <div key={idx} className={
                          log.startsWith('[ERR') || log.startsWith('[WARN')
                            ? 'text-rose-400'
                            : log.startsWith('[TX')
                            ? 'text-amber-300'
                            : log.startsWith('[LINK')
                            ? 'text-emerald-400 font-bold'
                            : 'text-slate-300'
                        }>
                          {log}
                        </div>
                      ))}
                    </div>

                    {/* Command Input Box */}
                    <div className="p-2 bg-[#030d1a] border-t border-[#163252] flex items-center gap-2">
                      <input
                        type="text"
                        value={serialCommand}
                        onChange={(e) => setSerialCommand(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSendSerialCommand()}
                        placeholder={serialConnected ? "Type ASCII command and press Enter..." : "Connect USB port to send commands..."}
                        disabled={!serialConnected}
                        className={`flex-1 px-3 py-1.5 text-xs font-mono rounded bg-[#020710] border border-[#163252] text-white focus:outline-none focus:border-[#00f2fe] ${!serialConnected ? 'opacity-50 cursor-not-allowed' : ''}`}
                      />
                      <button
                        type="button"
                        onClick={handleSendSerialCommand}
                        disabled={!serialConnected || !serialCommand.trim()}
                        className="px-3 py-1.5 rounded bg-[#00f2fe] text-[#030a16] font-bold text-xs shadow hover:opacity-90 disabled:opacity-40 cursor-pointer"
                      >
                        Send
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* =============================================================
                  TAB 3: WIFI & LOCAL LAN PROBE
                 ============================================================= */}
              {/* =============================================================
                  TAB 3: WIFI & LOCAL LAN PROBE + FAILOVER MANAGER
                 ============================================================= */}
              {connectTab === 'wifi' && (
                <div className="space-y-6">
                  {/* Top Header & Failover Summary */}
                  <div className={`p-4 rounded-xl border flex flex-col md:flex-row md:items-center justify-between gap-3 ${
                    isDark ? 'bg-[#030d1a] border-[#163252]' : 'bg-blue-50/70 border-blue-200'
                  }`}>
                    <div>
                      <div className="flex items-center gap-2">
                        <Wifi className="w-5 h-5 text-[#00f2fe]" />
                        <h4 className={`text-sm font-bold ${themeTextMain}`}>
                          Wi-Fi Network & Offline Failover Manager
                        </h4>
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30">
                          2.4 GHz Only
                        </span>
                      </div>
                      <p className={`text-xs mt-1 ${themeTextMuted}`}>
                        Configure primary greenhouse Wi-Fi and a backup hotspot. If your main Wi-Fi drops, switch easily or let the ESP32 failover automatically.
                      </p>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={handleDownloadCustomFirmware}
                        className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-mono font-medium border border-slate-700 shadow-sm flex items-center gap-1.5 cursor-pointer transition"
                        title="Download aquaplant_esp32.ino with these exact Wi-Fi credentials pre-configured"
                      >
                        <Download className="w-3.5 h-3.5 text-[#00f2fe]" />
                        <span>Download Pre-Set .ino</span>
                      </button>
                    </div>
                  </div>

                  {/* Feedback Notification Banner */}
                  {wifiSaveFeedback && (
                    <div className={`p-3.5 rounded-xl text-xs font-mono flex items-start gap-2.5 border transition ${
                      wifiSaveFeedback.type === 'success'
                        ? 'bg-emerald-950/40 border-emerald-500/50 text-emerald-300'
                        : 'bg-rose-950/40 border-rose-500/50 text-rose-300'
                    }`}>
                      {wifiSaveFeedback.type === 'success' ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                      ) : (
                        <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                      )}
                      <div className="flex-1 font-sans">
                        <p className="font-semibold">{wifiSaveFeedback.message}</p>
                        {wifiSaveFeedback.type === 'success' && (
                          <p className="text-[11px] opacity-80 mt-0.5 font-mono">
                            Stored in non-volatile flash memory and local station state.
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Dual Grid: Primary Wi-Fi vs Backup Hotspot */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                    {/* Primary Network Card */}
                    <div className={`p-4 sm:p-5 rounded-xl border flex flex-col justify-between ${
                      isDark ? 'bg-[#030a16] border-[#163252]' : 'bg-white border-slate-200 shadow-sm'
                    }`}>
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <h5 className={`text-xs font-mono font-bold uppercase tracking-wider flex items-center gap-2 ${themeTextMain}`}>
                            <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse"></span>
                            Primary Greenhouse Wi-Fi
                          </h5>
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                            Main Router
                          </span>
                        </div>
                        <p className={`text-xs mb-4 ${themeTextMuted}`}>
                          The main 2.4GHz network router the ESP32 connects to during normal farm operation.
                        </p>

                        <div className="space-y-3">
                          <div>
                            <label className={`block text-xs font-medium mb-1 ${themeTextMuted}`}>
                              Wi-Fi SSID (Network Name)
                            </label>
                            <input
                              type="text"
                              value={wifiSsid}
                              onChange={(e) => setWifiSsid(e.target.value)}
                              placeholder="e.g. GreenHouse_2.4G"
                              className={`w-full px-3 py-2 rounded-lg text-xs font-mono border focus:outline-none focus:border-[#00f2fe] ${
                                isDark ? 'bg-[#061222] border-[#163252] text-white' : 'bg-slate-50 border-slate-300 text-slate-900'
                              }`}
                            />
                          </div>

                          <div>
                            <label className={`block text-xs font-medium mb-1 ${themeTextMuted}`}>
                              Wi-Fi Password (WPA2/WPA3)
                            </label>
                            <div className="relative">
                              <input
                                type={showWifiPassword ? 'text' : 'password'}
                                value={wifiPassword}
                                onChange={(e) => setWifiPassword(e.target.value)}
                                placeholder="Enter Wi-Fi password"
                                className={`w-full px-3 py-2 pr-10 rounded-lg text-xs font-mono border focus:outline-none focus:border-[#00f2fe] ${
                                  isDark ? 'bg-[#061222] border-[#163252] text-white' : 'bg-slate-50 border-slate-300 text-slate-900'
                                }`}
                              />
                              <button
                                type="button"
                                onClick={() => setShowWifiPassword(!showWifiPassword)}
                                className={`absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-200 cursor-pointer`}
                              >
                                {showWifiPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="mt-4 pt-3 border-t border-slate-800/40 flex items-center justify-between text-[11px] font-mono text-slate-400">
                        <span>Frequency: 2.4 GHz</span>
                        <span className="text-cyan-400">Standard Station Mode</span>
                      </div>
                    </div>

                    {/* Backup / Mobile Hotspot Card */}
                    <div className={`p-4 sm:p-5 rounded-xl border flex flex-col justify-between ${
                      isDark ? 'bg-[#030a16] border-[#163252]' : 'bg-white border-slate-200 shadow-sm'
                    }`}>
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <h5 className={`text-xs font-mono font-bold uppercase tracking-wider flex items-center gap-2 ${themeTextMain}`}>
                            <span className="w-2 h-2 rounded-full bg-amber-400"></span>
                            Backup / Phone Hotspot Failover
                          </h5>
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                            Auto-Failover
                          </span>
                        </div>
                        <p className={`text-xs mb-4 ${themeTextMuted}`}>
                          If the primary router goes down, the ESP32 automatically falls back to your mobile phone hotspot.
                        </p>

                        <div className="space-y-3">
                          <div>
                            <label className={`block text-xs font-medium mb-1 ${themeTextMuted}`}>
                              Backup Hotspot SSID
                            </label>
                            <input
                              type="text"
                              value={wifiBackupSsid}
                              onChange={(e) => setWifiBackupSsid(e.target.value)}
                              placeholder="e.g. MyPhoneHotspot"
                              className={`w-full px-3 py-2 rounded-lg text-xs font-mono border focus:outline-none focus:border-[#00f2fe] ${
                                isDark ? 'bg-[#061222] border-[#163252] text-white' : 'bg-slate-50 border-slate-300 text-slate-900'
                              }`}
                            />
                          </div>

                          <div>
                            <label className={`block text-xs font-medium mb-1 ${themeTextMuted}`}>
                              Backup Hotspot Password
                            </label>
                            <div className="relative">
                              <input
                                type={showBackupPassword ? 'text' : 'password'}
                                value={wifiBackupPassword}
                                onChange={(e) => setWifiBackupPassword(e.target.value)}
                                placeholder="Hotspot password"
                                className={`w-full px-3 py-2 pr-10 rounded-lg text-xs font-mono border focus:outline-none focus:border-[#00f2fe] ${
                                  isDark ? 'bg-[#061222] border-[#163252] text-white' : 'bg-slate-50 border-slate-300 text-slate-900'
                                }`}
                              />
                              <button
                                type="button"
                                onClick={() => setShowBackupPassword(!showBackupPassword)}
                                className={`absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-200 cursor-pointer`}
                              >
                                {showBackupPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="mt-4 pt-3 border-t border-slate-800/40 flex items-center justify-between text-[11px] font-mono text-slate-400">
                        <span>Trigger: 10s Router Timeout</span>
                        <span className="text-amber-400">Emergency Hotspot</span>
                      </div>
                    </div>
                  </div>

                  {/* Action Buttons Toolbar */}
                  <div className={`p-4 rounded-xl border flex flex-wrap items-center justify-between gap-3 ${
                    isDark ? 'bg-[#030e1e] border-[#163252]' : 'bg-slate-50 border-slate-200'
                  }`}>
                    <div className="flex flex-wrap items-center gap-2.5">
                      {/* Save locally / DB */}
                      <button
                        type="button"
                        onClick={() => handleSaveWifiConfig(false)}
                        disabled={wifiSaving}
                        className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-600 active:scale-95 text-white font-bold text-xs shadow-md transition cursor-pointer disabled:opacity-50 flex items-center gap-2"
                      >
                        <Check className="w-4 h-4" />
                        <span>{wifiSaving ? 'Saving...' : 'Save Wi-Fi Configuration'}</span>
                      </button>

                      {/* Push to ESP32 over USB Serial (Direct Offline fix!) */}
                      <button
                        type="button"
                        onClick={handlePushWifiOverSerial}
                        disabled={pushingWifiSerial}
                        className="px-4 py-2 rounded-lg bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 active:scale-95 text-[#030a16] font-bold text-xs shadow-md transition cursor-pointer disabled:opacity-50 flex items-center gap-2"
                        title="Transmits SET_WIFI directly via USB Web Serial cable. Works 100% offline even if Wi-Fi is completely down!"
                      >
                        <Usb className={`w-4 h-4 ${pushingWifiSerial ? 'animate-pulse' : ''}`} />
                        <span>{pushingWifiSerial ? 'Pushing to ESP32...' : '⚡ Push to ESP32 via USB (Offline)'}</span>
                      </button>

                      {/* Push Over-the-Air (OTA) */}
                      <button
                        type="button"
                        onClick={() => handleSaveWifiConfig(true)}
                        disabled={wifiSaving}
                        className="px-3.5 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 active:scale-95 text-white font-semibold text-xs shadow transition cursor-pointer disabled:opacity-50 flex items-center gap-2"
                        title="If ESP32 is currently online, queues new Wi-Fi credentials for over-the-air update on next 3s poll cycle."
                      >
                        <Radio className="w-3.5 h-3.5" />
                        <span>Push Over-the-Air (OTA)</span>
                      </button>
                    </div>

                    <div className="text-right text-[11px] font-mono text-slate-400">
                      USB Serial Baud: <span className="text-[#00f2fe] font-bold">115200</span>
                    </div>
                  </div>

                  {/* HOW TO CHANGE WI-FI WHEN WI-FI IS DOWN: Visual Troubleshooting Guide */}
                  <div className={`p-5 rounded-xl border ${isDark ? 'bg-[#030a16] border-[#163252]' : 'bg-slate-50 border-slate-200'}`}>
                    <div className="flex items-center gap-2 mb-3">
                      <WifiOff className="w-4 h-4 text-amber-400" />
                      <h4 className={`text-xs font-mono font-bold uppercase tracking-wider ${themeTextMain}`}>
                        How to Change Wi-Fi If Your Network is Down or Changed
                      </h4>
                    </div>
                    <p className={`text-xs ${themeTextMuted} mb-4`}>
                      If you changed your router or password, or if your local Wi-Fi crashed, here are the 3 ways to reconnect your ESP32 without re-coding:
                    </p>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
                      {/* Option 1: USB Serial Push */}
                      <div className={`p-3.5 rounded-lg border ${isDark ? 'bg-[#051122] border-[#163252]' : 'bg-white border-slate-200 shadow-sm'}`}>
                        <div className="flex items-center gap-2 text-amber-400 font-bold text-xs font-mono mb-1.5">
                          <Usb className="w-3.5 h-3.5" />
                          <span>Method 1: USB Cable</span>
                        </div>
                        <p className="text-[11px] text-slate-300 mb-2 leading-relaxed">
                          Plug any standard USB data cable from this PC into the ESP32 board.
                        </p>
                        <ol className="text-[10px] font-mono text-slate-400 space-y-1 list-decimal list-inside">
                          <li>Enter your new SSID & Pass above.</li>
                          <li>Click <strong className="text-amber-400 font-bold">Push to ESP32 via USB</strong>.</li>
                          <li>Select your USB serial port popup.</li>
                          <li>ESP32 writes credentials to flash and reboots instantly!</li>
                        </ol>
                      </div>

                      {/* Option 2: ESP32 Built-in SoftAP Hotspot */}
                      <div className={`p-3.5 rounded-lg border ${isDark ? 'bg-[#051122] border-[#163252]' : 'bg-white border-slate-200 shadow-sm'}`}>
                        <div className="flex items-center gap-2 text-[#00f2fe] font-bold text-xs font-mono mb-1.5">
                          <Radio className="w-3.5 h-3.5" />
                          <span>Method 2: ESP32 Hotspot AP</span>
                        </div>
                        <p className="text-[11px] text-slate-300 mb-2 leading-relaxed">
                          When Wi-Fi fails to connect for 15s, ESP32 broadcasts its own rescue hotspot:
                        </p>
                        <ol className="text-[10px] font-mono text-slate-400 space-y-1 list-decimal list-inside">
                          <li>Connect phone/PC to Wi-Fi: <strong className="text-cyan-300 font-bold">AQUAPLANT-HOTSPOT</strong></li>
                          <li>Password: <strong className="text-cyan-300">aquaplant123</strong></li>
                          <li>Open browser to: <strong className="text-cyan-300">192.168.4.1</strong></li>
                          <li>Type new Wi-Fi name & password and submit.</li>
                        </ol>
                      </div>

                      {/* Option 3: Phone Mobile Hotspot Fallback */}
                      <div className={`p-3.5 rounded-lg border ${isDark ? 'bg-[#051122] border-[#163252]' : 'bg-white border-slate-200 shadow-sm'}`}>
                        <div className="flex items-center gap-2 text-emerald-400 font-bold text-xs font-mono mb-1.5">
                          <Smartphone className="w-3.5 h-3.5" />
                          <span>Method 3: Phone Hotspot</span>
                        </div>
                        <p className="text-[11px] text-slate-300 mb-2 leading-relaxed">
                          Emergency automatic zero-touch failover:
                        </p>
                        <ol className="text-[10px] font-mono text-slate-400 space-y-1 list-decimal list-inside">
                          <li>Turn on Personal Hotspot on your smartphone.</li>
                          <li>Name it matching your configured Backup SSID.</li>
                          <li>ESP32 detects main router loss and links to your phone automatically within 10s!</li>
                        </ol>
                      </div>
                    </div>
                  </div>

                  {/* LAN IP Direct Subnet Probe Tool */}
                  <div className={`p-4 sm:p-5 rounded-xl border ${isDark ? 'bg-[#030a16] border-[#163252]' : 'bg-slate-50 border-slate-200'}`}>
                    <h4 className={`text-sm font-bold ${themeTextMain} flex items-center gap-2 mb-1`}>
                      <Radio className="w-4 h-4 text-emerald-400" />
                      Probe ESP32 Local IP on Subnet
                    </h4>
                    <p className={`text-xs ${themeTextMuted} mb-3`}>
                      If the ESP32 is on the same local network, enter its IP address (assigned by your router) to test reachability.
                    </p>

                    <div className="flex flex-col sm:flex-row items-center gap-2">
                      <input
                        type="text"
                        value={lanIp}
                        onChange={(e) => setLanIp(e.target.value)}
                        placeholder="192.168.1.184 or aquaplant.local"
                        className={`flex-1 w-full px-3 py-2 rounded-lg text-xs font-mono border focus:outline-none focus:border-[#00f2fe] ${
                          isDark ? 'bg-[#061222] border-[#163252] text-white' : 'bg-white border-slate-300 text-slate-900'
                        }`}
                      />
                      <button
                        type="button"
                        onClick={handleProbeLan}
                        disabled={lanProbing}
                        className="w-full sm:w-auto px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white font-bold text-xs shadow active:scale-95 transition cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5 shrink-0"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${lanProbing ? 'animate-spin' : ''}`} />
                        <span>{lanProbing ? 'Probing...' : 'Probe Local IP'}</span>
                      </button>
                    </div>

                    {lanProbeResult && (
                      <div className={`mt-3 p-3 rounded-lg text-xs font-mono border ${
                        lanProbeResult.online
                          ? 'bg-emerald-950/30 border-emerald-500/40 text-emerald-400'
                          : 'bg-amber-950/30 border-amber-500/40 text-amber-300'
                      }`}>
                        {lanProbeResult.message}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* =============================================================
                  TAB 4: ARDUINO CODE & PINOUT GUIDE
                 ============================================================= */}
              {connectTab === 'arduino' && (
                <div className="space-y-6">
                  {/* Pinout Wiring Reference Table */}
                  <div>
                    <h4 className={`text-xs font-mono font-bold uppercase tracking-wider mb-2 ${themeTextDim}`}>
                      ESP32 GPIO Pinout Configuration
                    </h4>
                    <div className="overflow-x-auto rounded-xl border border-slate-700/40">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className={`border-b ${isDark ? 'bg-[#040e1b] border-[#163252] text-[#8ca2ba]' : 'bg-slate-100 border-slate-200 text-slate-600'}`}>
                            <th className="py-2 px-3 font-mono">Hardware Component</th>
                            <th className="py-2 px-3 font-mono">ESP32 Pin</th>
                            <th className="py-2 px-3 font-mono">Signal Type</th>
                            <th className="py-2 px-3 font-mono">Logic / Notes</th>
                          </tr>
                        </thead>
                        <tbody className={`divide-y font-mono ${isDark ? 'divide-slate-800/40' : 'divide-slate-200'}`}>
                          <tr>
                            <td className={`py-2 px-3 font-sans font-medium ${themeTextMain}`}>TDS Nutrient Sensor</td>
                            <td className="py-2 px-3 text-[#00f2fe] font-bold">GPIO 34</td>
                            <td className="py-2 px-3 text-slate-400">Analog (ADC1_CH6)</td>
                            <td className={`py-2 px-3 text-[11px] ${themeTextDim}`}>0-3.3V Analog voltage calibration</td>
                          </tr>
                          <tr>
                            <td className={`py-2 px-3 font-sans font-medium ${themeTextMain}`}>pH Chemistry Sensor</td>
                            <td className="py-2 px-3 text-[#e056fd] font-bold">GPIO 35</td>
                            <td className="py-2 px-3 text-slate-400">Analog (ADC1_CH7)</td>
                            <td className={`py-2 px-3 text-[11px] ${themeTextDim}`}>BNC Probe with operational amplifier</td>
                          </tr>
                          <tr>
                            <td className={`py-2 px-3 font-sans font-medium ${themeTextMain}`}>Water Temp (DS18B20)</td>
                            <td className="py-2 px-3 text-amber-400 font-bold">GPIO 4</td>
                            <td className="py-2 px-3 text-slate-400">Digital OneWire</td>
                            <td className={`py-2 px-3 text-[11px] ${themeTextDim}`}>Requires 4.7kΩ pull-up resistor to 3.3V</td>
                          </tr>
                          <tr>
                            <td className={`py-2 px-3 font-sans font-medium ${themeTextMain}`}>Reservoir Water Depth</td>
                            <td className="py-2 px-3 text-cyan-400 font-bold">GPIO 32</td>
                            <td className="py-2 px-3 text-slate-400">Analog (ADC1_CH4)</td>
                            <td className={`py-2 px-3 text-[11px] ${themeTextDim}`}>Submersible resistance depth sensor</td>
                          </tr>
                          <tr>
                            <td className={`py-2 px-3 font-sans font-medium ${themeTextMain}`}>Canopy Humidity (DHT)</td>
                            <td className="py-2 px-3 text-emerald-400 font-bold">GPIO 15</td>
                            <td className="py-2 px-3 text-slate-400">Digital</td>
                            <td className={`py-2 px-3 text-[11px] ${themeTextDim}`}>DHT11 or DHT22 digital data pin</td>
                          </tr>
                          <tr className="bg-cyan-500/5">
                            <td className={`py-2 px-3 font-sans font-medium ${themeTextMain}`}>Solutioned Water Pump Relay</td>
                            <td className="py-2 px-3 text-[#00f2fe] font-bold">GPIO 25</td>
                            <td className="py-2 px-3 text-slate-400">Digital Output</td>
                            <td className="py-2 px-3 text-[11px] text-cyan-300">Active-LOW Relay (LOW=ON, HIGH=OFF)</td>
                          </tr>
                          <tr className="bg-emerald-500/5">
                            <td className={`py-2 px-3 font-sans font-medium ${themeTextMain}`}>Fresh Water Pump Relay</td>
                            <td className="py-2 px-3 text-emerald-400 font-bold">GPIO 26</td>
                            <td className="py-2 px-3 text-slate-400">Digital Output</td>
                            <td className="py-2 px-3 text-[11px] text-emerald-300">Active-LOW Relay (LOW=ON, HIGH=OFF)</td>
                          </tr>
                          <tr className="bg-rose-500/5">
                            <td className={`py-2 px-3 font-sans font-medium ${themeTextMain}`}>Emergency Flush Pump Relay</td>
                            <td className="py-2 px-3 text-rose-400 font-bold">GPIO 27</td>
                            <td className="py-2 px-3 text-slate-400">Digital Output</td>
                            <td className="py-2 px-3 text-[11px] text-rose-300">Active-LOW Relay (Evacuation pump)</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Pre-Filled Firmware Header */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <h4 className={`text-xs font-mono font-bold uppercase tracking-wider ${themeTextDim}`}>
                        Pre-Configured C++ Header Config (Ready to Flash)
                      </h4>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            const snippet = `// AQUAPLANT ESP32 Station Configuration
const char* WIFI_SSID     = "${wifiSsid}";
const char* WIFI_PASS     = "${wifiPassword}";
const char* SERVER_URL    = "${esp32Config?.server_url || window.location.origin}";
const char* DEVICE_KEY    = "${esp32Config?.device_key || 'aquaplant_esp32_device_key_secret_2026'}";

// Pinout Assignments
#define PIN_TDS_ADC        34
#define PIN_PH_ADC         35
#define PIN_ONEWIRE_TEMP   4
#define PIN_WATER_LEVEL    32
#define PIN_DHT_HUMIDITY   15
#define RELAY_SOLUTION_PUMP 25
#define RELAY_WATER_PUMP    26
#define RELAY_FLUSH_PUMP    27`;
                            handleCopy(snippet, 'arduino_snippet');
                          }}
                          className="px-2.5 py-1 text-xs font-semibold rounded bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 hover:bg-[#00f2fe]/20 cursor-pointer flex items-center gap-1"
                        >
                          <Copy className="w-3 h-3" />
                          <span>{copiedField === 'arduino_snippet' ? 'Copied!' : 'Copy Config'}</span>
                        </button>

                        <a
                          href="/api/download/firmware"
                          download="aquaplant_esp32.ino"
                          className="px-2.5 py-1 text-xs font-semibold rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/20 cursor-pointer flex items-center gap-1"
                        >
                          <Download className="w-3 h-3" />
                          <span>Download .ino</span>
                        </a>
                      </div>
                    </div>

                    <pre className="p-4 rounded-xl font-mono text-xs overflow-x-auto bg-[#020710] border border-[#163252] text-cyan-300 leading-relaxed">
{`// =========================================================================
// AQUAPLANT Automated Hydroponic Station - Hardware Configuration
// Generated for: ${wifiSsid}
// Server Target: ${esp32Config?.server_url || window.location.origin}
// =========================================================================
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

const char* WIFI_SSID     = "${wifiSsid}";
const char* WIFI_PASS     = "${wifiPassword}";
const char* SERVER_URL    = "${esp32Config?.server_url || window.location.origin}";
const char* DEVICE_KEY    = "${esp32Config?.device_key || 'aquaplant_esp32_device_key_secret_2026'}";

// GPIO Pinout Configuration
#define PIN_TDS_ADC         34
#define PIN_PH_ADC          35
#define PIN_ONEWIRE_TEMP    4
#define PIN_WATER_LEVEL     32
#define PIN_DHT_HUMIDITY    15
#define RELAY_SOLUTION_PUMP 25
#define RELAY_WATER_PUMP    26
#define RELAY_FLUSH_PUMP    27

// Relays are optoisolated Active-LOW:
#define RELAY_ON   LOW
#define RELAY_OFF  HIGH`}
                    </pre>
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className={`p-4 border-t flex flex-wrap items-center justify-between gap-3 ${
              isDark ? 'border-[#163252] bg-[#030a16]' : 'border-slate-200 bg-slate-50'
            }`}>
              <div className="flex items-center gap-2 text-xs font-mono text-slate-400">
                <Cpu className="w-3.5 h-3.5 text-[#00f2fe]" />
                <span>ESP32 NodeMCU / ESP32-WROOM-32 Compatible</span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowConnectModal(false);
                    if (serialConnected) handleDisconnectUsbSerial();
                  }}
                  className={`px-4 py-2 rounded-lg text-xs font-semibold border transition cursor-pointer ${
                    isDark ? 'border-slate-700 text-slate-300 hover:text-white' : 'border-slate-300 text-slate-700 hover:text-slate-900'
                  }`}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}



