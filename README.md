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

## Roadmap

The following directions have been explored but are not implemented yet. Priorities may change.

Planned features:

- Runtime memory panel and one-click proxy mode switch over the Clash API (`/memory`, `/configs`).
- Per-node delay history trends rendered from stored helper probe samples.
- Provider quota and expiry visualization in the subscription and Overview views.
- Full UI internationalization for English and Simplified Chinese.

Engineering improvements:

- Retention cleanup for the helper `probe_samples` table to bound database growth.
- Panic-resilient background tasks (probe scheduler, network-usage sampler) with automatic restart.
- Structured logging with `tracing` and `RUST_LOG` level control in the helper.
- Module split for the oversized `helper/src/main.rs` and `src/ui/App.tsx`.

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

sudo env \
  SINGDECK_HELPER_BIND=0.0.0.0:9531 \
  SINGDECK_HELPER_DB=/var/lib/singdeck/helper.db \
  ./helper/target/release/singdeck-helper
```

The helper code default is `0.0.0.0:9531`. Keep that binding when phones or other LAN devices need to import the raw config URL. Use `127.0.0.1:9531` only for local-only access. The helper has no built-in authentication and enables permissive CORS.

Systemd templates are provided under `deploy/systemd`:

- `singdeck-helper.service`: standalone helper service.
- `singdeck-helper.with-sing-box.service`: starts, stops, and restarts with `sing-box.service`.
- `singdeck-helper.env.example`: shared helper environment file.

Install the helper binary and environment file:

```bash
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

The packaged systemd units run as root by default so the helper can read root-owned sing-box config files and Chrome profile paths explicitly configured in Settings.

## Helper Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `SINGDECK_HELPER_BIND` | `0.0.0.0:9531` | Address and port for the helper HTTP API. Use `127.0.0.1:9531` for local-only access. |
| `SINGDECK_HELPER_DB` | `singdeck-helper.db` | SQLite state database path. Store it outside the git checkout in deployed environments. |
| `SINGDECK_HELPER_PUBLIC_URL` | unset | Public base URL used to build `/api/v1/config/raw` links for remote profile import. |
| `SINGDECK_PROXYCHECK_KEY` | unset | Optional proxycheck.io key. Residential/data-center detection works without it; a free key raises the provider request allowance. |
| `SINGDECK_IPINFO_TOKEN` | unset | Optional IPinfo Privacy Detection API token. An unset token is reported as `not_configured`, never as a clean result. |
| `SINGDECK_ABUSEIPDB_KEY` | unset | Optional AbuseIPDB API key. An unset key is reported as `not_configured`, never as a no-reports result. |

The helper database stores controller settings, secrets, group settings, scheduled probe timestamps, and probe samples. Do not commit it and do not share it as a deployment artifact.

### Gemini Location and Node Inspection Parameters

Choose the one Selector group allowed to run the Gemini location probe with `geminiLocationGroup` in Settings. The selected group's sidebar stores `geminiLocationProbeEnabled`; Gemini controls and results are hidden from every other group. No group name is built into this behavior.

Gemini location probes always use the Google login stored in the Chrome profile selected by `Chrome profile (Gemini / Provider)` in Settings. There is no anonymous first request and no Chrome fallback switch. Provider Traffic does not need to be enabled for this profile to be used. After selecting each node, the helper loads `https://gemini.google.com/app` with the Chrome cookies and UA, extracts the fresh `at`, `f.sid`, and `bl` values, then calls `K4WWud` through the same node and temporary cookie session. Dynamic session values are neither persisted nor logged and are never reused across nodes.

An unconfigured profile, missing or undecryptable Google account cookies, or an expired login produces `auth_error`. The helper never falls back to an anonymous location request, and one optional inspection failure does not stop the other selected inspections. Legacy anonymous Gemini results are hidden until an authenticated inspection replaces them.

Speed probes and egress inspections are separate operations. `POST /api/v1/groups/<group>/probe` accepts only the speed-probe concurrency and never reads saved inspection switches or runs Gemini, exit-IP, or network-class detection:

```json
{
  "concurrency": 4
}
```

The sidebar's “Run egress inspection” button calls `POST /api/v1/groups/<group>/inspection`. Only this endpoint invokes the explicitly selected detector modules:

```json
{
  "geminiLocation": true,
  "nodeRisk": {
    "exitIp": false,
    "addressScope": false,
    "networkIdentity": false,
    "networkClass": true,
    "routeSecurity": false,
    "tor": false,
    "privacy": false,
    "abuse": false
  }
}
```

`geminiLocation: true` is accepted only for the Selector group selected in Settings. Generic exit and network inspection is available to every strategy group that contains concrete outbound members. `exitIp` and `networkClass` are independent: when `networkClass: true` and `exitIp: false`, the helper observes the address internally but leaves `nodes[].raw.nodeRisk.exitIp` as `null`. The report's `checks` object records the exact requested selection. Scheduled and failure-triggered probes remain speed-only and never invoke an inspection implicitly.

The helper logs `inspection start/complete` for each run and emits one `Gemini location result` or `node risk result` JSON line per node. These lines contain statuses, results, and sanitized error context, but never Cookie values or the dynamic `at`, `f.sid`, and `bl` session parameters. Follow them with `journalctl -u singdeck-helper.service -f`.

Generic inspection does not switch a Selector and does not interrupt existing connections. For each concrete member, the helper derives a minimal configuration from the sing-box config path saved in Settings and runs `sing-box tools fetch --outbound <member>` against the canonical HTTPS endpoint `https://api64.ipify.org?format=json`. The helper host therefore needs a readable sing-box configuration and a `sing-box` executable in its service `PATH`. A missing tag, unsupported group tag, invalid dependency chain, command timeout, or endpoint failure is reported for that node without changing any live policy-group selection.

`networkClass` queries proxycheck.io and ipquery.io independently and concurrently; neither provider is a fallback for the other. Provider-specific records are returned in `networkClass.evidence`. Explicit residential, hosting, wireless/mobile, and business signals map to `residential`, `data_center`, `mobile`, and `business`; conflicting signals produce `mixed`. A provider response without an explicit positive signal remains `unknown`, partial provider failures retain the successful evidence, and only an all-provider failure produces `unavailable`. This detector does not reuse privacy, reputation, BGP, or Tor results.

If Gemini redirects the Chrome-authenticated request to `/sorry/`, SingDeck reports `anti_abuse_challenge`. This proves that Google applied an anti-abuse challenge to that request, not that SingDeck has classified the node as malicious. Google does not expose the exact matched rule; shared-exit request volume, automation characteristics, account-session/IP mismatch, or IP reputation can all contribute.

## Provider Traffic

Provider Traffic is optional and is disabled by default. The Chrome profile in Settings is shared by authenticated Gemini probes and Provider Traffic, and remains usable by Gemini while Provider Traffic is disabled. Enable Provider Traffic only when provider usage synchronization is wanted, for example:

```text
/home/alice/.config/google-chrome/Default
```

The helper only uses the Chrome profile path saved in Settings; it does not auto-detect or default to the current user's Chrome profile. It reads Chrome's `Cookies` or `Network/Cookies` SQLite database and `Local Storage/leveldb` under that directory. The directory is created by Chrome, not by SingDeck. For encrypted Chrome cookies, the helper uses `secret-tool`; when the helper runs as root, it also tries the Chrome profile owner's DBus keyring session. Keep the desktop user's keyring unlocked, and install the libsecret tools package if `secret-tool` is unavailable.

Provider Traffic currently syncs WD Gold and XNYun. WD Gold uses the subscription URL saved in the configured Chrome profile session, then reads the `subscription-userinfo` response header for upload, download, total, and expire values. If that URL is unavailable, the helper falls back to the logged-in WD product page. The helper does not store provider passwords or attempt automated login. If a WD Gold sync fails after a previous success, Overview keeps showing the last successful WD Gold snapshot as stale data until the Chrome profile has a usable WD session again.

The Provider Traffic widget also shows a 7-day source usage trend when Network usage is enabled. The trend is calculated from SingDeck's local `network_usage_buckets` samples and the `nodeSources` node associations in the sidecar config. Use the Hour/Day switch to aggregate the same 7-day window by hour or by day. Traffic whose outbound node cannot be matched to a configured source is grouped as `unknown`, and the widget lists the unknown nodes underneath the chart.

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
- Gemini reports that the Chrome Google login is unavailable: point Settings at the Chrome profile currently signed in to Google/Gemini, open Gemini with that same profile to refresh the login, and make sure the helper can read the Cookies database and the unlocked system keyring.
- Provider Traffic is hidden: enable it in Settings.
- Traffic workspace shows provider errors: check the Chrome profile path in Settings and make sure WD Gold and XNYun sessions exist in that Chrome profile.
- WD Gold shows stale data: the WD login session or Cloudflare verification is usually expired. Open WD Gold with the same Chrome profile, log in or pass verification again, then click Sync in Overview.
