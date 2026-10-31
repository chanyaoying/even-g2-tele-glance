# TeleGlance

TeleGlance is an Even G2 glasses app for reading Telegram chats/topics and sending short replies with local voice transcription.

The app is designed for self-hosted use. The phone/glasses frontend stores the user's Telegram API credentials and MTProto session locally, while the backend stays a local relay for Telegram requests and Whisper transcription.

## What You Need

- Even G2 glasses and the Even Realities app.
- A local Mac/Linux machine for the backend.
- Telegram API credentials from `https://my.telegram.org`.
- A backend shared secret that you set both in backend `.env` and TeleGlance Settings. The same value must match exactly.
- Node.js for the frontend and Python 3.9+ for the backend.

## First-Time App Setup

1. Open `https://my.telegram.org`.
2. Sign in with your Telegram phone number.
3. Open API development tools and create an app.
4. Copy the API ID and API hash.
5. Create a backend shared secret. A strong random value is recommended:

```sh
openssl rand -base64 32
```

A normal string of your choice also works, but longer random values are safer. Put the same exact value in the backend root `.env` as `TELEGLANCE_SHARED_SECRET` and in TeleGlance Settings as `Backend shared secret`.

6. Open TeleGlance Settings and paste the API ID/hash, backend URL, and backend shared secret.
7. Save settings, then enter your mobile number with international code to receive a Telegram verification code.

After login, the frontend stores a Telegram StringSession on this phone only. On packaged phone builds, settings are mirrored into the Even App SDK storage so they survive app reopen/update; browser `localStorage` remains a simulator/development fallback. The backend receives encrypted credentials/session per request, but does not persist them in the public setup path. The shared secret is stored locally and used for encryption; it is not sent as plaintext.

Phone-code login requires the backend shared secret and API ID/API hash to be configured first.

## Configuration

Most settings live in the phone Settings page: Telegram API ID/hash, Telegram session, backend URL, backend shared secret, optional STT URL, recording minimum, and debug logging. Sensitive Telegram/shared-secret settings are stored in Even App SDK storage on phone builds and browser `localStorage` for simulator/development fallback, not cookies.

The backend needs root `.env` for `TELEGLANCE_SHARED_SECRET`. Create it before starting the backend and set it to the same value used in TeleGlance Settings:

```sh
cp .env.example .env
# edit .env and set TELEGLANCE_SHARED_SECRET
```

Relevant public settings:

- `BACKEND_CORS_ORIGINS`: optional comma-separated frontend origins for custom local development.
- `TAILSCALE_ENABLED`: defaults to `true`; keep enabled for local Tailscale testing. Set `TAILSCALE_ENABLED=false` only if you are not using Tailscale and want to rely on a LAN IP.
- `TELEGLANCE_SHARED_SECRET`: required shared secret for encrypted backend API payloads over HTTP. Generate with `openssl rand -base64 32` or choose your own strong string, then enter the same value in TeleGlance Settings.
- `WHISPER_MODEL`, `WHISPER_DEVICE`, `WHISPER_COMPUTE_TYPE`: optional local Whisper STT tuning. Defaults already run with `base`, `auto`, and `int8`.

Backend URL, STT URL, Telegram API ID/hash, Telegram session, and backend shared secret are configured in the frontend Settings page. `TELEGLANCE_SHARED_SECRET` must be configured on both sides. Telegram auth is sent in an encrypted header, JSON request bodies are encrypted, and JSON responses are encrypted before they are sent back to the app.

## Run The Backend

Repo link: `https://github.com/jalatif/even-g2-tele-glance.git`

```sh
git clone https://github.com/jalatif/even-g2-tele-glance.git
cd even-g2-tele-glance
cd server
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
cd ..
scripts/start-backend.sh --reload
```

### Docker behind Caddy (homelab setup)

`docker-compose.yml` joins the external `homelab_app-network` and publishes nothing on the Tailscale address; the backend is bound to `127.0.0.1:8788` for debugging only. Caddy proxies `https://teleglance.homelab.chanyaoying.com` to `teleglance:8787` (`homelab/caddy/conf.d/teleglance.caddy`, with `flush_interval -1` for the update stream). Set Backend URL in TeleGlance Settings to that https origin and package with:

```sh
BACKEND_ORIGIN=https://teleglance.homelab.chanyaoying.com npm run configure:tailscale --prefix web
```

Note: Caddy's single-file `Caddyfile` mount keeps the old inode when an editor replaces the file, so `docker restart caddy` (not just a reload) is needed after editing the `Caddyfile` itself. Files in `conf.d/` are a mounted directory and are picked up by a reload.

The backend listens on `0.0.0.0:8787` when started with `scripts/start-backend.sh`, so it can be reached from another device if your network allows it. Do not use `localhost` in TeleGlance Settings on the phone/glasses; use a Tailscale IP or LAN IP.

Tailscale is enabled by default for CORS. If Tailscale is installed and logged in, get the backend URL with:

```sh
tailscale ip -4
```

Then set Backend URL in TeleGlance Settings to `http://<tailscale-ip>:8787`.

If Tailscale is not installed or not working, either install/login to Tailscale or use LAN mode:

```sh
cp .env.example .env
# edit .env and set TELEGLANCE_SHARED_SECRET
echo "TAILSCALE_ENABLED=false" >> .env
```

Find your LAN IP:

```sh
# macOS, usually Wi-Fi:
ipconfig getifaddr en0

# Linux:
hostname -I
```

Then set Backend URL in TeleGlance Settings to `http://<lan-ip>:8787`.

## Quick Backend Setup For Installed App

Use this path if TeleGlance is already installed on your phone/glasses and you only need a backend:

```sh
git clone https://github.com/jalatif/even-g2-tele-glance.git
cd even-g2-tele-glance
cp .env.example .env
# edit .env and set TELEGLANCE_SHARED_SECRET
cd server
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
cd ..
scripts/start-backend.sh --reload
```

Then open TeleGlance Settings on the phone and set:

- `Backend URL`: `http://<your-computer-tailscale-or-lan-ip>:8787`
- `Backend shared secret`: required; must exactly match `TELEGLANCE_SHARED_SECRET` in root `.env`
- `STT Server Url (Optional)`: leave blank unless you run a separate transcription service

If you do not have an STT server, do nothing else: the backend includes local `faster-whisper` STT at `/api/transcribe` and uses the default `WHISPER_MODEL=base`. The first transcription can be slower because the model may need to download/load.

## Speech-To-Text

By default, voice replies are sent to the configured backend at `POST /api/transcribe`, where local Whisper runs through `faster-whisper`. The main backend transcription endpoint requires encrypted shared-secret auth.

Whisper settings are optional and live in the root `.env` if you want to tune transcription. Leave them unset for the default local STT setup:

```sh
# Defaults:
# WHISPER_MODEL=base
# WHISPER_DEVICE=auto
# WHISPER_COMPUTE_TYPE=int8
#
# Faster/lighter CPU option:
# WHISPER_MODEL=tiny
# WHISPER_COMPUTE_TYPE=int8
#
# More accurate but slower option:
# WHISPER_MODEL=small
# WHISPER_COMPUTE_TYPE=int8
#
# Advanced optional settings:
# WHISPER_BEAM_SIZE=1
# WHISPER_BEST_OF=1
# WHISPER_TEMPERATURE=0
# WHISPER_CONDITION_ON_PREVIOUS_TEXT=false
```

The phone Settings page also has `STT Server Url (Optional)`. Leave it blank to use the main backend. If set, that custom server must expose the same `POST /api/transcribe` API and return:

```json
{ "text": "transcribed message" }
```

Audio for transcription is sent to whichever STT/backend URL is configured. Leave STT URL blank to use your own backend. Only enter a custom STT URL if you trust that server with voice audio and transcript content.

Custom STT requests intentionally do not include Telegram auth headers. If you set a separate STT URL, that server must provide its own access control if it is reachable by anyone else.

## Run The Frontend Locally

```sh
cd web
npm install
npm run dev
```

Open the printed Vite URL in a browser. The same settings page is used for backend URL, Telegram credentials, STT URL, recording minimum, and debug logging.

## Tailscale Device Testing

```sh
cd web
npm run configure:tailscale
npm run dev:tailscale
```

`configure:tailscale` detects the machine's Tailscale IP and saves it to `app.local.json` (gitignored). `app.json` is not modified and keeps the runtime placeholder (`http://<BACKEND_URL>:8787`); `scripts/effective-manifest.mjs` (run automatically by `scripts/upload.mjs`) substitutes your origin into a generated, gitignored `.app-build/app.json` that gets packaged. If you are not using Tailscale, set `BACKEND_ORIGIN` to the exact backend origin you plan to ship, rerun the configurator, and repack before sideloading.

If backend requests fail with CORS errors while using a custom URL, prefer Tailscale first. If you must use another private network range, add a regex override in root `.env`, for example:

```sh
# Example only: allow local LAN origins from common private ranges.
BACKEND_CORS_ORIGIN_REGEX=^https?://(localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2[0-9]|3[0-1])\.\d{1,3}\.\d{1,3})(:\d+)?$
```

## Simulator

Start the backend and frontend, then run:

```sh
npx @evenrealities/evenhub-simulator@0.7.2 http://localhost:5173
```

Use the simulator to verify startup rendering, list navigation, message scrolling, phone-code login screens, and frontend settings before packaging.

Automated fixture validation is available:

```sh
npm run test:simulator --prefix web
```

This starts a fixture-mode Vite app, launches `@evenrealities/evenhub-simulator@0.7.2` with its automation API, drives chat/topic up/down/click/double-click flows, validates deterministic state and message content, and writes report artifacts under `artifacts/simulator-flow/<timestamp>/`. Blank glasses framebuffer captures are reported directly and are never replaced with desktop screenshots.

After intentional visual changes, inspect the generated `report.md` and valid glasses screenshots, then update goldens with:

```sh
npm run test:simulator --prefix web -- --update-goldens
```

For a state/content-focused run that does not fail only because the simulator
glasses screenshot endpoint returned a blank framebuffer:

```sh
node scripts/simulator-flow.mjs --fast --skip-latency-check
```

See [`validate_prompt_fixes.md`](docs/validate_prompt_fixes.md) for the June 10, 2026
simulator investigation, implemented fixes, and remaining harness work.

## Package For G2

```sh
npm run build --prefix web
node scripts/effective-manifest.mjs   # writes .app-build/app.json (app.json + app.local.json)
npx --yes @evenrealities/evenhub-cli@0.2.0 pack .app-build/app.json web/dist -o tele-glance-<version>.ehpk
```

The default `.ehpk` contains only the frontend and manifest and keeps the shared testing backend available for onboarding. For a custom self-hosted or Tailscale backend package, run `npm run configure:tailscale --prefix web` first, then rebuild and pack.

## Debugging

- Backend health: `curl http://localhost:8787/health`
- Backend logs: watch the terminal running `scripts/start-backend.sh`.
- Frontend checks: `npm run typecheck --prefix web` and `npm test --prefix web`.
- Backend checks: `PYTHONPYCACHEPREFIX=.pycache server/.venv/bin/python -m pytest tests/backend`.
- Hardware debug endpoints (`/api/debug/events`) require the same encrypted shared-secret auth as other sensitive backend calls. Use the in-app debug logging toggle instead of unauthenticated curl calls for normal hardware validation.
- Hardware notes: [EVEN_REALITIES_HW.md](EVEN_REALITIES_HW.md).
- Frontend architecture notes: [FRONTEND_ARCHITECTURE.md](FRONTEND_ARCHITECTURE.md).

## Privacy Notes

Telegram API hash, backend shared secret, and session strings are sensitive. Storing them in phone app storage keeps them off backend disk, but anyone with access to that phone/app storage, device backup, injected JavaScript, or a malicious WebView context could read them.

TeleGlance requires `TELEGLANCE_SHARED_SECRET` in the backend root `.env` and the same value in TeleGlance Settings. The frontend uses WebCrypto AES-GCM with that secret to send Telegram API ID/hash/session in `X-TeleGlance-Auth`, encrypt JSON request bodies, decrypt JSON responses, and decrypt update-stream event payloads. The secret token itself is not sent as plaintext.

This protects app-level payloads from passive HTTP sniffing, but it is not a full HTTPS replacement. A malicious network can still block or tamper with traffic, endpoint URLs and timing are still visible, and audio sent to STT is only as private as the configured STT server. Prefer Tailscale or HTTPS for public use.

Custom STT servers never receive Telegram auth headers from the frontend. They still receive voice audio and transcript-relevant content, so only configure STT URLs you trust.

Run your own backend. Do not point this app at a shared public backend unless that backend has real user authentication, encrypted session handling, rate limiting, and a clear privacy policy.

Audio for transcription is sent to the configured STT/backend URL. Use a backend or STT server you control if message and audio privacy matter.
