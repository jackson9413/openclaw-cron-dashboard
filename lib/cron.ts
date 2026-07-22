// lib/cron.ts — reads OpenClaw cron state directly from disk
// Source paths mirror OpenClaw's storage layout (~/.openclaw/cron/)

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const CRON_DIR = path.join(os.homedir(), ".openclaw", "cron");
const JOBS_FILE = path.join(CRON_DIR, "jobs.json");
const RUNS_DIR = path.join(CRON_DIR, "runs");

export type CronJob = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  schedule: { kind: "cron" | "at"; expr?: string; tz?: string };
  sessionTarget: string;
  wakeMode: string;
  payload: {
    kind: string;
    message: string;
    model?: string;
    timeoutSeconds?: number;
  };
  delivery: {
    mode: string;
    channel?: string;
    to?: string;
  };
  state: {
    nextRunAtMs?: number;
    lastStatus?: string;
    lastRunAtMs?: number;
  };
};

export type CronRun = {
  ts: number;
  jobId: string;
  action: string;
  status: "ok" | "error" | string;
  summary?: string;
  delivered?: boolean;
  deliveryStatus?: string;
  durationMs?: number;
  runAtMs?: number;
  nextRunAtMs?: number;
  model?: string;
  provider?: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  error?: string;
};

export type JobWithRuns = CronJob & {
  recentRuns: CronRun[];
  lastSuccessAt?: number;
  lastFailureAt?: number;
  consecutiveFailures: number;
  totalRuns: number;
  successRate: number;
};

export async function readJobs(): Promise<CronJob[]> {
  const raw = await fs.readFile(JOBS_FILE, "utf8");
  const parsed = JSON.parse(raw);
  return (parsed.jobs || []) as CronJob[];
}

export async function readRunsForJob(jobId: string, limit = 25): Promise<CronRun[]> {
  const file = path.join(RUNS_DIR, `${jobId}.jsonl`);
  try {
    const raw = await fs.readFile(file, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const runs: CronRun[] = [];
    // Read from the END of the file so we get the most recent N runs fast.
    // For files < 1MB this is fine; for huge files we'd tail properly.
    const start = Math.max(0, lines.length - limit);
    for (let i = start; i < lines.length; i++) {
      try {
        runs.push(JSON.parse(lines[i]));
      } catch {
        // skip malformed line
      }
    }
    return runs.reverse(); // newest first
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

export async function readAllJobsWithRuns(limit = 10): Promise<JobWithRuns[]> {
  const jobs = await readJobs();
  const enriched = await Promise.all(
    jobs.map(async (job) => {
      const runs = await readRunsForJob(job.id, limit * 5); // get more, then summarize
      const finishedRuns = runs.filter((r) => r.action === "finished" || r.status);
      const recentRuns = finishedRuns.slice(0, limit);

      let consecutiveFailures = 0;
      for (const r of recentRuns) {
        if (r.status === "error") consecutiveFailures++;
        else break;
      }

      const successes = finishedRuns.filter((r) => r.status === "ok").length;
      const successRate =
        finishedRuns.length === 0 ? 1 : successes / finishedRuns.length;

      const lastSuccess = finishedRuns.find((r) => r.status === "ok");
      const lastFailure = finishedRuns.find((r) => r.status === "error");

      return {
        ...job,
        recentRuns,
        lastSuccessAt: lastSuccess?.runAtMs,
        lastFailureAt: lastFailure?.runAtMs,
        consecutiveFailures,
        totalRuns: finishedRuns.length,
        successRate,
      };
    })
  );
  return enriched;
}

// Returns true if the job is "stale" (hasn't run successfully in N hours
// AND has been expected to run at least once in that window).
export function isStale(job: JobWithRuns, staleHours = 24): { stale: boolean; reason?: string } {
  if (!job.enabled) return { stale: false };
  if (job.totalRuns === 0) {
    // Never run. If next run is within 24h, not stale yet.
    if (job.state.nextRunAtMs) {
      const hoursAway = (job.state.nextRunAtMs - Date.now()) / 3_600_000;
      if (hoursAway <= staleHours) return { stale: false };
    }
    return { stale: true, reason: "Never run" };
  }
  const lastRun = job.lastSuccessAt || job.lastFailureAt || 0;
  const hoursSince = (Date.now() - lastRun) / 3_600_000;
  if (hoursSince > staleHours) {
    return { stale: true, reason: `Last run ${hoursSince.toFixed(1)}h ago` };
  }
  return { stale: false };
}

// Re-export pure formatters so server callers can keep using one import path.
export { humanDuration, humanTime, relativeTime } from "./format";
