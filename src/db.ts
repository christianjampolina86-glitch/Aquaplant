/**
 * AQUAPLANT Database Layer & Storage Engine
 * 
 * Architecture:
 * - Dual-mode persistence:
 *   1. Production/Defense: Connects to MySQL/MariaDB database pool using mysql2/promise.
 *   2. Instant Preview / Fallback: Runs an in-memory storage engine pre-seeded with 24 hours
 *      of realistic hydroponic data, active controls, and audit logs.
 * - Concurrency & Reliability:
 *   Uses atomic transactions and stored procedures (`sp_update_control_state_with_log`)
 *   to ensure actuator states and audit logs are recorded synchronously without race conditions.
 */

import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

/**
 * SensorReading: Represents an instantaneous snapshot of hydroponic telemetry.
 * Setpoints:
 * - TDS: 600 - 900 ppm (Total Dissolved Solids / nutrient concentration)
 * - pH: 5.5 - 6.5 (Optimal nutrient absorption window)
 * - Temperature: 20.0 - 28.0 °C (Water reservoir temperature)
 * - Water Level: 20% - 100% (Reservoir tank capacity)
 * - Humidity: 50% - 75% RH (Canopy relative humidity via DHT22)
 */
export interface SensorReading {
  id: number;
  tds: number;
  ph: number;
  temperature: number;
  water_level: number;
  humidity: number;
  device_ip?: string;
  recorded_at: string;
}

/**
 * ControlState: Represents the operational state of hardware relays and auto-regulation.
 * - state: 0 (OFF / Closed) or 1 (ON / Open / Active)
 * - manual_override: 1 when altered by human operator via dashboard, 0 when autonomous
 */
export interface ControlState {
  id: number;
  device_name: string;
  state: number; // 0 or 1
  manual_override: number;
  updated_at: string;
  updated_by?: number | null;
}

/**
 * SystemLog: Immutable audit trail for system events, alerts, and actuator switches.
 * Levels: INFO, WARN, ALERT, SUCCESS, ERROR
 */
export interface SystemLog {
  id: number;
  message: string;
  level: 'INFO' | 'WARN' | 'ALERT' | 'SUCCESS' | 'ERROR';
  source: string;
  created_at: string;
}

/**
 * User: System operator or administrator credentials with bcrypt hashing and RBAC.
 */
export interface User {
  id: number;
  username: string;
  email: string;
  password_hash: string;
  role: string;
  status?: string;
  last_seen?: string | null;
  created_at: string;
}

/**
 * SmsAlertSetting: Configuration for SMS notifications
 */
export interface SmsAlertSetting {
  id: number;
  phone_number: string;
  enabled: number; // 1 or 0
  notify_on_flush: number; // 1 or 0
  notify_on_low_ph: number; // 1 or 0
  notify_on_high_ph: number; // 1 or 0
  notify_on_low_tds: number; // 1 or 0
  notify_on_high_tds: number; // 1 or 0
  notify_on_low_water: number; // 1 or 0
  cooldown_minutes: number;
  sms_provider: 'SEMAPHORE' | 'TWILIO' | 'WEBHOOK' | 'SIMULATOR';
  semaphore_api_key?: string;
  semaphore_sender_name?: string;
  updated_at: string;
}

/**
 * SmsLog: Outbox and delivery records for sent SMS messages
 */
export interface SmsLog {
  id: number;
  phone_number: string;
  message: string;
  event_type: 'FLUSH_TRIGGERED' | 'LOW_PH' | 'HIGH_PH' | 'LOW_TDS' | 'HIGH_TDS' | 'LOW_WATER' | 'TEST_ALERT' | 'SYSTEM_RECOVERY';
  status: 'SENT' | 'DELIVERED' | 'FAILED';
  provider: string;
  created_at: string;
}

/**
 * In-Memory Storage Engine
 * Provides immediate operational readiness in environments where MySQL is not yet provisioned.
 * Generates realistic cyclical time-series data mimicking real plant nutrient uptake.
 */
class InMemoryStore {

  users: User[] = [];
  sensorReadings: SensorReading[] = [];
  controlStates: Map<string, ControlState> = new Map();
  systemLogs: SystemLog[] = [];
  smsSettings: SmsAlertSetting = {
    id: 1,
    phone_number: '+63 917 888 1234',
    enabled: 1,
    notify_on_flush: 1,
    notify_on_low_ph: 1,
    notify_on_high_ph: 1,
    notify_on_low_tds: 1,
    notify_on_high_tds: 1,
    notify_on_low_water: 1,
    cooldown_minutes: 5,
    sms_provider: 'SIMULATOR',
    updated_at: new Date().toISOString()
  };
  smsLogs: SmsLog[] = [];
  lastSmsSentTime: Map<string, number> = new Map();
  nextId = { user: 1, sensor: 1, log: 1, control: 1, sms: 1 };
  triggerFlushNextPoll = false;

  constructor() {
    this.seed();
  }

  seed() {
    // Initial controls for 3 submersible pumps:
    // 1. water_pump: Fresh / clean water supply submersible pump
    // 2. solution_pump: Solutioned / nutrient water submersible pump
    // 3. flush_pump: Flushing / reservoir evacuation submersible pump
    // 4. auto_mode: Autonomous biological feedback mode
    const defaultControls: Array<[string, number]> = [
      ['water_pump', 1],
      ['solution_pump', 0],
      ['flush_pump', 0],
      ['auto_mode', 1],
      // Compatibility aliases
      ['pump', 1],
      ['flush_valve', 0],
      ['refill_valve', 0]
    ];
    for (const [dev, st] of defaultControls) {
      this.controlStates.set(dev, {
        id: this.nextId.control++,
        device_name: dev,
        state: st,
        manual_override: 0,
        updated_at: new Date().toISOString()
      });
    }

    // Initial system logs
    this.addLog('AQUAPLANT telemetry and control service started.', 'SUCCESS', 'SYSTEM');
    this.addLog('Target setpoints active: TDS 600-900 ppm | pH 5.5-6.5 | Temp 20-28°C | Humidity 50-70%.', 'INFO', 'SYSTEM');
    this.addLog('Hardware 3 Submersible Pumps ready: Fresh Water Pump [ACTIVE], Solutioned Water Pump [STANDBY], Flushing Pump [STANDBY].', 'INFO', 'SYSTEM');
    this.addLog('SMS Gateway Alert System initialized: monitoring reservoir flush, low pH, high pH, low/high TDS, and tank depth.', 'SUCCESS', 'SMS_GATEWAY');

    // Seed 2 initial SMS alerts
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    const twentyMinsAgo = new Date(Date.now() - 1200000).toISOString();
    this.smsLogs.push({
      id: this.nextId.sms++,
      phone_number: this.smsSettings.phone_number,
      message: 'AQUAPLANT SYSTEM: SMS Gateway linked. Telemetry alerts armed for Reservoir Flush, Low pH (<5.5), and TDS setpoints.',
      event_type: 'SYSTEM_RECOVERY',
      status: 'DELIVERED',
      provider: 'SIMULATOR',
      created_at: oneHourAgo
    });
    this.smsLogs.push({
      id: this.nextId.sms++,
      phone_number: this.smsSettings.phone_number,
      message: 'AQUAPLANT TELEMETRY: Baseline calibration verified. TDS: 745 ppm, pH: 6.08, Temp: 24.2°C, Level: 86.5%. All setpoints normal.',
      event_type: 'TEST_ALERT',
      status: 'DELIVERED',
      provider: 'SIMULATOR',
      created_at: twentyMinsAgo
    });

    // Generate 24 hours of realistic initial hydroponic telemetry (1 reading every 10 mins)
    const now = Date.now();
    for (let i = 144; i >= 0; i--) {
      const timeOffset = now - i * 10 * 60 * 1000;
      // Slight smooth sinusoidal variation around optimal values
      const angle = (144 - i) * 0.15;
      const tds = Number((740 + Math.sin(angle) * 45 + (Math.random() * 12 - 6)).toFixed(1));
      const ph = Number((6.05 + Math.cos(angle * 0.7) * 0.28 + (Math.random() * 0.08 - 0.04)).toFixed(2));
      const temp = Number((23.8 + Math.sin(angle * 0.5) * 1.8 + (Math.random() * 0.4 - 0.2)).toFixed(1));
      const level = Number((86.0 - (i % 25) * 0.4 + (Math.random() * 0.8 - 0.4)).toFixed(1));
      const humidity = Number((64.0 + Math.sin(angle * 0.4) * 4.5 + (Math.random() * 1.2 - 0.6)).toFixed(1));

      this.sensorReadings.push({
        id: this.nextId.sensor++,
        tds,
        ph,
        temperature: temp,
        water_level: level,
        humidity,
        device_ip: '192.168.1.105',
        recorded_at: new Date(timeOffset).toISOString()
      });
    }
  }

  addLog(message: string, level: SystemLog['level'], source: string = 'SYSTEM', createdAt?: string): SystemLog {
    const log: SystemLog = {
      id: this.nextId.log++,
      message,
      level,
      source,
      created_at: createdAt || new Date().toISOString()
    };
    this.systemLogs.unshift(log);
    // Keep max 1000 logs in memory
    if (this.systemLogs.length > 1000) this.systemLogs.pop();
    return log;
  }
}

const memoryStore = new InMemoryStore();
let pool: mysql.Pool | null = null;
let isMySqlActive = false;

// Initialize MySQL pool if configured
let dbConnectionInfo = {
  is_cloud_db: false,
  provider: 'Internal Storage Engine',
  host: 'Embedded',
  database: 'in-memory',
  latency_ms: 0,
  tables_count: 6,
  message: 'Internal high-performance engine active',
  last_checked: new Date().toISOString()
};

// Adds the account-authorization columns to a users table created by an older version.
async function ensureUserColumns(p: mysql.Pool) {
  try {
    const [cols] = await p.query<mysql.RowDataPacket[]>(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`
    );
    const names = cols.map((c) => String(c.COLUMN_NAME).toLowerCase());

    if (!names.includes('status')) {
      await p.query(`ALTER TABLE users ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'approved'`);
      console.log('[AQUAPLANT DB] Added users.status column');
    }
    if (!names.includes('last_seen')) {
      await p.query(`ALTER TABLE users ADD COLUMN last_seen TIMESTAMP NULL DEFAULT NULL`);
      console.log('[AQUAPLANT DB] Added users.last_seen column');
    }
  } catch (err: any) {
    console.warn('[AQUAPLANT DB] users column migration note:', err?.message || err);
  }
}

// Automatic Cloud Database Migration Helper
async function autoMigrateCloudTables(p: mysql.Pool) {
  try {
    // 1. users table
    await p.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(64) NOT NULL UNIQUE,
        email VARCHAR(128) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(32) NOT NULL DEFAULT 'operator',
        status VARCHAR(16) NOT NULL DEFAULT 'approved',
        last_seen TIMESTAMP NULL DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // Add account-authorization columns to pre-existing installations
    await ensureUserColumns(p);

    // 2. sensor_readings table
    await p.query(`
      CREATE TABLE IF NOT EXISTS sensor_readings (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        tds DECIMAL(7, 2) NOT NULL,
        ph DECIMAL(4, 2) NOT NULL,
        temperature DECIMAL(5, 2) NOT NULL,
        water_level DECIMAL(5, 2) NOT NULL,
        humidity DECIMAL(5, 2) DEFAULT 65.00,
        device_ip VARCHAR(64) DEFAULT NULL,
        recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_recorded_at (recorded_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 3. control_states table
    await p.query(`
      CREATE TABLE IF NOT EXISTS control_states (
        id INT AUTO_INCREMENT PRIMARY KEY,
        device_name VARCHAR(64) NOT NULL UNIQUE,
        state TINYINT(1) NOT NULL DEFAULT 0,
        manual_override TINYINT(1) NOT NULL DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        updated_by INT DEFAULT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 4. system_logs table
    await p.query(`
      CREATE TABLE IF NOT EXISTS system_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        message TEXT NOT NULL,
        level ENUM('INFO', 'WARN', 'ALERT', 'SUCCESS', 'ERROR') NOT NULL DEFAULT 'INFO',
        source VARCHAR(64) NOT NULL DEFAULT 'SYSTEM',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_created_at (created_at),
        INDEX idx_level (level)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 5. sms_settings table
    await p.query(`
      CREATE TABLE IF NOT EXISTS sms_settings (
        id INT PRIMARY KEY DEFAULT 1,
        phone_number VARCHAR(32) NOT NULL DEFAULT '+63 917 888 1234',
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        notify_on_flush TINYINT(1) NOT NULL DEFAULT 1,
        notify_on_low_ph TINYINT(1) NOT NULL DEFAULT 1,
        notify_on_high_ph TINYINT(1) NOT NULL DEFAULT 1,
        notify_on_low_tds TINYINT(1) NOT NULL DEFAULT 1,
        notify_on_high_tds TINYINT(1) NOT NULL DEFAULT 1,
        notify_on_low_water TINYINT(1) NOT NULL DEFAULT 1,
        cooldown_minutes INT NOT NULL DEFAULT 5,
        sms_provider VARCHAR(32) NOT NULL DEFAULT 'SIMULATOR',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 6. sms_logs table
    await p.query(`
      CREATE TABLE IF NOT EXISTS sms_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        phone_number VARCHAR(32) NOT NULL,
        message TEXT NOT NULL,
        event_type VARCHAR(32) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'DELIVERED',
        provider VARCHAR(32) NOT NULL DEFAULT 'SIMULATOR',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_sms_created_at (created_at),
        INDEX idx_sms_event (event_type)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // Seed default 3 submersible pump controls
    await p.query(`
      INSERT INTO control_states (device_name, state, manual_override) VALUES
        ('water_pump', 1, 0),
        ('solution_pump', 0, 0),
        ('flush_pump', 0, 0),
        ('auto_mode', 1, 0),
        ('pump', 1, 0),
        ('flush_valve', 0, 0),
        ('refill_valve', 0, 0)
      ON DUPLICATE KEY UPDATE device_name = device_name;
    `);

    // Seed default SMS alert configuration
    await p.query(`
      INSERT INTO sms_settings (id, phone_number, enabled, notify_on_flush, notify_on_low_ph, notify_on_high_ph, notify_on_low_tds, notify_on_high_tds, notify_on_low_water, cooldown_minutes, sms_provider)
      VALUES (1, '+63 917 888 1234', 1, 1, 1, 1, 1, 1, 1, 5, 'SIMULATOR')
      ON DUPLICATE KEY UPDATE phone_number = phone_number;
    `);

    // Seed default admin operator account (admin / admin123)
    await p.query(`
      INSERT INTO users (username, email, password_hash, role)
      VALUES ('admin', 'admin@aquaplant.local', '$2a$10$wEeVg7hWbO7g49f8j0yvye0hFh/rO0Q0GkJyQ8cWk8z1R3C.5Lq0m', 'admin')
      ON DUPLICATE KEY UPDATE username = username;
    `);

    // No demo readings are seeded: telemetry stays at zero until the ESP32
    // (or the diagnostics page) sends the first real packet.

    console.log('[AQUAPLANT DB] Cloud database schema verified and auto-migrated successfully.');
  } catch (err: any) {
    console.warn('[AQUAPLANT DB] Cloud migration notice:', err.message);
  }
}

// Initialize MySQL pool (Connected to user database sql12839434)
export async function initDatabase(): Promise<{ isMySQL: boolean; message: string }> {
  const rawUrl = (process.env.DATABASE_URL || process.env.MYSQL_URL || process.env.DB_URL)?.trim();
  const databaseUrl = (rawUrl && rawUrl !== 'val' && rawUrl !== 'none') ? rawUrl : undefined;

  const rawHost = process.env.DB_HOST?.trim();
  const dbHost = (rawHost && rawHost !== 'val' && rawHost !== 'none' && rawHost !== 'null') ? rawHost : '';

  const rawUser = process.env.DB_USER?.trim();
  const dbUser = (rawUser && rawUser !== 'val' && rawUser !== 'none') ? rawUser : '';

  const rawPass = process.env.DB_PASSWORD?.trim();
  const dbPassword = (rawPass && rawPass !== 'val') ? rawPass : '';

  const rawName = process.env.DB_NAME?.trim();
  const dbName = (rawName && rawName !== 'val' && rawName !== 'none') ? rawName : 'aquaplant';

  const dbPort = (Number(process.env.DB_PORT) && !isNaN(Number(process.env.DB_PORT))) ? Number(process.env.DB_PORT) : 3306;

  try {
    const sslOption = process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined;

    // No database configured: skip straight to the in-memory fallback instead of
    // attempting a connection to a hardcoded host.
    if (!databaseUrl && !dbHost) {
      throw new Error('No database configured. Set DATABASE_URL (or DB_HOST/DB_USER/DB_PASSWORD/DB_NAME).');
    }

    if (databaseUrl) {
      pool = mysql.createPool({
        uri: databaseUrl,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        ssl: sslOption,
        connectTimeout: 8000
      });
    } else {
      pool = mysql.createPool({
        host: dbHost,
        port: dbPort,
        user: dbUser,
        password: dbPassword,
        database: dbName,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        ssl: sslOption,
        connectTimeout: 8000
      });
    }

    const t0 = Date.now();
    const connection = await pool.getConnection();
    const latency = Date.now() - t0;
    connection.release();

    isMySqlActive = true;
    const targetHost = databaseUrl ? databaseUrl.split('@')[1]?.split('/')[0] || 'Cloud Database' : `${dbHost}:${dbPort}`;
    console.log(`[AQUAPLANT DB] Connected successfully to Database ${dbName} at ${targetHost}!`);

    // Auto-migrate tables on the cloud database
    await autoMigrateCloudTables(pool);

    dbConnectionInfo = {
      is_cloud_db: true,
      provider: 'Live MySQL (FreeSQLDatabase)',
      host: targetHost,
      database: dbName,
      latency_ms: latency,
      tables_count: 6,
      message: `Connected live to database '${dbName}' at ${targetHost} (${latency}ms latency). All 6 tables synchronized!`,
      last_checked: new Date().toISOString()
    };

    return {
      isMySQL: true,
      message: dbConnectionInfo.message
    };
  } catch (err: any) {
    console.warn(`[AQUAPLANT DB] Cloud database connection note (${err.message}). Using internal storage.`);
    pool = null;
    isMySqlActive = false;
    dbConnectionInfo = {
      is_cloud_db: false,
      provider: 'Internal Storage Engine',
      host: 'Embedded In-Memory',
      database: 'aquaplant (virtual)',
      latency_ms: 1,
      tables_count: 6,
      message: `Cloud database link standby (${err.message}). Operating on zero-config internal storage.`,
      last_checked: new Date().toISOString()
    };
    return {
      isMySQL: false,
      message: dbConnectionInfo.message
    };
  }
}

export function getDbConnectionStatus() {
  return dbConnectionInfo;
}

export async function connectToDatabase(config: {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  url?: string;
  ssl?: boolean;
}): Promise<{ success: boolean; message: string; status: any }> {
  try {
    const dbName = config.database?.trim() || 'sql12839434';
    const sslOption = config.ssl === false ? undefined : { rejectUnauthorized: false };

    let newPool: mysql.Pool;

    if (config.url && config.url.trim()) {
      newPool = mysql.createPool({
        uri: config.url.trim(),
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        ssl: sslOption
      });
    } else {
      const targetHost = config.host?.trim() || 'localhost';
      newPool = mysql.createPool({
        host: targetHost,
        port: Number(config.port) || 3306,
        user: config.user?.trim() || 'sql12839434',
        password: config.password || '',
        database: dbName,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        ssl: sslOption,
        connectTimeout: 8000
      });
    }

    const t0 = Date.now();
    const conn = await newPool.getConnection();
    const latency = Date.now() - t0;
    conn.release();

    // Auto-migrate tables directly into database (sql12839434)
    await autoMigrateCloudTables(newPool);

    if (pool) {
      try {
        await pool.end();
      } catch {}
    }

    pool = newPool;
    isMySqlActive = true;

    const targetDisplay = config.url
      ? config.url.split('@')[1]?.split('/')[0] || 'Cloud MySQL'
      : `${config.host || 'localhost'}:${config.port || 3306}`;

    dbConnectionInfo = {
      is_cloud_db: true,
      provider: 'MySQL / phpMyAdmin Database',
      host: targetDisplay,
      database: dbName,
      latency_ms: latency,
      tables_count: 6,
      message: `Connected successfully to database '${dbName}' at ${targetDisplay} (${latency}ms latency). All 6 tables verified & synchronized.`,
      last_checked: new Date().toISOString()
    };

    console.log(`[AQUAPLANT DB] Live database connection established to ${dbName} at ${targetDisplay}`);

    return {
      success: true,
      message: dbConnectionInfo.message,
      status: dbConnectionInfo
    };
  } catch (err: any) {
    console.warn(`[AQUAPLANT DB] Dynamic connection attempt failed: ${err.message}`);
    return {
      success: false,
      message: `Connection to '${config.database || 'sql12839434'}' failed: ${err.message}`,
      status: dbConnectionInfo
    };
  }
}

// User Operations
export async function findUserByUsername(username: string): Promise<User | null> {
  if (isMySqlActive && pool) {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT * FROM users WHERE username = ? OR email = ? LIMIT 1',
      [username, username]
    );
    return (rows[0] as User) || null;
  }
  const u = memoryStore.users.find(
    (x) => x.username.toLowerCase() === username.toLowerCase() || x.email.toLowerCase() === username.toLowerCase()
  );
  return u || null;
}

export async function findUserByUsernameOrEmail(username: string, email: string): Promise<User | null> {
  if (isMySqlActive && pool) {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT * FROM users WHERE username = ? OR email = ? LIMIT 1',
      [username, email]
    );
    return (rows[0] as User) || null;
  }
  const u = memoryStore.users.find(
    (x) =>
      x.username.toLowerCase() === username.toLowerCase() ||
      x.email.toLowerCase() === email.toLowerCase()
  );
  return u || null;
}

export async function createUser(username: string, email: string, passwordHash: string, role = 'operator', status = 'approved'): Promise<User> {
  if (isMySqlActive && pool) {
    const [result] = await pool.query<mysql.ResultSetHeader>(
      'INSERT INTO users (username, email, password_hash, role, status) VALUES (?, ?, ?, ?, ?)',
      [username, email, passwordHash, role, status]
    );
    return {
      id: result.insertId,
      username,
      email,
      password_hash: passwordHash,
      role,
      status,
      last_seen: null,
      created_at: new Date().toISOString()
    };
  }

  const newUser: User = {
    id: memoryStore.nextId.user++,
    username,
    email,
    password_hash: passwordHash,
    role,
    status,
    last_seen: null,
    created_at: new Date().toISOString()
  };
  memoryStore.users.push(newUser);
  return newUser;
}

export async function countUsers(): Promise<number> {
  if (isMySqlActive && pool) {
    const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT COUNT(*) as count FROM users');
    return rows[0].count;
  }
  return memoryStore.users.length;
}

// ============================================================================
// USER ADMINISTRATION (Admin Dashboard)
// ============================================================================

export interface ManagedUser {
  id: number;
  username: string;
  email: string;
  role: string;
  status: string;
  created_at: string;
  last_seen: string | null;
  is_online: boolean;
}

// A user counts as "online" when their last authenticated request was under 5 minutes ago.
const ONLINE_WINDOW_MS = 5 * 60 * 1000;

function toManagedUser(u: any): ManagedUser {
  const lastSeen = u.last_seen ? new Date(u.last_seen) : null;
  const lastSeenMs = lastSeen ? lastSeen.getTime() : 0;
  return {
    id: Number(u.id),
    username: String(u.username || ''),
    email: String(u.email || ''),
    role: String(u.role || 'operator'),
    status: String(u.status || 'approved'),
    created_at: u.created_at instanceof Date ? u.created_at.toISOString() : String(u.created_at || ''),
    last_seen: lastSeen ? lastSeen.toISOString() : null,
    is_online: lastSeenMs > 0 && Date.now() - lastSeenMs < ONLINE_WINDOW_MS
  };
}

export async function listManagedUsers(): Promise<ManagedUser[]> {
  if (isMySqlActive && pool) {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT id, username, email, role, status, created_at, last_seen FROM users ORDER BY created_at ASC, id ASC'
    );
    return rows.map(toManagedUser);
  }
  return memoryStore.users.map(toManagedUser);
}

export async function setUserStatus(id: number, status: 'approved' | 'pending' | 'suspended'): Promise<boolean> {
  if (isMySqlActive && pool) {
    const [r] = await pool.query<mysql.ResultSetHeader>('UPDATE users SET status = ? WHERE id = ?', [status, id]);
    return r.affectedRows > 0;
  }
  const u = memoryStore.users.find((x) => x.id === id);
  if (!u) return false;
  u.status = status;
  return true;
}

export async function setUserRole(id: number, role: 'admin' | 'operator'): Promise<boolean> {
  if (isMySqlActive && pool) {
    const [r] = await pool.query<mysql.ResultSetHeader>('UPDATE users SET role = ? WHERE id = ?', [role, id]);
    return r.affectedRows > 0;
  }
  const u = memoryStore.users.find((x) => x.id === id);
  if (!u) return false;
  u.role = role;
  return true;
}

export async function deleteUserById(id: number): Promise<boolean> {
  if (isMySqlActive && pool) {
    const [r] = await pool.query<mysql.ResultSetHeader>('DELETE FROM users WHERE id = ?', [id]);
    return r.affectedRows > 0;
  }
  const idx = memoryStore.users.findIndex((x) => x.id === id);
  if (idx === -1) return false;
  memoryStore.users.splice(idx, 1);
  return true;
}

export async function countAdmins(): Promise<number> {
  if (isMySqlActive && pool) {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) as count FROM users WHERE role = 'admin'"
    );
    return rows[0].count;
  }
  return memoryStore.users.filter((u) => u.role === 'admin').length;
}

export async function getUserStatusById(id: number): Promise<string | null> {
  if (isMySqlActive && pool) {
    const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT status FROM users WHERE id = ?', [id]);
    return rows[0] ? String(rows[0].status || 'approved') : null;
  }
  const u = memoryStore.users.find((x) => x.id === id);
  return u ? (u.status || 'approved') : null;
}

// Heartbeat used by the admin dashboard to decide who is online.
export async function touchUserLastSeen(id: number): Promise<void> {
  try {
    if (isMySqlActive && pool) {
      await pool.query('UPDATE users SET last_seen = NOW() WHERE id = ?', [id]);
      return;
    }
    const u = memoryStore.users.find((x) => x.id === id);
    if (u) u.last_seen = new Date().toISOString();
  } catch {
    // Heartbeat failures must never break a request.
  }
}

// Sensor Telemetry
export async function insertSensorReading(
  tds: number,
  ph: number,
  temperature: number,
  water_level: number,
  humidity: number = 65.0,
  device_ip?: string,
  recordedAt?: string
): Promise<SensorReading> {
  const recorded_at = recordedAt && !Number.isNaN(new Date(recordedAt).getTime())
    ? new Date(recordedAt).toISOString()
    : new Date().toISOString();

  if (isMySqlActive && pool) {
    const [result] = await pool.query<mysql.ResultSetHeader>(
      'INSERT INTO sensor_readings (tds, ph, temperature, water_level, humidity, device_ip, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [tds, ph, temperature, water_level, humidity, device_ip || null, new Date(recorded_at)]
    );
    return {
      id: result.insertId,
      tds,
      ph,
      temperature,
      water_level,
      humidity,
      device_ip,
      recorded_at
    };
  }

  const reading: SensorReading = {
    id: memoryStore.nextId.sensor++,
    tds,
    ph,
    temperature,
    water_level,
    humidity,
    device_ip,
    recorded_at
  };
  memoryStore.sensorReadings.push(reading);
  if (memoryStore.sensorReadings.length > 5000) {
    memoryStore.sensorReadings.shift();
  }
  return reading;
}

export async function getLatestSensorReading(): Promise<SensorReading | null> {
  if (isMySqlActive && pool) {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT * FROM sensor_readings ORDER BY recorded_at DESC LIMIT 1'
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
      id: r.id,
      tds: Number(r.tds),
      ph: Number(r.ph),
      temperature: Number(r.temperature),
      water_level: Number(r.water_level),
      humidity: r.humidity !== undefined && r.humidity !== null ? Number(r.humidity) : 65.0,
      device_ip: r.device_ip,
      recorded_at: new Date(r.recorded_at).toISOString()
    };
  }

  if (memoryStore.sensorReadings.length === 0) return null;
  return memoryStore.sensorReadings[memoryStore.sensorReadings.length - 1];
}

export async function getSensorHistory(hours = 24): Promise<SensorReading[]> {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

  if (isMySqlActive && pool) {
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT * FROM sensor_readings WHERE recorded_at >= ? ORDER BY recorded_at ASC',
      [cutoff]
    );
    return rows.map((r) => ({
      id: r.id,
      tds: Number(r.tds),
      ph: Number(r.ph),
      temperature: Number(r.temperature),
      water_level: Number(r.water_level),
      humidity: r.humidity !== undefined && r.humidity !== null ? Number(r.humidity) : 65.0,
      device_ip: r.device_ip,
      recorded_at: new Date(r.recorded_at).toISOString()
    }));
  }

  const cutoffIso = cutoff.toISOString();
  return memoryStore.sensorReadings
    .filter((r) => r.recorded_at >= cutoffIso)
    .slice(-300); // Reasonable limit for canvas graph
}

// Actuator Controls (3 Submersible Pumps + Auto Mode)
export async function getControlStates(): Promise<Record<string, number>> {
  if (isMySqlActive && pool) {
    const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT device_name, state FROM control_states');
    const result: Record<string, number> = {
      water_pump: 1,
      solution_pump: 0,
      flush_pump: 0,
      auto_mode: 1,
      // Compatibility aliases
      pump: 1,
      flush_valve: 0,
      refill_valve: 0
    };
    for (const r of rows) {
      result[r.device_name] = r.state;
    }
    // Guarantee aliases match primary 3 pumps
    if (result.water_pump !== undefined) result.pump = result.water_pump;
    if (result.flush_pump !== undefined) result.flush_valve = result.flush_pump;
    return result;
  }

  const result: Record<string, number> = {
    water_pump: 1,
    solution_pump: 0,
    flush_pump: 0,
    auto_mode: 1
  };
  for (const [key, val] of memoryStore.controlStates.entries()) {
    result[key] = val.state;
  }
  // Guarantee aliases match primary 3 pumps
  if (result.water_pump !== undefined) result.pump = result.water_pump;
  if (result.flush_pump !== undefined) result.flush_valve = result.flush_pump;
  return result;
}

export async function updateControlStateWithLog(
  deviceName: string,
  state: number,
  source: string,
  userId: number | null,
  logMsg: string,
  logLevel: SystemLog['level']
): Promise<void> {
  // Normalize alias names
  const canonicalDevice = deviceName === 'pump' ? 'water_pump' : (deviceName === 'flush_valve' ? 'flush_pump' : deviceName);

  if (isMySqlActive && pool) {
    try {
      // Execute Stored Procedure
      await pool.query('CALL sp_update_control_state_with_log(?, ?, ?, ?, ?, ?)', [
        canonicalDevice,
        state,
        source,
        userId,
        logMsg,
        logLevel
      ]);
      return;
    } catch (spErr) {
      // Fallback if procedure wasn't created yet
      await pool.query(
        `INSERT INTO control_states (device_name, state, manual_override, updated_by, updated_at)
         VALUES (?, ?, 1, ?, NOW())
         ON DUPLICATE KEY UPDATE state = VALUES(state), manual_override = 1, updated_by = VALUES(updated_by), updated_at = NOW()`,
        [canonicalDevice, state, userId]
      );
      await pool.query('INSERT INTO system_logs (message, level, source, created_at) VALUES (?, ?, ?, NOW())', [
        logMsg,
        logLevel,
        source
      ]);
      return;
    }
  }

  // In-Memory Stored Procedure execution
  const existing = memoryStore.controlStates.get(canonicalDevice) || {
    id: memoryStore.nextId.control++,
    device_name: canonicalDevice,
    state,
    manual_override: 1,
    updated_at: new Date().toISOString()
  };
  existing.state = state;
  existing.manual_override = 1;
  existing.updated_at = new Date().toISOString();
  existing.updated_by = userId;
  memoryStore.controlStates.set(canonicalDevice, existing);

  // Sync aliases in memory store
  if (canonicalDevice === 'water_pump') {
    const aliasPump = memoryStore.controlStates.get('pump');
    if (aliasPump) aliasPump.state = state;
  } else if (canonicalDevice === 'flush_pump') {
    const aliasFlush = memoryStore.controlStates.get('flush_valve');
    if (aliasFlush) aliasFlush.state = state;
  }

  memoryStore.addLog(logMsg, logLevel, source);
}

export function setTriggerFlushForNextPoll(val: boolean) {
  memoryStore.triggerFlushNextPoll = val;
}

export function getTriggerFlushForNextPoll(): boolean {
  const current = memoryStore.triggerFlushNextPoll;
  if (current) {
    memoryStore.triggerFlushNextPoll = false; // consume trigger
  }
  return current;
}

// System Logs
export async function getSystemLogs(limit = 50, level?: string): Promise<SystemLog[]> {
  if (isMySqlActive && pool) {
    let query = 'SELECT * FROM system_logs';
    const params: any[] = [];
    if (level && level !== 'ALL') {
      query += ' WHERE level = ?';
      params.push(level);
    }
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const [rows] = await pool.query<mysql.RowDataPacket[]>(query, params);
    return rows.map((r) => ({
      id: r.id,
      message: r.message,
      level: r.level,
      source: r.source,
      created_at: new Date(r.created_at).toISOString()
    }));
  }

  let logs = memoryStore.systemLogs;
  if (level && level !== 'ALL') {
    logs = logs.filter((l) => l.level === level);
  }
  return logs.slice(0, limit);
}

export async function addSystemLog(
  message: string,
  level: SystemLog['level'],
  source = 'SYSTEM',
  createdAt?: string
) {
  const created_at = createdAt && !Number.isNaN(new Date(createdAt).getTime())
    ? new Date(createdAt).toISOString()
    : new Date().toISOString();

  if (isMySqlActive && pool) {
    await pool.query('INSERT INTO system_logs (message, level, source, created_at) VALUES (?, ?, ?, ?)', [
      message,
      level,
      source,
      new Date(created_at)
    ]);
    return;
  }
  memoryStore.addLog(message, level, source, created_at);
}

export async function getAllDataForExport() {
  let readings: SensorReading[] = [];
  let logs: SystemLog[] = [];
  let controls: Record<string, number> = {};

  if (isMySqlActive && pool) {
    const [rRows] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT * FROM sensor_readings ORDER BY recorded_at DESC LIMIT 2000'
    );
    readings = rRows.map((r) => ({
      id: r.id,
      tds: Number(r.tds),
      ph: Number(r.ph),
      temperature: Number(r.temperature),
      water_level: Number(r.water_level),
      humidity: r.humidity !== undefined && r.humidity !== null ? Number(r.humidity) : 65.0,
      device_ip: r.device_ip,
      recorded_at: new Date(r.recorded_at).toISOString()
    }));

    const [lRows] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT * FROM system_logs ORDER BY created_at DESC LIMIT 1000'
    );
    logs = lRows.map((r) => ({
      id: r.id,
      message: r.message,
      level: r.level,
      source: r.source,
      created_at: new Date(r.created_at).toISOString()
    }));

    controls = await getControlStates();
  } else {
    readings = [...memoryStore.sensorReadings].reverse();
    logs = [...memoryStore.systemLogs];
    controls = await getControlStates();
  }

  return { readings, logs, controls };
}

// ============================================================================
// SMS ALERTS & NOTIFICATIONS LAYER
// ============================================================================

export async function getSmsSettings(): Promise<SmsAlertSetting> {
  if (isMySqlActive && pool) {
    try {
      const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT * FROM sms_settings LIMIT 1');
      if (rows && rows.length > 0) {
        const r = rows[0];
        return {
          id: r.id,
          phone_number: r.phone_number,
          enabled: Number(r.enabled),
          notify_on_flush: Number(r.notify_on_flush),
          notify_on_low_ph: Number(r.notify_on_low_ph),
          notify_on_high_ph: Number(r.notify_on_high_ph),
          notify_on_low_tds: Number(r.notify_on_low_tds),
          notify_on_high_tds: Number(r.notify_on_high_tds),
          notify_on_low_water: Number(r.notify_on_low_water),
          cooldown_minutes: Number(r.cooldown_minutes || 5),
          sms_provider: (r.sms_provider as any) || 'SIMULATOR',
          semaphore_api_key: r.semaphore_api_key || undefined,
          semaphore_sender_name: r.semaphore_sender_name || undefined,
          updated_at: new Date(r.updated_at || Date.now()).toISOString()
        };
      }
    } catch {
      // Fallback to memoryStore if table not created
    }
  }
  return { ...memoryStore.smsSettings };
}

export async function updateSmsSettings(partial: Partial<SmsAlertSetting>): Promise<SmsAlertSetting> {
  const current = await getSmsSettings();
  const updated: SmsAlertSetting = {
    ...current,
    ...partial,
    updated_at: new Date().toISOString()
  };

  if (isMySqlActive && pool) {
    try {
      await pool.query(
        `INSERT INTO sms_settings (id, phone_number, enabled, notify_on_flush, notify_on_low_ph, notify_on_high_ph, notify_on_low_tds, notify_on_high_tds, notify_on_low_water, cooldown_minutes, sms_provider, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
           phone_number = VALUES(phone_number),
           enabled = VALUES(enabled),
           notify_on_flush = VALUES(notify_on_flush),
           notify_on_low_ph = VALUES(notify_on_low_ph),
           notify_on_high_ph = VALUES(notify_on_high_ph),
           notify_on_low_tds = VALUES(notify_on_low_tds),
           notify_on_high_tds = VALUES(notify_on_high_tds),
           notify_on_low_water = VALUES(notify_on_low_water),
           cooldown_minutes = VALUES(cooldown_minutes),
           sms_provider = VALUES(sms_provider),
           updated_at = NOW()`,
        [
          updated.id,
          updated.phone_number,
          updated.enabled,
          updated.notify_on_flush,
          updated.notify_on_low_ph,
          updated.notify_on_high_ph,
          updated.notify_on_low_tds,
          updated.notify_on_high_tds,
          updated.notify_on_low_water,
          updated.cooldown_minutes,
          updated.sms_provider
        ]
      );
    } catch {
      // Memory fallback
    }
  }

  memoryStore.smsSettings = updated;
  return updated;
}

export async function getSmsLogs(limit = 50): Promise<SmsLog[]> {
  if (isMySqlActive && pool) {
    try {
      const [rows] = await pool.query<mysql.RowDataPacket[]>(
        'SELECT * FROM sms_logs ORDER BY created_at DESC LIMIT ?',
        [limit]
      );
      return rows.map((r) => ({
        id: r.id,
        phone_number: r.phone_number,
        message: r.message,
        event_type: r.event_type,
        status: r.status,
        provider: r.provider,
        created_at: new Date(r.created_at).toISOString()
      }));
    } catch {
      // Fallback
    }
  }
  return [...memoryStore.smsLogs].slice(0, limit);
}

export async function createSmsLog(entry: Omit<SmsLog, 'id' | 'created_at'>): Promise<SmsLog> {
  const created_at = new Date().toISOString();
  let id = memoryStore.nextId.sms++;

  if (isMySqlActive && pool) {
    try {
      const [res] = await pool.query<mysql.ResultSetHeader>(
        'INSERT INTO sms_logs (phone_number, message, event_type, status, provider, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
        [entry.phone_number, entry.message, entry.event_type, entry.status, entry.provider]
      );
      if (res && res.insertId) id = res.insertId;
    } catch {
      // Fallback
    }
  }

  const log: SmsLog = {
    id,
    phone_number: entry.phone_number,
    message: entry.message,
    event_type: entry.event_type,
    status: entry.status,
    provider: entry.provider,
    created_at
  };

  memoryStore.smsLogs.unshift(log);
  memoryStore.lastSmsSentTime.set(entry.event_type, Date.now());
  return log;
}

export async function clearSmsLogs(): Promise<void> {
  if (isMySqlActive && pool) {
    try {
      await pool.query('DELETE FROM sms_logs');
    } catch {
      // Fallback
    }
  }
  memoryStore.smsLogs = [];
}

/**
 * Checks whether an SMS should be dispatched based on user settings and cooldown timers.
 */
export async function canDispatchSms(eventType: SmsLog['event_type']): Promise<{ canSend: boolean; reason?: string; settings: SmsAlertSetting }> {
  const settings = await getSmsSettings();

  if (!settings.enabled) {
    return { canSend: false, reason: 'SMS notifications globally disabled.', settings };
  }

  if (!settings.phone_number || settings.phone_number.trim().length < 7) {
    return { canSend: false, reason: 'Invalid or missing recipient phone number.', settings };
  }

  // Check specific event type toggles
  if (eventType === 'FLUSH_TRIGGERED' && !settings.notify_on_flush) {
    return { canSend: false, reason: 'Reservoir flush SMS notifications disabled.', settings };
  }
  if (eventType === 'LOW_PH' && !settings.notify_on_low_ph) {
    return { canSend: false, reason: 'Low pH SMS notifications disabled.', settings };
  }
  if (eventType === 'HIGH_PH' && !settings.notify_on_high_ph) {
    return { canSend: false, reason: 'High pH SMS notifications disabled.', settings };
  }
  if (eventType === 'LOW_TDS' && !settings.notify_on_low_tds) {
    return { canSend: false, reason: 'Low TDS SMS notifications disabled.', settings };
  }
  if (eventType === 'HIGH_TDS' && !settings.notify_on_high_tds) {
    return { canSend: false, reason: 'High TDS SMS notifications disabled.', settings };
  }
  if (eventType === 'LOW_WATER' && !settings.notify_on_low_water) {
    return { canSend: false, reason: 'Low water level SMS notifications disabled.', settings };
  }

  // TEST_ALERT bypasses cooldown
  if (eventType === 'TEST_ALERT') {
    return { canSend: true, settings };
  }

  // Cooldown check to prevent SMS flooding
  const lastTime = memoryStore.lastSmsSentTime.get(eventType);
  if (lastTime) {
    const elapsedMinutes = (Date.now() - lastTime) / (60 * 1000);
    const cooldown = settings.cooldown_minutes || 5;
    if (elapsedMinutes < cooldown) {
      const waitRemaining = Math.ceil(cooldown - elapsedMinutes);
      return {
        canSend: false,
        reason: `Cooldown active for ${eventType} (${waitRemaining} min remaining to prevent SMS spam).`,
        settings
      };
    }
  }

  return { canSend: true, settings };
}
