// lib/alerts.ts — Discord webhook alert sender + dedupe state
//
// Persists a small JSON file under the user's data dir so we don't spam Discord
// every time the dashboard polls (30s interval). One alert per job per cooldown.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const STATE_DIR = path.join(os.homedir(), ".openclaw", "cron-dashboard");
const STATE_FILE = path.join(STATE_DIR, "alert-state.json");

type AlertState = {
  // jobId → { lastFiredAt, lastReason }
  jobs: Record<string, { lastFiredAt: number; lastReason: string }>;
};

async function readState(): Promise<AlertState> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    return JSON.parse(raw);
  } catch (err: any) {
    if (err.code === "ENOENT") return { jobs: {} };
    // Don't crash the whole dashboard over a corrupt alert state file.
    return { jobs: {} };
  }
}

async function writeState(state: AlertState): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

export type AlertReason =
  | { kind: "consecutive_failures"; jobId: string; jobName: string; count: number }
  | { kind: "stale"; jobId: string; jobName: string; hoursSince: number }
  | { kind: "explicit_test"; note?: string };

export async function maybeFireAlert(reason: AlertReason): Promise<{
  fired: boolean;
  reason: string;
  httpStatus?: number;
}> {
  const webhook = process.env.DISCORD_WEBHOOK_URL?.trim();
  if (!webhook) {
    return { fired: false, reason: "DISCORD_WEBHOOK_URL not set" };
  }

  const cooldownMinutes = Number(process.env.ALERT_COOLDOWN_MINUTES || 60);
  const cooldownMs = cooldownMinutes * 60_000;

  // For test alerts, always fire; for real alerts, dedupe per job.
  const isTest = reason.kind === "explicit_test";
  const dedupeKey = isTest ? `__test__${Date.now()}` : reason.jobId;

  const state = await readState();
  const lastFired = state.jobs[dedupeKey]?.lastFiredAt ?? 0;
  const now = Date.now();
  if (!isTest && now - lastFired < cooldownMs) {
    return {
      fired: false,
      reason: `cooldown (last fired ${Math.round((now - lastFired) / 60_000)}m ago)`,
    };
  }

  const payload = buildDiscordPayload(reason);
  let httpStatus: number | undefined;
  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    httpStatus = res.status;
    if (!res.ok) {
      return {
        fired: false,
        reason: `Discord webhook returned ${res.status}`,
        httpStatus,
      };
    }
  } catch (err: any) {
    return {
      fired: false,
      reason: `Discord webhook error: ${err.message || String(err)}`,
    };
  }

  state.jobs[dedupeKey] = { lastFiredAt: now, lastReason: reason.kind };
  await writeState(state);

  return { fired: true, reason: "sent", httpStatus };
}

function buildDiscordPayload(reason: AlertReason) {
  const mention = process.env.DISCORD_MENTION_USER_ID?.trim();
  const contentPrefix = mention ? `${mention} ` : "";
  const ts = Math.floor(Date.now() / 1000);

  if (reason.kind === "explicit_test") {
    return {
      content: `${contentPrefix}🧪 OpenClaw cron dashboard alert test.`,
      embeds: [
        {
          title: "Alert test",
          description: reason.note || "If you can read this, Discord alerting works.",
          color: 0x3b82f6,
          timestamp: new Date().toISOString(),
        },
      ],
    };
  }

  if (reason.kind === "consecutive_failures") {
    return {
      content: `${contentPrefix}🚨 Cron job failing: **${reason.jobName}** (${reason.count} consecutive failures)`,
      embeds: [
        {
          title: `Job: ${reason.jobName}`,
          description: `Job ID: \`${reason.jobId}\`\nConsecutive failures: **${reason.count}**`,
          color: 0xef4444,
          footer: { text: "OpenClaw Cron Dashboard" },
          timestamp: new Date().toISOString(),
        },
      ],
      allowed_mentions: mention ? { users: [mention.replace(/[<@>]/g, "")] } : undefined,
    };
  }

  // stale
  return {
    content: `${contentPrefix}⏰ Cron job looks stale: **${reason.jobName}** (${reason.hoursSince.toFixed(1)}h since last successful run)`,
    embeds: [
      {
        title: `Job: ${reason.jobName}`,
        description: `Job ID: \`${reason.jobId}\`\nHours since last success: **${reason.hoursSince.toFixed(1)}h**`,
        color: 0xf59e0b,
        footer: { text: "OpenClaw Cron Dashboard" },
        timestamp: new Date().toISOString(),
      },
    ],
    allowed_mentions: mention ? { users: [mention.replace(/[<@>]/g, "")] } : undefined,
  };
}

// Exposed for the "test alert" UI button.
export async function fireTestAlert(note?: string) {
  return maybeFireAlert({ kind: "explicit_test", note });
}
