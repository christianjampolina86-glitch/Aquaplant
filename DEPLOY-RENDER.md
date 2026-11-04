# AQUAPLANT — Render Deployment

One Render web service hosts **everything**: the React site, the static
`dashboard.html` / `login.html` pages, and the Express API. No Netlify, no
proxy, no CORS.

```
https://aquaplant-station.onrender.com   (or your custom domain)
        |
        +-- /                -> built React app (dist/index.html)
        +-- /dashboard.html  -> static dashboard
        +-- /login.html      -> static login
        +-- /api/*           -> Express API (server.ts)
                    |
                    v
              MySQL (external)
```

Render has **no managed MySQL**, so the database lives at a separate provider.
If `DATABASE_URL` is missing, the app falls back to in-memory storage and all
data is lost on every restart.

---

## Step 1 — Create the MySQL database

The app creates its 6 tables automatically on first connect, so you only need
an **empty database**.

| Provider | Notes |
|---|---|
| **freesqldatabase.com** | Free, no card, expires after ~1 month. Easiest. |
| **Aiven** | Free tier, requires SSL → also set `DB_SSL=true`. |
| **Railway** | $5 credit, MySQL addon. |

Copy the connection string in this shape:

```
mysql://USER:PASSWORD@HOST:3306/DBNAME
```

If the password contains `@ : / #`, percent-encode it (`p@ss` → `p%40ss`).

---

## Step 2 — Push to GitHub

Render deploys from a Git repo.

```bash
git remote add origin https://github.com/YOURNAME/aquaplant.git
git push -u origin main
```

---

## Step 3 — Create the service on Render

1. [dashboard.render.com](https://dashboard.render.com) → **New +** → **Blueprint**.
2. Select your repo. Render reads `render.yaml` and shows `aquaplant-station`.
3. It prompts for the one variable marked `sync: false`:
   - **`DATABASE_URL`** → paste the string from Step 1.
   - `SEMAPHORE_API_KEY` can stay blank; add it later if you want real SMS.
4. Click **Apply**. First build takes 3–5 minutes.

Build command: `npm install --include=dev && npm run build`
Start command: `npm start` (runs `tsx server.ts`)

---

## Step 4 — Verify it works

Open:

```
https://aquaplant-station.onrender.com/api/system/status
```

You should see JSON like:

```json
{ "project": "AQUAPLANT Capstone System", "db": { "isMySQL": true } }
```

- `isMySQL: true` → database connected ✅
- `isMySQL: false` → it fell back to in-memory. Check `DATABASE_URL` in
  Render → Environment, then **Manual Deploy → Clear build cache & deploy**.

Then open the site root and `/dashboard.html`. Login with the seeded account:

```
username: admin
password: admin123
```

**Change that password immediately.**

---

## Step 5 — Custom domain

1. Render dashboard → your service → **Settings** → **Custom Domains** → **Add**.
2. Enter your domain (e.g. `aquaplant.yourdomain.com`).
3. Render shows the DNS records to add at your registrar:
   - subdomain → a `CNAME` pointing at `aquaplant-station.onrender.com`
   - apex/root domain → the `A`/`ALIAS` records Render displays
4. Wait for DNS (minutes to a few hours). Render issues the HTTPS certificate
   automatically once it resolves.

---

## Step 6 — Point the ESP32 at the domain

In `firmware/aquaplant_esp32.ino`:

```cpp
const char* SERVER_BASE_URL = "https://aquaplant-station.onrender.com";
const char* DEVICE_KEY      = "aquaplant_esp32_device_key_secret_2026";
```

`DEVICE_KEY` must match the value in Render → Environment exactly, or every
sensor post returns `401`. Re-flash the board after editing.

The device posts telemetry every 60 s and polls controls every 3 s.

---

## About the free plan

Render's free instance **sleeps after 15 minutes with no traffic** and takes
~50 seconds to wake.

- While the ESP32 is polling every 3 s, there is constant traffic, so the
  service stays awake.
- If the device is offline, the next request pays the ~50 s cold start and the
  ESP32 may time out once before recovering.
- Free instances also restart on each deploy, which wipes in-memory data
  (another reason the MySQL connection matters).

For a defense/demo where reliability matters, upgrade that service to
**Starter ($7/mo)**.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Build fails: `tsx: not found` | Already fixed — `tsx` is now in `dependencies`, not `devDependencies`. |
| Build fails on `vite` | Build command must include `--include=dev`. |
| Site loads but API returns 500 | Check Render logs; usually a bad `DATABASE_URL`. |
| `isMySQL: false` | Wrong/expired DB credentials, or provider requires SSL → add `DB_SSL=true`. |
| 502 after idle | Free-tier cold start; wait ~50 s and retry. |
| Login fails after redeploy | In-memory fallback was used — the DB never connected. |
| ESP32 shows offline | `SERVER_BASE_URL` or `DEVICE_KEY` mismatch; check Render logs for 401s. |

---

## Security items to fix before this is public

1. **`src/db.ts` hardcodes real database credentials** as fallback defaults
   (host `sql12.freesqldatabase.com`, user `sql12839434`, password in plain
   text). Anyone with the repo can connect. Rotate that password.
2. **`docker-compose.yml` hardcodes `JWT_SECRET` and DB passwords** — fine for
   local demos only.
3. **Seeded admin account** is `admin` / `admin123`. Change it on first login.
4. **Google sign-in**: if used, add your Render domain under Firebase Console →
   Authentication → Settings → Authorized domains.
