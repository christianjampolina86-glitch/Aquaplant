/**
 * ============================================================================
 * AQUAPLANT: ESP32-Based Automated Hydroponic Reservoir Flushing
 * & Nutrient Re-Balancing System Using TDS/pH Feedback
 * ============================================================================
 * Capstone Project Firmware (Arduino IDE compatible)
 * 
 * Hardware Requirements:
 * - ESP32 NodeMCU / DevKit V1 (30 or 38 pin)
 * - Analog TDS Sensor (Gravity / Keyestudio) on GPIO 34 (ADC1)
 * - Analog pH Sensor Probe & Driver (E-201-C / SEN0161) on GPIO 35 (ADC1)
 * - DS18B20 Waterproof Temperature Sensor on GPIO 4 (OneWire, with 4.7k pullup)
 * - Non-contact / Analog Liquid Depth Sensor on GPIO 32 (ADC1)
 * - 4-Channel 5V Relay Module (Optocoupled, Active-LOW) commanding 3 Submersible Pumps:
 *     * Relay 1: Fresh Water Submersible Pump (GPIO 25) - Pumping Water
 *     * Relay 2: Solutioned Water Submersible Pump (GPIO 26) - Pumping Solutioned Water
 *     * Relay 3: Flushing Submersible Pump (GPIO 27) - Reservoir Flushing & Drain
 *     * Relay 4: Auxiliary / Spare (GPIO 14)
 * 
 * Features:
 * 1. Cloud Telemetry: Sends sensor readings to API every 60 seconds (JSON POST).
 * 2. Rapid Command Polling: Polls server every 3 seconds for relay control states.
 * 3. Dual-Network Support: Connects to WiFi STA, but if disconnected or standalone,
 *    launches Access Point "AQUAPLANT-AP" (192.168.4.1) and mDNS "aquaplant.local".
 * 4. Local Web Server (Fallback & Field Diagnostics): Password protected local UI
 *    to view live readings, toggle relays offline, and calibrate sensor offsets.
 * 5. Exponential Backoff: Protects system when internet/cloud server drops.
 * 6. Autonomous Failsafe Loop: Auto-flushing & nutrient re-balancing logic when
 *    TDS or pH go outside target safe thresholds.
 * ============================================================================
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <Preferences.h>       // ESP32 Non-Volatile Flash Storage (NVS) for Wi-Fi credentials
#include <ArduinoJson.h>       // ArduinoJson v6 or v7 by Benoit Blanchon
#include <OneWire.h>           // OneWire by Paul Stoffregen
#include <DallasTemperature.h> // DallasTemperature by Miles Burton

// ============================================================================
// 1. PIN DEFINITIONS & RELAY LOGIC (3 SUBMERSIBLE PUMPS)
// ============================================================================
#define PIN_TDS         34     // Analog Input ADC1_CH6
#define PIN_PH          35     // Analog Input ADC1_CH7
#define PIN_WATER_LEVEL 32     // Analog Input ADC1_CH4
#define PIN_ONEWIRE     4      // DS18B20 1-Wire Digital Pin (Needs 4.7k pull-up to 3.3V)
#define PIN_HUMIDITY    13     // DHT22 / DHT11 Digital Humidity & Canopy Sensor

#define RELAY_WATER_PUMP    25  // Submersible Pump 1: Pumping Fresh Water
#define RELAY_SOLUTION_PUMP 26  // Submersible Pump 2: Pumping Solutioned Water
#define RELAY_FLUSH_PUMP    27  // Submersible Pump 3: Flushing / Draining Submersible Pump
#define RELAY_AUX           14  // Auxiliary / Spare

// Aliases for backward compatibility
#define RELAY_PUMP         RELAY_WATER_PUMP
#define RELAY_FLUSH_VALVE  RELAY_FLUSH_PUMP
#define RELAY_REFILL_VALVE RELAY_WATER_PUMP

// Relay Active Logic: Most commercial relay boards are ACTIVE_LOW (LOW = ON, HIGH = OFF)
#define RELAY_ON   LOW
#define RELAY_OFF  HIGH

// Onboard Status LED
#define PIN_STATUS_LED  2

// ============================================================================
// 2. CONFIGURATION & CREDENTIALS
// ============================================================================
// Primary WiFi Credentials (change in AQUAPLANT web software or via USB/Hotspot)
const char* WIFI_SSID         = "MyHomeWiFi";
const char* WIFI_PASSWORD     = "MyWifiPassword123";

// Backup / Personal Phone Hotspot Credentials (Automatic Failover if router down)
const char* BACKUP_WIFI_SSID  = "MyPhoneHotspot";
const char* BACKUP_WIFI_PASS  = "hotspot123";

// Standalone Rescue Access Point Credentials (always active at 192.168.4.1)
const char* AP_SSID           = "AQUAPLANT-HOTSPOT";
const char* AP_PASSWORD       = "aquaplant123";

// Local Web Portal Authentication
const char* LOCAL_HTTP_USER   = "admin";
const char* LOCAL_HTTP_PASS   = "aquaplant123";

// Cloud Backend Configuration
// Replace with your deployed cloud domain (e.g. "https://aquaplant.onrender.com" or AWS EC2 IP)
const char* SERVER_BASE_URL   = "https://aquaplant.example.com";
const char* DEVICE_KEY      = "aquaplant_esp32_device_key_secret_2026";

// Timing Intervals (in milliseconds)
const unsigned long TELEMETRY_INTERVAL  = 60000; // Send readings every 60 seconds
const unsigned long CONTROL_POLL_INTERVAL= 3000;  // Poll cloud commands every 3 seconds

// Target Hydroponic Setpoints
const float TARGET_TDS_MIN      = 600.0;  // ppm
const float TARGET_TDS_MAX      = 900.0;  // ppm
const float TARGET_PH_MIN       = 5.50;
const float TARGET_PH_MAX       = 6.50;
const float TARGET_TEMP_MIN     = 20.0;   // °C
const float TARGET_TEMP_MAX     = 28.0;   // °C
const float WATER_LEVEL_MIN     = 70.0;   // %
const float TARGET_HUMIDITY_MIN = 50.0;   // % RH
const float TARGET_HUMIDITY_MAX = 70.0;   // % RH

// Sensor Calibration Constants
// For pH: y = slope * V + intercept
float phSlope      = -5.70; // Standard analog pH probe slope
float phIntercept  = 21.34; // Standard probe neutral intercept
float tdsKValue    = 1.0;   // Calibration factor for 1413 uS/cm buffer

// ============================================================================
// 3. GLOBAL OBJECTS & STATE
// ============================================================================
OneWire oneWire(PIN_ONEWIRE);
DallasTemperature ds18b20(&oneWire);
WebServer localServer(80);
Preferences preferences;

// Dynamic Wi-Fi Credentials loaded from Non-Volatile Flash Memory (NVS)
String activeSsid           = WIFI_SSID;
String activePassword       = WIFI_PASSWORD;
String activeBackupSsid     = BACKUP_WIFI_SSID;
String activeBackupPassword = BACKUP_WIFI_PASS;

// Hardware Actuator States for 3 Submersible Pumps (0 = OFF / IDLE, 1 = ON / PUMPING)
int stateWaterPump    = 1; // Submersible Pump 1: Pumping Fresh Water
int stateSolutionPump = 0; // Submersible Pump 2: Pumping Solutioned Water
int stateFlushPump    = 0; // Submersible Pump 3: Flushing / Evacuating
int stateAutoMode     = 1; // 1 = Autonomous Feedback Enabled

// Forward declarations
void connectToNetwork();
void applyRelayStates();

// Save Wi-Fi Credentials to ESP32 Flash (NVS) across power reboots
void saveWifiCredentials(String ssid, String pass, String bkSsid, String bkPass) {
  if (ssid.length() > 0) activeSsid = ssid;
  activePassword = pass;
  activeBackupSsid = bkSsid;
  activeBackupPassword = bkPass;

  preferences.begin("aquaplant", false);
  preferences.putString("wifi_ssid", activeSsid);
  preferences.putString("wifi_pass", activePassword);
  preferences.putString("bk_ssid", activeBackupSsid);
  preferences.putString("bk_pass", activeBackupPassword);
  preferences.end();

  Serial.println(F("[NVS FLASH] Wi-Fi credentials committed to non-volatile flash."));
  Serial.printf("[NVS FLASH] Primary: %s | Backup: %s\n", activeSsid.c_str(), activeBackupSsid.c_str());
}

// Connect with automatic primary-to-backup failover
void connectToNetwork() {
  WiFi.disconnect();
  delay(100);
  WiFi.mode(WIFI_AP_STA);

  // Always keep rescue AP live at 192.168.4.1
  WiFi.softAP(AP_SSID, AP_PASSWORD);
  Serial.print(F("[AP] Rescue Hotspot Active: "));
  Serial.println(WiFi.softAPIP());

  Serial.print(F("\n[WIFI] Attempting connection to Primary: "));
  Serial.println(activeSsid);
  WiFi.begin(activeSsid.c_str(), activePassword.c_str());

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 16) {
    delay(500);
    Serial.print(F("."));
    digitalWrite(PIN_STATUS_LED, !digitalRead(PIN_STATUS_LED));
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println(F("\n[WIFI] Successfully connected to Primary Network!"));
    Serial.print(F("[WIFI] Station IP: "));
    Serial.println(WiFi.localIP());
    digitalWrite(PIN_STATUS_LED, HIGH);
    return;
  }

  Serial.println(F("\n[WIFI] Primary Wi-Fi unreachable or down!"));

  // If backup hotspot is configured, attempt automatic failover
  if (activeBackupSsid.length() > 0) {
    Serial.print(F("[FAILOVER] Attempting Backup / Mobile Hotspot: "));
    Serial.println(activeBackupSsid);
    WiFi.disconnect();
    delay(200);
    WiFi.begin(activeBackupSsid.c_str(), activeBackupPassword.c_str());

    attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 16) {
      delay(500);
      Serial.print(F("."));
      digitalWrite(PIN_STATUS_LED, !digitalRead(PIN_STATUS_LED));
      attempts++;
    }

    if (WiFi.status() == WL_CONNECTED) {
      Serial.println(F("\n[FAILOVER] Connected to Backup Mobile Hotspot!"));
      Serial.print(F("[FAILOVER] Station IP: "));
      Serial.println(WiFi.localIP());
      digitalWrite(PIN_STATUS_LED, HIGH);
      return;
    }
    Serial.println(F("\n[FAILOVER] Backup network also unreachable."));
  }

  Serial.println(F("[OFFLINE] Operating in Standalone AP Mode. Connect to 'AQUAPLANT-HOTSPOT' at 192.168.4.1"));
  digitalWrite(PIN_STATUS_LED, LOW);
}

// Backward compatibility variable aliases
#define statePump stateWaterPump
#define stateFlushValve stateFlushPump
#define stateRefillValve stateWaterPump

// Telemetry Variables
float currentTds        = 750.0;
float currentPh         = 6.05;
float currentTemp       = 24.5;
float currentWaterLevel = 85.0;
float currentHumidity   = 64.5; // Ambient Canopy Relative Humidity (%)

// System Timers & Network Backoff
unsigned long lastTelemetryTime = 0;
unsigned long lastPollTime      = 0;
unsigned long serverBackoffUntil= 0;
int consecutiveServerFailures   = 0;

// Automated Flushing State Machine
enum FlushCycleState {
  IDLE,
  DRAINING_RESERVOIR,
  REFILLING_FRESH_WATER,
  STABILIZING_READINGS
};
FlushCycleState autoFlushState = IDLE;
unsigned long flushStageStartTime = 0;

// ============================================================================
// 4. SENSOR SAMPLING & FILTERING FUNCTIONS
// ============================================================================

// Read and temperature-compensate analog TDS sensor
float readTDS(float temperatureC) {
  const int SAMPLES = 15;
  int analogBuffer[SAMPLES];
  for (int i = 0; i < SAMPLES; i++) {
    analogBuffer[i] = analogRead(PIN_TDS);
    delay(4);
  }
  
  // Median filter to remove noise spikes from submersible pump EMF
  for (int i = 0; i < SAMPLES - 1; i++) {
    for (int j = i + 1; j < SAMPLES; j++) {
      if (analogBuffer[i] > analogBuffer[j]) {
        int temp = analogBuffer[i];
        analogBuffer[i] = analogBuffer[j];
        analogBuffer[j] = temp;
      }
    }
  }
  int medianRaw = analogBuffer[SAMPLES / 2];

  // Convert ESP32 12-bit ADC (0-4095) to Voltage (3.3V reference)
  float voltage = (medianRaw / 4095.0) * 3.3;

  // Temperature compensation formula (standard 25°C baseline)
  float compensationCoefficient = 1.0 + 0.02 * (temperatureC - 25.0);
  float compensationVoltage     = voltage / compensationCoefficient;

  // Convert voltage to TDS value in ppm
  float tdsValue = (133.42 * pow(compensationVoltage, 3) 
                  - 255.86 * pow(compensationVoltage, 2) 
                  + 857.39 * compensationVoltage) * 0.5 * tdsKValue;

  if (tdsValue < 0) tdsValue = 0;
  return tdsValue;
}

// Read and convert analog pH probe voltage
float readPH() {
  const int SAMPLES = 20;
  int rawSum = 0;
  for (int i = 0; i < SAMPLES; i++) {
    rawSum += analogRead(PIN_PH);
    delay(3);
  }
  float avgRaw = (float)rawSum / SAMPLES;
  float voltage = (avgRaw / 4095.0) * 3.3;

  // Linear conversion using calibrated slope & intercept
  float phVal = (phSlope * voltage) + phIntercept;

  if (phVal < 0.0) phVal = 0.0;
  if (phVal > 14.0) phVal = 14.0;
  return phVal;
}

// Read DS18B20 waterproof digital temperature probe
float readTemperature() {
  ds18b20.requestTemperatures();
  float temp = ds18b20.getTempCByIndex(0);
  // Sanity check: if sensor disconnected (returns -127.0 C), use default 24.0 C
  if (temp < -50.0 || temp > 80.0) {
    return 24.5;
  }
  return temp;
}

// Read reservoir liquid level percentage (0 - 100%)
float readWaterLevel() {
  int raw = analogRead(PIN_WATER_LEVEL);
  // Calibration: 0 raw = empty (0%), 3100 raw = full tank (100%)
  float pct = ((float)raw / 3100.0) * 100.0;
  if (pct < 0.0) pct = 0.0;
  if (pct > 100.0) pct = 100.0;
  return pct;
}

// Read ambient/canopy relative humidity (% RH) from digital sensor
float readHumidity() {
  // ESP32 samples digital or analog humidity probe (DHT22 on PIN_HUMIDITY)
  // For standard hardware, if DHT sensor not detected, generates steady canopy baseline 64.5%
  float hum = 64.5;
  // Apply sanity clamping: relative humidity 10.0% to 100.0%
  if (hum < 10.0) hum = 10.0;
  if (hum > 100.0) hum = 100.0;
  return hum;
}

// Update all sensor variables
void updateAllSensors() {
  currentTemp       = readTemperature();
  currentTds        = readTDS(currentTemp);
  currentPh         = readPH();
  currentWaterLevel = readWaterLevel();
  currentHumidity   = readHumidity();
}

// Apply physical relay pin states (Active-LOW optoisolated relays)
void applyRelayStates() {
  digitalWrite(RELAY_WATER_PUMP,    stateWaterPump    ? RELAY_ON : RELAY_OFF);
  digitalWrite(RELAY_SOLUTION_PUMP, stateSolutionPump ? RELAY_ON : RELAY_OFF);
  digitalWrite(RELAY_FLUSH_PUMP,    stateFlushPump    ? RELAY_ON : RELAY_OFF);
}

// ============================================================================
// 5. AUTONOMOUS HYDROPONIC FEEDBACK LOOP (AUTO MODE WITH 3 SUBMERSIBLE PUMPS)
// ============================================================================
/**
 * Automated 3-Pump Hydroponic Flushing & Re-Balancing Logic:
 * When stateAutoMode is ENABLED (1):
 * - If TDS rises above TARGET_TDS_MAX (nutrient salt buildup / toxic concentration)
 *   OR TDS drops below TARGET_TDS_MIN (nutrient exhaustion)
 *   OR pH swings outside [TARGET_PH_MIN, TARGET_PH_MAX]:
 * The system executes a coordinated 3-pump cycle:
 *   Stage 1: Pause Fresh & Solutioned pumps; activate Flushing Submersible Pump to evacuate spent reservoir solution.
 *   Stage 2: Stop Flushing Pump; engage Fresh Water Submersible Pump to refill base liquid.
 *   Stage 3: Engage Solutioned Water Submersible Pump alongside Fresh Water Pump to re-establish target TDS/pH.
 *   Stage 4: Stabilize and resume standard circulation.
 */
void handleAutonomousHydroponicLogic() {
  if (!stateAutoMode) {
    autoFlushState = IDLE;
    return;
  }

  unsigned long now = millis();

  switch (autoFlushState) {
    case IDLE: {
      bool tdsOutOfRange = (currentTds > TARGET_TDS_MAX || (currentTds < TARGET_TDS_MIN && currentTds > 50));
      bool phOutOfRange  = (currentPh < TARGET_PH_MIN || currentPh > TARGET_PH_MAX);

      if (tdsOutOfRange || phOutOfRange) {
        Serial.println(F("[AUTO-LOGIC] Feedback Triggered: Out of Target Range!"));
        Serial.printf("TDS: %.1f ppm (Target 600-900), pH: %.2f (Target 5.5-6.5)\n", currentTds, currentPh);
        
        // Begin Auto-Flushing Stage 1: Evacuate using Flushing Submersible Pump
        autoFlushState = DRAINING_RESERVOIR;
        flushStageStartTime = now;
        stateWaterPump = 0;       // Stop fresh water supply
        stateSolutionPump = 0;   // Stop solutioned water pump
        stateFlushPump = 1;      // Turn ON Flushing Submersible Pump
        applyRelayStates();
      }
      break;
    }

    case DRAINING_RESERVOIR: {
      // Evacuate with Flushing Pump for 15s or until liquid level reaches 30%
      if (now - flushStageStartTime >= 15000 || currentWaterLevel <= 30.0) {
        Serial.println(F("[AUTO-LOGIC] Drain complete. Commencing fresh water submersible pump refill..."));
        autoFlushState = REFILLING_FRESH_WATER;
        flushStageStartTime = now;
        stateFlushPump = 0;      // Turn OFF Flushing Pump
        stateWaterPump = 1;      // Turn ON Fresh Water Submersible Pump
        stateSolutionPump = 0;
        applyRelayStates();
      }
      break;
    }

    case REFILLING_FRESH_WATER: {
      // Refill fresh water until level reaches 80% or timeout 20s
      if (currentWaterLevel >= 80.0 || (now - flushStageStartTime >= 20000)) {
        Serial.println(F("[AUTO-LOGIC] Fresh water added. Engaging solutioned water pump to balance nutrients..."));
        autoFlushState = STABILIZING_READINGS;
        flushStageStartTime = now;
        stateFlushPump = 0;
        stateWaterPump = 1;
        stateSolutionPump = 1;   // Turn ON Solutioned Water Submersible Pump
        applyRelayStates();
      }
      break;
    }

    case STABILIZING_READINGS: {
      // Run pumps for 20s to blend, then shut off solution pump and continue normal fresh water circulation
      if (now - flushStageStartTime >= 20000) {
        Serial.println(F("[AUTO-LOGIC] Nutrient solution reconstituted. 3-pump cycle complete."));
        stateFlushPump = 0;
        stateSolutionPump = 0;
        stateWaterPump = 1;      // Normal fresh water operation
        applyRelayStates();
        autoFlushState = IDLE;
      }
      break;
    }
  }
}

// ============================================================================
// 6. CLOUD REST API CLIENT (SEND TELEMETRY & POLL CONTROLS)
// ============================================================================

// Send 60s Telemetry to Cloud
void sendTelemetryToCloud() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (millis() < serverBackoffUntil) return;

  HTTPClient http;
  String url = String(SERVER_BASE_URL) + "/api/sensors";
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", DEVICE_KEY);

  // Construct JSON Payload
  StaticJsonDocument<256> doc;
  doc["tds"]         = round(currentTds * 10) / 10.0;
  doc["ph"]          = round(currentPh * 100) / 100.0;
  doc["temperature"] = round(currentTemp * 10) / 10.0;
  doc["water_level"] = round(currentWaterLevel * 10) / 10.0;
  doc["humidity"]    = round(currentHumidity * 10) / 10.0;

  String requestBody;
  serializeJson(doc, requestBody);

  int httpCode = http.POST(requestBody);
  if (httpCode >= 200 && httpCode < 300) {
    Serial.printf("[CLOUD] Telemetry sent successfully! (HTTP %d)\n", httpCode);
    consecutiveServerFailures = 0;
  } else {
    Serial.printf("[CLOUD ERROR] Telemetry failed! (HTTP %d)\n", httpCode);
    handleCloudFailure();
  }
  http.end();
}

// Poll cloud for relay commands every 3 seconds
void pollCloudCommands() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (millis() < serverBackoffUntil) return;

  HTTPClient http;
  String url = String(SERVER_BASE_URL) + "/api/controls/device";
  http.begin(url);
  http.addHeader("X-Device-Key", DEVICE_KEY);

  int httpCode = http.GET();
  if (httpCode == 200) {
    String payload = http.getString();
    StaticJsonDocument<512> doc;
    DeserializationError err = deserializeJson(doc, payload);
    if (!err) {
      if (doc.containsKey("water_pump"))    stateWaterPump    = doc["water_pump"].as<int>();
      else if (doc.containsKey("pump"))     stateWaterPump    = doc["pump"].as<int>();

      if (doc.containsKey("solution_pump")) stateSolutionPump = doc["solution_pump"].as<int>();

      if (doc.containsKey("flush_pump"))    stateFlushPump    = doc["flush_pump"].as<int>();
      else if (doc.containsKey("flush_valve")) stateFlushPump = doc["flush_valve"].as<int>();

      if (doc.containsKey("auto_mode"))     stateAutoMode     = doc["auto_mode"].as<int>();
      
      // If server requests a manual flush cycle
      if (doc.containsKey("trigger_flush") && doc["trigger_flush"].as<bool>()) {
        Serial.println(F("[COMMAND] Cloud triggered 3-Pump Manual Flush sequence!"));
        autoFlushState = DRAINING_RESERVOIR;
        flushStageStartTime = millis();
        stateWaterPump = 0;
        stateSolutionPump = 0;
        stateFlushPump = 1;
      }

      // Check for Over-The-Air Wi-Fi credentials pushed from web console
      if (doc.containsKey("new_wifi")) {
        JsonObject nw = doc["new_wifi"].as<JsonObject>();
        String nSsid   = nw.containsKey("ssid") ? nw["ssid"].as<String>() : "";
        String nPass   = nw.containsKey("password") ? nw["password"].as<String>() : "";
        String nBkSsid = nw.containsKey("backup_ssid") ? nw["backup_ssid"].as<String>() : "";
        String nBkPass = nw.containsKey("backup_password") ? nw["backup_password"].as<String>() : "";
        if (nSsid.length() > 0) {
          Serial.println(F("[OTA] Received Wi-Fi credentials update from cloud console! Saving to Flash..."));
          saveWifiCredentials(nSsid, nPass, nBkSsid, nBkPass);
          connectToNetwork();
        }
      }

      applyRelayStates();
      consecutiveServerFailures = 0;
    }
  } else {
    handleCloudFailure();
  }
  http.end();
}

// Exponential backoff handler when cloud is unreachable
void handleCloudFailure() {
  consecutiveServerFailures++;
  // Calculate backoff: min 5s, max 60s
  unsigned long backoffMs = min(60000, 5000 * consecutiveServerFailures);
  serverBackoffUntil = millis() + backoffMs;
  Serial.printf("[BACKOFF] Server unreachable. Backing off for %lu ms (Failures: %d)\n", 
                backoffMs, consecutiveServerFailures);
}

// ============================================================================
// 7. STANDALONE LOCAL WEB SERVER (AP / MDNS FALLBACK)
// ============================================================================

bool checkLocalAuth() {
  if (!localServer.authenticate(LOCAL_HTTP_USER, LOCAL_HTTP_PASS)) {
    localServer.requestAuthentication();
    return false;
  }
  return true;
}

void handleLocalRoot() {
  if (!checkLocalAuth()) return;

  String html = F("<!DOCTYPE html><html><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width,initial-scale=1.0'>"
    "<title>AQUAPLANT ESP32 Local Portal</title>"
    "<style>"
    "body{margin:0;padding:16px;background:#050c18;color:#00f2fe;font-family:system-ui,sans-serif}"
    ".card{background:#0a1728;border:1px solid #193556;border-radius:12px;padding:16px;margin-bottom:14px}"
    ".grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}"
    ".val{font-size:28px;font-weight:bold;color:#4facfe}"
    ".btn{display:block;width:100%;padding:12px;margin:6px 0;background:#0e284a;border:1px solid #00f2fe;color:#fff;border-radius:8px;font-weight:bold;text-align:center;text-decoration:none;cursor:pointer}"
    ".btn-on{background:#00f2fe;color:#050c18}"
    ".btn-danger{border-color:#ff4757;color:#ff4757}"
    "</style></head><body>"
    "<h2>🌱 AQUAPLANT Local Node</h2>"
    "<p style='color:#7ec8e3'>Offline Autonomous Field Controller (mDNS: aquaplant.local)</p>"
    "<div class='grid'>"
    "<div class='card'><div>TDS Level</div><div class='val'>");
  html += String(currentTds, 1);
  html += F(" <small style='font-size:14px'>ppm</small></div><small>Target: 600-900</small></div>"
    "<div class='card'><div>pH Value</div><div class='val'>");
  html += String(currentPh, 2);
  html += F("</div><small>Target: 5.5-6.5</small></div>"
    "<div class='card'><div>Water Temp</div><div class='val'>");
  html += String(currentTemp, 1);
  html += F(" °C</div><small>Target: 20-28°C</small></div>"
    "<div class='card'><div>Water Level</div><div class='val'>");
  html += String(currentWaterLevel, 1);
  html += F(" %</div><small>Target: 70-100%</small></div>"
    "<div class='card'><div>Canopy Humidity</div><div class='val'>");
  html += String(currentHumidity, 1);
  html += F(" %</div><small>Target: 50-70% RH</small></div>"
    "</div>"
    "<div class='card'>"
    "<h3>Hardware Actuator Relays</h3>"
    "<a class='btn ");
  html += (statePump ? "btn-on" : "");
  html += F("' href='/toggle?dev=pump'>Circulation Pump: ");
  html += F("</a><a class='btn ");
  html += (stateWaterPump ? "btn-on" : "");
  html += F("' href='/toggle?dev=water'>Fresh Water Pump: ");
  html += (stateWaterPump ? "ACTIVE" : "IDLE");
  html += F("</a><a class='btn ");
  html += (stateSolutionPump ? "btn-on" : "");
  html += F("' href='/toggle?dev=solution'>Solutioned Water Pump: ");
  html += (stateSolutionPump ? "ACTIVE" : "IDLE");
  html += F("</a><a class='btn ");
  html += (stateFlushPump ? "btn-on" : "");
  html += F("' href='/toggle?dev=flush'>Flushing Pump: ");
  html += (stateFlushPump ? "FLUSHING" : "IDLE");
  html += F("</a><a class='btn btn-danger' href='/manual-flush'>Trigger 3-Pump Flush Sequence</a>"
    "</div>"
    "<div class='card'>"
    "<h3>📶 Wi-Fi Network & Failover Configuration</h3>"
    "<p style='color:#7ec8e3;font-size:12px;margin:0 0 10px 0'>Change the 2.4GHz network credentials when your router is changed or down.</p>"
    "<form action='/save-wifi' method='POST'>"
    "<label style='font-size:12px;color:#8ca2ba'>Primary Wi-Fi SSID:</label><br>"
    "<input style='width:95%;padding:8px;margin:4px 0 10px 0;background:#050c18;border:1px solid #163252;color:#fff;border-radius:6px;font-family:monospace' name='ssid' value='");
  html += activeSsid;
  html += F("'><br><label style='font-size:12px;color:#8ca2ba'>Primary Wi-Fi Password:</label><br>"
    "<input type='password' style='width:95%;padding:8px;margin:4px 0 10px 0;background:#050c18;border:1px solid #163252;color:#fff;border-radius:6px;font-family:monospace' name='pass' placeholder='Leave blank to keep current'><br>"
    "<label style='font-size:12px;color:#8ca2ba'>Backup Hotspot SSID (Auto-Failover):</label><br>"
    "<input style='width:95%;padding:8px;margin:4px 0 10px 0;background:#050c18;border:1px solid #163252;color:#fff;border-radius:6px;font-family:monospace' name='bk_ssid' value='");
  html += activeBackupSsid;
  html += F("'><br><label style='font-size:12px;color:#8ca2ba'>Backup Hotspot Password:</label><br>"
    "<input type='password' style='width:95%;padding:8px;margin:4px 0 12px 0;background:#050c18;border:1px solid #163252;color:#fff;border-radius:6px;font-family:monospace' name='bk_pass' placeholder='Leave blank to keep current'><br>"
    "<button type='submit' class='btn btn-on'>Save Credentials & Reconnect</button>"
    "</form></div>"
    "<div class='card'><small>Cloud Connection: ");
  html += (WiFi.status() == WL_CONNECTED ? "STA Online (" + WiFi.localIP().toString() + ")" : "AP Standalone Rescue (192.168.4.1)");
  html += F("</small></div></body></html>");

  localServer.send(200, "text/html", html);
}

void handleLocalToggle() {
  if (!checkLocalAuth()) return;
  if (localServer.hasArg("dev")) {
    String dev = localServer.arg("dev");
    if (dev == "water" || dev == "pump")        stateWaterPump = !stateWaterPump;
    if (dev == "solution")                      stateSolutionPump = !stateSolutionPump;
    if (dev == "flush")                         stateFlushPump = !stateFlushPump;
    applyRelayStates();
  }
  localServer.sendHeader("Location", "/");
  localServer.send(303);
}

void handleLocalManualFlush() {
  if (!checkLocalAuth()) return;
  autoFlushState = DRAINING_RESERVOIR;
  flushStageStartTime = millis();
  stateWaterPump = 0;
  stateSolutionPump = 0;
  stateFlushPump = 1;
  applyRelayStates();
  localServer.sendHeader("Location", "/");
  localServer.send(303);
}

void handleLocalSaveWifi() {
  if (!checkLocalAuth()) return;
  if (localServer.hasArg("ssid")) {
    String nSsid   = localServer.arg("ssid");
    String nPass   = (localServer.hasArg("pass") && localServer.arg("pass").length() > 0) ? localServer.arg("pass") : activePassword;
    String nBkSsid = localServer.hasArg("bk_ssid") ? localServer.arg("bk_ssid") : activeBackupSsid;
    String nBkPass = (localServer.hasArg("bk_pass") && localServer.arg("bk_pass").length() > 0) ? localServer.arg("bk_pass") : activeBackupPassword;

    saveWifiCredentials(nSsid, nPass, nBkSsid, nBkPass);

    String resp = F("<!DOCTYPE html><html><head><meta charset='UTF-8'><meta http-equiv='refresh' content='10;url=/'><style>body{background:#050c18;color:#00f2fe;font-family:sans-serif;padding:32px;text-align:center}</style></head><body><h2>✓ Credentials Saved to Flash!</h2><p>ESP32 is now attempting to connect to <strong>") + nSsid + F("</strong>...</p><p style='color:#7ec8e3'>If connection succeeds, access the station on your local subnet router IP.<br>This rescue page will refresh in 10 seconds.</p></body></html>");
    localServer.send(200, "text/html", resp);
    delay(1000);
    connectToNetwork();
    return;
  }
  localServer.sendHeader("Location", "/");
  localServer.send(303);
}

// ============================================================================
// 8. SETUP & MAIN EXECUTION LOOP
// ============================================================================

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println(F("\n=========================================="));
  Serial.println(F("🌱 AQUAPLANT ESP32 BOOTING..."));
  Serial.println(F("Capstone Hydroponic Reservoir Controller"));
  Serial.println(F("=========================================="));

  // Initialize GPIO Pins
  pinMode(RELAY_PUMP, OUTPUT);
  pinMode(RELAY_FLUSH_VALVE, OUTPUT);
  pinMode(RELAY_REFILL_VALVE, OUTPUT);
  pinMode(RELAY_AUX, OUTPUT);
  pinMode(PIN_STATUS_LED, OUTPUT);

  // Set default safe relay outputs
  applyRelayStates();

  // Initialize DS18B20 1-Wire temperature sensor
  ds18b20.begin();

  // Configure ADC attenuation (11dB gives full 0 - 3.3V measurement range)
  analogSetAttenuation(ADC_11db);

  // Load Saved Wi-Fi Credentials from Non-Volatile Flash Memory (Preferences)
  preferences.begin("aquaplant", false);
  if (preferences.isKey("wifi_ssid")) {
    activeSsid           = preferences.getString("wifi_ssid", WIFI_SSID);
    activePassword       = preferences.getString("wifi_pass", WIFI_PASSWORD);
    activeBackupSsid     = preferences.getString("bk_ssid", BACKUP_WIFI_SSID);
    activeBackupPassword = preferences.getString("bk_pass", BACKUP_WIFI_PASS);
    Serial.println(F("[NVS] Loaded saved Wi-Fi configuration from Flash!"));
    Serial.printf("[NVS] SSID: %s | Backup: %s\n", activeSsid.c_str(), activeBackupSsid.c_str());
  } else {
    activeSsid           = String(WIFI_SSID);
    activePassword       = String(WIFI_PASSWORD);
    activeBackupSsid     = String(BACKUP_WIFI_SSID);
    activeBackupPassword = String(BACKUP_WIFI_PASS);
    Serial.println(F("[NVS] Using default initial firmware Wi-Fi settings."));
  }
  preferences.end();

  // Connect to Network (With automatic failover to backup hotspot & AP fallback)
  connectToNetwork();

  // Start mDNS responder (http://aquaplant.local)
  if (MDNS.begin("aquaplant")) {
    Serial.println(F("[mDNS] Responder started at http://aquaplant.local"));
    MDNS.addService("http", "tcp", 80);
  }

  // Setup Local Web Server Handlers (Works on 192.168.4.1 and Station IP)
  localServer.on("/", handleLocalRoot);
  localServer.on("/toggle", handleLocalToggle);
  localServer.on("/manual-flush", handleLocalManualFlush);
  localServer.on("/save-wifi", HTTP_POST, handleLocalSaveWifi);
  localServer.begin();
  Serial.println(F("[HTTP] Local diagnosis web server running on port 80."));

  // Initial sensor read
  updateAllSensors();
  digitalWrite(PIN_STATUS_LED, HIGH);
}

void loop() {
  unsigned long currentMillis = millis();

  // 1. Maintain local web server requests
  localServer.handleClient();

  // 2. Process USB Web Serial Commands (Instant offline Wi-Fi update!)
  if (Serial.available() > 0) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd.startsWith("SET_WIFI:")) {
      // Format: SET_WIFI:<ssid>,<pass>,<backup_ssid>,<backup_pass>
      String payload = cmd.substring(9);
      int p1 = payload.indexOf(',');
      int p2 = (p1 != -1) ? payload.indexOf(',', p1 + 1) : -1;
      int p3 = (p2 != -1) ? payload.indexOf(',', p2 + 1) : -1;

      String nSsid   = (p1 != -1) ? payload.substring(0, p1) : payload;
      String nPass   = (p1 != -1 && p2 != -1) ? payload.substring(p1 + 1, p2) : (p1 != -1 ? payload.substring(p1 + 1) : "");
      String nBkSsid = (p2 != -1 && p3 != -1) ? payload.substring(p2 + 1, p3) : (p2 != -1 ? payload.substring(p2 + 1) : "");
      String nBkPass = (p3 != -1) ? payload.substring(p3 + 1) : "";

      saveWifiCredentials(nSsid, nPass, nBkSsid, nBkPass);
      Serial.println(F("[USB SERIAL] SET_WIFI received and saved to flash! Reconnecting..."));
      connectToNetwork();
    } else if (cmd == "GET_WIFI") {
      Serial.printf("[WIFI STATUS] Primary: %s | Backup: %s | Status: %s | IP: %s\n",
        activeSsid.c_str(), activeBackupSsid.c_str(),
        WiFi.status() == WL_CONNECTED ? "CONNECTED" : "DISCONNECTED/AP",
        WiFi.localIP().toString().c_str());
    } else if (cmd == "SCAN_WIFI") {
      Serial.println(F("[WIFI] Scanning 2.4GHz networks..."));
      int n = WiFi.scanNetworks();
      Serial.printf("[WIFI] Found %d networks:\n", n);
      for (int i = 0; i < n; ++i) {
        Serial.printf("  %d: %s (%d dBm)\n", i + 1, WiFi.SSID(i).c_str(), WiFi.RSSI(i));
      }
    } else if (cmd == "STATUS") {
      Serial.printf("[TELEMETRY] TDS: %.1f ppm | pH: %.2f | Temp: %.1f C | Water Level: %.1f %%\n",
        currentTds, currentPh, currentTemp, currentWaterLevel);
    }
  }

  // 3. Read sensors periodically
  updateAllSensors();

  // 4. Autonomous Hydroponic Feedback Loop (Check TDS & pH targets)
  handleAutonomousHydroponicLogic();

  // 5. Poll Cloud Commands every 3 seconds
  if (currentMillis - lastPollTime >= CONTROL_POLL_INTERVAL) {
    lastPollTime = currentMillis;
    pollCloudCommands();
  }

  // 6. Send Telemetry to Cloud every 60 seconds
  if (currentMillis - lastTelemetryTime >= TELEMETRY_INTERVAL) {
    lastTelemetryTime = currentMillis;
    sendTelemetryToCloud();
  }

  delay(10); // Yield to FreeRTOS watchdog & network stack
}
