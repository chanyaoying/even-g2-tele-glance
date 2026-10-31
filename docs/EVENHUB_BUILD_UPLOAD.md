# EvenHub Build Upload

## Quick start

```bash
# Full pipeline: build, pack, upload, create the private build, promote it to the beta channel
# (add --no-beta to stop at the private build)
node scripts/upload.mjs --publish -m "Description of changes"

# Just upload to draft (won't appear on glasses until published via portal)
node scripts/upload.mjs

# Dry-run to preview
node scripts/upload.mjs --dry-run
```

## Prerequisites

1. **EvenHub CLI login**: Run `npx @evenrealities/evenhub-cli login` once. This stores credentials at `~/.config/evenhub/credentials.yaml`. The upload script reads the access token from there.

2. **app.json**: Must exist at repo root with `package_id` and `version` fields set. The script reads `version` to discover the matching `.ehpk` file.

3. **Built `.ehpk`**: Either let the script build it (`npm run build --prefix web` + `evenhub pack`), or pass `--skip-build` if you already have the file.

## What happens

The script performs up to 3 steps:

### Step 1 — Build + Pack (unless `--skip-build`)

Runs `npm run build --prefix web` followed by `npx @evenrealities/evenhub-cli@0.2.0 pack .app-build/app.json web/dist -o tele-glance-<version>.ehpk`, where `.app-build/app.json` is generated from `app.json` plus the optional gitignored `app.local.json` by `scripts/effective-manifest.mjs`.

The default upload package keeps the shared testing backend (`https://teleglance.akira-os.net`) and the unreplaced placeholder from `app.json`. Run `npm run configure:tailscale --prefix web` only for deliberate local device-test packages that should bake in a custom reachable backend origin; it writes `app.local.json` (gitignored) and leaves `app.json` untouched. Delete `app.local.json` to package without it.

The `.ehpk` filename always matches `app.json`'s `version`. Bump `app.json` version before building.

### Step 2 — Upload to Draft

**`POST /api/v1/versions/draft?package_id=<id>`**

Sends the `.ehpk` as `multipart/form-data` with field name `ehpk`. Auth header: `X-Even-Authorization`.

On success, returns a `draft_id`. At this point the build exists in **Draft** state — invisible to anyone except you in the portal.

### Step 3 — Create Version (`--publish` flag)

**`POST /api/v1/versions/create?package_id=<id>`**

Sends `draft_id` and optional `changelog` as FormData. This moves the build from Draft → **Test** state, making it a **private build** installable on your glasses via the Even Realities app under Even Hub → Private builds.

Without `--publish`, Step 3 is skipped and the script prints a reminder.

## Token handling


- The access token is read from `~/.config/evenhub/credentials.yaml` (created by `evenhub login`).
- If the access token is expired (HTTP 401), the script auto-refreshes it using the refresh token stored in the same file and **saves the new tokens back** to the YAML file.
- Refresh tokens are single-use. If a refresh returns `code: 1006` ("auth error"), the token was already consumed. Re-run `npx @evenrealities/evenhub-cli login`.
- No tokens, emails, or credentials are **ever** hardcoded in the script or logged to output.
- The `X-Even-Authorization` header is sent over HTTPS.

## API Endpoints (discovered from portal JS bundles)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/versions/draft?package_id=` | Upload `.ehpk` → Draft state |
| `POST` | `/api/v1/versions/create?package_id=` | Draft → Test (private build) |
| `GET`  | `/api/v1/versions/list-private?package_id=` | List your private builds |
| `POST` | `/api/v1/auth/refresh` | Exchange refresh token for new access token |
| `GET`  | `/api/v1/auth/self_check` | Validate current session |
| `GET`  | `/api/v1/apps/check?package_id=` | Check if package ID is taken |

There is **no CLI `deploy` command**; `npx @evenrealities/evenhub-cli` only provides `login`, `init`, `pack`, and `qr`. Upload can be done through the web portal at `https://hub.evenrealities.com/hub` or via the script above.

## Build state machine

```
Draft ──(upload .ehpk)──▶ Test ──(portal submit)──▶ Submitted ──(reviewer)──▶ Released
               ▲              │                         │
               │              │ (fail review)           │
               └──────────────┴─────────────────────────┘
```

- **Draft**: Exists in your project, not visible to anyone else.
- **Test**: Private build. Installable on your glasses via Even Realities App → Even Hub → Private builds. You stay in this state for device testing.
- **Submitted**: In reviewer queue. You cannot change the build.
- **Released**: Public in the store. Immutable — any fix requires a higher version.

## Options reference

```
node scripts/upload.mjs [options]

  --publish, --create    After upload, create the version as private build
  --changelog, -m <msg>  Changelog message (only with --publish)
  --project-id <id>      Override package_id from app.json
  --endpoint <url>       Override upload API endpoint
  --skip-build           Skip build+pack (use existing .ehpk)
  --dry-run              Preview without uploading
  -h, --help             Show help
```

## Troubleshooting

**"No authentication token found"**  
Run `npx @evenrealities/evenhub-cli login` first. The script looks for `~/.config/evenhub/credentials.yaml`.

**"No .ehpk file found"**  
Run without `--skip-build` to build automatically, or check that `app.json` version matches the `.ehpk` filename.

**HTTP 401 on upload (token appears valid)**
The `~/.config/evenhub/credentials.yaml` file may use YAML block scalar syntax (`access_token: >-` / `refresh_token: >-`) where the actual JWT is on an indented continuation line. If `readToken()` or `readRefreshToken()` in `scripts/upload.mjs` only captures the `>-` indicator (2 chars) instead of the indented value, the API rejects it as invalid. Check that the YAML parser handles block scalar indicators (`>-`, `|-`, `|`, `>`) by reading the indented continuation line(s). If the file uses plain inline values (`access_token: eyJ...`), the regex-based parser works fine.

**HTTP 401 on upload (token genuinely expired)**
Token expired. The script auto-refreshes if a refresh token is available. If that also fails, re-run `evenhub login`.

**Upload succeeds but build not on glasses**  
The upload only goes to Draft. Use `--publish` to create the version as a private build, or log into the EvenHub portal and move it to Test manually.

**"app's package_id already exists" on `/api/v1/apps/draft`**  
You're hitting the wrong endpoint. Use `/api/v1/versions/draft` for uploading new versions of an existing app. `/api/v1/apps/draft` is for brand-new app registration.
