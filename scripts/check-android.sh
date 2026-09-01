#!/usr/bin/env bash
set -Eeuo pipefail

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_binary() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

main() {
  [[ "$#" -eq 0 ]] || die "this script does not accept arguments"
  require_binary java
  require_binary javac
  require_binary unzip

  local repo_dir aar java_version
  repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  aar="$repo_dir/android/app/libs/libbox.aar"
  [[ -f "$aar" ]] || die "missing $aar; run pnpm android:libbox first"
  unzip -tqq "$aar" || die "libbox.aar is not a valid archive"
  unzip -l "$aar" | grep -Fq 'jni/arm64-v8a/libbox.so' \
    || die "libbox.aar does not contain arm64-v8a/libbox.so"

  java_version="$(java -XshowSettings:properties -version 2>&1 \
    | awk -F= '/^[[:space:]]*java\.specification\.version =/{gsub(/[[:space:]]/, "", $2); print $2; exit}')"
  [[ "$java_version" == "17" ]] || die "JDK 17 is required (found ${java_version:-unknown})"

  (
    cd "$repo_dir/android"
    ./gradlew --no-daemon \
      :app:testDebugUnitTest \
      :app:lintDebug \
      :app:assembleDebug \
      :app:assembleDebugAndroidTest
  )
}

main "$@"
