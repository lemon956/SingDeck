# SingDeck

[English](README.md) | [简体中文](README.zh-CN.md)

SingDeck is a local-first, single-controller sing-box dashboard. The web app talks directly to one `experimental.clash_api` endpoint from the browser. An optional local helper service adds node scoring, scheduled probes, config-file reading, raw config download, and provider traffic snapshots.

## Features

- Single sing-box Clash API controller setup with zashboard-style URL startup parameters.
- Connection detection with auth, network, CORS, and Private Network Access failure hints.
- Runtime dashboard for version, mode, traffic rates, totals, and connection counts.
- Proxy topology, selector switching, per-node delay tests, and per-group test URL overrides.
- Optional helper service for strategy-group scoring, scheduled probes, auto-switching, and config-file access.
- Connection browser with filtering and close actions.
- Log workspace with level and text filters.
- JSON config workspace with necessary sing-box dashboard checks, snapshots, import/export-ready content, and sensitive-field masking.
- Client-side subscription parsing for common `ss://`, `trojan://`, and `vless://` links.
- Advanced tools for route simulation, selector graph edges, Linux pasted-output diagnostics, and API compatibility shaping.

## Architecture

SingDeck can run in two modes:

- Frontend-only mode: deploy the built `dist/` directory as a static site. The browser connects directly to the sing-box Clash API.
- Frontend plus helper mode: run the static frontend and also run `singdeck-helper` near the sing-box instance. The helper stores local state in SQLite and calls the Clash API from the host machine.

The frontend does not require a backend for basic runtime control. The helper is optional, but required for helper-based scoring, scheduled probes, auto-switching, direct config-file reads, raw config download, and the traffic workspace.

## Prerequisites

- Node.js and pnpm for the frontend.
- Rust and Cargo for the helper service.
- A running sing-box instance with `experimental.clash_api` enabled.
- A reachable Clash API URL, for example `http://127.0.0.1:9090`.

## sing-box Configuration

Enable the Clash API in your sing-box config:

```jsonc
{
  "experimental": {
    "clash_api": {
      "external_controller": "127.0.0.1:9090",
      "secret": "change-this-secret"
    }
  }
}
```

Use a `secret` whenever the controller is reachable outside the local machine. If the frontend runs on another host or device, the controller must be reachable from that browser, not just from the server hosting SingDeck.

## Development

Install dependencies and start the Vite development server:

```bash
pnpm install
pnpm start
```

`pnpm start` runs Vite with `--host 0.0.0.0`. It is for development and local testing, not production serving.

Run the helper service in another terminal when you want helper features:

```bash
SINGDECK_HELPER_BIND=127.0.0.1:9531 \
SINGDECK_HELPER_DB=$HOME/.local/state/singdeck/helper.db \
pnpm helper:dev
```

Open the app, then go to Settings:

1. Set the controller URL, for example `http://127.0.0.1:9090`.
2. Enter the same `secret` configured in sing-box.
3. Set the helper URL, for example `http://127.0.0.1:9531`.
4. Sync/check the helper.
5. If you need config access, explicitly set the config path, for example `/etc/sing-box/config.json` or `/etc/sing-box/config.jsonc`; the helper only reads the path saved in Settings.

## Frontend Deployment

Build the static app:

```bash
pnpm install
pnpm build
```

The production files are written to `dist/`. Serve that directory with any static host, such as nginx, Caddy, object storage, Pages, or a CDN.

Example nginx site:

```nginx
server {
  listen 80;
  server_name singdeck.example.com;

  root /var/www/singdeck/dist;
  index index.html;

  location / {
    try_files $uri $uri/ /index.html;
  }
}
```

The Vite config uses `base: './'`, so the app can also be served from a subdirectory.

For a local production preview:

```bash
pnpm preview
```

## Helper Deployment

Build the helper binary:

```bash
cargo build --release --manifest-path helper/Cargo.toml
```

Create a state directory and run the binary:

```bash
sudo mkdir -p /var/lib/singdeck
sudo chown "$USER":"$USER" /var/lib/singdeck

SINGDECK_HELPER_BIND=127.0.0.1:9531 \
SINGDECK_HELPER_DB=/var/lib/singdeck/helper.db \
./helper/target/release/singdeck-helper
```

The helper code default is `0.0.0.0:9531`, so set `SINGDECK_HELPER_BIND` explicitly unless you intentionally want LAN access. The helper has no built-in authentication and enables permissive CORS.

Systemd templates are provided under `deploy/systemd`:

- `singdeck-helper.service`: standalone helper service.
- `singdeck-helper.with-sing-box.service`: starts, stops, and restarts with `sing-box.service`.
- `singdeck-helper.env.example`: shared helper environment file.

Install the helper binary and environment file:

```bash
id -u singdeck >/dev/null 2>&1 || sudo useradd --system --home /var/lib/singdeck --shell /usr/sbin/nologin singdeck
sudo install -Dm755 helper/target/release/singdeck-helper /opt/singdeck/singdeck-helper
sudo install -Dm640 deploy/systemd/singdeck-helper.env.example /etc/singdeck/helper.env
```

For standalone startup:

```bash
sudo install -Dm644 deploy/systemd/singdeck-helper.service /etc/systemd/system/singdeck-helper.service
sudo systemctl daemon-reload
sudo systemctl enable --now singdeck-helper.service
```

For startup synchronized with sing-box:

```bash
sudo install -Dm644 deploy/systemd/singdeck-helper.with-sing-box.service /etc/systemd/system/singdeck-helper.service
sudo systemctl daemon-reload
sudo systemctl enable singdeck-helper.service
sudo systemctl restart sing-box.service
```

The synchronized unit uses `BindsTo=sing-box.service`, `PartOf=sing-box.service`, `After=sing-box.service`, and `WantedBy=sing-box.service`. Starting `sing-box.service` also starts the helper; stopping or restarting sing-box propagates to the helper. If your sing-box unit has a different name, edit the template before installing it.

## Helper Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `SINGDECK_HELPER_BIND` | `0.0.0.0:9531` | Address and port for the helper HTTP API. Use `127.0.0.1:9531` for local-only access. |
| `SINGDECK_HELPER_DB` | `singdeck-helper.db` | SQLite state database path. Store it outside the git checkout in deployed environments. |
| `SINGDECK_HELPER_PUBLIC_URL` | unset | Public base URL used to build `/api/v1/config/raw` links for remote profile import. |

The helper database stores controller settings, secrets, group settings, scheduled probe timestamps, and probe samples. Do not commit it and do not share it as a deployment artifact.

## Provider Traffic

Provider Traffic is optional and is disabled by default. Enable it in Settings, then set the Chrome profile directory used for provider sessions, for example:

```text
/home/alice/.config/google-chrome/Default
```

The helper only uses the Chrome profile path saved in Settings; it does not auto-detect or default to the current user's Chrome profile. It reads Chrome's `Cookies` or `Network/Cookies` SQLite database and `Local Storage/leveldb` under that directory. The directory is created by Chrome, not by SingDeck. If the helper runs as the `singdeck` system user, it cannot usually read a desktop user's Chrome profile or decrypt cookies through that user's keyring. For this module, either run the helper as the same desktop user that owns the Chrome profile, or point it at a readable profile directory.

## Verification

Run frontend tests and production build:

```bash
pnpm check
```

Run helper tests:

```bash
pnpm helper:test
```

Check a running helper:

```bash
curl http://127.0.0.1:9531/api/v1/health
```

Expected response fields include `ok`, `sqlite`, `controllerConfigured`, and `controllerReachable`.

## Security Notes

- The frontend stores controller settings in the current browser.
- A `secret` in a URL parameter can leak through browser history, bookmarks, screenshots, and shared links. Prefer entering it in Settings.
- Do not expose sing-box Clash API on `0.0.0.0` without a `secret`.
- Do not expose the helper to the public internet. It has no authentication and can read configured local files.
- Browser-to-controller requests may be blocked by CORS, HTTPS-to-HTTP mixed content rules, or Private Network Access restrictions. If SingDeck is hosted on a public HTTPS origin and the controller is private HTTP, test from the target browser.
- If mobile devices need to import the raw config through the helper, bind the helper to a reachable LAN address and set `SINGDECK_HELPER_PUBLIC_URL`; protect that network path carefully.

## Troubleshooting

- Helper URL fails: confirm the helper is running and `curl http://127.0.0.1:9531/api/v1/health` works from the same machine as the browser.
- Controller is configured but unreachable: confirm the URL is reachable from the browser for frontend-only features, and from the helper host for helper features.
- Config workspace cannot read the file: set the config path in Settings and make sure the helper process user can read it.
- Scores do not appear: sync the controller to the helper, then load groups or manually probe a group.
- Provider Traffic is hidden: enable it in Settings.
- Traffic workspace shows provider errors: check the Chrome profile path in Settings and make sure the relevant provider sessions exist in that Chrome profile.
