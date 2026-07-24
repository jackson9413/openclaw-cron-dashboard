"use client";

import { useEffect, useState, useCallback } from "react";
import type { JobWithRuns } from "@/lib/cron";
import { humanDuration, humanTime, relativeTime } from "@/lib/format";

type ApiJob = JobWithRuns & {
  staleness: { stale: boolean; reason?: string };
};

type ApiResponse = {
  jobs: ApiJob[];
  fetchedAt: number;
  error?: string;
};

export default function Dashboard() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [rerunningId, setRerunningId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "failing" | "stale" | "disabled">("all");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<number | null>(null);
  const [alertStatus, setAlertStatus] = useState<{ webhookConfigured: boolean; message: string } | null>(null);
  const [testingAlert, setTestingAlert] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/cron", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Fetch failed");
      setData(json);
      setError(null);
      setLastRefreshed(Date.now());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    // Probe alerts endpoint once on mount so we can show webhook status in the footer.
    fetch("/api/alerts", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        setAlertStatus({
          webhookConfigured: Boolean(j.webhookConfigured),
          message: j.webhookConfigured ? "" : "set DISCORD_WEBHOOK_URL to enable",
        });
      })
      .catch(() => {});
    if (!autoRefresh) return;
    const t = setInterval(fetchData, 30_000);
    return () => clearInterval(t);
  }, [fetchData, autoRefresh]);

  const handleTestAlert = async () => {
    setTestingAlert(true);
    try {
      const res = await fetch("/api/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "test", note: "Test from dashboard" }),
      });
      const json = await res.json();
      if (json?.test?.fired) {
        setAlertStatus({
          webhookConfigured: true,
          message: `✓ Test alert sent (HTTP ${json.test.httpStatus ?? "?"})`,
        });
      } else {
        setAlertStatus({
          webhookConfigured: Boolean(process.env.NEXT_PUBLIC_DISCORD_WEBHOOK_URL),
          message: `⚠️ ${json?.test?.reason || "unknown"}`,
        });
      }
    } catch (e: any) {
      setAlertStatus({ webhookConfigured: false, message: `❌ ${e.message}` });
    } finally {
      setTestingAlert(false);
    }
  };

  const handleRerun = async (jobId: string, jobName: string) => {
    if (!confirm(`Rerun "${jobName}" now? This will invoke the agent immediately.`)) return;
    setRerunningId(jobId);
    try {
      const res = await fetch(`/api/cron/${jobId}/rerun`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Rerun failed");
      if (json.ok) {
        alert(`✅ ${jobName} triggered. Refresh in a few seconds to see the run.`);
      } else {
        alert(`⚠️ Rerun exited with code ${json.exitCode}\n\nSTDERR:\n${json.stderr || "(none)"}\n\nSTDOUT:\n${json.stdout || "(none)"}`);
      }
    } catch (e: any) {
      alert(`❌ ${e.message}`);
    } finally {
      setRerunningId(null);
      fetchData();
    }
  };

  const filteredJobs = (data?.jobs || []).filter((job) => {
    if (filter === "all") return true;
    if (filter === "failing") return job.consecutiveFailures > 0;
    if (filter === "stale") return job.staleness.stale;
    if (filter === "disabled") return !job.enabled;
    return true;
  });

  const summary = data?.jobs
    ? {
        total: data.jobs.length,
        enabled: data.jobs.filter((j) => j.enabled).length,
        failing: data.jobs.filter((j) => j.consecutiveFailures > 0).length,
        stale: data.jobs.filter((j) => j.staleness.stale).length,
        disabled: data.jobs.filter((j) => !j.enabled).length,
      }
    : null;

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <header className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">OpenClaw Cron Dashboard</h1>
          <p className="mt-1 text-sm text-muted">
            Local monitor for {summary?.total ?? "—"} jobs · {summary?.enabled ?? "—"} enabled · {summary?.failing ?? "—"} failing
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          {lastRefreshed && (
            <span className="text-muted">refreshed {relativeTime(lastRefreshed)}</span>
          )}
          <label className="flex items-center gap-1.5 text-muted">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="accent-accent"
            />
            auto (30s)
          </label>
          <button
            onClick={fetchData}
            className="rounded border border-border bg-panel px-3 py-1.5 text-gray-200 hover:bg-border"
          >
            Refresh
          </button>
        </div>
      </header>

      <div className="mb-4 flex gap-2 text-sm">
        {(["all", "failing", "stale", "disabled"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded px-3 py-1.5 capitalize ${
              filter === f
                ? "bg-accent/20 text-accent"
                : "bg-panel text-muted hover:text-gray-200"
            }`}
          >
            {f}
            {summary && f !== "all" && (
              <span className="ml-1.5 text-xs opacity-70">
                {f === "failing" ? summary.failing : f === "stale" ? summary.stale : summary.disabled}
              </span>
            )}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4 rounded border border-err/40 bg-err/10 px-4 py-3 text-sm text-err">
          {error}
        </div>
      )}

      {loading && !data && (
        <div className="text-muted">Loading…</div>
      )}

      <div className="overflow-hidden rounded-lg border border-border bg-panel">
        <table className="w-full text-sm">
          <thead className="bg-panel/60 text-xs uppercase tracking-wide text-muted">
            <tr className="border-b border-border">
              <th className="px-4 py-3 text-left">Job</th>
              <th className="px-4 py-3 text-left">Schedule</th>
              <th className="px-4 py-3 text-left">Model</th>
              <th className="px-4 py-3 text-left">Last run</th>
              <th className="px-4 py-3 text-left">Next run</th>
              <th className="px-4 py-3 text-left">Success rate</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredJobs.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                isSelected={selectedJobId === job.id}
                isRerunning={rerunningId === job.id}
                onSelect={() => setSelectedJobId(selectedJobId === job.id ? null : job.id)}
                onRerun={() => handleRerun(job.id, job.name)}
              />
            ))}
            {filteredJobs.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted">
                  No jobs match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selectedJobId && (
        <RunsDrawer
          jobId={selectedJobId}
          jobName={data?.jobs.find((j) => j.id === selectedJobId)?.name || ""}
          onClose={() => setSelectedJobId(null)}
        />
      )}

      <footer className="mt-8 text-center text-xs text-muted">
        <div className="flex items-center justify-center gap-3">
          <span>
            Reads from <code className="rounded bg-panel px-1.5 py-0.5">~/.openclaw/cron/</code> ·
            reruns invoke <code className="rounded bg-panel px-1.5 py-0.5">openclaw cron run &lt;id&gt;</code>
          </span>
          <span className="text-border">|</span>
          <span className={alertStatus?.webhookConfigured ? "text-ok" : "text-muted"}>
            Discord alerts: {alertStatus?.webhookConfigured ? "✓ configured" : "not configured"}
          </span>
          <button
            onClick={handleTestAlert}
            disabled={testingAlert || !alertStatus?.webhookConfigured}
            className="rounded border border-border bg-panel px-2 py-0.5 text-xs text-gray-200 hover:bg-border disabled:opacity-40"
            title="Fire a test Discord webhook"
          >
            {testingAlert ? "sending…" : "Test alert"}
          </button>
        </div>
        {alertStatus?.message && (
          <div className="mt-1 text-xs text-muted">{alertStatus.message}</div>
        )}
      </footer>
    </div>
  );
}

function StatusPill({ job }: { job: ApiJob }) {
  if (!job.enabled) {
    return <span className="rounded bg-muted/20 px-2 py-0.5 text-xs text-muted">disabled</span>;
  }
  if (job.consecutiveFailures > 0) {
    return (
      <span className="rounded bg-err/20 px-2 py-0.5 text-xs text-err">
        failing ×{job.consecutiveFailures}
      </span>
    );
  }
  if (job.staleness.stale) {
    return (
      <span className="rounded bg-warn/20 px-2 py-0.5 text-xs text-warn">
        stale
      </span>
    );
  }
  return <span className="rounded bg-ok/20 px-2 py-0.5 text-xs text-ok">healthy</span>;
}

// Renders the model identifier (e.g. "minimax/minimax-3.0") as a compact chip.
// Trims long names, falls back to a muted "default" pill when missing.
function ModelBadge({ model }: { model?: string }) {
  if (!model) {
    return <span className="text-muted">default</span>;
  }
  // Split "provider/model" -> show just the model part on the chip, hover for full.
  const parts = model.split("/");
  const display = parts[parts.length - 1] || model;
  return (
    <span
      title={model}
      className="inline-block max-w-[10rem] truncate rounded bg-accent/15 px-2 py-0.5 font-mono text-[11px] text-accent align-middle"
    >
      {display}
    </span>
  );
}

function JobRow({
  job,
  isSelected,
  isRerunning,
  onSelect,
  onRerun,
}: {
  job: ApiJob;
  isSelected: boolean;
  isRerunning: boolean;
  onSelect: () => void;
  onRerun: () => void;
}) {
  const lastRun = job.lastSuccessAt || job.lastFailureAt;
  const lastRunStatus = job.lastSuccessAt ? "ok" : job.lastFailureAt ? "error" : null;
  const scheduleStr =
    job.schedule.kind === "cron"
      ? `${job.schedule.expr}${job.schedule.tz ? ` ${job.schedule.tz.split("/").pop()}` : ""}`
      : "one-shot";

  return (
    <>
      <tr
        className={`border-b border-border/50 hover:bg-border/30 ${isSelected ? "bg-border/20" : ""}`}
      >
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <button onClick={onSelect} className="text-left">
              <div className="font-medium text-gray-100">{job.name}</div>
              {job.description && (
                <div className="text-xs text-muted">{job.description}</div>
              )}
            </button>
            <StatusPill job={job} />
          </div>
        </td>
        <td className="px-4 py-3 font-mono text-xs text-muted">
          <div>{scheduleStr}</div>
        </td>
        <td className="px-4 py-3 text-xs text-muted">
          <ModelBadge model={job.payload?.model} />
        </td>
        <td className="px-4 py-3 text-xs">
          {lastRun ? (
            <>
              <div className={lastRunStatus === "error" ? "text-err" : "text-gray-200"}>
                {relativeTime(lastRun)}
              </div>
              <div className="text-muted">{humanTime(lastRun)}</div>
            </>
          ) : (
            <span className="text-muted">never</span>
          )}
        </td>
        <td className="px-4 py-3 text-xs">
          {job.state.nextRunAtMs ? (
            <>
              <div className="text-gray-200">{humanTime(job.state.nextRunAtMs)}</div>
              <div className="text-muted">{relativeTime(job.state.nextRunAtMs)}</div>
            </>
          ) : (
            <span className="text-muted">—</span>
          )}
        </td>
        <td className="px-4 py-3 text-xs">
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-20 overflow-hidden rounded-full bg-border">
              <div
                className={`h-full ${
                  job.successRate >= 0.95 ? "bg-ok" : job.successRate >= 0.7 ? "bg-warn" : "bg-err"
                }`}
                style={{ width: `${(job.successRate * 100).toFixed(0)}%` }}
              />
            </div>
            <span className="text-muted">
              {(job.successRate * 100).toFixed(0)}% ({job.totalRuns})
            </span>
          </div>
        </td>
        <td className="px-4 py-3 text-right">
          <button
            onClick={onRerun}
            disabled={isRerunning}
            className="rounded bg-accent/20 px-3 py-1 text-xs text-accent hover:bg-accent/30 disabled:opacity-40"
          >
            {isRerunning ? "Running…" : "Rerun"}
          </button>
        </td>
      </tr>
    </>
  );
}

function RunsDrawer({
  jobId,
  jobName,
  onClose,
}: {
  jobId: string;
  jobName: string;
  onClose: () => void;
}) {
  const [runs, setRuns] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/cron/${jobId}/runs`, { cache: "no-store" });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Failed");
        if (!cancelled) setRuns(json.runs);
      } catch (e: any) {
        if (!cancelled) setError(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div
        className="h-full w-full max-w-3xl overflow-y-auto border-l border-border bg-bg p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-medium">
            Run history — <span className="text-accent">{jobName}</span>
          </h2>
          <button
            onClick={onClose}
            className="rounded border border-border bg-panel px-3 py-1 text-sm hover:bg-border"
          >
            Close
          </button>
        </div>
        {error && <div className="text-err">{error}</div>}
        {!runs && !error && <div className="text-muted">Loading…</div>}
        {runs && runs.length === 0 && <div className="text-muted">No runs yet.</div>}
        <div className="space-y-3">
          {runs?.map((run, i) => (
            <div
              key={i}
              className={`rounded border ${
                run.status === "error" ? "border-err/40" : "border-border"
              } bg-panel p-4`}
            >
              <div className="mb-2 flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs ${
                      run.status === "error"
                        ? "bg-err/20 text-err"
                        : run.status === "ok"
                        ? "bg-ok/20 text-ok"
                        : "bg-muted/20 text-muted"
                    }`}
                  >
                    {run.status}
                  </span>
                  <span className="text-muted">{humanTime(run.runAtMs || run.ts)}</span>
                  {run.durationMs && (
                    <span className="text-muted">· {humanDuration(run.durationMs)}</span>
                  )}
                  {run.delivered !== undefined && (
                    <span className={run.delivered ? "text-ok" : "text-warn"}>
                      · {run.delivered ? "delivered" : "not delivered"}
                    </span>
                  )}
                </div>
                <span className="text-muted">
                  {run.model && `${run.model}`}
                  {run.usage?.total_tokens && ` · ${run.usage.total_tokens.toLocaleString()} tok`}
                </span>
              </div>
              {run.error && (
                <div className="mt-2 rounded bg-err/10 px-3 py-2 text-xs text-err">
                  {run.error}
                </div>
              )}
              {run.summary && (
                <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap rounded bg-bg p-3 text-xs text-gray-300">
                  {run.summary.slice(0, 2000)}
                  {run.summary.length > 2000 && "\n…(truncated)"}
                </pre>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
