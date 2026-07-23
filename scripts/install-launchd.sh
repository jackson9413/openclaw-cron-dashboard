#!/usr/bin/env bash
# scripts/install-launchd.sh — install the OpenClaw cron dashboard as a launchd
# service that auto-starts at login and restarts on crash.
#
# Usage:
#   ./scripts/install-launchd.sh              # install + load
#   ./scripts/install-launchd.sh uninstall    # unload + remove plist
#   ./scripts/install-launchd.sh status       # show current status

set -euo pipefail

LABEL="com.user.openclaw-cron-dashboard"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
PROJECT_DIR="$HOME/projects/openclaw-cron-dashboard"
LOG_DIR="$HOME/Library/Logs/openclaw-cron-dashboard"
PORT="${PORT:-3737}"

cmd="${1:-install}"

mkdir -p "$LOG_DIR"

render_plist() {
  cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-lc</string>
    <string>cd ${PROJECT_DIR} && PORT=${PORT} npm start</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${PROJECT_DIR}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
    <key>Crashed</key>
    <true/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/stdout.log</string>

  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/stderr.log</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
</dict>
</plist>
EOF
}

case "$cmd" in
  install)
    if [[ ! -d "$PROJECT_DIR" ]]; then
      echo "❌ Project directory not found: $PROJECT_DIR" >&2
      echo "   Clone the repo first or update PROJECT_DIR in this script." >&2
      exit 1
    fi
    echo "→ Rendering plist at $PLIST_PATH"
    render_plist
    echo "→ Loading via launchctl"
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    launchctl load -w "$PLIST_PATH"
    echo "✓ Installed and started."
    echo
    echo "Dashboard should be live at: http://localhost:${PORT}"
    echo "Logs: tail -f ${LOG_DIR}/stdout.log"
    echo
    echo "To check status:  ./scripts/install-launchd.sh status"
    echo "To uninstall:     ./scripts/install-launchd.sh uninstall"
    ;;

  uninstall)
    echo "→ Unloading $PLIST_PATH"
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    rm -f "$PLIST_PATH"
    echo "✓ Uninstalled."
    ;;

  status)
    if launchctl list | grep -q "$LABEL"; then
      echo "✓ Loaded"
      launchctl list | grep "$LABEL" || true
    else
      echo "✗ Not loaded"
    fi
    if [[ -f "$PLIST_PATH" ]]; then
      echo "Plist: $PLIST_PATH"
    fi
    ;;

  *)
    echo "Usage: $0 [install|uninstall|status]" >&2
    exit 2
    ;;
esac
