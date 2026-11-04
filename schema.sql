-- ============================================================================
-- AQUAPLANT: Automated Hydroponic Reservoir Flushing & Nutrient Re-Balancing
-- Capstone Project Database Schema (MySQL / MariaDB / AWS RDS)
-- ============================================================================

CREATE DATABASE IF NOT EXISTS `aquaplant` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `aquaplant`;

-- Drop existing tables if needed (in reverse dependency order)
SET FOREIGN_KEY_CHECKS = 0;
DROP PROCEDURE IF EXISTS `sp_update_control_state_with_log`;
DROP TABLE IF EXISTS `system_logs`;
DROP TABLE IF EXISTS `control_states`;
DROP TABLE IF EXISTS `sensor_readings`;
DROP TABLE IF EXISTS `users`;
SET FOREIGN_KEY_CHECKS = 1;

-- ----------------------------------------------------------------------------
-- Table: users
-- Stores authenticated operator accounts with bcrypt-hashed passwords.
-- ----------------------------------------------------------------------------
CREATE TABLE `users` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `username` VARCHAR(50) NOT NULL UNIQUE,
  `email` VARCHAR(100) NOT NULL UNIQUE,
  `password_hash` VARCHAR(255) NOT NULL,
  `role` VARCHAR(20) NOT NULL DEFAULT 'operator',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_users_username` (`username`),
  INDEX `idx_users_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- Table: sensor_readings
-- Time-series telemetry received from ESP32 analog/digital sensors.
-- ----------------------------------------------------------------------------
CREATE TABLE `sensor_readings` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `tds` DECIMAL(6,2) NOT NULL COMMENT 'Total Dissolved Solids in ppm (target 600-900)',
  `ph` DECIMAL(4,2) NOT NULL COMMENT 'Nutrient acidity/alkalinity 0.00 - 14.00 (target 5.5-6.5)',
  `temperature` DECIMAL(5,2) NOT NULL COMMENT 'Solution temperature in °C (target 20-28)',
  `water_level` DECIMAL(5,2) NOT NULL COMMENT 'Reservoir capacity percentage 0.00-100.00% (target 70-100)',
  `humidity` DECIMAL(5,2) NOT NULL DEFAULT 65.00 COMMENT 'Ambient canopy relative humidity in % (target 50-70)',
  `device_ip` VARCHAR(45) DEFAULT NULL,
  `recorded_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_sensor_recorded_at` (`recorded_at` DESC),
  INDEX `idx_sensor_feedback` (`tds`, `ph`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- ----------------------------------------------------------------------------
-- Table: control_states
-- Hardware actuator states for 3 submersible pumps:
-- 1. water_pump: Fresh / clean water supply submersible pump
-- 2. solution_pump: Solutioned / nutrient water submersible pump
-- 3. flush_pump: Flushing / reservoir evacuation submersible pump
-- 4. auto_mode: Autonomous biological feedback mode
-- ----------------------------------------------------------------------------
CREATE TABLE `control_states` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `device_name` VARCHAR(50) NOT NULL UNIQUE COMMENT 'water_pump, solution_pump, flush_pump, auto_mode',
  `state` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '0=OFF/IDLE, 1=ON/PUMPING',
  `manual_override` TINYINT(1) NOT NULL DEFAULT 0,
  `updated_by` INT NULL,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_device_name` (`device_name`),
  CONSTRAINT `fk_control_user` FOREIGN KEY (`updated_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- Table: system_logs
-- Audit trail of automated events, valve flushes, sensor alerts, and user commands.
-- ----------------------------------------------------------------------------
CREATE TABLE `system_logs` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `message` TEXT NOT NULL,
  `level` ENUM('INFO', 'WARN', 'ALERT', 'SUCCESS', 'ERROR') NOT NULL DEFAULT 'INFO',
  `source` VARCHAR(50) NOT NULL DEFAULT 'SYSTEM' COMMENT 'ESP32, WEB_USER, AUTO_FLUSH, SYSTEM',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_logs_created_at` (`created_at` DESC),
  INDEX `idx_logs_level` (`level`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- Stored Procedure: sp_update_control_state_with_log
-- Atomically updates an actuator state and records an auditable event in one transaction.
-- ----------------------------------------------------------------------------
DELIMITER $$
CREATE PROCEDURE `sp_update_control_state_with_log`(
  IN p_device_name VARCHAR(50),
  IN p_state TINYINT(1),
  IN p_source VARCHAR(50),
  IN p_user_id INT,
  IN p_log_msg VARCHAR(255),
  IN p_log_level VARCHAR(10)
)
BEGIN
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  START TRANSACTION;
    -- Upsert or update device state
    INSERT INTO `control_states` (`device_name`, `state`, `manual_override`, `updated_by`, `updated_at`)
    VALUES (p_device_name, p_state, 1, p_user_id, NOW())
    ON DUPLICATE KEY UPDATE
      `state` = p_state,
      `manual_override` = 1,
      `updated_by` = p_user_id,
      `updated_at` = NOW();

    -- Append to system logs
    INSERT INTO `system_logs` (`message`, `level`, `source`, `created_at`)
    VALUES (p_log_msg, p_log_level, p_source, NOW());
  COMMIT;
END$$
DELIMITER ;

-- ----------------------------------------------------------------------------
-- Seed Initial Control States for 3 Submersible Pumps
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

-- ----------------------------------------------------------------------------
-- Table: sms_settings
-- SMS Alert Gateway configuration and event notification toggles
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `sms_settings` (
  `id` INT PRIMARY KEY DEFAULT 1,
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

-- ----------------------------------------------------------------------------
-- Table: sms_logs
-- Outbox and historical audit trail for sent SMS notifications
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `sms_logs` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `phone_number` VARCHAR(32) NOT NULL,
  `message` TEXT NOT NULL,
  `event_type` VARCHAR(32) NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'DELIVERED',
  `provider` VARCHAR(32) NOT NULL DEFAULT 'SIMULATOR',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_sms_created_at` (`created_at`),
  INDEX `idx_sms_event` (`event_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed Initial SMS Alert Settings
INSERT INTO `sms_settings` (`id`, `phone_number`, `enabled`, `notify_on_flush`, `notify_on_low_ph`, `notify_on_high_ph`, `notify_on_low_tds`, `notify_on_high_tds`, `notify_on_low_water`, `cooldown_minutes`, `sms_provider`)
VALUES (1, '+63 917 888 1234', 1, 1, 1, 1, 1, 1, 1, 5, 'SIMULATOR')
ON DUPLICATE KEY UPDATE `phone_number` = `phone_number`;

-- Initial Startup Log
INSERT INTO `system_logs` (`message`, `level`, `source`) VALUES
  ('AQUAPLANT Database Initialized successfully with stored procedures and telemetry indexes.', 'SUCCESS', 'SYSTEM'),
  ('Hydroponic telemetry target thresholds active: TDS 600-900 ppm, pH 5.5-6.5, Temp 20-28°C.', 'INFO', 'SYSTEM'),
  ('SMS Gateway Alert System initialized: monitoring reservoir flush, low pH, high pH, and TDS.', 'SUCCESS', 'SMS_GATEWAY');
