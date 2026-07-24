# OpenClaw Cron Dashboard

Local-only Next.js dashboard for monitoring your OpenClaw cron jobs, viewing run history, and rerunning failed jobs with one click.

## What it does

- **Live status** of every cron job (auto-refreshes every 30s)
- **Health pills**: healthy / failing / stale / disabled
- **Stale detection**: flags any enabled job that hasn't run successfully in 24h
- **Success-rate bars** with rolling history
- **Run history drawer** — full JSONL tail with summary, status, duration, token usage
- **One-click rerun** via `openclaw cron run <id>`
- **Soft delete + Trash panel** — move jobs to a soft-deleted trash list, restore them anytime, or purge forever
- **Timestamped backup rotation** — every write snapshots `jobs.json`; restore any historical state from the Backups tab
- **Discord failure alerts** — pings your server when a job is failing or goes stale
- **Filters**: all / failing / stale / disabled

## Stack

- Next.js 14 (App Router) + TypeScript + Tailwind
- Reads directly from `~/.openclaw/cron/jobs.json` and `~/.openclaw/cron/runs/*.jsonl`
- Reruns invoke `openclaw cron run <id>` via subprocess

## Run it

```bash
cd ~/projects/openclaw-cron-dashboard
npm install
npm run dev
# Open http://localhost:3737
```

## Production build (recommended)

```bash
npm run build
npm start
```

## Auto-start at login (launchd)

A one-shot installer script handles everything: writes the plist, loads it, and verifies it's running.

```bash
./scripts/install-launchd.sh            # install + start
./scripts/install-launchd.sh status     # check status
./scripts/install-launchd.sh uninstall  # stop + remove
```

The plist is rendered to `~/Library/LaunchAgents/com.user.openclaw-cron-dashboard.plist` and keeps the dashboard alive across reboots and crashes. Logs go to `~/Library/Logs/openclaw-cron-dashboard/`.

The installer runs `node server.js` from inside `.next/standalone/` directly (Next.js's standalone output) instead of `npm start`. This is faster, uses less memory, and avoids the "next start does not work with output: standalone" warning. The installer auto-runs `npm run build` if the standalone artifact is missing, and copies `public/` + `.next/static/` next to the server so static assets resolve.

## Discord failure alerts

The dashboard can ping you on Discord when a job is in trouble. Two scan modes:

- **On-demand**: visit `/api/alerts` (or click the dashboard's *Test alert* button)
- **Scheduled**: register the helper cron (see below) so the dashboard is scanned every 15 minutes

Setup:

1. Discord → Server Settings → Integrations → Webhooks → New Webhook → name it "OpenClaw Cron" → copy the URL.
2. Copy `.env.example` to `.env.local` and set:
   ```bash
   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/…
   DISCORD_MENTION_USER_ID=1194064134879314003   # optional, pings you
   ALERT_CONSECUTIVE_FAILURES=2                  # ping after this many in a row
   ALERT_STALE_HOURS=24                          # ping if no success in N hours
   ALERT_COOLDOWN_MINUTES=60                     # don't re-ping same job within N min
   ```

Alerts are deduped per-job with a configurable cooldown so a flapping job doesn't spam the channel.

To register the scheduled scan:

```bash
openclaw cron add --from-file docs/cron-alert-scan.json
```

(The job calls `curl http://localhost:3737/api/alerts` every 15 minutes. Make sure the dashboard is running — either via `npm start` or the launchd installer.)

## Docker

A multi-stage `Dockerfile` produces a slim runtime image. The container needs access to your local `~/.openclaw` and to the `openclaw` binary for reruns to work, so bind-mount them:

```bash
docker build -t openclaw-cron-dashboard .
docker run --rm \
  -p 3737:3737 \
  -v "$HOME/.openclaw:/root/.openclaw:ro" \
  -v "$HOME/.openclaw/cron-dashboard:/root/.openclaw/cron-dashboard" \
  --env-file .env.local \
  openclaw-cron-dashboard
```

## Privacy

- Binds to `localhost` only — never exposed externally
- Reads your local cron state; no telemetry, no remote calls (except the Discord webhook you opt into)
- The rerun endpoint shells out to your local `openclaw` binary

## File layout

```
app/
  page.tsx              ← root page
  layout.tsx            ← shell
  globals.css           ← Tailwind + theme
  api/cron/
    route.ts            ← GET /api/cron — list jobs + summary
    [id]/runs/route.ts  ← GET /api/cron/<id>/runs — full history
    [id]/rerun/route.ts ← POST /api/cron/<id>/rerun — invokes openclaw
  api/alerts/
    route.ts            ← GET /api/alerts (scan + fire) / POST { kind: 'test' }
components/
  StatusPill.tsx        ← main client component (table + drawer + filters)
lib/
  cron.ts               ← reads ~/.openclaw/cron/* + utilities
  alerts.ts             ← Discord webhook sender + dedupe state
scripts/
  install-launchd.sh    ← register the dashboard as a launchd service
docs/
  cron-alert-scan.json  ← ready-to-import OpenClaw cron job for periodic scans
Dockerfile              ← multi-stage build (uses Next.js standalone output)
```
