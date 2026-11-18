#!/bin/bash
# Undo install.sh: stop macOS from starting the RoughCut engine on demand.
set -euo pipefail
LABEL="com.roughcut.engine"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Removed. Start the engine by hand with: uv run roughcut-engine"
