# Running TeleGlance with Docker

One container, `teleglance`: the FastAPI backend (Telegram MTProto relay + local faster-whisper STT).
It joins the external `homelab_app-network` and is reached through Caddy at
`https://teleglance.homelab.chanyaoying.com` (`homelab/caddy/conf.d/teleglance.caddy`).
For debugging it is also bound to `127.0.0.1:8788` (8787 inside the container).

The frontend is not served from Docker: the beta/private build is a packaged `.ehpk` that already
contains it. For development use `npm run dev --prefix web` and the Even Hub simulator.

## Setup

```sh
cp .env.example .env
sed -i "s|^TELEGLANCE_SHARED_SECRET=.*|TELEGLANCE_SHARED_SECRET=$(openssl rand -base64 32)|" .env
chmod 600 .env
docker compose up -d --build
curl http://127.0.0.1:8788/health
curl https://teleglance.homelab.chanyaoying.com/health
```

Whisper models are cached in the `whisper-models` volume (first transcription downloads the model).

## Install on the glasses

Package and release with `node scripts/upload.mjs --publish -m "<changelog>"` (uploads, creates the
private build and promotes it to beta), then install the beta build from the Even app. In TeleGlance
Settings enter the Telegram API ID/hash, Backend URL `https://teleglance.homelab.chanyaoying.com`, and
the shared secret from `.env`.
