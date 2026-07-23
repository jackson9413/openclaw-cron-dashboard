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
STANDALONE_DIR="${PROJECT_DIR}/.next/standalone"
LOG_DIR="$HOME/Library/Logs/openclaw-cron-dashboard"
PORT="${PORT:-3737}"

cmd="${1:-install}"

mkdir -p "$LOG_DIR"

render_plist() {
  # Build the EnvironmentVariables dict.
  # Start with the always-present keys, then layer in any DISCORD_*/ALERT_*
  # keys found in $PROJECT_DIR/.env.local so users don't have to re-enter
  # webhook URLs every time the plist changes.
  local env_block
  env_block=$(cat <<'EOF'
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>PORT</key>
    <string>__PORT__</string>
    <key>HOSTNAME</key>
    <string>0.0.0.0</string>
__ENVFILE_ENTRIES__
EOF
  )
  env_block="${env_block//__PORT__/${PORT}}"

  local envfile_entries=""
  if [[ -f "$PROJECT_DIR/.env.local" ]]; then
    # Whitelist: only inject vars we know the dashboard uses. Avoids leaking
    # anything unrelated (e.g. someone storing GITHUB_TOKEN in the same file).
    while IFS='=' read -r key value; do
      # Skip blanks, comments, shell continuations
      [[ -z "$key" || "$key" =~ ^[[:space:]]*# ]] && continue
      key="${key// /}"
      case "$key" in
        DISCORD_WEBHOOK_URL|DISCORD_MENTION_USER_ID|ALERT_CONSECUTIVE_FAILURES|ALERT_STALE_HOURS|ALERT_COOLDOWN_MINUTES)
          # Strip surrounding quotes from value
          value="${value%\"}"; value="${value#\"}"
          value="${value%\'}"; value="${value#\'}"
          # XML-escape the value
          local esc="${value//&/&amp;}"
          esc="${esc//</&lt;}"
          esc="${esc//>/&gt;}"
          esc="${esc//\"/&quot;}"
          envfile_entries+="    <key>${key}</key>
    <string>${esc}</string>
"
          ;;
      esac
    done < <(grep -E '^(DISCORD_|ALERT_)' "$PROJECT_DIR/.env.local")
  fi

  env_block="${env_block//__ENVFILE_ENTRIES__/${envfile_entries}}"

  cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>server.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${STANDALONE_DIR}</string>

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
${env_block}  </dict>
</dict>
</plist>
EOF
}

# Build if .next/standalone/server.js is missing.
ensure_built() {
  if [[ ! -f "${STANDALONE_DIR}/server.js" ]]; then
    echo "→ No standalone build found at ${STANDALONE_DIR}, running npm run build"
    ( cd "$PROJECT_DIR" && npm run build ) || {
      echo "❌ Build failed" >&2
      exit 1
    }
  fi
}

case "$cmd" in
  install)
    if [[ ! -d "$PROJECT_DIR" ]]; then
      echo "❌ Project directory not found: $PROJECT_DIR" >&2
      echo "   Clone the repo first or update PROJECT_DIR in this script." >&2
      exit 1
    fi
    ensure_built
    if [[ -f "$PROJECT_DIR/.env.local" ]]; then
      echo "→ Found .env.local — DISCORD_/ALERT_ keys will be loaded into the plist"
    else
      echo "→ No .env.local found. Copy .env.example to .env.local if you want alerts."
    fi
    echo "→ Rendering plist at $PLIST_PATH"
    render_plist
    echo "→ Loading via launchctl"
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    launchctl load -w "$PLIST_PATH"
    echo "✓ Installed and started (using Next.js standalone server)."
    echo
    echo "Dashboard should be live at: http://localhost:${PORT}"
    echo "Logs: tail -f ${LOG_DIR}/stdout.log"
    echo
    echo "To check status:  ./scripts/install-launchd.sh status"
    echo "To uninstall:     ./scripts/install-launchd.sh uninstall"
    echo "To re-apply .env changes: ./scripts/install-launchd.sh install"
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
