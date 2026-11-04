# 🌱 AQUAPLANT: Capstone System Guide & Documentation

**"ESP32-Based Automated Hydroponic Reservoir Flushing and Nutrient Re-Balancing System Using TDS/pH Feedback"**

---

## 📑 Table of Contents
1. [Project Overview & System Architecture](#project-overview--system-architecture)
2. [Hardware Pinout & Wiring](#hardware-pinout--wiring)
3. [Local Development Setup (XAMPP + Node.js)](#local-development-setup-xampp--nodejs)
4. [Production Deployment Guide (AWS RDS + AWS EC2 + HTTPS)](#production-deployment-guide-aws-rds--aws-ec2--https)
5. [Sensor Calibration Guide (TDS, pH, Temp, Level)](#sensor-calibration-guide)
6. [ESP32 Firmware Guide & Dual-Mode Networking](#esp32-firmware-guide--dual-mode-networking)
7. [Database Schema & Stored Procedure Documentation](#database-schema--stored-procedure-documentation)
8. [Capstone Defense Panel Q&A Cheat Sheet](#capstone-defense-panel-qa-cheat-sheet)

---

## 1. Project Overview & System Architecture

AQUAPLANT is an IoT-enabled cyber-physical hydroponics management platform designed to automate reservoir water replenishment and chemical balance:
- **Telemetry Loop:** The ESP32 micro-controller samples nutrient solution Total Dissolved Solids (TDS in ppm), acidity/alkalinity (pH), temperature (°C), and reservoir water level (%).
- **Automated Feedback Control:** When TDS rises above **900 ppm** (osmotic stress/salt lock) or drops below **600 ppm** (nutrient depletion), or when pH strays from the **5.5 - 6.5** optimal biological band, the system automatically activates a timed drain-and-refill sequence.
- **Fail-Safe & Dual Connectivity:** The ESP32 maintains an autonomous offline state machine with its own WiFi Access Point (`192.168.4.1`) and mDNS (`http://aquaplant.local`), alongside cloud synchronization to the Node.js/Express web dashboard.

```
+-------------------------------------------------------------+
|                     HYDROPONIC RESERVOIR                    |
|   [TDS Sensor]   [pH Probe]   [DS18B20 Temp]   [Water Level] |
+-------------------------------------------------------------+
                               | Analog / 1-Wire
                               v
+-------------------------------------------------------------+
|                         ESP32 MCU                           |
|  - 60s Telemetry HTTP POST (/api/sensors)                   |
|  - 3s Command Polling (/api/controls/device)               |
|  - Local Web Portal (192.168.4.1 / aquaplant.local)         |
|  - Relays: [Circulation Pump] [Flush Valve] [Refill Valve]  |
+-------------------------------------------------------------+
                 ^                               ^
   Offline WiFi  |                               | WiFi (STA) / Internet
   AP Direct     |                               v
+-----------------------+     +-------------------------------+
|  Local Mobile Browser |     |    AQUAPLANT Cloud Server     |
| (No Router Needed)    |     |  (Node.js + Express + MySQL)  |
+-----------------------+     +-------------------------------+
                                             ^
                                             | REST / JWT Auth
                                             v
                              +-------------------------------+
                              |    Responsive Web Dashboard   |
                              |  - Real-time HTML5 Canvas     |
                              |  - Actuator Controls          |
                              |  - ExcelJS Data Export        |
                              +-------------------------------+
```

---

## 2. Hardware Pinout & Wiring

| Sensor / Module | ESP32 GPIO | Operating Voltage | Notes |
|---|---|---|---|
| **Analog TDS Sensor** | `GPIO 34` (ADC1_CH6) | 3.3V - 5.0V | Gravity TDS meter, connected to ADC1 pin (ADC2 cannot be used with WiFi). |
| **Analog pH Probe** | `GPIO 35` (ADC1_CH7) | 5.0V (Signal via 3.3V divider or calibrated) | E-201-C glass electrode probe. |
| **DS18B20 Temp Sensor**| `GPIO 4` | 3.3V | 1-Wire digital bus. **Requires a 4.7kΩ pull-up resistor** between DATA and 3.3V! |
| **Water Level Sensor** | `GPIO 32` (ADC1_CH4) | 3.3V | Submersible analog probe or ultrasonic JSN-SR04T. |
| **Canopy Humidity (DHT22)** | `GPIO 13` | 3.3V - 5.0V | Ambient canopy relative humidity (% RH, target 50-70%). |
| **Relay 1: Pump** | `GPIO 25` | 5.0V VCC / Logic 3.3V | Optoisolated relay module (Active LOW). Submersible 12V DC pump. |
| **Relay 2: Flush Valve**| `GPIO 26` | 5.0V VCC / Logic 3.3V | Active LOW. 12V Solenoid valve connected to drain outlet. |
| **Relay 3: Refill Valve**| `GPIO 27`| 5.0V VCC / Logic 3.3V | Active LOW. 12V Solenoid connected to fresh water reservoir. |
| **Status LED** | `GPIO 2` | Onboard | Blinks during WiFi search, solid when online. |

> **Crucial Hardware Tip for Defense:** Never use ADC2 pins (GPIO 0, 2, 4, 12, 13, 14, 15, 25, 26, 27) for analog sensors while WiFi is active. WiFi uses the ADC2 peripheral. All analog inputs in AQUAPLANT use **ADC1 pins** (32, 34, 35) to prevent reading corruptions.

---

## 3. Local Development Setup (XAMPP + Node.js)

### Step 1: Install XAMPP
1. Download and install XAMPP from [apachefriends.org](https://www.apachefriends.org/).
2. Open the **XAMPP Control Panel** and click **Start** on **Apache** and **MySQL**.
3. Open your browser and navigate to `http://localhost/phpmyadmin`.

### Step 2: Import Database Schema
1. In phpMyAdmin, click the **Import** tab.
2. Select the provided `schema.sql` file and click **Go**.
3. This creates the `aquaplant` database with `users`, `sensor_readings`, `control_states`, `system_logs`, and the stored procedure `sp_update_control_state_with_log`.

### Step 3: Configure Environment Variables
In the project root folder, ensure `.env` contains:
```ini
PORT=3000
JWT_SECRET=super_secret_aquaplant_jwt_key_2026
DEVICE_KEY=aquaplant_esp32_device_key_secret_2026
ALLOW_REGISTRATION=true
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=aquaplant
DB_SSL=false
```

### Step 4: Run Node.js Server
```bash
npm install
npm run dev
```
Open `http://localhost:3000` in your web browser.

---

## 4. Production Deployment Guide (AWS RDS + AWS EC2 + HTTPS)

### A. AWS RDS (Relational Database Service - MySQL)
1. Sign in to AWS Console -> Navigate to **RDS** -> Click **Create database**.
2. Select **MySQL** (version 8.0), Template: **Free Tier**.
3. Set **DB instance identifier**: `aquaplant-db`.
4. Master username: `admin`, Master password: `YourStrongPassword!`.
5. Under **Connectivity**:
   - Set **Public Access**: `Yes` (or link to the same VPC as your EC2 instance).
   - In VPC Security Group: Allow Inbound Type **MYSQL/Aurora (Port 3306)** from your EC2 Security Group or IP.
6. Under **Additional Configuration**, set **Initial database name**: `aquaplant`.
7. Once created, note your RDS Endpoint (e.g. `aquaplant-db.c123456789.us-east-1.rds.amazonaws.com`).
8. Connect using MySQL Workbench or CLI and execute `schema.sql`.

### B. AWS EC2 (Virtual Server)
1. Launch an **Ubuntu 24.04 LTS** t2.micro instance.
2. In the Security Group, open ports:
   - `22` (SSH)
   - `80` (HTTP)
   - `443` (HTTPS)
   - `3000` (Node.js fallback)
3. SSH into your server:
   ```bash
   ssh -i your-key.pem ubuntu@ec2-xx-xx-xx-xx.compute-1.amazonaws.com
   ```
4. Install Node.js 20 & Git:
   ```bash
   sudo apt update && sudo apt upgrade -y
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt install -y nodejs git build-essential nginx certbot python3-certbot-nginx
   sudo npm install -g pm2
   ```

### C. Deploy Application
```bash
git clone <your-repository-url> /var/www/aquaplant
cd /var/www/aquaplant
npm install
npm run build
```
Create `/var/www/aquaplant/.env`:
```ini
PORT=3000
JWT_SECRET=super_secret_production_key_xyz987
DEVICE_KEY=aquaplant_esp32_device_key_secret_2026
ALLOW_REGISTRATION=false
DB_HOST=aquaplant-db.c123456789.us-east-1.rds.amazonaws.com
DB_PORT=3306
DB_USER=admin
DB_PASSWORD=YourStrongPassword!
DB_NAME=aquaplant
DB_SSL=true
```
Start process with PM2:
```bash
pm2 start server.ts --name aquaplant --interpreter tsx
pm2 startup
pm2 save
```

### D. Nginx Reverse Proxy & Free SSL with Let's Encrypt
Edit `/etc/nginx/sites-available/aquaplant`:
```nginx
server {
    server_name yourdomain.com www.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```
Enable site and obtain HTTPS certificate:
```bash
sudo ln -s /etc/nginx/sites-available/aquaplant /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```

---

## 5. Sensor Calibration Guide

### 1. TDS (Total Dissolved Solids) Sensor Calibration
- **Principles:** Pure water has minimal electrical conductivity. Dissolved mineral salts dissociate into ions that conduct electrical current between the probe electrodes.
- **Buffer Solution:** Standard **1413 µS/cm** EC buffer solution (equivalent to **707 ppm** TDS at 0.5 conversion factor).
- **Procedure:**
  1. Rinse probe thoroughly in distilled/deionized water.
  2. Submerge in 1413 µS/cm calibration buffer. Note the liquid temperature with the DS18B20.
  3. ESP32 firmware includes automatic temperature compensation:
     $$V_{\text{compensated}} = \frac{V_{\text{raw}}}{1.0 + 0.02 \times (T_{\text{water}} - 25.0)}$$
  4. Adjust `tdsKValue` in `aquaplant_esp32.ino`:
     $$\text{kValue} = \frac{707.0}{\text{Measured TDS}}$$

### 2. Analog pH Sensor Probe Calibration (2-Point Linear Fit)
- **Standard Buffers:** pH 4.00 (Red/Pink buffer) and pH 7.00 (Green/Clear neutral buffer).
- **Math Formula:** $pH = (m \times V) + b$
- **Procedure:**
  1. Rinse pH probe in distilled water.
  2. Dip in **pH 7.00 neutral buffer**. Wait 60 seconds for voltage to settle. Record $V_7$ (typically ~1.50V - 1.65V).
  3. Rinse and dip in **pH 4.00 acid buffer**. Record $V_4$ (typically ~2.00V - 2.15V).
  4. Calculate slope $m$ and intercept $b$:
     $$m = \frac{4.00 - 7.00}{V_4 - V_7} = \frac{-3.00}{V_4 - V_7}$$
     $$b = 7.00 - (m \times V_7)$$
  5. Update `phSlope` and `phIntercept` variables in `firmware/aquaplant_esp32.ino`.

### 3. DS18B20 Temperature Calibration
- Digital factory calibrated via Maxim Integrated 1-Wire protocol.
- Check 0°C with an ice-water bath and 100°C with boiling water to verify probe integrity.

---

## 6. ESP32 Firmware Guide & Dual-Mode Networking

- **Station Mode (Cloud Sync):** When connected to the home/lab WiFi router, the ESP32 posts telemetry every 60s via HTTP POST to `/api/sensors` and checks relay commands every 3s via GET to `/api/controls/device`.
- **SoftAP Hotspot (Field Mode):** The ESP32 constantly broadcasts an SSID called `AQUAPLANT-HOTSPOT`. Operators can connect their phone directly to `192.168.4.1` with no router and control all relays through the onboard web server.
- **Fail-Soft Backoff:** If the cloud server is unreachable, the ESP32 does not freeze; it executes an exponential backoff (5s up to 60s) to keep local interrupts, sensor sampling, and auto-flush loops responsive.

---

## 7. Database Schema & Stored Procedure Documentation

### Stored Procedure: `sp_update_control_state_with_log`
Ensures that no actuator state can change without generating a tamper-proof audit trail log.
```sql
CALL sp_update_control_state_with_log(
    'flush_valve',      -- Actuator device name
    1,                  -- 1 = Open, 0 = Closed
    'AUTO_FLUSH',       -- Source: 'AUTO_FLUSH' or 'WEB_USER'
    NULL,               -- User ID (NULL if automated system)
    'Automatic reservoir drain initiated due to TDS exceeding 900 ppm.',
    'ALERT'             -- Log Level: 'INFO', 'WARN', 'ALERT', 'SUCCESS', 'ERROR'
);
```

---

## 8. Capstone Defense Panel Q&A Cheat Sheet

**Q1: Why did you choose TDS and pH as the primary feedback parameters?**  
*Answer:* In hydroponics, plants absorb mineral ions (N, P, K, Ca, Mg). TDS directly quantifies the electrical conductivity and ionic nutrient density. If TDS is too high, osmotic shock draws water out of root cells (nutrient burn). If pH drifts outside 5.5 - 6.5, essential nutrients precipitate into insoluble chemical salts that roots cannot absorb (nutrient lockout).

**Q2: How does the system handle power failure or internet disconnection?**  
*Answer:* The ESP32 contains an autonomous local control loop in FreeRTOS. Even if the WiFi drops, the local SoftAP server remains active at `192.168.4.1` and the ESP32 continues auto-flushing based on onboard sensor thresholds. Once internet is restored, telemetry resumes syncing.

**Q3: How do you prevent electrical noise from the pump interfering with analog sensors?**  
*Answer:* 
1. The 4-channel relay module uses optocoupler isolation (PC817) to separate the digital ESP32 logic ground from the inductive relay coil supply.
2. Flyback freewheeling diodes on the solenoids suppress reverse voltage spikes.
3. The firmware uses a 15-sample software median filter to discard transient ADC spikes.

**Q4: Why use a Stored Procedure instead of separate SQL queries in Node.js?**  
*Answer:* Stored procedures execute inside a single atomic database transaction (`START TRANSACTION ... COMMIT`). If a server error occurs mid-action, either both the control state and the log entry succeed, or both roll back together, preventing desynchronized system states.
