#!/usr/bin/env bash
# Build a signed arm64 release APK into bin/dsh-remote.apk.
#
# Toolchain (all local, no Android Studio):
#   - Go 1.26 + wails3 v3.0.0-beta.33   (mise / go install)
#   - JDK 21                             (mise temurin-21)
#   - Android SDK + NDK 26.3             (~/Library/Android/sdk, via cmdline-tools)
# Signing key: ~/.android-keys/dsh-remote.jks + dsh-remote.env (never commit). Keep it:
# Android refuses to update an installed app signed by a different key.
set -euo pipefail
cd "$(dirname "$0")"

export PATH="$HOME/.local/share/mise/installs/go/1.26.5/bin:$PATH"
export GOPROXY="${GOPROXY:-https://goproxy.cn,direct}"
JAVA_HOME="$HOME/.local/share/mise/installs/java/temurin-21.0.12+101.0.LTS"
[ -d "$JAVA_HOME/Contents/Home" ] && JAVA_HOME="$JAVA_HOME/Contents/Home"
export JAVA_HOME PATH="$JAVA_HOME/bin:$PATH"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"

KEYENV="$HOME/.android-keys/dsh-remote.env"
if [ -f "$KEYENV" ]; then
  set -a; . "$KEYENV"; set +a
else
  echo "warning: $KEYENV missing, APK will be debug-signed" >&2
fi

( cd frontend && [ -d node_modules ] || npm install --registry=https://registry.npmmirror.com )
GOOS=android CGO_ENABLED=0 wails3 generate bindings -f '-tags android' -clean=true >/dev/null
wails3 task android:package ARCH="${ARCH:-arm64}"

mv -f bin/dsh-mobile.apk bin/dsh-remote.apk
"$ANDROID_HOME/build-tools/35.0.0/apksigner" verify --print-certs bin/dsh-remote.apk 2>/dev/null | grep "certificate DN"
echo "APK: $(pwd)/bin/dsh-remote.apk"
