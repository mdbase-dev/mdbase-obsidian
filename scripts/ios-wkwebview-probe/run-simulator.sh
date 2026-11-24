#!/usr/bin/env bash
set -euo pipefail

echo "=== Installed Xcode versions ==="
ls -d /Applications/Xcode*.app || true
# Prefer newest Xcode installed (sorted descending)
XCODE_APP="$(ls -d /Applications/Xcode*.app | sort -V | tail -n 1)"
echo "Selected Xcode: $XCODE_APP"
export DEVELOPER_DIR="$XCODE_APP/Contents/Developer"
xcodebuild -version

echo "=== Available iOS Simulator runtimes ==="
xcrun simctl list runtimes iOS

# Pick newest available iOS simulator device (prefer iPhone)
UDID="$(python3 - <<'PY'
import json, subprocess, sys
data = json.loads(subprocess.check_output(["xcrun", "simctl", "list", "-j", "devices", "available"]))
candidates = []
for runtime, devices in data["devices"].items():
    if "SimRuntime.iOS-" not in runtime:
        continue
    ver_str = runtime.split("SimRuntime.iOS-")[1]
    ver = tuple(int(x) for x in ver_str.split("-"))
    for d in devices:
        if d.get("isAvailable"):
            is_iphone = 1 if "iPhone" in d["name"] else 0
            candidates.append((ver, is_iphone, d["name"], d["udid"]))
if not candidates:
    sys.exit("No available iOS Simulator device found")
candidates.sort()
best = candidates[-1]
sys.stderr.write(f"Selected simulator: iOS {'.'.join(map(str, best[0]))} — {best[2]} ({best[3]})\n")
print(best[3])
PY
)"

ARCH="$(uname -m)"
SDK_PATH="$(xcrun --sdk iphonesimulator --show-sdk-path)"
BUILD_DIR="$(mktemp -d)"
APP_DIR="$BUILD_DIR/ProbeApp.app"
mkdir -p "$APP_DIR/assets"

# Copy real @mdbase-dev/sdk native assets
cp node_modules/@mdbase-dev/sdk/dist/native/sqlite3.js "$APP_DIR/assets/"
cp node_modules/@mdbase-dev/sdk/dist/native/sqlite3.wasm "$APP_DIR/assets/"
cp node_modules/@mdbase-dev/sdk/dist/native/runtime.wasm "$APP_DIR/assets/"

cat > "$APP_DIR/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>dev.mdbase.iosprobe</string>
  <key>CFBundleExecutable</key>
  <string>ProbeApp</string>
  <key>CFBundleName</key>
  <string>ProbeApp</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>LSRequiresIPhoneOS</key>
  <true/>
</dict>
</plist>
PLIST

echo "=== Compiling ProbeApp ($ARCH-apple-ios16.0-simulator) ==="
xcrun swiftc \
  -target "${ARCH}-apple-ios16.0-simulator" \
  -sdk "$SDK_PATH" \
  -framework UIKit \
  -framework WebKit \
  -framework Foundation \
  -parse-as-library \
  scripts/ios-wkwebview-probe/ProbeApp.swift \
  -o "$APP_DIR/ProbeApp"

codesign --force --sign - "$APP_DIR"

echo "=== Booting Simulator $UDID ==="
xcrun simctl boot "$UDID" || true
xcrun simctl bootstatus "$UDID" -b

echo "=== Installing & Running ProbeApp ==="
xcrun simctl install "$UDID" "$APP_DIR"
xcrun simctl launch --console "$UDID" dev.mdbase.iosprobe
