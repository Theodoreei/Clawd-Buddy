#!/bin/bash
# Builds "Clawd Buddy.app" and installs it in /Applications.
set -euo pipefail
cd "$(dirname "$0")/.."

APP_NAME="Clawd Buddy"
ARCH="$(uname -m)"   # arm64 on Apple silicon, x86_64 on Intel
[ "$ARCH" = "x86_64" ] && ARCH="x64"

echo "→ Drawing the icon"
npx electron scripts/make-icon.js
ICONSET=build/icon.iconset
rm -rf "$ICONSET" && mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s build/icon-1024.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) build/icon-1024.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o build/icon.icns

echo "→ Packaging"
npx @electron/packager . "$APP_NAME" \
  --platform=darwin --arch="$ARCH" \
  --icon=build/icon.icns \
  --app-bundle-id=com.clawdbuddy.app \
  --extend-info=build/extra-info.plist \
  --out=dist --overwrite \
  --ignore='^/dist' --ignore='^/release' --ignore='^/build' --ignore='^/scripts' --ignore='\.command$'

APP="dist/$APP_NAME-darwin-$ARCH/$APP_NAME.app"
echo "→ Signing (ad-hoc, so macOS will run it on this Mac)"
codesign --force --deep --sign - "$APP"

echo "→ Installing to /Applications"
rm -rf "/Applications/$APP_NAME.app"
ditto "$APP" "/Applications/$APP_NAME.app"
echo "✓ Installed /Applications/$APP_NAME.app"
