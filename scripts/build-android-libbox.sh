#!/usr/bin/env bash
set -Eeuo pipefail

readonly SING_BOX_VERSION="v1.14.0"
readonly SING_BOX_COMMIT="0b8995879f29a9b98ee027bc17b75e101445b238"
readonly TEMURIN_VERSION="17.0.20.1+1"
readonly TEMURIN_ARCHIVE="OpenJDK17U-jdk_x64_linux_hotspot_17.0.20.1_1.tar.gz"
readonly TEMURIN_URL="https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/${TEMURIN_ARCHIVE}"
readonly TEMURIN_SHA256="3808d1d15e3ec6bd5b84057fb5d84c33d8a1536a258146bcea2e603fc726e08e"
readonly NDK_VERSION="28.0.13004108"
readonly NDK_ARCHIVE="android-ndk-r28-linux.zip"
readonly NDK_URL="https://dl.google.com/android/repository/${NDK_ARCHIVE}"
readonly NDK_SHA1="894f469c5192a116d21f412de27966140a530ebc"
readonly GO_VERSION="1.26.7"
readonly GO_ARCHIVE="go${GO_VERSION}.linux-amd64.tar.gz"
readonly GO_URL="https://go.dev/dl/${GO_ARCHIVE}"
readonly GO_SHA256="ffb5f8de10c62550dfddab66b36b57030721e0a44a3218e9e1181d7b59f121ca"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_binary() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

download_verified() {
  local url="$1"
  local destination="$2"
  local algorithm="$3"
  local expected="$4"

  if [[ -f "$destination" ]]; then
    if [[ "$algorithm" == "sha256" ]] && printf '%s  %s\n' "$expected" "$destination" | sha256sum --check --status; then
      return
    fi
    if [[ "$algorithm" == "sha1" ]] && printf '%s  %s\n' "$expected" "$destination" | sha1sum --check --status; then
      return
    fi
    die "cached download has the wrong checksum: $destination"
  fi

  local partial="${destination}.part"
  curl --fail --location --retry 3 --output "$partial" "$url"
  if [[ "$algorithm" == "sha256" ]]; then
    printf '%s  %s\n' "$expected" "$partial" | sha256sum --check --status || die "SHA-256 verification failed: $url"
  else
    printf '%s  %s\n' "$expected" "$partial" | sha1sum --check --status || die "SHA-1 verification failed: $url"
  fi
  mv "$partial" "$destination"
}

resolve_android_sdk() {
  if [[ -n "${SINGDECK_ANDROID_SDK_DIR:-}" ]]; then
    printf '%s' "$SINGDECK_ANDROID_SDK_DIR"
    return
  fi

  local properties="$REPO_DIR/android/local.properties"
  [[ -f "$properties" ]] || die "android/local.properties is missing; set SINGDECK_ANDROID_SDK_DIR"
  awk -F= '/^sdk\.dir=/{sub(/^sdk\.dir=/, ""); print; exit}' "$properties"
}

prepare_jdk() {
  local root="$CACHE_DIR/toolchains/jdk17"
  local archive="$CACHE_DIR/downloads/$TEMURIN_ARCHIVE"
  local java_path

  java_path="$(find "$root" -mindepth 2 -maxdepth 3 -type f -path '*/bin/java' -print -quit 2>/dev/null || true)"
  if [[ -z "$java_path" ]]; then
    mkdir -p "$root"
    download_verified "$TEMURIN_URL" "$archive" sha256 "$TEMURIN_SHA256"
    tar -xzf "$archive" -C "$root"
    java_path="$(find "$root" -mindepth 2 -maxdepth 3 -type f -path '*/bin/java' -print -quit)"
  fi

  [[ -n "$java_path" ]] || die "Temurin $TEMURIN_VERSION was not extracted correctly"
  dirname "$(dirname "$java_path")"
}

prepare_ndk() {
  local root="$CACHE_DIR/toolchains"
  local ndk_dir="$root/android-ndk-r28"
  local archive="$CACHE_DIR/downloads/$NDK_ARCHIVE"

  if [[ ! -f "$ndk_dir/source.properties" ]]; then
    download_verified "$NDK_URL" "$archive" sha1 "$NDK_SHA1"
    unzip -q -o "$archive" -d "$root"
  fi

  grep -Fq "Pkg.Revision = $NDK_VERSION" "$ndk_dir/source.properties" || die "unexpected Android NDK revision in $ndk_dir"
  printf '%s' "$ndk_dir"
}

prepare_go() {
  local root="$CACHE_DIR/toolchains/go-$GO_VERSION"
  local archive="$CACHE_DIR/downloads/$GO_ARCHIVE"
  local go_root="$root/go"

  if [[ ! -x "$go_root/bin/go" ]]; then
    mkdir -p "$root"
    download_verified "$GO_URL" "$archive" sha256 "$GO_SHA256"
    tar -xzf "$archive" -C "$root"
  fi

  [[ "$($go_root/bin/go version)" == "go version go${GO_VERSION} linux/amd64" ]] || die "unexpected Go toolchain in $go_root"
  printf '%s' "$go_root"
}

prepare_source() {
  local source_dir="$CACHE_DIR/source/sing-box-$SING_BOX_VERSION"
  if [[ ! -d "$source_dir/.git" ]]; then
    mkdir -p "$(dirname "$source_dir")"
    git clone --branch "$SING_BOX_VERSION" --depth 1 https://github.com/SagerNet/sing-box.git "$source_dir"
  fi

  local actual_commit
  actual_commit="$(git -C "$source_dir" rev-parse HEAD)"
  [[ "$actual_commit" == "$SING_BOX_COMMIT" ]] || die "unexpected sing-box commit: $actual_commit"
  printf '%s' "$source_dir"
}

main() {
  [[ "$#" -eq 0 ]] || die "this script does not accept arguments"
  require_binary awk
  require_binary curl
  require_binary find
  require_binary git
  require_binary sha1sum
  require_binary sha256sum
  require_binary tar
  require_binary unzip

  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  CACHE_DIR="${SINGDECK_ANDROID_CACHE_DIR:-/tmp/singdeck-android-build-cache}"
  [[ -n "$CACHE_DIR" && "$CACHE_DIR" != "/" ]] || die "unsafe SINGDECK_ANDROID_CACHE_DIR: $CACHE_DIR"
  mkdir -p "$CACHE_DIR/downloads" "$CACHE_DIR/toolchains"

  local available_kib
  available_kib="$(df --output=avail "$CACHE_DIR" | tail -n 1 | tr -d ' ')"
  (( available_kib >= 10 * 1024 * 1024 )) || die "at least 10 GiB free is required under $CACHE_DIR"

  local android_sdk_dir java_home ndk_dir go_root source_dir
  android_sdk_dir="$(resolve_android_sdk)"
  [[ -f "$android_sdk_dir/licenses/android-sdk-license" ]] || die "invalid Android SDK: $android_sdk_dir"
  java_home="$(prepare_jdk)"
  ndk_dir="$(prepare_ndk)"
  go_root="$(prepare_go)"
  source_dir="$(prepare_source)"

  export ANDROID_HOME="$android_sdk_dir"
  export ANDROID_NDK_HOME="$ndk_dir"
  export JAVA_HOME="$java_home"
  export GOROOT="$go_root"
  export GOPATH="$CACHE_DIR/go"
  export GOCACHE="$CACHE_DIR/go-build"
  export GOMODCACHE="$CACHE_DIR/go-mod"
  export GOTOOLCHAIN=local
  export PATH="$JAVA_HOME/bin:$GOROOT/bin:$GOPATH/bin:$PATH"

  java --version
  go version

  (
    cd "$source_dir"
    go install -v github.com/sagernet/gomobile/cmd/gomobile@v0.1.13
    go install -v github.com/sagernet/gomobile/cmd/gobind@v0.1.13
    go run ./cmd/internal/build_libbox -target android -platform android/arm64
  )

  local aar_source="$source_dir/libbox.aar"
  local aar_target="$REPO_DIR/android/app/libs/libbox.aar"
  [[ -f "$aar_source" ]] || die "libbox build did not produce $aar_source"
  mkdir -p "$(dirname "$aar_target")"
  install -m 0644 "$aar_source" "$aar_target"
  unzip -l "$aar_target" | grep -Fq 'jni/arm64-v8a/libbox.so' || die "libbox.aar does not contain arm64-v8a/libbox.so"

  printf 'libbox: %s\n' "$aar_target"
  sha256sum "$aar_target"
}

main "$@"
