#!/bin/bash
# One-time setup: let macOS start the RoughCut engine on demand.
#
# macOS holds 127.0.0.1:7317 (no process, no memory). When the Premiere panel
# connects, the engine starts; after 10 idle minutes it quits again.
# Undo with ./uninstall.sh.
set -euo pipefail

ENGINE_DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.roughcut.engine"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/RoughCut"

command -v uv >/dev/null || { echo "uv is required: https://docs.astral.sh/uv/"; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg is required: brew install ffmpeg"; exit 1; }

echo "Installing engine dependencies…"
(cd "$ENGINE_DIR" && uv sync --quiet)

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$ENGINE_DIR/.venv/bin/roughcut-engine</string></array>
  <key>WorkingDirectory</key><string>$ENGINE_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$(command -v ffmpeg)"):/usr/bin:/bin</string>
  </dict>
  <key>Sockets</key>
  <dict>
    <key>Listener</key>
    <dict>
      <key>SockNodeName</key><string>127.0.0.1</string>
      <key>SockServiceName</key><string>7317</string>
      <key>SockType</key><string>stream</string>
      <key>SockFamily</key><string>IPv4</string>
    </dict>
  </dict>
  <key>StandardOutPath</key><string>$LOG_DIR/engine.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/engine.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Done. The engine now starts when RoughCut connects and quits after 10 idle minutes."
echo "Engine log: $LOG_DIR/engine.log"
