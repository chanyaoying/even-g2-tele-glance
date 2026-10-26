# Running TeleGlance with Docker

Two containers, both published **only on your Tailscale address**:

| Service | Port | Purpose |
|---|---|---|
| `teleglance` | 8787 | FastAPI backend: Telegram (MTProto) relay + local faster-whisper STT |
| `teleglance-web` | 5173 | Static frontend, for sideloading into the Even app via `evenhub qr` |

## Setup

```sh
cp .env.example .env
sed -i "s|^TELEGLANCE_SHARED_SECRET=.*|TELEGLANCE_SHARED_SECRET=$(openssl rand -base64 32)|" .env
echo "TAILSCALE_IP=$(tailscale ip -4 | head -1)" >> .env
chmod 600 .env
docker compose up -d --build
curl http://$(tailscale ip -4 | head -1):8787/health
```

Whisper models are cached in the `whisper-models` volume (first transcription downloads the model).

## Sideload to the glasses

```sh
npx @evenrealities/evenhub-cli qr --http -i "$(tailscale ip -4 | head -1)" -p 5173
```

Scan the QR in the Even Realities app, then in TeleGlance Settings enter the Telegram API ID/hash,
Backend URL `http://<tailscale-ip>:8787`, and the shared secret from `.env`.
