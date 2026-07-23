// app/api/alerts/route.ts — scan cron jobs and fire alerts when needed.
//
// GET  /api/alerts         → run a scan, fire alerts for any job that's over
//                            threshold and not in cooldown, return a summary.
// POST /api/alerts         → body { kind: "test", note?: string } → fire a
//                            test webhook regardless of thresholds/cooldown.
// POST /api/alerts { kind: "reset", jobId } → clear cooldown for one job.

import { NextResponse } from "next/server";
import { readAllJobsWithRuns, isStale } from "@/lib/cron";
import { fireTestAlert, maybeFireAlert } from "@/lib/alerts";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const jobs = await readAllJobsWithRuns(20);
    const failThreshold = Number(process.env.ALERT_CONSECUTIVE_FAILURES || 2);
    const staleHours = Number(process.env.ALERT_STALE_HOURS || 24);

    const results: any[] = [];

    for (const job of jobs) {
      if (!job.enabled) continue;

      // 1. Consecutive failures
      if (job.consecutiveFailures >= failThreshold) {
        const res = await maybeFireAlert({
          kind: "consecutive_failures",
          jobId: job.id,
          jobName: job.name || job.id,
          count: job.consecutiveFailures,
        });
        results.push({
          jobId: job.id,
          jobName: job.name || job.id,
          check: "consecutive_failures",
          count: job.consecutiveFailures,
          ...res,
        });
        continue; // don't double-alert same job in same scan
      }

      // 2. Stale (no recent successful run)
      const staleness = isStale(job, staleHours);
      if (staleness.stale) {
        const hoursSince =
          job.lastSuccessAt || job.lastFailureAt
            ? (Date.now() - (job.lastSuccessAt || job.lastFailureAt || 0)) / 3_600_000
            : 9999;
        const res = await maybeFireAlert({
          kind: "stale",
          jobId: job.id,
          jobName: job.name || job.id,
          hoursSince,
        });
        results.push({
          jobId: job.id,
          jobName: job.name || job.id,
          check: "stale",
          hoursSince,
          staleReason: staleness.reason,
          ...res,
        });
      }
    }

    return NextResponse.json({
      ok: true,
      webhookConfigured: Boolean(process.env.DISCORD_WEBHOOK_URL?.trim()),
      scanned: jobs.length,
      results,
      scannedAt: Date.now(),
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Alert scan failed" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.kind === "test") {
      const res = await fireTestAlert(body.note);
      return NextResponse.json({ ok: true, test: res });
    }
    return NextResponse.json(
      { error: "Unsupported action; use { kind: 'test' }" },
      { status: 400 }
    );
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Alert action failed" },
      { status: 500 }
    );
  }
}
