#!/bin/bash
# Build a double-clickable macOS app bundle: "RoughCut Ingest.app".
#
# Usage:
#   ./engine/build_app.sh                              # installs to /Applications/RoughCut Ingest.app
#   ./engine/build_app.sh ~/Desktop/RoughCut\ Ingest.app
#
# The built app bundles the engine source under Contents/Resources/engine and
# launches the GUI using uv's managed Python 3.13 (which includes Tk), so it
# works both on this Mac and if copied directly to another Mac with uv + ffmpeg.
set -euo pipefail

ENGINE_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_PATH="${1:-/Applications/RoughCut Ingest.app}"
CONTENTS="$APP_PATH/Contents"
MACOS_DIR="$CONTENTS/MacOS"
RES_DIR="$CONTENTS/Resources"
BUNDLE_ENGINE="$RES_DIR/engine"
APP_VENV="$HOME/Library/Application Support/RoughCut/app-venv"

echo "Building $APP_PATH ..."
rm -rf "$APP_PATH"
mkdir -p "$MACOS_DIR" "$RES_DIR" "$BUNDLE_ENGINE"

# 1. Copy clean engine sources into Contents/Resources/engine
cp "$ENGINE_DIR/pyproject.toml" "$BUNDLE_ENGINE/"
if [ -f "$ENGINE_DIR/uv.lock" ]; then
  cp "$ENGINE_DIR/uv.lock" "$BUNDLE_ENGINE/"
fi
rsync -a \
  --exclude "__pycache__" \
  --exclude "*.pyc" \
  --exclude ".DS_Store" \
  "$ENGINE_DIR/roughcut_engine/" "$BUNDLE_ENGINE/roughcut_engine/"

# 2. Write Info.plist
cat > "$CONTENTS/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>RoughCut Ingest</string>
  <key>CFBundleExecutable</key>
  <string>RoughCut Ingest</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>com.roughcut.ingest</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>RoughCut Ingest</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
EOF

# 3. Write launcher executable
cat > "$MACOS_DIR/RoughCut Ingest" <<'EOF'
#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

LOG_DIR="$HOME/Library/Logs/RoughCut"
LOG_FILE="$LOG_DIR/gui.log"
mkdir -p "$LOG_DIR"

alert() {
  local msg="$1"
  /usr/bin/osascript -e "display alert \"RoughCut Ingest\" message \"${msg//\"/\\\"}\" as critical" >/dev/null 2>&1 || true
}

notify() {
  local msg="$1"
  /usr/bin/osascript -e "display notification \"${msg//\"/\\\"}\" with title \"RoughCut Ingest\"" >/dev/null 2>&1 || true
}

if ! command -v uv >/dev/null 2>&1; then
  alert "uv is required to run RoughCut Ingest.\n\nOpen Terminal and run:\nbrew install uv ffmpeg"
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  alert "ffmpeg is required for audio sync and waveform analysis.\n\nOpen Terminal and run:\nbrew install ffmpeg"
  exit 1
fi

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENGINE_DIR="$APP_DIR/Resources/engine"
export UV_PROJECT_ENVIRONMENT="$HOME/Library/Application Support/RoughCut/app-venv"

if [ ! -x "$UV_PROJECT_ENVIRONMENT/bin/roughcut-gui" ]; then
  notify "First-time setup in progress (installing Python + dependencies)..."
fi

{
  echo "=== Launching RoughCut Ingest at $(date) ==="
  cd "$ENGINE_DIR"
  if ! uv sync --offline --python 3.13 --python-preference only-managed --no-dev --quiet; then
    uv sync --python 3.13 --python-preference only-managed --no-dev --quiet
  fi
} >>"$LOG_FILE" 2>&1 || {
  alert "RoughCut Ingest failed during setup.\n\nCheck log:\n$LOG_FILE"
  exit 1
}

exec "$UV_PROJECT_ENVIRONMENT/bin/roughcut-gui" >>"$LOG_FILE" 2>&1
EOF
chmod +x "$MACOS_DIR/RoughCut Ingest"

# 4. Generate a crisp macOS .icns icon (dark slate + RoughCut amber gold timeline bars)
ICON_TMP="$(mktemp -d)"
trap 'rm -rf "$ICON_TMP"' EXIT
ICONSET="$ICON_TMP/AppIcon.iconset"
mkdir -p "$ICONSET"

/usr/bin/python3 - "$ICON_TMP/icon_1024.png" <<'PYEOF'
import math, struct, sys, zlib

W = H = 512
bg = (13, 17, 23)         # #0d1117
card = (22, 27, 34)       # #161b22
border = (48, 54, 61)     # #30363d
gold = (229, 169, 59)     # #e5a93b
blue = (88, 166, 255)     # #58a6ff
green = (63, 185, 80)     # #3fb950
white = (240, 246, 252)   # #f0f6fc

def in_round_rect(x, y, x0, y0, x1, y1, r):
    cx = max(x0 + r, min(x, x1 - r))
    cy = max(y0 + r, min(y, y1 - r))
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= r * r

rows = bytearray()
for y in range(H):
    rows.append(0)  # PNG filter type 0
    for x in range(W):
        if not in_round_rect(x, y, 28, 28, W - 28, H - 28, 96):
            rows.extend((0, 0, 0, 0))
            continue
        if not in_round_rect(x, y, 36, 36, W - 36, H - 36, 88):
            col = border
        else:
            col = bg
            # Three stacked multicam timeline tracks
            # Track 1 (Wide - blue)
            if in_round_rect(x, y, 88, 130, 210, 190, 16) or in_round_rect(x, y, 310, 130, 424, 190, 16):
                col = blue
            # Track 2 (Host - gold)
            elif in_round_rect(x, y, 218, 216, 302, 276, 16) or in_round_rect(x, y, 88, 216, 160, 276, 16):
                col = gold
            # Track 3 (Guest - green)
            elif in_round_rect(x, y, 168, 302, 348, 362, 16) or in_round_rect(x, y, 356, 302, 424, 362, 16):
                col = green
            # Subtle inactive track rails
            elif in_round_rect(x, y, 88, 130, 424, 190, 16) or in_round_rect(x, y, 88, 216, 424, 276, 16) or in_round_rect(x, y, 88, 302, 424, 362, 16):
                col = card
            # Playhead vertical cut line
            if 252 <= x <= 260 and 92 <= y <= 406:
                col = white
            # Playhead top triangle handle
            if 78 <= y <= 104 and abs(x - 256) <= (104 - y) * 0.9:
                col = gold
        rows.extend((col[0], col[1], col[2], 255))

def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

ihdr = struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0)
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b"")
with open(sys.argv[1], "wb") as f:
    f.write(png)
PYEOF

for sz in 16 32 128 256 512; do
  sips -z "$sz" "$sz" "$ICON_TMP/icon_1024.png" --out "$ICONSET/icon_${sz}x${sz}.png" >/dev/null
  sz2=$((sz * 2))
  sips -z "$sz2" "$sz2" "$ICON_TMP/icon_1024.png" --out "$ICONSET/icon_${sz}x${sz}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$RES_DIR/AppIcon.icns"

# 5. Ad-hoc sign so macOS LaunchServices accepts the bundle cleanly
codesign --force --deep --sign - "$APP_PATH" >/dev/null 2>&1 || true

# 6. Pre-warm the managed Python 3.13 venv on this machine so first double-click is instant
if command -v uv >/dev/null 2>&1; then
  echo "Pre-warming app Python environment at $APP_VENV ..."
  UV_PROJECT_ENVIRONMENT="$APP_VENV" uv sync --project "$BUNDLE_ENGINE" --python 3.13 --python-preference only-managed --no-dev --quiet
fi

echo "Done! Installed double-clickable app at:"
echo "  $APP_PATH"
