# SingDeck

SingDeck is a local-first, single-controller sing-box dashboard. The frontend still talks directly to one `experimental.clash_api` endpoint, and an optional local helper service can provide node scoring plus read-only access to the running sing-box config file.

## Features

- Single controller setup with zashboard-style URL startup parameters.
- Connection detection with actionable auth/network/CORS-style failure buckets.
- Runtime dashboard for version, mode, traffic rates, totals, and connection counts.
- Proxy topology view with selector switching and per-node delay test URL overrides.
- Local helper service for per-strategy-group node scoring and full config file display.
- Connection browser with filtering and close actions.
- Log workspace with level and text filters.
- JSON config workspace with necessary sing-box dashboard checks, snapshots, import/export-ready content, and sensitive-field masking.
- Client-side subscription parsing for common `ss://`, `trojan://`, and `vless://` links.
- Advanced tools for simple route simulation, selector graph edges, Linux pasted-output diagnostics, and API compatibility shaping.

## Development

```bash
pnpm install
pnpm start
```

The app is served by Vite and can be installed as a PWA in supported browsers.

Run the helper service in a separate terminal when you want scoring or direct config file reading:

```bash
pnpm helper:dev
```

The helper listens on `http://127.0.0.1:9531` by default. In Settings, set the helper URL and optionally set the config path, for example `/etc/sing-box/config.json` or `/etc/sing-box/config.jsonc`.

## Verification

```bash
pnpm check
pnpm helper:test
```

`pnpm check` runs the Vitest suite and a production build. `pnpm helper:test` runs the Rust helper unit tests.

## Local Use Notes

Set the controller URL to your sing-box Clash API endpoint, for example `http://127.0.0.1:9090`. If `secret` is configured in sing-box, enter the same value in SingDeck. URL parameters may also initialize the controller, but placing `secret` in a URL can leak it through browser history or shared links.
