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

type TrashEntry = {
  job: {
    id: string;
    name: string;
    schedule: { kind: string; expr?: string; tz?: string };
    payload?: { model?: string };
    enabled?: boolean;
    description?: string;
  };
  deletedAtMs: number;
};

type TrashResponse = {
  trash: TrashEntry[];
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
  const [view, setView] = useState<"active" | "trash" | "backups">("active");
  const [trash, setTrash] = useState<TrashEntry[]>([]);
  const [actionPending, setActionPending] = useState<string | null>(null);
  const [backups, setBackups] = useState<{ file: string; mtimeMs: number; size: number }[]>([]);
  const [backupRetention, setBackupRetention] = useState<number>(30);
  const [restoringBackup, setRestoringBackup] = useState<string | null>(null);

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

  const fetchTrash = useCallback(async () => {
    try {
      const res = await fetch("/api/cron/trash", { cache: "no-store" });
      const json: TrashResponse = await res.json();
      if (!res.ok) throw new Error(json.error || "Trash fetch failed");
      setTrash(json.trash);
    } catch (e: any) {
      // Non-fatal — still surface in the trash panel.
      setTrash([]);
      setError((prev) => prev ?? `trash fetch failed: ${e.message}`);
    }
  }, []);

  useEffect(() => {
    if (view === "trash") fetchTrash();
    if (view === "backups") fetchBackups();
  }, [view, fetchTrash]);

  const fetchBackups = useCallback(async () => {
    try {
      const res = await fetch("/api/cron/backups", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Backups fetch failed");
      setBackups(json.backups || []);
      if (typeof json.retention === "number") setBackupRetention(json.retention);
    } catch (e: any) {
      setBackups([]);
      setError((prev) => prev ?? `backups fetch failed: ${e.message}`);
    }
  }, []);

  const handleRestoreBackup = async (file: string) => {
    if (!confirm(`Restore jobs.json from "${file}"?\n\nThis REPLACES the current jobs.json (which will itself be backed up first, so it's recoverable). All current jobs will be overwritten with the snapshot's contents.`)) return;
    setRestoringBackup(file);
    try {
      const res = await fetch("/api/cron/backups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restore", file }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Restore failed");
      alert(`✓ Restored jobs.json from ${file}. Reload to see the snapshot's data.`);
      await fetchData();
      await fetchBackups();
    } catch (e: any) {
      alert(`❌ Restore failed: ${e.message}`);
    } finally {
      setRestoringBackup(null);
    }
  };

  const handleDelete = async (jobId: string, jobName: string) => {
    if (!confirm(`Move "${jobName}" to trash?\n\nIt will stop running immediately. You can restore it from the Trash panel anytime.`)) return;
    setActionPending(jobId);
    try {
      const res = await fetch(`/api/cron/${jobId}/delete`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Delete failed");
      alert(`🗑️ "${jobName}" moved to trash.`);
      await fetchData();
    } catch (e: any) {
      alert(`❌ Delete failed: ${e.message}`);
    } finally {
      setActionPending(null);
    }
  };

  const handleRestore = async (jobId: string, jobName: string) => {
    if (!confirm(`Restore "${jobName}" from trash? It will return to active jobs and resume on its schedule.`)) return;
    setActionPending(jobId);
    try {
      const res = await fetch(`/api/cron/${jobId}/restore`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Restore failed");
      alert(`✓ "${jobName}" restored.`);
      await Promise.all([fetchData(), fetchTrash()]);
    } catch (e: any) {
      alert(`❌ Restore failed: ${e.message}`);
    } finally {
      setActionPending(null);
    }
  };

  const handlePurge = async (jobId: string, jobName: string) => {
    if (!confirm(`PERMANENTLY delete "${jobName}"?\n\nThis cannot be undone. The job, its run history, and its JSONL log file will be erased forever. If a jobs.json.bak exists, recovery is possible but you'll lose everything after the backup point.\n\nType OK to confirm.`)) return;
    setActionPending(jobId);
    try {
      const res = await fetch(`/api/cron/${jobId}/purge`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Purge failed");
      alert(`🔥 "${jobName}" permanently deleted.`);
      await fetchTrash();
    } catch (e: any) {
      alert(`❌ Purge failed: ${e.message}`);
    } finally {
      setActionPending(null);
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

      <div className="mb-4 flex items-center gap-3">
        <div className="flex items-center gap-3 text-sm">
          <span className="text-xs uppercase tracking-wide text-muted">View</span>
          <div className="flex gap-2">
          <button
            onClick={() => setView("active")}
            className={`rounded px-3 py-1.5 ${
              view === "active"
                ? "bg-accent/20 text-accent"
                : "bg-panel text-muted hover:text-gray-200"
            }`}
          >
            Active
            {summary && (
              <span className="ml-1.5 text-xs opacity-70">{summary.total}</span>
            )}
          </button>
          <button
            onClick={() => setView("trash")}
            className={`rounded px-3 py-1.5 ${
              view === "trash"
                ? "bg-warn/20 text-warn"
                : "bg-panel text-muted hover:text-gray-200"
            }`}
          >
            Trash
            <span className="ml-1.5 text-xs opacity-70">{trash.length}</span>
          </button>
          <button
            onClick={() => setView("backups")}
            className={`rounded px-3 py-1.5 ${
              view === "backups"
                ? "bg-accent/20 text-accent"
                : "bg-panel text-muted hover:text-gray-200"
            }`}
          >
            Backups
            <span className="ml-1.5 text-xs opacity-70">{backups.length}</span>
          </button>
          </div>
        </div>

        {view === "active" && (
          <div className="flex items-center gap-3 text-sm">
            <span className="text-xs uppercase tracking-wide text-muted">By health</span>
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
        )}
      </div>

      {error && (
        <div className="mb-4 rounded border border-err/40 bg-err/10 px-4 py-3 text-sm text-err">
          {error}
        </div>
      )}

      {loading && !data && view === "active" && (
        <div className="text-muted">Loading…</div>
      )}

      {view === "active" && (
      <div className="overflow-hidden rounded-lg border border-border bg-panel">
        <table className="w-full text-sm">
          <thead className="bg-panel/60 text-xs uppercase tracking-wide text-muted">
            <tr className="border-b border-border">
              <th className="px-4 py-3 text-left">Job</th>
              <th className="px-4 py-3 text-left">Schedule</th>
              <th className="px-4 py-3 text-left">Model</th>
              <th className="px-4 py-3 text-left">Last run</th>
              <th className="px-4 py-3 text-left">Next run</th>
              <th className="px-4 py-3 text-left">Avg duration</th>
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
                isDeleting={actionPending === job.id}
                onSelect={() => setSelectedJobId(selectedJobId === job.id ? null : job.id)}
                onRerun={() => handleRerun(job.id, job.name)}
                onDelete={() => handleDelete(job.id, job.name)}
              />
            ))}
            {filteredJobs.length === 0 && !loading && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-muted">
                  No jobs match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      )}

      {view === "trash" && (
        <TrashPanel
          entries={trash}
          pendingId={actionPending}
          onRestore={handleRestore}
          onPurge={handlePurge}
          onRefresh={fetchTrash}
        />
      )}

      {view === "backups" && (
        <BackupsPanel
          backups={backups}
          retention={backupRetention}
          restoringId={restoringBackup}
          onRestore={handleRestoreBackup}
          onRefresh={fetchBackups}
        />
      )}

      {view === "active" && selectedJobId && (
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

// Renders duration stats: avg over last 10 runs (top) + last-run duration (below).
// Color-codes the avg so long jobs stand out: >=5m = warn, >=10m = err.
function DurationCell({ recentRuns }: { recentRuns: { durationMs?: number }[] }) {
  const finished = (recentRuns || []).filter(
    (r) => typeof r.durationMs === "number" && r.durationMs > 0
  );
  if (finished.length === 0) {
    return <span className="text-muted">—</span>;
  }
  const last = finished[0].durationMs!; // newest is first
  const sample = finished.slice(0, 10);
  const avg = Math.round(
    sample.reduce((sum, r) => sum + (r.durationMs || 0), 0) / sample.length
  );
  const avgColor =
    avg >= 600_000 ? "text-err" : avg >= 300_000 ? "text-warn" : "text-gray-200";
  const shown = sample.length < 10 ? `${sample.length}` : "10";
  return (
    <>
      <div className={avgColor} title={`Average over ${shown} run${shown === "1" ? "" : "s"}`}>
        {humanDuration(avg)}
      </div>
      <div className="text-muted" title="Most recent run">
        last: {humanDuration(last)}
      </div>
    </>
  );
}

function TrashPanel({
  entries,
  pendingId,
  onRestore,
  onPurge,
  onRefresh,
}: {
  entries: TrashEntry[];
  pendingId: string | null;
  onRestore: (id: string, name: string) => void;
  onPurge: (id: string, name: string) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-warn/40 bg-panel">
      <div className="flex items-center justify-between border-b border-border bg-warn/10 px-4 py-3 text-sm">
        <div className="text-warn">
          🗑️ Trash · {entries.length} {entries.length === 1 ? "job" : "jobs"} archived
        </div>
        <button
          onClick={onRefresh}
          className="rounded border border-border bg-panel px-2 py-1 text-xs text-muted hover:text-gray-200"
        >
          Refresh
        </button>
      </div>
      {entries.length === 0 ? (
        <div className="px-4 py-12 text-center text-sm text-muted">
          Trash is empty. Deleted jobs appear here and can be restored anytime.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-panel/60 text-xs uppercase tracking-wide text-muted">
            <tr className="border-b border-border">
              <th className="px-4 py-3 text-left">Job</th>
              <th className="px-4 py-3 text-left">Schedule</th>
              <th className="px-4 py-3 text-left">Model</th>
              <th className="px-4 py-3 text-left">Deleted</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const j = entry.job;
              const isPending = pendingId === j.id;
              const scheduleStr =
                j.schedule?.kind === "cron"
                  ? `${j.schedule.expr ?? ""}${j.schedule.tz ? ` ${j.schedule.tz.split("/").pop()}` : ""}`
                  : "one-shot";
              return (
                <tr key={j.id} className="border-b border-border/50">
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-100">{j.name}</div>
                    <div className="text-xs text-muted">{j.id}</div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted">{scheduleStr || "—"}</td>
                  <td className="px-4 py-3 text-xs">
                    <ModelBadge model={j.payload?.model} />
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <div className="text-gray-200">{humanTime(entry.deletedAtMs)}</div>
                    <div className="text-muted">{relativeTime(entry.deletedAtMs)}</div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => onRestore(j.id, j.name)}
                        disabled={isPending}
                        className="rounded bg-ok/20 px-3 py-1 text-xs text-ok hover:bg-ok/30 disabled:opacity-40"
                        title="Move this job back to active jobs"
                      >
                        {isPending ? "…" : "Restore"}
                      </button>
                      <button
                        onClick={() => onPurge(j.id, j.name)}
                        disabled={isPending}
                        className="rounded bg-err/15 px-3 py-1 text-xs text-err hover:bg-err/25 disabled:opacity-40"
                        title="Permanently delete (no undo)"
                      >
                        Purge
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function BackupsPanel({
  backups,
  retention,
  restoringId,
  onRestore,
  onRefresh,
}: {
  backups: { file: string; mtimeMs: number; size: number }[];
  retention: number;
  restoringId: string | null;
  onRestore: (file: string) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-panel">
      <div className="flex items-center justify-between border-b border-border bg-accent/10 px-4 py-3 text-sm">
        <div className="text-accent">
          💾 Backups · {backups.length} of {retention} retained (oldest pruned on next write)
        </div>
        <button
          onClick={onRefresh}
          className="rounded border border-border bg-panel px-2 py-1 text-xs text-muted hover:text-gray-200"
        >
          Refresh
        </button>
      </div>
      {backups.length === 0 ? (
        <div className="px-4 py-12 text-center text-sm text-muted">
          No backups yet. Backups are created automatically before every dashboard write (delete / restore / purge).
          <br />
          Override retention via <code className="rounded bg-border/30 px-1">BACKUP_RETENTION</code> in the launchd plist.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-panel/60 text-xs uppercase tracking-wide text-muted">
            <tr className="border-b border-border">
              <th className="px-4 py-3 text-left">File</th>
              <th className="px-4 py-3 text-left">Saved</th>
              <th className="px-4 py-3 text-right">Size</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {backups.map((b) => (
              <tr key={b.file} className="border-b border-border/50">
                <td className="px-4 py-3">
                  <code className="rounded bg-border/30 px-1.5 py-0.5 font-mono text-xs text-gray-200">
                    {b.file}
                  </code>
                </td>
                <td className="px-4 py-3 text-xs">
                  <div className="text-gray-200">{humanTime(b.mtimeMs)}</div>
                  <div className="text-muted">{relativeTime(b.mtimeMs)}</div>
                </td>
                <td className="px-4 py-3 text-right text-xs text-muted">
                  {(b.size / 1024).toFixed(1)} KB
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => onRestore(b.file)}
                    disabled={restoringId === b.file}
                    className="rounded bg-warn/20 px-3 py-1 text-xs text-warn hover:bg-warn/30 disabled:opacity-40"
                    title="Replace jobs.json with this snapshot (current state is itself backed up first)"
                  >
                    {restoringId === b.file ? "Restoring…" : "Restore"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function JobRow({
  job,
  isSelected,
  isRerunning,
  isDeleting,
  onSelect,
  onRerun,
  onDelete,
}: {
  job: ApiJob;
  isSelected: boolean;
  isRerunning: boolean;
  isDeleting: boolean;
  onSelect: () => void;
  onRerun: () => void;
  onDelete: () => void;
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
          <DurationCell recentRuns={job.recentRuns} />
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
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={onRerun}
              disabled={isRerunning || isDeleting}
              className="rounded bg-accent/20 px-3 py-1 text-xs text-accent hover:bg-accent/30 disabled:opacity-40"
            >
              {isRerunning ? "Running…" : "Rerun"}
            </button>
            <button
              onClick={onDelete}
              disabled={isRerunning || isDeleting}
              className="rounded bg-err/15 px-3 py-1 text-xs text-err hover:bg-err/25 disabled:opacity-40"
              title="Move to trash (soft delete)"
            >
              {isDeleting ? "…" : "Delete"}
            </button>
          </div>
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
