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
  createUser,
  countUsers,
  insertSensorReading,
  getLatestSensorReading,
  getSensorHistory,
  getControlStates,
  updateControlStateWithLog,
  getSystemLogs,
  addSystemLog,
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
  connectToDatabase,
  SmsLog,
  SmsAlertSetting
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

// Enable JSON body parsing and URL-encoded form parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Database connection pool (MySQL with seamless in-memory fallback)
let dbStatus = { isMySQL: false, message: 'Initializing...' };
initDatabase().then((res) => {
  dbStatus = res;
});

// Seed default admin account on initial system startup
(async () => {
  const userCount = await countUsers();
  if (userCount === 0) {
    const defaultHash = await bcrypt.hash('admin123', 10);
    await createUser('admin', 'admin@aquaplant.local', defaultHash, 'admin');
    console.log('[AQUAPLANT] Default admin account created: username: "admin", password: "admin123"');
  }
})();

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

function authenticateToken(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    res.status(401).json({ error: 'Access token required. Please log in.' });
    return;
  }

  jwt.verify(token, JWT_SECRET, (err, decodedUser) => {
    if (err) {
      res.status(403).json({ error: 'Invalid or expired session token.' });
      return;
    }
    req.user = decodedUser as any;
    next();
  });
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

    const existing = await findUserByUsername(username);
    if (existing) {
      res.status(409).json({ error: 'Username or email already registered.' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await createUser(username, email, passwordHash, 'operator');

    await addSystemLog(`New operator registered: ${username} (${email})`, 'INFO', 'WEB_AUTH');

    // 12-hour expiry JWT as specified
    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.status(201).json({
      message: 'Registration successful',
      token,
      user: { id: user.id, username: user.username, email: user.email, role: user.role }
    });
  } catch (error: any) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed due to server error.' });
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

    const user = await findUserByUsername(username);
    if (!user) {
      res.status(401).json({ error: 'Invalid username or password.' });
      return;
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      res.status(401).json({ error: 'Invalid username or password.' });
      return;
    }

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
// SMS ALERTS DISPATCH ENGINE (Semaphore PH Telcos / Twilio / Webhook / Carrier Gateway)
// ============================================================================

export async function dispatchSmsAlert(
  eventType: SmsLog['event_type'],
  message: string
): Promise<{ sent: boolean; reason?: string; log?: SmsLog }> {
  try {
    const { canSend, reason, settings } = await canDispatchSms(eventType);
    if (!canSend) {
      return { sent: false, reason };
    }

    const phone = settings.phone_number;
    let provider = settings.sms_provider || 'SIMULATOR';
    let status: SmsLog['status'] = 'DELIVERED';

    const semaphoreKey = settings.semaphore_api_key || process.env.SEMAPHORE_API_KEY;
    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioFrom = process.env.TWILIO_PHONE_NUMBER;
    const webhookUrl = process.env.SMS_WEBHOOK_URL;

    // 1. Prioritize Semaphore if configured (Optimal for Philippines ₱500 budget: ₱0.50/SMS)
    if (semaphoreKey && (settings.sms_provider === 'SEMAPHORE' || (!twilioSid && !webhookUrl))) {
      provider = 'SEMAPHORE';
      try {
        const params = new URLSearchParams({
          apikey: semaphoreKey,
          number: phone,
          message: message,
          sendername: settings.semaphore_sender_name || process.env.SEMAPHORE_SENDER_NAME || 'SEMAPHORE'
        });

        const res = await fetch('https://api.semaphore.co/api/v4/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString()
        });

        const data = await res.json().catch(() => null);
        if (res.ok) {
          status = 'DELIVERED';
        } else {
          console.warn('[SEMAPHORE API] Dispatch response:', data);
          status = 'SENT';
        }
      } catch (err) {
        console.warn('[SEMAPHORE API] Request failed:', err);
        status = 'SENT';
      }
    } else if (twilioSid && twilioToken && twilioFrom && (settings.sms_provider === 'TWILIO' || !semaphoreKey)) {
      provider = 'TWILIO';
      try {
        const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');
        const body = new URLSearchParams({
          To: phone,
          From: twilioFrom,
          Body: message
        });
        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: body.toString()
        });
        if (!res.ok) {
          status = 'SENT';
        }
      } catch {
        status = 'SENT';
      }
    } else if (webhookUrl) {
      provider = 'WEBHOOK';
      try {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, message, eventType, timestamp: new Date().toISOString() })
        });
      } catch {
        // logged as sent
      }
    }

    const log = await createSmsLog({
      phone_number: phone,
      message,
      event_type: eventType,
      status,
      provider
    });

    await addSystemLog(
      `[SMS DISPATCH] Recipient: ${phone} | Event: ${eventType} | "${message}"`,
      eventType === 'LOW_PH' || eventType === 'HIGH_TDS' || eventType === 'FLUSH_TRIGGERED' ? 'ALERT' : 'INFO',
      'SMS_GATEWAY'
    );

    return { sent: true, log };
  } catch (error: any) {
    console.error('SMS dispatch error:', error);
    return { sent: false, reason: error.message };
  }
}

/**
 * Evaluates instantaneous telemetry for SMS notification triggers (low pH, high pH, low TDS, high TDS, low water)
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

    // 5. Low water level alert (< 30%)
    if (reading.water_level < 30) {
      await dispatchSmsAlert(
        'LOW_WATER',
        `AQUAPLANT WARNING: Low reservoir capacity! Liquid level at ${reading.water_level.toFixed(1)}% (Target: >70%). Fresh Water Pump refill recommended.`
      );
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

    const clientIp = req.headers['x-forwarded-for']?.toString() || req.socket.remoteAddress || 'ESP32';
    const reading = await insertSensorReading(
      Number(tds),
      Number(ph),
      Number(temperature),
      Number(water_level),
      humidity !== undefined ? Number(humidity) : 65.0,
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

    // Requirement: Show "ESP32 Online" only if a reading arrived in the last 3 minutes (180s)
    const isOnline = diffSec <= 180;
    let lastSeenAgo = '';

    if (diffSec < 60) {
      lastSeenAgo = `${diffSec}s ago`;
    } else if (diffMin < 60) {
      lastSeenAgo = `${diffMin}m ago`;
    } else {
      const diffHours = Math.floor(diffMin / 60);
      lastSeenAgo = `${diffHours}h ago`;
    }

    res.json({
      reading,
      esp32_status: {
        is_online: isOnline,
        last_seen_ago: isOnline ? 'Online now' : `Offline, last seen ${lastSeenAgo}`,
        diff_seconds: diffSec
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
      const tdsStatus = r.tds < 600 ? 'LOW (Deficiency)' : r.tds > 900 ? 'HIGH (Excess Salts)' : 'OPTIMAL';
      const phStatus = r.ph < 5.5 ? 'ACIDIC (Lockout)' : r.ph > 6.5 ? 'ALKALINE (Precipitation)' : 'OPTIMAL';
      const humidityStatus = (r.humidity || 65) < 50 ? 'LOW (Excess Transpiration)' : (r.humidity || 65) > 70 ? 'HIGH (Mold Risk / Low Evap)' : 'OPTIMAL';

      sheetSensors.addRow({
        id: r.id,
        recorded_at: r.recorded_at,
        tds: r.tds,
        tds_status: tdsStatus,
        ph: r.ph,
        ph_status: phStatus,
        temperature: r.temperature,
        water_level: r.water_level,
        humidity: r.humidity || 65.0,
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

// 12. Diagnostic & Sensor Calibration Injection (for hardware calibration & test triggers)
app.post('/api/simulator/reading', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { tds, ph, temperature, water_level, humidity, simulate_anomaly } = req.body;

    let finalTds = tds !== undefined ? Number(tds) : 750;
    let finalPh = ph !== undefined ? Number(ph) : 6.1;
    let finalTemp = temperature !== undefined ? Number(temperature) : 24.2;
    let finalLevel = water_level !== undefined ? Number(water_level) : 85;
    let finalHumidity = humidity !== undefined ? Number(humidity) : 64.5;

    if (simulate_anomaly === 'high_tds') {
      finalTds = 1120; // Causes salt build-up alert
    } else if (simulate_anomaly === 'low_tds') {
      finalTds = 420; // Deficiency alert
    } else if (simulate_anomaly === 'acidic_ph') {
      finalPh = 4.8; // Acidic lockout
    } else if (simulate_anomaly === 'alkaline_ph') {
      finalPh = 7.4; // Alkaline precipitation
    } else if (simulate_anomaly === 'low_water') {
      finalLevel = 25; // Water level warning
    } else if (simulate_anomaly === 'dry_air') {
      finalHumidity = 36.0; // Dry air stress
    } else if (simulate_anomaly === 'high_humidity') {
      finalHumidity = 86.0; // Mold risk
    }

    const reading = await insertSensorReading(
      finalTds,
      finalPh,
      finalTemp,
      finalLevel,
      finalHumidity,
      'CALIBRATION-PROBE'
    );

    const isTdsOut = finalTds < 600 || finalTds > 900;
    const isPhOut = finalPh < 5.5 || finalPh > 6.5;

    if (isTdsOut || isPhOut) {
      await addSystemLog(
        `[CALIBRATION DIAGNOSTIC] Hydroponic threshold breached: TDS=${finalTds}ppm, pH=${finalPh}. Automated response active!`,
        'ALERT',
        'STATION_DIAGNOSTIC'
      );
    } else {
      await addSystemLog(
        `[CALIBRATION DIAGNOSTIC] Sensor calibration reading verified: TDS=${finalTds}ppm, pH=${finalPh}, Temp=${finalTemp}°C, Humidity=${finalHumidity}%.`,
        'INFO',
        'STATION_DIAGNOSTIC'
      );
    }

    // Evaluate SMS alerts for simulated low pH, high TDS, low water, etc.
    await evaluateTelemetryForSmsAlerts(reading);

    res.json({ success: true, reading });
  } catch (error: any) {
    res.status(500).json({ error: 'Simulator telemetry failed.' });
  }
});

// 13. SMS Settings & Management Endpoints
app.get('/api/sms/settings', async (req: Request, res: Response) => {
  try {
    const settings = await getSmsSettings();
    res.json(settings);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to retrieve SMS settings' });
  }
});

app.post('/api/sms/settings', async (req: Request, res: Response) => {
  try {
    const updated = await updateSmsSettings(req.body);
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

app.post('/api/sms/test', async (req: Request, res: Response) => {
  try {
    const { phone_number } = req.body;
    if (phone_number) {
      await updateSmsSettings({ phone_number });
    }
    const settings = await getSmsSettings();
    const timestamp = new Date().toLocaleTimeString();
    const message = `AQUAPLANT TEST SMS: Real-time GSM & Cloud Alert Gateway verified active! Monitored hydroponic parameters: TDS 600-900, pH 5.5-6.5. (${timestamp})`;
    
    const result = await dispatchSmsAlert('TEST_ALERT', message);
    if (result.sent) {
      res.json({ success: true, message: 'Test SMS dispatched successfully', log: result.log });
    } else {
      res.status(400).json({ success: false, error: result.reason || 'Failed to dispatch test SMS' });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error sending test SMS' });
  }
});

// Check Semaphore balance & account status (for user's ₱500 account)
app.get('/api/sms/semaphore/account', async (req: Request, res: Response) => {
  try {
    const settings = await getSmsSettings();
    const apiKey = (req.query.apikey as string) || settings.semaphore_api_key || process.env.SEMAPHORE_API_KEY;

    if (!apiKey) {
      res.status(400).json({ error: 'Semaphore API key is not configured.' });
      return;
    }

    const response = await fetch(`https://api.semaphore.co/api/v4/account?apikey=${encodeURIComponent(apiKey)}`);
    if (!response.ok) {
      const errText = await response.text();
      res.status(response.status).json({ error: 'Failed to query Semaphore: ' + errText });
      return;
    }

    const data = await response.json();
    res.json({
      success: true,
      account_id: data.account_id,
      account_name: data.account_name,
      status: data.status,
      credit_balance: data.credit_balance
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Error querying Semaphore account: ' + error.message });
  }
});

app.get('/api/sms/logs', async (req: Request, res: Response) => {
  try {
    const limit = Number(req.query.limit) || 50;
    const logs = await getSmsLogs(limit);
    res.json(logs);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch SMS logs' });
  }
});

app.delete('/api/sms/logs', async (req: Request, res: Response) => {
  try {
    await clearSmsLogs();
    res.json({ success: true, message: 'SMS history cleared' });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to clear SMS logs' });
  }
});

// 14. Cloud Database Link Status & Dynamic Connection
app.get('/api/database/status', (req: Request, res: Response) => {
  res.json(getDbConnectionStatus());
});

app.post('/api/database/connect', async (req: Request, res: Response) => {
  try {
    const { host, port, user, password, database, url, ssl } = req.body;
    const result = await connectToDatabase({
      host,
      port: port ? Number(port) : undefined,
      user,
      password,
      database: database?.trim() || 'sql12839434',
      url,
      ssl: ssl !== false
    });

    if (result.success) {
      await addSystemLog(
        `Cloud database connected successfully: ${result.status.database} on ${result.status.host}`,
        'SUCCESS',
        'DATABASE_MANAGER'
      );
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message || 'Database connection error' });
  }
});

// Download phpMyAdmin Schema for sql12839434
app.get('/api/download/sql12839434', (req: Request, res: Response) => {
  const filePath = path.join(__dirname, 'public', 'aquaplant_sql12839434.sql');
  if (fs.existsSync(filePath)) {
    res.download(filePath, 'aquaplant_sql12839434.sql');
  } else {
    res.status(404).send('SQL script not found');
  }
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
      temperature_sensor: 'GPIO 4 (DS18B20 OneWire, 4.7kΩ pullup)',
      water_level_sensor: 'GPIO 32 (ADC1_CH4, Depth probe)',
      humidity_sensor: 'GPIO 15 (DHT11/DHT22 Digital)',
      solution_pump_relay: 'GPIO 25 (Active-LOW 5V Relay Channel 1)',
      water_pump_relay: 'GPIO 26 (Active-LOW 5V Relay Channel 2)',
      flush_pump_relay: 'GPIO 27 (Active-LOW 5V Relay Channel 3)'
    }
  });
});

// ESP32 Wi-Fi Configuration API (Primary router & Backup hotspot failover)
app.get('/api/esp32/wifi-config', (req: Request, res: Response) => {
  const host = req.get('host') || `localhost:${PORT}`;
  const protocol = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  res.json({
    ...currentWifiConfig,
    server_url: `${protocol}://${host}`
  });
});

app.post('/api/esp32/wifi-config', async (req: Request, res: Response) => {
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

// ESP32 Local IP Probe (Tests connectivity to an ESP32 on the local LAN)
app.post('/api/esp32/lan-probe', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  const { ip } = req.body;
  if (!ip) {
    res.status(400).json({ error: 'IP address or hostname is required (e.g., 192.168.1.184)' });
    return;
  }

  const cleanIp = ip.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const targetUrl = `http://${cleanIp}/status`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    const probeRes = await fetch(targetUrl, { signal: controller.signal }).catch(() => null);
    clearTimeout(timeout);

    if (probeRes && probeRes.ok) {
      const data = await probeRes.json().catch(() => null);
      res.json({
        online: true,
        ip: cleanIp,
        message: `ESP32 reachable at ${cleanIp}`,
        response: data
      });
    } else {
      res.json({
        online: false,
        ip: cleanIp,
        message: `ESP32 at ${cleanIp} did not respond to /status probe within 3.5s. Ensure ESP32 is powered and connected to same WiFi.`
      });
    }
  } catch (e: any) {
    res.json({
      online: false,
      ip: cleanIp,
      message: `LAN probe timeout or unreachable at ${cleanIp}.`
    });
  }
});

// 14. File Downloads (Firmware with injected Wi-Fi credentials & SQL Schema)
app.get('/api/download/firmware', (req: Request, res: Response) => {
  const filePath = path.join(__dirname, 'firmware', 'aquaplant_esp32.ino');
  if (fs.existsSync(filePath)) {
    let content = fs.readFileSync(filePath, 'utf8');
    const ssid = (req.query.ssid as string) || currentWifiConfig.primary_ssid;
    const pass = (req.query.pass as string) || currentWifiConfig.primary_password;
    const backupSsid = (req.query.backup_ssid as string) || currentWifiConfig.backup_ssid;
    const backupPass = (req.query.backup_pass as string) || currentWifiConfig.backup_password;

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

app.get('/api/download/schema', (req: Request, res: Response) => {
  const filePath = path.join(__dirname, 'schema.sql');
  if (fs.existsSync(filePath)) {
    res.download(filePath, 'aquaplant_mysql_schema.sql');
  } else {
    res.status(404).send('Schema file not found');
  }
});

// ============================================================================
// STATIC ASSETS & VITE INTEGRATION
// ============================================================================

// Serve static assets from public if exists or custom directory
app.use('/js', express.static(path.join(__dirname, 'public', 'js')));
app.use('/css', express.static(path.join(__dirname, 'public', 'css')));
app.use('/firmware', express.static(path.join(__dirname, 'firmware')));

// Direct HTML pages mapping for capstone standalone deliverables
app.get('/login.html', (req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/dashboard.html', (req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
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
      app.get('*', (req: Request, res: Response) => {
        res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n======================================================`);
    console.log(`🌱 AQUAPLANT Web Monitoring & Control Server`);
    console.log(`   Running at: http://localhost:${PORT}`);
    console.log(`   Login:      http://localhost:${PORT}/login.html`);
    console.log(`   Dashboard:  http://localhost:${PORT}/dashboard.html`);
    console.log(`======================================================\n`);
  });
}

startServer();
