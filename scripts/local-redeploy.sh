#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/local-redeploy.sh

Build and install the local SingDeck frontend and helper, then restart services.

Environment overrides:
  SINGDECK_WEB_ROOT=/var/www/singdeck/dist
  SINGDECK_HELPER_BIN=/opt/singdeck/singdeck-helper
  SINGDECK_HELPER_SERVICE=singdeck-helper.service
  SINGDECK_SING_BOX_SERVICE=sing-box.service
  SINGDECK_WEB_SERVICE=                 optional nginx/caddy service to reload
  SINGDECK_RESTART_MODE=both            sing-box|sb|helper|both|combined|none
  INSTALL_HELPER_SERVICE=1              1|0, install managed helper systemd service
  SINGDECK_DISABLE_EMBEDDED_HELPER=1    1|0, clear sing-box ExecStartPost helper hooks
  SINGDECK_KILL_STALE_HELPER=1          1|0, kill unmanaged singdeck-helper before restart
  INSTALL_FRONTEND=1                    1|0
  INSTALL_HELPER=1                      1|0
  RUN_TESTS=0                           1|0
  DRY_RUN=0                             1|0, print commands without changing files
  PNPM=pnpm
  CARGO=cargo

Examples:
  scripts/local-redeploy.sh
  SINGDECK_SING_BOX_SERVICE=sb.service scripts/local-redeploy.sh
  RUN_TESTS=1 SINGDECK_RESTART_MODE=both scripts/local-redeploy.sh
  SINGDECK_RESTART_MODE=combined scripts/local-redeploy.sh
  DRY_RUN=1 scripts/local-redeploy.sh
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

enabled() {
  case "${1,,}" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

run() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  if ! enabled "$DRY_RUN"; then
    "$@"
  fi
}

run_sudo() {
  if ((${#SUDO_CMD[@]})); then
    run "${SUDO_CMD[@]}" "$@"
  else
    run "$@"
  fi
}

run_allow_fail() {
  printf '+'
  printf ' %q' "$@"
  printf ' || true\n'
  if ! enabled "$DRY_RUN"; then
    "$@" || true
  fi
}

run_sudo_allow_fail() {
  if ((${#SUDO_CMD[@]})); then
    run_allow_fail "${SUDO_CMD[@]}" "$@"
  else
    run_allow_fail "$@"
  fi
}

sudo_test_exists() {
  if ((${#SUDO_CMD[@]})); then
    "${SUDO_CMD[@]}" test -e "$1"
  else
    test -e "$1"
  fi
}

require_binary() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

strip_trailing_slashes() {
  local value="$1"
  while [[ "$value" != "/" && "$value" == */ ]]; do
    value="${value%/}"
  done
  printf '%s' "$value"
}

ensure_safe_path() {
  local label="$1"
  local value="$2"

  [[ -n "$value" ]] || die "$label must not be empty"
  [[ "$value" != "/" ]] || die "$label must not be /"
  [[ "$value" != "." && "$value" != ".." ]] || die "$label must be an absolute or explicit deploy path"
}

preflight() {
  [[ -f "$ROOT_DIR/package.json" ]] || die "package.json not found at repo root"
  [[ -f "$ROOT_DIR/helper/Cargo.toml" ]] || die "helper/Cargo.toml not found"

  if ! enabled "$DRY_RUN"; then
    if ((${#SUDO_CMD[@]})); then
      require_binary "${SUDO_CMD[0]}"
    fi
    if enabled "$INSTALL_FRONTEND"; then
      require_binary "$PNPM_BIN"
    fi
    if enabled "$INSTALL_HELPER"; then
      require_binary "$CARGO_BIN"
    fi
    if [[ -n "$WEB_SERVICE" || "$RESTART_MODE" != "none" ]] || enabled "$INSTALL_HELPER_SERVICE"; then
      require_binary systemctl
    fi
  fi
}

build_and_test() {
  if enabled "$RUN_TESTS"; then
    if enabled "$INSTALL_FRONTEND"; then
      run "$PNPM_BIN" test
    fi
    if enabled "$INSTALL_HELPER"; then
      run "$CARGO_BIN" test --manifest-path "$ROOT_DIR/helper/Cargo.toml"
    fi
  fi

  if enabled "$INSTALL_FRONTEND"; then
    run "$PNPM_BIN" build
  fi
  if enabled "$INSTALL_HELPER"; then
    run "$CARGO_BIN" build --release --manifest-path "$ROOT_DIR/helper/Cargo.toml"
  fi
}

install_frontend() {
  ensure_safe_path "SINGDECK_WEB_ROOT" "$WEB_ROOT"

  if ! enabled "$DRY_RUN"; then
    [[ -d "$ROOT_DIR/dist" ]] || die "frontend build output not found: $ROOT_DIR/dist"
  fi

  local parent next previous
  parent="$(dirname "$WEB_ROOT")"
  next="${WEB_ROOT}.next"
  previous="${WEB_ROOT}.previous"

  run_sudo mkdir -p "$parent"
  run_sudo rm -rf "$next"
  run_sudo mkdir -p "$next"
  run_sudo cp -a "$ROOT_DIR/dist/." "$next/"
  run_sudo rm -rf "$previous"

  if enabled "$DRY_RUN" || sudo_test_exists "$WEB_ROOT"; then
    run_sudo mv "$WEB_ROOT" "$previous"
  fi

  run_sudo mv "$next" "$WEB_ROOT"
}

install_helper() {
  ensure_safe_path "SINGDECK_HELPER_BIN" "$HELPER_BIN"

  local binary="$ROOT_DIR/helper/target/release/singdeck-helper"
  if ! enabled "$DRY_RUN"; then
    [[ -x "$binary" ]] || die "helper build output not found or not executable: $binary"
  fi

  run_sudo install -Dm755 "$binary" "$HELPER_BIN"
}

install_helper_service() {
  local unit="$ROOT_DIR/deploy/systemd/singdeck-helper.with-sing-box.service"
  local env_example="$ROOT_DIR/deploy/systemd/singdeck-helper.env.example"

  if ! enabled "$DRY_RUN"; then
    [[ -f "$unit" ]] || die "helper service unit not found: $unit"
    [[ -f "$env_example" ]] || die "helper env example not found: $env_example"
  fi

  run_sudo mkdir -p /etc/singdeck
  if enabled "$DRY_RUN" || ! sudo_test_exists /etc/singdeck/helper.env; then
    run_sudo install -Dm640 "$env_example" /etc/singdeck/helper.env
  fi

  run_sudo install -Dm644 "$unit" "/etc/systemd/system/$HELPER_SERVICE"
  run_sudo systemctl enable "$HELPER_SERVICE"
}

disable_embedded_helper_hooks() {
  local dropin="$ROOT_DIR/deploy/systemd/sing-box.no-embedded-helper.conf"
  if ! enabled "$DISABLE_EMBEDDED_HELPER"; then
    return
  fi

  if ! enabled "$DRY_RUN"; then
    [[ -f "$dropin" ]] || die "sing-box drop-in not found: $dropin"
  fi

  run_sudo install -Dm644 "$dropin" "/etc/systemd/system/$SING_BOX_SERVICE.d/90-singdeck-helper-service.conf"
}

stop_stale_helper_processes() {
  if enabled "$KILL_STALE_HELPER"; then
    run_sudo_allow_fail pkill -x singdeck-helper
  fi
}

restart_services() {
  if [[ -z "$WEB_SERVICE" && "$RESTART_MODE" == "none" ]]; then
    return
  fi

  stop_stale_helper_processes
  run_sudo systemctl daemon-reload

  if [[ -n "$WEB_SERVICE" ]]; then
    run_sudo systemctl reload-or-restart "$WEB_SERVICE"
  fi

  case "$RESTART_MODE" in
    sing-box|sb)
      run_sudo systemctl restart "$SING_BOX_SERVICE"
      ;;
    combined|sb-helper|sing-box-helper)
      run_sudo systemctl restart "$SING_BOX_SERVICE"
      ;;
    helper)
      run_sudo systemctl restart "$HELPER_SERVICE"
      ;;
    both)
      run_sudo systemctl restart "$SING_BOX_SERVICE"
      run_sudo systemctl restart "$HELPER_SERVICE"
      ;;
    none)
      ;;
    *)
      die "unsupported SINGDECK_RESTART_MODE: $RESTART_MODE"
      ;;
  esac
}

main() {
  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
  fi
  [[ "$#" -eq 0 ]] || die "unknown arguments: $*"

  ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "$ROOT_DIR"

  WEB_ROOT="$(strip_trailing_slashes "${SINGDECK_WEB_ROOT:-/var/www/singdeck/dist}")"
  HELPER_BIN="$(strip_trailing_slashes "${SINGDECK_HELPER_BIN:-/opt/singdeck/singdeck-helper}")"
  HELPER_SERVICE="${SINGDECK_HELPER_SERVICE:-singdeck-helper.service}"
  SING_BOX_SERVICE="${SINGDECK_SING_BOX_SERVICE:-sing-box.service}"
  WEB_SERVICE="${SINGDECK_WEB_SERVICE:-}"
  RESTART_MODE="${SINGDECK_RESTART_MODE:-both}"
  INSTALL_FRONTEND="${INSTALL_FRONTEND:-1}"
  INSTALL_HELPER="${INSTALL_HELPER:-1}"
  INSTALL_HELPER_SERVICE="${INSTALL_HELPER_SERVICE:-$INSTALL_HELPER}"
  DISABLE_EMBEDDED_HELPER="${SINGDECK_DISABLE_EMBEDDED_HELPER:-$INSTALL_HELPER_SERVICE}"
  KILL_STALE_HELPER="${SINGDECK_KILL_STALE_HELPER:-$INSTALL_HELPER_SERVICE}"
  RUN_TESTS="${RUN_TESTS:-0}"
  DRY_RUN="${DRY_RUN:-0}"
  PNPM_BIN="${PNPM:-pnpm}"
  CARGO_BIN="${CARGO:-cargo}"

  if [[ "$EUID" -eq 0 ]]; then
    SUDO_CMD=()
  else
    SUDO_CMD=("${SUDO:-sudo}")
  fi

  preflight
  build_and_test
  if enabled "$INSTALL_FRONTEND"; then
    install_frontend
  fi
  if enabled "$INSTALL_HELPER"; then
    install_helper
  fi
  if enabled "$INSTALL_HELPER_SERVICE"; then
    install_helper_service
    disable_embedded_helper_hooks
  fi
  restart_services

  if enabled "$DRY_RUN"; then
    printf 'Dry run finished. No files or services were changed.\n'
  else
    printf 'Local redeploy finished.\n'
  fi
}

main "$@"
