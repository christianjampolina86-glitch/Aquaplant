# AQUAPLANT Production Deployment Guide

This guide walks you through deploying the **AQUAPLANT Automated Hydroponics Monitoring & Control Station** to production.

---

## Quick Comparison of Hosting Options

| Hosting Provider | Pricing Plan | Database Support | Recommended For |
|---|---|---|---|
| **Render** | Free tier / $7/mo Starter | Connects to external MySQL | **Easiest 1-Click Cloud Deployment** |
| **Railway** | $5 free credit / usage | Built-in MySQL addon | Fast all-in-one full-stack hosting |
| **VPS (Ubuntu / Debian)** | $4–$6/mo (DigitalOcean / Linode) | Local or remote MySQL | Full control & 24/7 reliability |
| **Docker Compose** | Run on any server | Includes MySQL container | Production containers & local servers |

---

## 1. Deploying to Render (Easiest Cloud PaaS)

1. **Push your code to GitHub / GitLab**.
2. Go to [render.com](https://render.com) and create an account.
3. Click **New +** → **Web Service** and connect your repository.
4. Set the following settings:
   - **Environment**: `Node`
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
5. Under **Environment Variables**, add:
   - `NODE_ENV` = `production`
   - `PORT` = `3000`
   - `JWT_SECRET` = *(Click Generate or paste a secure random string)*
   - `DEVICE_KEY` = `aquaplant_esp32_device_key_secret_2026`
   - `DATABASE_URL` = `mysql://sql12839434:YOUR_PASS@sql12.freesqldatabase.com:3306/sql12839434`
   - `SEMAPHORE_API_KEY` = *(Your Semaphore API Key from semaphore.co)*
6. Click **Deploy**. Render will build and launch your live URL (e.g., `https://aquaplant.onrender.com`).

---

## 2. Deploying with Docker Compose (1 Command)

If deploying to a VPS (Ubuntu, Debian, or Raspberry Pi 4):

```bash
# 1. Clone your project
git clone <your-repo-url> /opt/aquaplant
cd /opt/aquaplant

# 2. Configure your environment
cp .env.production.example .env
nano .env

# 3. Launch container stack (Application + MySQL)
docker compose up -d --build

# 4. View logs
docker compose logs -f aquaplant-app
```

---

## 3. Configuring Semaphore SMS (₱500 Budget Setup)

With a ₱500 budget, Semaphore is the most affordable SMS gateway for the Philippines:

1. Create an account at [semaphore.co](https://semaphore.co).
2. Top up **₱500** via **GCash**, Maya, or Debit Card (gives ~1,000 non-expiring texts at ₱0.50/SMS).
3. Copy your **API Key** from your Semaphore dashboard.
4. In your AQUAPLANT web app:
   - Click the **SMS Gateway** button in the top navigation bar.
   - Select **Semaphore (₱0.50/SMS)**.
   - Paste your **API Key** and enter your mobile number (`0917...` or `+63917...`).
   - Click **Check Balance** to see your live remaining credits.
   - Click **Dispatch Test SMS Alert Now** to verify real-time text delivery on your phone.

---

## 4. Connecting the ESP32 Microcontroller to Production

In `firmware/aquaplant_esp32.ino`:

1. Update your WiFi credentials:
   ```cpp
   const char* WIFI_SSID = "Your_WiFi_Name";
   const char* WIFI_PASSWORD = "Your_WiFi_Password";
   ```
2. Set your production server URL:
   ```cpp
   const char* SERVER_HOST = "https://your-deployed-app.onrender.com";
   const char* DEVICE_KEY = "aquaplant_esp32_device_key_secret_2026";
   ```
3. Flash the firmware using the Arduino IDE.
4. Your ESP32 will immediately begin streaming live sensor telemetry to your production web app and receiving actuator commands every 3 seconds!
