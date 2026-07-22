# OpenClaw Cron Dashboard

Local-only Next.js dashboard for monitoring your OpenClaw cron jobs, viewing run history, and rerunning failed jobs with one click.

## What it does

- **Live status** of every cron job (auto-refreshes every 30s)
- **Health pills**: healthy / failing / stale / disabled
- **Stale detection**: flags any enabled job that hasn't run successfully in 24h
- **Success-rate bars** with rolling history
- **Run history drawer** — full JSONL tail with summary, status, duration, token usage
- **One-click rerun** via `openclaw cron run <id>`
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

## Auto-start at login (optional)

A launchd plist can be generated with the included helper, or you can run `npm start` manually once logged in.

## Privacy

- Binds to `localhost` only — never exposed externally
- Reads your local cron state; no telemetry, no remote calls
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
components/
  StatusPill.tsx        ← main client component (table + drawer + filters)
lib/
  cron.ts               ← reads ~/.openclaw/cron/* + utilities
```
