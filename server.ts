/**
 * AQUAPLANT Backend REST API & Server Entry Point
 * 
 * System Roles:
 * 1. Hardware Interface: Accepts encrypted HTTP POST telemetry from ESP32 (`/api/sensor-data`)
 *    and delivers real-time relay actuator instructions (`/api/device/poll`).
 * 2. Web Application API: Serves live telemetry, 24-hr historical analytics, relay toggles,
 *    and system logs to the React Web Application and desktop dashboard.
 * 3. Security Model:
 *    - Human Operators: Authenticated via JSON Web Tokens (JWT) signed with HMAC-SHA256 (12h TTL).
 *    - ESP32 Hardware: Authenticated via shared pre-shared key header (`X-Device-Key`).
 * 4. Reporting & Defense:
 *    - Automated multi-tab Excel (.xlsx) report generation via ExcelJS.
 *    - Built-in endpoints to inspect and download Arduino firmware and MySQL schemas.
 * 5. Full-Stack Dev Integration: Mounts Vite middleware during development for zero-config SPA serving.
 */

import express, { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  initDatabase,
  findUserByUsername,
  findUserByUsernameOrEmail,
  createUser,
  countUsers,
  listManagedUsers,
  setUserStatus,
  setUserRole,
  deleteUserById,
  countAdmins,
  touchUserLastSeen,
  getUserStatusById,
  insertSensorReading,
  insertSensorReadingsBatch,
  getLatestSensorReading,
  getSensorHistory,
  getControlStates,
  updateControlStateWithLog,
  getSystemLogs,
  addSystemLog,
  addSystemLogsBatch,
  setTriggerFlushForNextPoll,
  getTriggerFlushForNextPoll,
  getAllDataForExport,
  getSmsSettings,
  updateSmsSettings,
  getSmsLogs,
  createSmsLog,
  clearSmsLogs,
  canDispatchSms,
  getDbConnectionStatus,
  SmsLog,
  SystemLog
} from './src/db.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'aquaplant_capstone_jwt_secret_key_2026';
const rawKey = process.env.DEVICE_KEY;
const DEVICE_KEY = (rawKey && rawKey !== 'val' && rawKey !== 'undefined' && rawKey.trim().length > 0) ? rawKey : 'aquaplant_esp32_device_key_secret_2026';
const ALLOW_REGISTRATION = process.env.ALLOW_REGISTRATION !== 'false';

// Access code required to create a NEW administrator account from the Admin Portal.
// It must be supplied through Render -> Environment (ADMIN_SIGNUP_CODE). The old
// hardcoded default is only allowed in local development; in production an unset
// code disables administrator self-registration so a public repo cannot be used to
// create an admin account.
const configuredAdminSignupCode = process.env.ADMIN_SIGNUP_CODE?.trim();
const ADMIN_SIGNUP_CODE = configuredAdminSignupCode || 'AQUAPLANT-ADMIN-2026';
const ADMIN_SIGNUP_ENABLED = Boolean(configuredAdminSignupCode) || process.env.NODE_ENV !== 'production';

// Very small brute-force guard for the public sign-in endpoint.
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 15;
const loginFailures = new Map<string, { count: number; firstAt: number }>();

function loginClientKey(req: Request): string {
  const forwarded = req.headers['x-forwarded-for']?.toString().split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function isLoginThrottled(key: string): boolean {
  const entry = loginFailures.get(key);
  if (!entry) return false;
  if (Date.now() - entry.firstAt > LOGIN_FAILURE_WINDOW_MS) {
    loginFailures.delete(key);
    return false;
  }
  return entry.count >= LOGIN_FAILURE_LIMIT;
}

function recordLoginFailure(key: string) {
  const entry = loginFailures.get(key);
  if (!entry || Date.now() - entry.firstAt > LOGIN_FAILURE_WINDOW_MS) {
    loginFailures.set(key, { count: 1, firstAt: Date.now() });
  } else {
    entry.count += 1;
  }
}

// Enable JSON body parsing and URL-encoded form parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Database connection pool (MySQL with seamless in-memory fallback)
let dbStatus = { isMySQL: false, message: 'Initializing...' };

// Seed default admin account on initial system startup.
// IMPORTANT: wait for initDatabase() first, and never let seeding crash the server.
(async () => {
  try {
    dbStatus = await initDatabase();

    const userCount = await countUsers();
    const bootstrapPassword = process.env.DEFAULT_ADMIN_PASSWORD;

    if (userCount === 0 && bootstrapPassword) {
      const defaultHash = await bcrypt.hash(bootstrapPassword, 10);
      await createUser('admin', 'admin@aquaplant.local', defaultHash, 'admin');
      console.log('[AQUAPLANT] Bootstrap administrator account created from DEFAULT_ADMIN_PASSWORD.');
      console.log('[AQUAPLANT] Change that password after signing in, then remove the variable.');
    } else if (userCount === 0) {
      console.log('[AQUAPLANT] No accounts yet. Create the first administrator in the Administrator Portal with the admin access code.');
    } else {
      console.log('[AQUAPLANT] Admin account already present — seed skipped.');
    }
  } catch (err: any) {
    if (err && (err.code === 'ER_DUP_ENTRY' || err.errno === 1062)) {
      console.log('[AQUAPLANT] Default admin account already exists — seed skipped.');
    } else {
      console.error('[AQUAPLANT] Startup seed skipped:', err?.message || err);
    }
  }
})();

// Safety net: log unexpected promise rejections instead of terminating the process.
process.on('unhandledRejection', (reason: any) => {
  console.error('[AQUAPLANT] Unhandled promise rejection (server kept running):', reason?.message || reason);
});

// ============================================================================
// AUTHENTICATION MIDDLEWARES
// ============================================================================


export interface AuthenticatedRequest extends Request {
  user?: {
    id: number;
    username: string;
    email: string;
    role: string;
  };
}

const lastSeenTouch = new Map<number, number>();
const authStatusCache = new Map<number, { status: string; checkedAt: number }>();

// Suspended / unapproved accounts lose access within one minute of the admin action.
async function isAccountAuthorized(userId: number): Promise<boolean> {
  try {
    const now = Date.now();
    const cached = authStatusCache.get(userId);
    if (cached && now - cached.checkedAt < 60_000) {
      return cached.status === 'approved';
    }
    const status = (await getUserStatusById(userId)) || 'approved';
    authStatusCache.set(userId, { status, checkedAt: now });
    return status === 'approved';
  } catch {
    // Never lock users out because of a transient database hiccup.
    return true;
  }
}

function authenticateToken(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    res.status(401).json({ error: 'Access token required. Please log in.' });
    return;
  }

  jwt.verify(token, JWT_SECRET, async (err, decodedUser) => {
    if (err) {
      res.status(403).json({ error: 'Invalid or expired session token.' });
      return;
    }
    req.user = decodedUser as any;

    const userId = Number(req.user?.id);
    if (userId) {
      const authorized = await isAccountAuthorized(userId);
      if (!authorized) {
        res.status(403).json({
          error: 'Your account is no longer authorized. Please contact an administrator.'
        });
        return;
      }

      // Presence heartbeat for the admin dashboard (at most once per minute per user).
      const now = Date.now();
      const previous = lastSeenTouch.get(userId) || 0;
      if (now - previous > 60_000) {
        lastSeenTouch.set(userId, now);
        void touchUserLastSeen(userId);
      }
    }

    next();
  });
}

function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  if (req.user.role !== 'admin') {
    res.status(403).json({ error: 'Administrator privileges required.' });
    return;
  }
  next();
}

function authenticateDeviceKey(req: Request, res: Response, next: NextFunction) {
  const clientKey = req.headers['x-device-key'];
  if (!clientKey || clientKey !== DEVICE_KEY) {
    res.status(401).json({ error: 'Unauthorized: Invalid or missing X-Device-Key' });
    return;
  }
  next();
}

// ============================================================================
// API ROUTES
// ============================================================================

// 1. Auth: Register
app.post('/api/auth/register', async (req: Request, res: Response) => {
  try {
    if (!ALLOW_REGISTRATION) {
      res.status(403).json({
        error: 'Registration is closed by administrator. Contact project owner.'
      });
      return;
    }

    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      res.status(400).json({ error: 'Username, email, and password are required.' });
      return;
    }

    if (password.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters long.' });
      return;
    }

    const existing = await findUserByUsernameOrEmail(username, email);
    if (existing) {
      res.status(409).json({ error: 'That username or email is already registered. Try signing in instead.' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await createUser(username, email, passwordHash, 'operator', 'pending');

    await addSystemLog(`New operator registered (pending approval): ${username} (${email})`, 'INFO', 'WEB_AUTH');

    res.status(202).json({
      message: 'Account created. An administrator must approve it before you can sign in.',
      pending: true,
      user: { id: user.id, username: user.username, email: user.email, role: user.role, status: user.status }
    });
  } catch (error: any) {
    if (error && (error.code === 'ER_DUP_ENTRY' || error.errno === 1062)) {
      res.status(409).json({ error: 'That username or email is already registered. Try signing in instead.' });
      return;
    }
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed due to server error.' });
  }
});

// 1b. Auth: Register a NEW administrator (requires the admin access code)
app.post('/api/auth/register-admin', async (req: Request, res: Response) => {
  try {
    const { username, email, password, admin_code } = req.body || {};

    if (!username || !email || !password || !admin_code) {
      res.status(400).json({ error: 'Username, email, password and admin access code are required.' });
      return;
    }
    if (!ADMIN_SIGNUP_ENABLED) {
      res.status(503).json({
        error: 'Administrator self-registration is disabled. Ask the server owner to set ADMIN_SIGNUP_CODE.'
      });
      return;
    }
    if (String(admin_code).trim() !== ADMIN_SIGNUP_CODE) {
      res.status(403).json({ error: 'Invalid administrator access code.' });
      return;
    }
    if (String(password).length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters long.' });
      return;
    }

    const existing = await findUserByUsernameOrEmail(username, email);
    if (existing) {
      res.status(409).json({ error: 'That username or email is already registered. Try signing in instead.' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await createUser(username, email, passwordHash, 'admin', 'approved');

    await addSystemLog(`New administrator registered: ${username} (${email})`, 'WARN', 'WEB_AUTH');

    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.status(201).json({
      message: 'Administrator account created',
      token,
      user: { id: user.id, username: user.username, email: user.email, role: user.role, status: user.status }
    });
  } catch (error: any) {
    if (error && (error.code === 'ER_DUP_ENTRY' || error.errno === 1062)) {
      res.status(409).json({ error: 'That username or email is already registered. Try signing in instead.' });
      return;
    }
    console.error('Admin registration error:', error);
    res.status(500).json({ error: 'Administrator registration failed due to server error.' });
  }
});

// 2. Auth: Login
app.post('/api/auth/login', async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      res.status(400).json({ error: 'Username/email and password required.' });
      return;
    }

    const clientKey = loginClientKey(req);
    if (isLoginThrottled(clientKey)) {
      res.status(429).json({ error: 'Too many failed sign-in attempts. Please wait 15 minutes and try again.' });
      return;
    }

    const user = await findUserByUsername(username);
    if (!user) {
      recordLoginFailure(clientKey);
      res.status(401).json({ error: 'Invalid username or password.' });
      return;
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      recordLoginFailure(clientKey);
      res.status(401).json({ error: 'Invalid username or password.' });
      return;
    }

    loginFailures.delete(clientKey);

    const accountStatus = user.status || 'approved';
    if (accountStatus === 'pending') {
      res.status(403).json({
        error: 'Your account is waiting for administrator approval. Please try again later.'
      });
      return;
    }
    if (accountStatus === 'suspended') {
      res.status(403).json({
        error: 'Your account has been suspended by the administrator.'
      });
      return;
    }

    void touchUserLastSeen(user.id);

    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    await addSystemLog(`User logged in: ${user.username}`, 'INFO', 'WEB_AUTH');

    res.json({
      message: 'Login successful',
      token,
      user: { id: user.id, username: user.username, email: user.email, role: user.role }
    });
  } catch (error: any) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed due to server error.' });
  }
});

// ============================================================================
// ADMIN: USER AUTHORIZATION & PRESENCE DASHBOARD
// ============================================================================

// List every account with its approval status and online/offline presence
app.get('/api/admin/users', authenticateToken, requireAdmin, async (_req: Request, res: Response) => {
  try {
    const users = await listManagedUsers();
    res.json({
      users,
      summary: {
        total: users.length,
        online: users.filter((u) => u.is_online).length,
        pending: users.filter((u) => u.status === 'pending').length,
        suspended: users.filter((u) => u.status === 'suspended').length,
        admins: users.filter((u) => u.role === 'admin').length
      }
    });
  } catch (error: any) {
    console.error('Admin user list error:', error);
    res.status(500).json({ error: 'Failed to load user accounts.' });
  }
});

// Approve / re-pend / suspend an account
app.patch('/api/admin/users/:id/status', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const status = String(req.body?.status || '').toLowerCase();

    if (!['approved', 'pending', 'suspended'].includes(status)) {
      res.status(400).json({ error: "status must be 'approved', 'pending' or 'suspended'." });
      return;
    }
    if (!id || Number.isNaN(id)) {
      res.status(400).json({ error: 'Invalid user id.' });
      return;
    }

    const users = await listManagedUsers();
    const target = users.find((u) => u.id === id);
    if (!target) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }

    if (target.role === 'admin' && status !== 'approved' && (await countAdmins()) <= 1) {
      res.status(400).json({ error: 'Cannot suspend the only administrator account.' });
      return;
    }

    await setUserStatus(id, status as 'approved' | 'pending' | 'suspended');
    await addSystemLog(`Administrator set ${target.username} account status to ${status}`, 'INFO', 'WEB_AUTH');

    res.json({ message: `${target.username} is now ${status}.` });
  } catch (error: any) {
    console.error('Admin status update error:', error);
    res.status(500).json({ error: 'Failed to update account status.' });
  }
});

// Promote to administrator / demote to operator
app.patch('/api/admin/users/:id/role', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const role = String(req.body?.role || '').toLowerCase();

    if (!['admin', 'operator'].includes(role)) {
      res.status(400).json({ error: "role must be 'admin' or 'operator'." });
      return;
    }

    const users = await listManagedUsers();
    const target = users.find((u) => u.id === id);
    if (!target) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }

    if (target.role === 'admin' && role === 'operator' && (await countAdmins()) <= 1) {
      res.status(400).json({ error: 'Cannot demote the only administrator account.' });
      return;
    }

    await setUserRole(id, role as 'admin' | 'operator');
    await addSystemLog(`Administrator changed ${target.username} role to ${role}`, 'INFO', 'WEB_AUTH');

    res.json({ message: `${target.username} is now ${role}.` });
  } catch (error: any) {
    console.error('Admin role update error:', error);
    res.status(500).json({ error: 'Failed to update account role.' });
  }
});

// Remove an account permanently
app.delete('/api/admin/users/:id', authenticateToken, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const id = Number(req.params.id);

    if (req.user && Number(req.user.id) === id) {
      res.status(400).json({ error: 'You cannot delete your own account.' });
      return;
    }

    const users = await listManagedUsers();
    const target = users.find((u) => u.id === id);
    if (!target) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }

    if (target.role === 'admin' && (await countAdmins()) <= 1) {
      res.status(400).json({ error: 'Cannot delete the only administrator account.' });
      return;
    }

    await deleteUserById(id);
    await addSystemLog(`Administrator deleted account ${target.username}`, 'WARN', 'WEB_AUTH');

    res.json({ message: `${target.username} has been deleted.` });
  } catch (error: any) {
    console.error('Admin delete user error:', error);
    res.status(500).json({ error: 'Failed to delete account.' });
  }
});

// ============================================================================
// SMS ALERTS DISPATCH ENGINE (IPROG SMS PH)
// ============================================================================

// Convert a Philippine mobile number to the format SMS gateways expect.
// Accepts 09171234567, +639171234567, 639171234567, 9171234567.
export function normalizePhoneNumber(raw: string): string {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('63') && digits.length === 12) return digits;
  if (digits.startsWith('0') && digits.length === 11) return '63' + digits.slice(1);
  if (digits.length === 10 && digits.startsWith('9')) return '63' + digits;
  return digits;
}

export async function dispatchSmsAlert(
  eventType: SmsLog['event_type'],
  message: string
): Promise<{ sent: boolean; reason?: string; log?: SmsLog }> {
  try {
    const { canSend, reason, settings } = await canDispatchSms(eventType);
    if (!canSend) {
      return { sent: false, reason };
    }

    const phone = normalizePhoneNumber(settings.phone_number);
    if (!phone) {
      return {
        sent: false,
        reason: 'No recipient SIM number saved. Enter the phone number that should receive alerts.'
      };
    }

    const provider: SmsLog['provider'] = 'IPROG';
    const iprogKey = settings.iprog_api_key || process.env.IPROG_API_KEY;
    let status: SmsLog['status'] = 'SENT';
    let reason4Failure: string | undefined;

    if (!iprogKey) {
      return {
        sent: false,
        reason: 'IPROG SMS API token is not configured. Paste your IPROG API token in the SMS Alert Gateway and save it.'
      };
    }

    try {
      const res = await fetch('https://www.iprogsms.com/api/v1/sms_messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_token: iprogKey,
          phone_number: phone,
          message
        })
      });
      const data = await res.json().catch(() => null);
      const apiStatus = Number(data?.status);
      const ok = res.ok && (!Number.isFinite(apiStatus) || apiStatus < 400) && !data?.error;
      if (!ok) {
        status = 'FAILED';
        reason4Failure = data?.message || data?.error || `IPROG responded with HTTP ${res.status}`;
      }
    } catch (err: any) {
      // Record the failure through the normal log path so the per-event
      // cooldown engages and the gateway is not retried every 10 seconds.
      status = 'FAILED';
      reason4Failure = `Could not reach IPROG SMS: ${err.message}`;
    }

    const log = await createSmsLog({
      phone_number: phone,
      message,
      event_type: eventType,
      status,
      provider
    });

    await addSystemLog(
      status === 'FAILED'
        ? `[SMS FAILED] ${provider} | Recipient: ${phone} | ${reason4Failure || 'Unknown gateway error'}`
        : `[SMS ${status}] ${provider} | Recipient: ${phone} | Event: ${eventType}`,
      status === 'FAILED' ? 'ERROR' : eventType === 'LOW_PH' || eventType === 'HIGH_TDS' || eventType === 'FLUSH_TRIGGERED' || eventType === 'EMPTY_TANK' ? 'ALERT' : 'INFO',
      'SMS_GATEWAY'
    );

    if (status === 'FAILED') {
      return { sent: false, reason: reason4Failure || 'SMS gateway rejected the message.', log };
    }

    return { sent: true, log };
  } catch (error: any) {
    console.error('SMS dispatch error:', error);
    return { sent: false, reason: error.message };
  }
}

/**
 * Empty refill tank detection.
 * The water-level sensor reads 0% when the tank is dry. To avoid a false alarm
 * from a single noisy reading, we only send once the level has stayed at or
 * below 5% for five continuous minutes. The alert re-arms as soon as water is
 * detected again.
 */
const WATER_EMPTY_THRESHOLD = 5; // percent
const EMPTY_TANK_CONFIRM_MS = 5 * 60 * 1000;
let waterEmptySince: number | null = null;
let emptyTankAlertSent = false;

/**
 * Evaluates instantaneous telemetry for SMS notification triggers (low pH, high pH, low TDS, high TDS, low water, empty tank)
 */
async function evaluateTelemetryForSmsAlerts(reading: { tds: number; ph: number; temperature: number; water_level: number; humidity?: number }) {
  try {
    // 1. Low pH alert (< 5.50)
    if (reading.ph < 5.5) {
      await dispatchSmsAlert(
        'LOW_PH',
        `AQUAPLANT CRITICAL: Low pH detected at ${reading.ph.toFixed(2)} (Setpoint: 5.50-6.50). Acidic lockout risk! Autonomous reservoir flush initiated.`
      );
    } else if (reading.ph > 6.5) {
      // 2. High pH alert (> 6.50)
      await dispatchSmsAlert(
        'HIGH_PH',
        `AQUAPLANT WARNING: High alkaline pH at ${reading.ph.toFixed(2)} (Setpoint: 5.50-6.50). Insoluble nutrient salt formation risk. Auto-balancing active.`
      );
    }

    // 3. Low TDS alert (< 600 ppm)
    if (reading.tds < 600) {
      await dispatchSmsAlert(
        'LOW_TDS',
        `AQUAPLANT ALERT: Depleted nutrient solution! TDS dropped to ${reading.tds.toFixed(0)} ppm (Setpoint: 600-900 ppm). Solutioned Water Pump engagement needed.`
      );
    } else if (reading.tds > 900) {
      // 4. High TDS alert (> 900 ppm)
      await dispatchSmsAlert(
        'HIGH_TDS',
        `AQUAPLANT CRITICAL: High TDS salt accumulation! TDS reached ${reading.tds.toFixed(0)} ppm (Setpoint: 600-900 ppm). Reservoir flush triggered to protect roots.`
      );
    }

    // 5. Low water level alert (< 30% but the tank is not empty)
    if (reading.water_level >= WATER_EMPTY_THRESHOLD && reading.water_level < 30) {
      await dispatchSmsAlert(
        'LOW_WATER',
        `AQUAPLANT WARNING: Low reservoir capacity! Liquid level at ${reading.water_level.toFixed(1)}% (Target: >70%). Fresh Water Pump refill recommended.`
      );
    }

    // 6. Empty refill tank alert: no water detected for 5 continuous minutes
    const level = Number(reading.water_level);
    if (Number.isFinite(level)) {
      if (level > WATER_EMPTY_THRESHOLD) {
        // Water is present again - reset the timer and allow a new alert later
        waterEmptySince = null;
        emptyTankAlertSent = false;
      } else {
        const now = Date.now();
        if (waterEmptySince === null) {
          waterEmptySince = now;
        }
        if (!emptyTankAlertSent && now - waterEmptySince >= EMPTY_TANK_CONFIRM_MS) {
          const emptyMinutes = Math.max(5, Math.round((now - waterEmptySince) / 60000));
          await dispatchSmsAlert(
            'EMPTY_TANK',
            `AQUAPLANT CRITICAL: No water detected in the refill tank for ${emptyMinutes} minutes (level ${level.toFixed(1)}%). The tank appears EMPTY - refill it immediately. If the tank is not actually empty, check the water-level sensor wiring.`
          );
          // Latch after the attempt (even a failed one) so a dead gateway or a
          // disabled SMS toggle cannot retry the same emergency every reading.
          emptyTankAlertSent = true;
        }
      }
    }
  } catch (err) {
    console.error('Error evaluating telemetry for SMS:', err);
  }
}

// 3. Sensors: Post Telemetry (ESP32 only, X-Device-Key protected)
app.post('/api/sensors', authenticateDeviceKey, async (req: Request, res: Response) => {
  try {
    const { tds, ph, temperature, water_level, humidity } = req.body;

    if (tds === undefined || ph === undefined || temperature === undefined || water_level === undefined) {
      res.status(400).json({ error: 'Missing sensor parameters (tds, ph, temperature, water_level).' });
      return;
    }

    // Reject malformed packets instead of storing NaN/Infinity, which would
    // break the charts and fire nonsense SMS alerts.
    const numeric = {
      tds: Number(tds),
      ph: Number(ph),
      temperature: Number(temperature),
      water_level: Number(water_level),
      humidity: humidity !== undefined ? Number(humidity) : 0
    };
    if (!Object.values(numeric).every((value) => Number.isFinite(value))) {
      res.status(400).json({ error: 'Sensor parameters must all be finite numbers.' });
      return;
    }
    if (
      numeric.tds < 0 ||
      numeric.ph < 0 || numeric.ph > 14 ||
      numeric.water_level < 0 || numeric.water_level > 100 ||
      numeric.humidity < 0 || numeric.humidity > 100
    ) {
      res.status(400).json({ error: 'Sensor parameters are outside the physical range of the probes.' });
      return;
    }

    const clientIp = (req.headers['x-forwarded-for']?.toString().split(',')[0].trim()) || req.socket.remoteAddress || 'ESP32';
    const reading = await insertSensorReading(
      numeric.tds,
      numeric.ph,
      numeric.temperature,
      numeric.water_level,
      numeric.humidity,
      clientIp
    );

    // Automated Feedback Monitoring: Check if values are out of biological safety bands
    const isTdsOut = reading.tds < 600 || reading.tds > 900;
    const isPhOut = reading.ph < 5.5 || reading.ph > 6.5;

    if (isTdsOut || isPhOut) {
      let alertReason = '';
      if (isTdsOut) alertReason += `TDS out of range (${reading.tds} ppm, target 600-900). `;
      if (isPhOut) alertReason += `pH out of range (${reading.ph}, target 5.5-6.5).`;

      await addSystemLog(
        `[FEEDBACK ALERT] Nutrient anomaly detected: ${alertReason.trim()} Triggering reservoir flush consideration.`,
        'ALERT',
        'ESP32'
      );
    }

    // Evaluate SMS alerts for low pH, high TDS, low water, etc.
    await evaluateTelemetryForSmsAlerts(reading);

    res.status(201).json({
      success: true,
      message: 'Telemetry logged',
      reading_id: reading.id,
      recorded_at: reading.recorded_at
    });
  } catch (error: any) {
    console.error('Error logging sensor telemetry:', error);
    res.status(500).json({ error: 'Failed to record sensor reading.' });
  }
});

// 3b. Offline sync: upload the readings and logs captured while the station
//     had no internet. Sent by the dashboard right after the operator signs in.
app.post('/api/sync/offline', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const rawReadings = Array.isArray(req.body?.readings) ? req.body.readings : [];
    const rawLogs = Array.isArray(req.body?.logs) ? req.body.logs : [];

    const readings = rawReadings.slice(0, 1000);
    const logs = rawLogs.slice(0, 500);

    if (!readings.length && !logs.length) {
      res.json({ ok: true, readings: 0, logs: 0, message: 'Nothing to sync.' });
      return;
    }

    const isValidDate = (value: any) => value && !Number.isNaN(new Date(value).getTime());

    const validReadings: Array<{
      tds: number;
      ph: number;
      temperature: number;
      water_level: number;
      humidity: number;
      device_ip?: string;
      recorded_at: string;
    }> = [];
    let readingsSkipped = 0;

    for (const item of readings) {
      const tds = Number(item?.tds);
      const ph = Number(item?.ph);
      const temperature = Number(item?.temperature);
      const waterLevel = Number(item?.water_level);

      if (![tds, ph, temperature, waterLevel].every((n) => Number.isFinite(n))) {
        readingsSkipped++;
        continue;
      }

      validReadings.push({
        tds,
        ph,
        temperature,
        water_level: waterLevel,
        humidity: Number.isFinite(Number(item?.humidity)) ? Number(item.humidity) : 0,
        device_ip: 'OFFLINE_SYNC',
        recorded_at: isValidDate(item?.recorded_at)
          ? new Date(item.recorded_at).toISOString()
          : new Date().toISOString()
      });
    }

    const validLogs: Array<{ message: string; level: SystemLog['level']; source: string; created_at: string }> = [];
    let logsSkipped = 0;
    const allowedLevels = ['INFO', 'WARN', 'ALERT', 'SUCCESS', 'ERROR'];

    for (const item of logs) {
      const message = typeof item?.message === 'string' ? item.message.trim() : '';
      if (!message) {
        logsSkipped++;
        continue;
      }
      const level = allowedLevels.includes(item?.level) ? item.level : 'INFO';
      const source = typeof item?.source === 'string' && item.source.trim()
        ? item.source.trim().slice(0, 64)
        : 'OFFLINE_SYNC';

      validLogs.push({
        message: message.slice(0, 1000),
        level,
        source,
        created_at: isValidDate(item?.created_at)
          ? new Date(item.created_at).toISOString()
          : new Date().toISOString()
      });
    }

    const readingsSaved = await insertSensorReadingsBatch(validReadings);
    const logsSaved = await addSystemLogsBatch(validLogs);

    const operator = req.user?.username || 'Operator';
    await addSystemLog(
      `Offline data synchronised by ${operator}: ${readingsSaved} sensor reading(s) and ${logsSaved} log(s) uploaded to the database.`,
      'SUCCESS',
      'OFFLINE_SYNC'
    );

    res.json({
      ok: true,
      readings: readingsSaved,
      logs: logsSaved,
      skipped: readingsSkipped + logsSkipped
    });
  } catch (error: any) {
    console.error('Error syncing offline data:', error);
    res.status(500).json({ error: 'Failed to upload the offline data.' });
  }
});

// 4. Sensors: Latest Reading & ESP32 Online/Offline status
app.get('/api/sensors/latest', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const reading = await getLatestSensorReading();
    if (!reading) {
      res.json({
        reading: null,
        esp32_status: {
          is_online: false,
          last_seen_ago: 'No data recorded yet'
        }
      });
      return;
    }

    const recordedTime = new Date(reading.recorded_at).getTime();
    const diffMs = Math.max(0, Date.now() - recordedTime);
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);

    // Readings written by the diagnostics tool, the ESP32 link test, or an
    // offline sync are not proof that the ESP32 itself is connected.
    const syntheticSources = ['CALIBRATION-PROBE', 'ESP32_LINK_TEST', 'OFFLINE_SYNC'];
    const fromRealDevice = !syntheticSources.includes(reading.device_ip || '');

    // Requirement: Show "ESP32 Online" only if a reading arrived in the last 3 minutes (180s)
    const isOnline = fromRealDevice && diffSec <= 180;
    let lastSeenAgo = '';

    if (diffSec < 60) {
      lastSeenAgo = `${diffSec}s ago`;
    } else if (diffMin < 60) {
      lastSeenAgo = `${diffMin}m ago`;
    } else {
      const diffHours = Math.floor(diffMin / 60);
      lastSeenAgo = `${diffHours}h ago`;
    }

    // Do not show a stale reading as if it were live. When no real ESP32 packet
    // arrived recently, every monitoring value is zero so accounts never display
    // yesterday's numbers (or a diagnostic test) as if they were current.
    const liveReading = isOnline
      ? reading
      : {
          ...reading,
          tds: 0,
          ph: 0,
          temperature: 0,
          water_level: 0,
          humidity: 0
        };

    res.json({
      reading: liveReading,
      esp32_status: {
        is_online: isOnline,
        last_seen_ago: isOnline
          ? 'Online now'
          : fromRealDevice
          ? `Offline, last seen ${lastSeenAgo}`
          : 'Offline — waiting for an ESP32 packet'
      }
    });
  } catch (error: any) {
    console.error('Error getting latest reading:', error);
    res.status(500).json({ error: 'Failed to retrieve latest sensor reading.' });
  }
});

// 5. Sensors: History (1h, 6h, 12h, 24h)
app.get('/api/sensors/history', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const range = (req.query.range as string) || '24h';
    let hours = 24;
    if (range === '1h') hours = 1;
    else if (range === '6h') hours = 6;
    else if (range === '12h') hours = 12;
    else if (range === '24h') hours = 24;

    const readings = await getSensorHistory(hours);
    res.json({
      range,
      hours,
      count: readings.length,
      readings
    });
  } catch (error: any) {
    console.error('Error getting sensor history:', error);
    res.status(500).json({ error: 'Failed to retrieve sensor history.' });
  }
});

// 6. Controls: Get actuator states (Login required)
app.get('/api/controls', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const controls = await getControlStates();
    res.json(controls);
  } catch (error: any) {
    console.error('Error getting controls:', error);
    res.status(500).json({ error: 'Failed to retrieve actuator states.' });
  }
});

// 7. Controls: Update actuator state (Login required)
app.post('/api/controls/:device', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const device = req.params.device;
    const user = req.user!;

    if (device === 'manual_flush') {
      // Manual flush cycle with 3 submersible pumps:
      // 1. Activate Flushing Submersible Pump to evacuate stale/imbalanced reservoir
      // 2. Keep Solutioned Water Pump and Fresh Water Pump OFF during evacuation
      // 3. Signal ESP32 hardware
      await updateControlStateWithLog(
        'flush_pump',
        1,
        'WEB_USER',
        user.id,
        `Manual Flush Sequence Initiated by ${user.username}: Flushing Submersible Pump turned ON to evacuate reservoir.`,
        'ALERT'
      );
      await updateControlStateWithLog(
        'solution_pump',
        0,
        'WEB_USER',
        user.id,
        `Manual Flush Sequence Initiated by ${user.username}: Solutioned Water Submersible Pump paused.`,
        'WARN'
      );
      await updateControlStateWithLog(
        'water_pump',
        0,
        'WEB_USER',
        user.id,
        `Manual Flush Sequence Initiated by ${user.username}: Fresh Water Submersible Pump held for post-flush refill.`,
        'WARN'
      );
      setTriggerFlushForNextPoll(true);

      // Dispatch SMS alert notifying operator that water flush sequence was initiated
      await dispatchSmsAlert(
        'FLUSH_TRIGGERED',
        `AQUAPLANT NOTIFICATION: Reservoir Flush Sequence ACTIVE! Initiated by operator ${user.username}. Flushing Submersible Pump (GPIO 27) engaged to evacuate spent solution.`
      );

      const updated = await getControlStates();
      res.json({
        message: 'Manual 3-pump flush cycle triggered',
        controls: updated
      });
      return;
    }

    const { state } = req.body;
    if (state === undefined) {
      res.status(400).json({ error: 'State (0 or 1) is required.' });
      return;
    }

    const numState = Number(state) ? 1 : 0;
    const deviceLabels: Record<string, string> = {
      water_pump: 'Fresh Water Submersible Pump',
      solution_pump: 'Solutioned Water Submersible Pump',
      flush_pump: 'Flushing Submersible Pump',
      pump: 'Fresh Water Submersible Pump',
      flush_valve: 'Flushing Submersible Pump',
      refill_valve: 'Fresh Water Submersible Pump',
      auto_mode: 'Autonomous Feedback Mode'
    };

    const label = deviceLabels[device] || device;
    const stateText = numState ? 'ACTIVE (PUMPING)' : 'IDLE (OFF)';

    await updateControlStateWithLog(
      device,
      numState,
      'WEB_USER',
      user.id,
      `${label} manually set to ${stateText} by operator ${user.username}.`,
      'INFO'
    );

    const controls = await getControlStates();
    res.json({ message: `${label} updated to ${stateText}`, controls });
  } catch (error: any) {
    console.error('Error updating control state:', error);
    res.status(500).json({ error: 'Failed to update control state.' });
  }
});

// ============================================================================
// ESP32 WI-FI CONFIGURATION & FAILOVER MANAGER
// ============================================================================
export interface Esp32WifiConfig {
  primary_ssid: string;
  primary_password: string;
  backup_ssid: string;
  backup_password: string;
  ap_ssid: string;
  ap_password: string;
  updated_at: string;
  pending_ota: boolean;
}

export const currentWifiConfig: Esp32WifiConfig = {
  primary_ssid: process.env.ESP32_WIFI_SSID || 'AQUAPLANT_NETWORK',
  primary_password: process.env.ESP32_WIFI_PASS || 'hydroponics2026',
  backup_ssid: process.env.ESP32_BACKUP_SSID || 'Field_Hotspot',
  backup_password: process.env.ESP32_BACKUP_PASS || 'field12345',
  ap_ssid: 'AQUAPLANT-HOTSPOT',
  ap_password: 'aquaplant2026',
  updated_at: new Date().toISOString(),
  pending_ota: false
};

// 8. Controls: Device Poll (ESP32 only, every 3s)
app.get('/api/controls/device', authenticateDeviceKey, async (req: Request, res: Response) => {
  try {
    const controls = await getControlStates();
    const triggerFlush = getTriggerFlushForNextPoll();

    const responseData: any = {
      ...controls,
      trigger_flush: triggerFlush
    };

    if (currentWifiConfig.pending_ota) {
      responseData.new_wifi = {
        ssid: currentWifiConfig.primary_ssid,
        pass: currentWifiConfig.primary_password,
        backup_ssid: currentWifiConfig.backup_ssid,
        backup_pass: currentWifiConfig.backup_password
      };
      currentWifiConfig.pending_ota = false;
    }

    res.json(responseData);
  } catch (error: any) {
    console.error('Error in device poll:', error);
    res.status(500).json({ error: 'Device poll failed' });
  }
});

// 9. Controls: Device Update (ESP32 reports physical state changes)
app.post('/api/controls/device/:device', authenticateDeviceKey, async (req: Request, res: Response) => {
  try {
    const device = req.params.device;
    const { state } = req.body;
    const numState = Number(state) ? 1 : 0;

    await updateControlStateWithLog(
      device,
      numState,
      'ESP32',
      null,
      `Hardware actuator '${device}' state changed to ${numState ? 'ON/OPEN' : 'OFF/CLOSED'} via ESP32 local controller.`,
      'INFO'
    );

    res.json({ success: true, device, state: numState });
  } catch (error: any) {
    console.error('Error handling device update:', error);
    res.status(500).json({ error: 'Device state sync failed.' });
  }
});

// 10. Logs: Get System Logs (Login required)
app.get('/api/logs', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const limit = Number(req.query.limit) || 50;
    const level = req.query.level as string;
    const logs = await getSystemLogs(limit, level);
    res.json({ count: logs.length, logs });
  } catch (error: any) {
    console.error('Error fetching logs:', error);
    res.status(500).json({ error: 'Failed to retrieve system logs.' });
  }
});

// 11. Export to Excel (.xlsx via ExcelJS, login required)
app.get('/api/export/excel', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { readings, logs, controls } = await getAllDataForExport();

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'AQUAPLANT Capstone System';
    workbook.lastModifiedBy = req.user?.username || 'Operator';
    workbook.created = new Date();

    // Sheet 1: Sensor Telemetry
    const sheetSensors = workbook.addWorksheet('Sensor Readings', {
      views: [{ state: 'frozen', ySplit: 1 }]
    });

    sheetSensors.columns = [
      { header: 'ID', key: 'id', width: 8 },
      { header: 'Timestamp (UTC)', key: 'recorded_at', width: 24 },
      { header: 'TDS (ppm)', key: 'tds', width: 14 },
      { header: 'TDS Status (600-900)', key: 'tds_status', width: 22 },
      { header: 'pH Level', key: 'ph', width: 12 },
      { header: 'pH Status (5.5-6.5)', key: 'ph_status', width: 20 },
      { header: 'Temperature (°C)', key: 'temperature', width: 18 },
      { header: 'Water Level (%)', key: 'water_level', width: 16 },
      { header: 'Humidity (% RH)', key: 'humidity', width: 16 },
      { header: 'Humidity Status (50-70%)', key: 'humidity_status', width: 24 },
      { header: 'Device IP', key: 'device_ip', width: 16 }
    ];

    // Style Header Row
    const headerRowSensors = sheetSensors.getRow(1);
    headerRowSensors.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRowSensors.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF0F2B48' } // Dark Navy
    };

    readings.forEach((r) => {
      // A zero reading means no sensor packet, not a real measurement, so it is
      // reported as NO DATA instead of a false deficiency / acidity alarm.
      const tdsStatus = !r.tds ? 'NO DATA' : r.tds < 600 ? 'LOW (Deficiency)' : r.tds > 900 ? 'HIGH (Excess Salts)' : 'OPTIMAL';
      const phStatus = !r.ph ? 'NO DATA' : r.ph < 5.5 ? 'ACIDIC (Lockout)' : r.ph > 6.5 ? 'ALKALINE (Precipitation)' : 'OPTIMAL';
      const humidityStatus = !r.humidity ? 'NO DATA' : r.humidity < 50 ? 'LOW (Excess Transpiration)' : r.humidity > 70 ? 'HIGH (Mold Risk / Low Evap)' : 'OPTIMAL';

      sheetSensors.addRow({
        id: r.id,
        recorded_at: r.recorded_at,
        tds: r.tds,
        tds_status: tdsStatus,
        ph: r.ph,
        ph_status: phStatus,
        temperature: r.temperature,
        water_level: r.water_level,
        humidity: r.humidity,
        humidity_status: humidityStatus,
        device_ip: r.device_ip || 'N/A'
      });
    });

    // Sheet 2: System Logs
    const sheetLogs = workbook.addWorksheet('System Audit Logs', {
      views: [{ state: 'frozen', ySplit: 1 }]
    });
    sheetLogs.columns = [
      { header: 'Log ID', key: 'id', width: 10 },
      { header: 'Timestamp', key: 'created_at', width: 24 },
      { header: 'Level', key: 'level', width: 14 },
      { header: 'Event Source', key: 'source', width: 16 },
      { header: 'Message', key: 'message', width: 65 }
    ];

    const headerRowLogs = sheetLogs.getRow(1);
    headerRowLogs.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRowLogs.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF0D3B66' }
    };

    logs.forEach((l) => {
      sheetLogs.addRow(l);
    });

    // Sheet 3: Actuator States
    const sheetControls = workbook.addWorksheet('Actuator Controls');
    sheetControls.columns = [
      { header: 'Actuator Device', key: 'device', width: 25 },
      { header: 'Physical Relay State', key: 'state', width: 20 },
      { header: 'Description', key: 'desc', width: 40 }
    ];

    const headerRowCtrl = sheetControls.getRow(1);
    headerRowCtrl.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRowCtrl.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF006699' }
    };

    sheetControls.addRow({
      device: 'Fresh Water Submersible Pump',
      state: (controls.water_pump ?? controls.pump) ? 'ACTIVE (PUMPING)' : 'IDLE (OFF)',
      desc: 'Submersible Pump 1: Responsible for pumping clean/fresh water for reservoir hydration and dilution'
    });
    sheetControls.addRow({
      device: 'Solutioned Water Submersible Pump',
      state: controls.solution_pump ? 'ACTIVE (PUMPING)' : 'IDLE (OFF)',
      desc: 'Submersible Pump 2: Responsible for pumping solutioned nutrient water to adjust TDS & pH'
    });
    sheetControls.addRow({
      device: 'Flushing Submersible Pump',
      state: (controls.flush_pump ?? controls.flush_valve) ? 'ACTIVE (FLUSHING)' : 'IDLE (OFF)',
      desc: 'Submersible Pump 3: Responsible for flushing & draining spent solution out of the reservoir'
    });
    sheetControls.addRow({
      device: 'Auto Feedback Mode',
      state: controls.auto_mode ? 'ENABLED (AUTO)' : 'DISABLED (MANUAL)',
      desc: 'Autonomous closed-loop TDS/pH monitoring and automatic flush actuation'
    });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `AQUAPLANT_Export_${timestamp}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (error: any) {
    console.error('Error generating Excel export:', error);
    res.status(500).json({ error: 'Failed to generate Excel export.' });
  }
});

// 13. SMS Settings & Management Endpoints
app.get('/api/sms/settings', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const settings = await getSmsSettings();
    res.json(settings);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to retrieve SMS settings' });
  }
});

app.post('/api/sms/settings', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const patch: Record<string, any> = { ...req.body };

    // Only accept the fields this feature actually uses, and coerce them so a
    // malformed request cannot disable the cooldown or corrupt the stored row.
    const toggleFields = [
      'enabled',
      'notify_on_flush',
      'notify_on_low_ph',
      'notify_on_high_ph',
      'notify_on_low_tds',
      'notify_on_high_tds',
      'notify_on_low_water',
      'notify_on_empty_tank'
    ];
    for (const field of toggleFields) {
      if (patch[field] !== undefined) patch[field] = patch[field] ? 1 : 0;
    }
    if (patch.cooldown_minutes !== undefined) {
      const minutes = Number(patch.cooldown_minutes);
      patch.cooldown_minutes = Number.isFinite(minutes) ? Math.min(1440, Math.max(1, Math.round(minutes))) : 15;
    }
    if (typeof patch.phone_number === 'string') {
      patch.phone_number = normalizePhoneNumber(patch.phone_number);
    }
    if (typeof patch.iprog_api_key === 'string') {
      patch.iprog_api_key = patch.iprog_api_key.trim();
    }
    patch.sms_provider = 'IPROG';

    const updated = await updateSmsSettings(patch);
    await addSystemLog(
      `SMS alert settings updated: Recipient=${updated.phone_number}, Active=${updated.enabled ? 'ON' : 'OFF'}`,
      'INFO',
      'WEB_USER'
    );
    res.json({ success: true, settings: updated });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update SMS settings' });
  }
});

app.post('/api/sms/test', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { phone_number, api_token } = req.body;
    const patch: Record<string, any> = { sms_provider: 'IPROG' };
    if (phone_number) patch.phone_number = normalizePhoneNumber(phone_number);
    if (api_token) patch.iprog_api_key = api_token;
    await updateSmsSettings(patch);
    const settings = await getSmsSettings();
    const timestamp = new Date().toLocaleTimeString();
    const message = `AQUAPLANT TEST SMS via IPROG: Your SMS alert gateway is working. Recipient SIM: ${normalizePhoneNumber(settings.phone_number) || 'not set'}. Alerts cover reservoir flush, pH 5.5-6.5, and TDS 600-900. (${timestamp})`;

    const result = await dispatchSmsAlert('TEST_ALERT', message);
    if (result.sent) {
      res.json({ success: true, message: 'Test SMS sent to the IPROG gateway', log: result.log });
    } else {
      res.status(400).json({ success: false, error: result.reason || 'Failed to dispatch test SMS' });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error sending test SMS' });
  }
});

// Check IPROG SMS load balance (₱1 per SMS)
app.get('/api/sms/iprog/account', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const settings = await getSmsSettings();
    const apiToken = (req.query.token as string) || settings.iprog_api_key || process.env.IPROG_API_KEY;

    if (!apiToken) {
      res.status(400).json({ error: 'IPROG API token is not configured.' });
      return;
    }

    const response = await fetch(
      `https://www.iprogsms.com/api/v1/account/sms_credits?api_token=${encodeURIComponent(apiToken)}`
    );
    const data = await response.json().catch(() => null);

    if (!response.ok || !data || data.status === 'error' || Number(data.status) >= 400) {
      res.status(response.status >= 400 ? response.status : 400).json({
        error: data?.message || 'IPROG rejected the API token.'
      });
      return;
    }

    res.json({
      success: true,
      load_balance: Number(data?.data?.load_balance ?? 0)
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Error querying IPROG account: ' + error.message });
  }
});

app.get('/api/sms/logs', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const limit = Number(req.query.limit) || 50;
    const logs = await getSmsLogs(limit);
    res.json(logs);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch SMS logs' });
  }
});

app.delete('/api/sms/logs', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    await clearSmsLogs();
    res.json({ success: true, message: 'SMS history cleared' });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to clear SMS logs' });
  }
});

// 14. Cloud Database Link Status
app.get('/api/database/status', authenticateToken, (req: AuthenticatedRequest, res: Response) => {
  res.json(getDbConnectionStatus());
});

// 15. System Diagnostic Status
app.get('/api/system/status', (req: Request, res: Response) => {
  res.json({
    project: 'AQUAPLANT Capstone System',
    version: '1.0.0',
    db: dbStatus,
    cloud_db: getDbConnectionStatus(),
    registration_allowed: ALLOW_REGISTRATION,
    device_key_configured: Boolean(DEVICE_KEY),
    timestamp: new Date().toISOString()
  });
});

// ============================================================================
// ESP32 CONNECTION, PAIRING & DIAGNOSTIC ENDPOINTS
// ============================================================================

// ESP32 Connection Configuration
app.get('/api/esp32/config', authenticateToken, (req: AuthenticatedRequest, res: Response) => {
  const host = req.get('host') || `localhost:${PORT}`;
  const protocol = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const serverUrl = `${protocol}://${host}`;

  res.json({
    server_url: serverUrl,
    telemetry_endpoint: '/api/sensors',
    controls_poll_endpoint: '/api/controls/device',
    device_key: DEVICE_KEY,
    poll_interval_ms: 3000,
    headers: {
      'Content-Type': 'application/json',
      'X-Device-Key': DEVICE_KEY
    },
    pinout: {
      tds_sensor: 'GPIO 34 (ADC1_CH6, 0-3.3V Analog)',
      ph_sensor: 'GPIO 35 (ADC1_CH7, 0-3.3V Analog)',
      temperature_sensor: 'GPIO 13 (DHT22 ambient air temperature + humidity)',
      water_level_sensor: 'GPIO 32 (ADC1_CH4, Depth probe)',
      humidity_sensor: 'GPIO 13 (DHT22 Digital, shared with air temperature)',
      solution_pump_relay: 'GPIO 26 (Active-LOW 5V Relay Channel 2)',
      water_pump_relay: 'GPIO 25 (Active-LOW 5V Relay Channel 1)',
      flush_pump_relay: 'GPIO 27 (Active-LOW 5V Relay Channel 3)'
    }
  });
});

// ESP32 Wi-Fi Configuration API (Primary router & Backup hotspot failover)
app.get('/api/esp32/wifi-config', authenticateToken, (req: AuthenticatedRequest, res: Response) => {
  const host = req.get('host') || `localhost:${PORT}`;
  const protocol = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  res.json({
    ...currentWifiConfig,
    server_url: `${protocol}://${host}`
  });
});

app.post('/api/esp32/wifi-config', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { primary_ssid, primary_password, backup_ssid, backup_password, push_ota } = req.body;
    if (primary_ssid !== undefined) currentWifiConfig.primary_ssid = String(primary_ssid).trim();
    if (primary_password !== undefined) currentWifiConfig.primary_password = String(primary_password);
    if (backup_ssid !== undefined) currentWifiConfig.backup_ssid = String(backup_ssid).trim();
    if (backup_password !== undefined) currentWifiConfig.backup_password = String(backup_password);
    currentWifiConfig.updated_at = new Date().toISOString();
    if (push_ota) {
      currentWifiConfig.pending_ota = true;
    }

    await addSystemLog(
      `ESP32 Wi-Fi configuration updated: Primary="${currentWifiConfig.primary_ssid}", Backup Hotspot="${currentWifiConfig.backup_ssid}". ${push_ota ? 'Queued for OTA transmission.' : ''}`,
      'INFO',
      'WIFI_CONFIG'
    );

    res.json({
      success: true,
      message: 'Wi-Fi configuration saved successfully. Ready for ESP32 sync.',
      config: currentWifiConfig
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update Wi-Fi configuration.' });
  }
});

// ESP32 Handshake & Key Validation
app.post('/api/esp32/handshake', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const startTime = Date.now();
    const { device_key: clientKey } = req.body;
    const keyToTest = clientKey || DEVICE_KEY;
    const isValid = keyToTest === DEVICE_KEY;

    if (!isValid) {
      res.status(401).json({
        success: false,
        valid: false,
        error: 'Device Key mismatch! Verify X-Device-Key in your firmware.'
      });
      return;
    }

    const latencyMs = Date.now() - startTime;
    await addSystemLog(
      `ESP32 Handshake verified by operator ${req.user?.username || 'admin'}. Latency: ${latencyMs}ms`,
      'INFO',
      'ESP32'
    );

    res.json({
      success: true,
      valid: true,
      message: 'ESP32 handshake authenticated successfully!',
      server_time: new Date().toISOString(),
      latency_ms: latencyMs,
      device_key_match: true
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Handshake verification failed.' });
  }
});

// ESP32 Test Telemetry Dispatch (Verifies pipeline end-to-end)
app.post('/api/esp32/test-telemetry', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { tds = 760, ph = 6.2, temperature = 24.8, water_level = 88, humidity = 64 } = req.body;
    const reading = await insertSensorReading(
      Number(tds),
      Number(ph),
      Number(temperature),
      Number(water_level),
      Number(humidity),
      'ESP32_LINK_TEST'
    );

    await addSystemLog(
      `ESP32 Test Telemetry packet received: TDS=${tds}ppm, pH=${ph}, Temp=${temperature}°C`,
      'INFO',
      'ESP32'
    );

    res.json({
      success: true,
      message: 'Test telemetry packet processed & logged to database.',
      reading
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Failed to dispatch test telemetry.' });
  }
});

// 14. File Downloads (Firmware with injected Wi-Fi credentials)
app.get('/api/download/firmware', (req: Request, res: Response) => {
  const filePath = path.join(__dirname, 'firmware', 'aquaplant_esp32.ino');
  if (fs.existsSync(filePath)) {
    let content = fs.readFileSync(filePath, 'utf8');
    // Only personalise with credentials the caller explicitly sent. Never fall
    // back to the Wi-Fi password stored on the server: this route is a plain
    // download link and cannot carry an Authorization header.
    const ssid = req.query.ssid as string;
    const pass = req.query.pass as string;
    const backupSsid = req.query.backup_ssid as string;
    const backupPass = req.query.backup_pass as string;

    if (ssid) {
      content = content.replace(/const char\* WIFI_SSID\s*=\s*".*?";/, `const char* WIFI_SSID     = "${ssid.replace(/"/g, '\\"')}";`);
    }
    if (pass) {
      content = content.replace(/const char\* WIFI_PASSWORD\s*=\s*".*?";/, `const char* WIFI_PASSWORD = "${pass.replace(/"/g, '\\"')}";`);
    }
    if (backupSsid) {
      content = content.replace(/const char\* BACKUP_WIFI_SSID\s*=\s*".*?";/, `const char* BACKUP_WIFI_SSID = "${backupSsid.replace(/"/g, '\\"')}";`);
    }
    if (backupPass) {
      content = content.replace(/const char\* BACKUP_WIFI_PASS\s*=\s*".*?";/, `const char* BACKUP_WIFI_PASS = "${backupPass.replace(/"/g, '\\"')}";`);
    }
    res.setHeader('Content-Disposition', 'attachment; filename="aquaplant_esp32.ino"');
    res.setHeader('Content-Type', 'text/x-c');
    res.send(content);
  } else {
    res.status(404).send('Firmware file not found');
  }
});

// ============================================================================
// STATIC ASSETS & VITE INTEGRATION
// ============================================================================

// Serve static assets from public if exists or custom directory
app.use('/js', express.static(path.join(__dirname, 'public', 'js')));
app.use('/css', express.static(path.join(__dirname, 'public', 'css')));
app.use('/firmware', express.static(path.join(__dirname, 'firmware')));

// Dedicated Administrator Portal (separate from the monitoring dashboard)
app.get('/admin.html', (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// PWA files. They live in public/ and are copied into dist/ by `vite build`.
// Serve them with explicit headers so browsers treat the app as installable.
function sendPwaFile(res: Response, fileName: string, contentType: string) {
  const distFile = path.join(__dirname, 'dist', fileName);
  const publicFile = path.join(__dirname, 'public', fileName);
  res.type(contentType);
  res.sendFile(fs.existsSync(distFile) ? distFile : publicFile);
}

app.get('/manifest.webmanifest', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  sendPwaFile(res, 'manifest.webmanifest', 'application/manifest+json');
});

app.get('/sw.js', (_req: Request, res: Response) => {
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  sendPwaFile(res, 'sw.js', 'application/javascript');
});

// Development server setup
async function startServer() {
  const isDev = process.env.NODE_ENV !== 'production';

  if (isDev) {
    try {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa'
      });
      app.use(vite.middlewares);
      console.log('[AQUAPLANT] Vite middleware attached for development Web App.');
    } catch (e) {
      console.warn('[AQUAPLANT] Vite middleware not attached, running in standard Express mode.');
      app.use(express.static(path.join(__dirname, 'public')));
    }
  } else {
    // Production static serving
    const distPath = path.join(__dirname, 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (req: Request, res: Response) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    } else {
      app.use(express.static(path.join(__dirname, 'public')));
      app.get('*', (_req: Request, res: Response) => {
        res
          .status(404)
          .send('AQUAPLANT frontend build not found. Run "npm run build" and restart the server.');
      });
    }
  }

  if (!process.env.JWT_SECRET) {
    console.warn(
      '[AQUAPLANT] WARNING: JWT_SECRET is not set. A public fallback secret is in use; set JWT_SECRET in Render before exposing the app.'
    );
  }
  if (!ADMIN_SIGNUP_ENABLED) {
    console.warn(
      '[AQUAPLANT] Administrator self-registration is disabled because ADMIN_SIGNUP_CODE is not set. Set it in Render to allow new admin accounts.'
    );
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n======================================================`);
    console.log(`🌱 AQUAPLANT Web Monitoring & Control Server`);
    console.log(`   Running at: http://localhost:${PORT}`);
    console.log(`   App:        http://localhost:${PORT}/`);
    console.log(`   Admin:      http://localhost:${PORT}/admin.html`);
    console.log(`======================================================\n`);
  });
}

startServer();
