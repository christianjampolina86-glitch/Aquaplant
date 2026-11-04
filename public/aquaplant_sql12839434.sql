-- ============================================================================
-- AQUAPLANT: Automated Hydroponic Reservoir Flushing & Telemetry System
-- SQL Schema Import for Database: sql12839434 (phpMyAdmin Compatible)
-- ============================================================================

-- Table 1: users (Operator Authentication)
CREATE TABLE IF NOT EXISTS `users` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `username` VARCHAR(64) NOT NULL UNIQUE,
  `email` VARCHAR(128) NOT NULL UNIQUE,
  `password_hash` VARCHAR(255) NOT NULL,
  `role` VARCHAR(32) NOT NULL DEFAULT 'operator',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_users_username` (`username`),
  INDEX `idx_users_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table 2: sensor_readings (Live Telemetry Time-Series)
CREATE TABLE IF NOT EXISTS `sensor_readings` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `tds` DECIMAL(7, 2) NOT NULL COMMENT 'Total Dissolved Solids in ppm (Setpoint: 600-900)',
  `ph` DECIMAL(4, 2) NOT NULL COMMENT 'Acidity/Alkalinity level (Setpoint: 5.50-6.50)',
  `temperature` DECIMAL(5, 2) NOT NULL COMMENT 'Reservoir water temperature in °C',
  `water_level` DECIMAL(5, 2) NOT NULL COMMENT 'Tank depth percentage (0.00 - 100.00%)',
  `humidity` DECIMAL(5, 2) DEFAULT 65.00 COMMENT 'Relative canopy humidity % RH',
  `device_ip` VARCHAR(64) DEFAULT NULL,
  `recorded_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_sensor_recorded_at` (`recorded_at` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table 3: control_states (Submersible Pumps & Auto Mode)
-- 1. water_pump: Fresh water submersible pump (GPIO 25)
-- 2. solution_pump: Solutioned water submersible pump (GPIO 26)
-- 3. flush_pump: Flushing submersible pump (GPIO 27)
-- 4. auto_mode: Autonomous biological feedback mode
CREATE TABLE IF NOT EXISTS `control_states` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `device_name` VARCHAR(64) NOT NULL UNIQUE,
  `state` TINYINT(1) NOT NULL DEFAULT 0,
  `manual_override` TINYINT(1) NOT NULL DEFAULT 0,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `updated_by` INT DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table 4: system_logs (Audit Trail)
CREATE TABLE IF NOT EXISTS `system_logs` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `message` TEXT NOT NULL,
  `level` ENUM('INFO', 'WARN', 'ALERT', 'SUCCESS', 'ERROR') NOT NULL DEFAULT 'INFO',
  `source` VARCHAR(64) NOT NULL DEFAULT 'SYSTEM',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_logs_created_at` (`created_at` DESC),
  INDEX `idx_logs_level` (`level`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table 5: sms_settings (Cellular Alert Configuration)
CREATE TABLE IF NOT EXISTS `sms_settings` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `phone_number` VARCHAR(32) NOT NULL DEFAULT '+63 917 888 1234',
  `enabled` TINYINT(1) NOT NULL DEFAULT 1,
  `notify_on_flush` TINYINT(1) NOT NULL DEFAULT 1,
  `notify_on_low_ph` TINYINT(1) NOT NULL DEFAULT 1,
  `notify_on_high_ph` TINYINT(1) NOT NULL DEFAULT 1,
  `notify_on_low_tds` TINYINT(1) NOT NULL DEFAULT 1,
  `notify_on_high_tds` TINYINT(1) NOT NULL DEFAULT 1,
  `notify_on_low_water` TINYINT(1) NOT NULL DEFAULT 1,
  `cooldown_minutes` INT NOT NULL DEFAULT 5,
  `sms_provider` VARCHAR(32) NOT NULL DEFAULT 'SIMULATOR',
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Table 6: sms_logs (Cellular Outbox Delivery Records)
CREATE TABLE IF NOT EXISTS `sms_logs` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `phone_number` VARCHAR(32) NOT NULL,
  `message` TEXT NOT NULL,
  `event_type` VARCHAR(32) NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'DELIVERED',
  `provider` VARCHAR(32) NOT NULL DEFAULT 'SIMULATOR',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_sms_created_at` (`created_at` DESC),
  INDEX `idx_sms_event` (`event_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- Initial Seeds for Submersible Pumps & Auto Mode
-- ----------------------------------------------------------------------------
INSERT INTO `control_states` (`device_name`, `state`, `manual_override`) VALUES
  ('water_pump', 1, 0),
  ('solution_pump', 0, 0),
  ('flush_pump', 0, 0),
  ('auto_mode', 1, 0),
  ('pump', 1, 0),
  ('flush_valve', 0, 0),
  ('refill_valve', 0, 0)
ON DUPLICATE KEY UPDATE `device_name` = `device_name`;

-- Seed SMS alert config
INSERT INTO `sms_settings` (`id`, `phone_number`, `enabled`, `notify_on_flush`, `notify_on_low_ph`, `notify_on_high_ph`, `notify_on_low_tds`, `notify_on_high_tds`, `notify_on_low_water`, `cooldown_minutes`, `sms_provider`)
VALUES (1, '+63 917 888 1234', 1, 1, 1, 1, 1, 1, 1, 5, 'SIMULATOR')
ON DUPLICATE KEY UPDATE `phone_number` = `phone_number`;

-- Seed Default Admin Operator (admin / admin123)
-- Password hash generated with bcrypt 10 salt rounds
INSERT INTO `users` (`username`, `email`, `password_hash`, `role`) VALUES
  ('admin', 'admin@aquaplant.local', '$2a$10$wEeVg7hWbO7g49f8j0yvye0hFh/rO0Q0GkJyQ8cWk8z1R3C.5Lq0m', 'admin')
ON DUPLICATE KEY UPDATE `username` = `username`;

-- Seed Initial System Logs
INSERT INTO `system_logs` (`message`, `level`, `source`) VALUES
  ('AQUAPLANT database synchronized successfully for database sql12839434.', 'SUCCESS', 'DATABASE_INIT'),
  ('Autonomous closed-loop monitor engaged: TDS Setpoint 600-900 ppm, pH Setpoint 5.50-6.50.', 'INFO', 'AUTONOMOUS_DAEMON'),
  ('Cellular SMS notification gateway verified active for emergency reservoir flush and threshold alerts.', 'INFO', 'SMS_GATEWAY');
