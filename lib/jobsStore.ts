// lib/jobsStore.ts — soft-delete / restore / purge for OpenClaw cron jobs.
//
// OpenClaw writes its job list to ~/.openclaw/cron/jobs.json as a small JSON
// document with shape { version: number, jobs: CronJob[] }. We add a parallel
// `trash: TrashEntry[]` key so soft-deletes don't require touching OpenClaw's
// CLI or restarting the scheduler — the daemon simply ignores keys it doesn't
// know about, and by keeping deleted jobs OUT of the `jobs[]` array it
// considers the job gone.
//
// Every write goes through `writeWithBackup()`, which:
//   1. Copies the current file to a timestamped jobs.json.YYYY-MM-DD_HHMMSS.bak
//      (configurable retention via BACKUP_RETENTION, default 30)
//   2. Validates the new shape (must have version + jobs[])
//   3. Writes atomically via tmp + rename so a mid-write crash can't corrupt
//   4. Prunes the oldest backups beyond retention so the directory doesn't grow
//
// Calling code does NOT need to also `openclaw cron rm` for soft-delete — only
// for true `purge()` (hard delete).

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const CRON_DIR = path.join(os.homedir(), ".openclaw", "cron");
const JOBS_FILE = path.join(CRON_DIR, "jobs.json");
const BACKUP_PREFIX = "jobs.json.";
const BACKUP_SUFFIX = ".bak";

// Retention: override via env. Default 30 keeps ~30 days of history if the
// dashboard only writes ~1x/day, or ~7 days at 5x/day. Old backups beyond this
// are pruned on every successful write.
function retentionLimit(): number {
  const raw = process.env.BACKUP_RETENTION;
  if (!raw) return 30;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function timestampForBackup(d = new Date()): string {
  // YYYY-MM-DD_HHMMSS_mmm in local time — sorts lexically by recency.
  // The millisecond suffix guarantees uniqueness even when multiple writes
  // happen within the same second (e.g. a tight delete+restore+delete loop).
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
  const stamp =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}` +
    `_${pad(d.getMilliseconds(), 3)}`;
  return stamp;
}

export type CronJobRaw = {
  id: string;
  name: string;
  enabled?: boolean;
  createdAtMs?: number;
  schedule: any;
  sessionTarget?: string;
  wakeMode?: string;
  payload: any;
  delivery?: any;
  state?: any;
  [k: string]: unknown;
};

export type TrashEntry = {
  job: CronJobRaw;
  deletedAtMs: number;
};

type JobsFile = {
  version: number;
  jobs: CronJobRaw[];
  // Optional — only present after the dashboard does its first soft-delete.
  trash?: TrashEntry[];
};

async function readJobsFile(): Promise<JobsFile> {
  const raw = await fs.readFile(JOBS_FILE, "utf8");
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`jobs.json is not an object: ${typeof parsed}`);
  }
  if (typeof parsed.version !== "number") {
    throw new Error("jobs.json missing 'version' field");
  }
  if (!Array.isArray(parsed.jobs)) {
    throw new Error("jobs.json missing 'jobs' array");
  }
  // Ensure trash exists for reads.
  if (!Array.isArray(parsed.trash)) parsed.trash = [];
  return parsed as JobsFile;
}

// Narrow: forces callers to treat `trash` as defined. Useful for TS strict mode
// where the optional `trash?: TrashEntry[]` annotation otherwise requires `?? []`
// at every read.
function withTrash(f: JobsFile): JobsFile & { trash: TrashEntry[] } {
  return { ...f, trash: f.trash ?? [] };
}

// Atomic write with a timestamped backup. Re-validates before writing.
async function writeWithBackup(next: JobsFile): Promise<void> {
  if (typeof next.version !== "number") {
    throw new Error("Refusing to write jobs.json without a version field");
  }
  if (!Array.isArray(next.jobs)) {
    throw new Error("Refusing to write jobs.json without a jobs array");
  }
  if (!Array.isArray(next.trash)) {
    next.trash = [];
  }

  // 1) Backup the existing file as a timestamped snapshot (best-effort).
  //    Skip on first write (no prior file).
  try {
    await fs.access(JOBS_FILE);
    const backupName = `${BACKUP_PREFIX}${timestampForBackup()}${BACKUP_SUFFIX}`;
    const backupPath = path.join(CRON_DIR, backupName);
    await fs.copyFile(JOBS_FILE, backupPath);
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
    // No prior file — skip backup. Nothing to preserve.
  }

  // 2) Write atomically: tmp file, then rename over the original.
  const tmp = `${JOBS_FILE}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await fs.rename(tmp, JOBS_FILE);

  // 3) Prune old backups beyond retention. Best-effort.
  await pruneBackups(retentionLimit()).catch(() => {
    // Swallow pruning errors — write succeeded; just log if needed.
  });
}

// List existing timestamped backup files, newest first.
export async function listBackups(): Promise<{ file: string; mtimeMs: number; size: number }[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(CRON_DIR);
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const backups = entries.filter((n) => n.startsWith(BACKUP_PREFIX) && n.endsWith(BACKUP_SUFFIX));
  const out: { file: string; mtimeMs: number; size: number }[] = [];
  for (const file of backups) {
    const full = path.join(CRON_DIR, file);
    try {
      const st = await fs.stat(full);
      if (st.isFile()) out.push({ file, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      // file vanished — ignore
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

async function pruneBackups(keep: number): Promise<void> {
  const all = await listBackups();
  const toDelete = all.slice(keep);
  for (const b of toDelete) {
    await fs.unlink(path.join(CRON_DIR, b.file)).catch(() => {});
  }
}

export async function listTrash(): Promise<TrashEntry[]> {
  const f = await readJobsFile();
  return f.trash ?? [];
}

// Move a job from jobs[] into trash[]. Returns the entry on success.
// Idempotent: if the job is already in trash, returns the existing entry
// without writing again.
export async function softDelete(
  jobId: string
): Promise<{ entry: TrashEntry; action: "moved" | "already_trashed" }> {
  const f = await readJobsFile();
  const idx = f.jobs.findIndex((j) => j.id === jobId);
  if (idx === -1) {
    // Maybe it's already in trash?
    const existing = (f.trash ?? []).find((e) => e.job.id === jobId);
    if (existing) return { entry: existing, action: "already_trashed" };
    throw new Error(`Job ${jobId} not found in active jobs or trash`);
  }
  const job = f.jobs[idx];
  const entry: TrashEntry = { job, deletedAtMs: Date.now() };

  f.jobs.splice(idx, 1);
  if (!Array.isArray(f.trash)) f.trash = [];
  // De-dup if somehow already there.
  f.trash = f.trash.filter((e) => e.job.id !== jobId);
  f.trash.push(entry);

  await writeWithBackup(f);
  return { entry, action: "moved" };
}

export async function restore(jobId: string): Promise<CronJobRaw> {
  const f = withTrash(await readJobsFile());
  const trashIdx = f.trash.findIndex((e) => e.job.id === jobId);
  if (trashIdx === -1) {
    throw new Error(`Job ${jobId} is not in trash`);
  }
  const entry = f.trash[trashIdx];

  // Guard: refuse to restore if an active job with the same id already exists.
  const dupe = f.jobs.find((j) => j.id === jobId);
  if (dupe) {
    throw new Error(
      `Cannot restore: an active job with id ${jobId} already exists`
    );
  }

  f.trash.splice(trashIdx, 1);
  f.jobs.push(entry.job);
  await writeWithBackup(f);
  return entry.job;
}

export async function purge(jobId: string): Promise<void> {
  const f = withTrash(await readJobsFile());
  const before = f.trash.length;
  f.trash = f.trash.filter((e) => e.job.id !== jobId);
  if (f.trash.length === before) {
    throw new Error(`Job ${jobId} is not in trash`);
  }
  await writeWithBackup(f);
}

// Read a specific backup file (or the newest one if no filename given) and
// return the parsed JobsFile. Does NOT swap it into jobs.json — caller decides.
export async function readBackup(file?: string): Promise<{ file: string; jobsFile: JobsFile }> {
  let target: string;
  if (file) {
    // Defend against path traversal: must be a plain basename with the prefix/suffix.
    if (file.includes("/") || file.includes("..")) {
      throw new Error("Invalid backup filename");
    }
    if (!file.startsWith(BACKUP_PREFIX) || !file.endsWith(BACKUP_SUFFIX)) {
      throw new Error("Backup filename must match jobs.json.*.bak pattern");
    }
    target = file;
  } else {
    const all = await listBackups();
    if (all.length === 0) throw new Error("No backups available");
    target = all[0].file;
  }
  const full = path.join(CRON_DIR, target);
  const raw = await fs.readFile(full, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.jobs)) {
    throw new Error(`Backup ${target} does not look like a valid jobs.json`);
  }
  if (!Array.isArray(parsed.trash)) parsed.trash = [];
  return { file: target, jobsFile: parsed as JobsFile };
}

// Swap a chosen backup into jobs.json. Backup is preserved (not consumed).
// Caller should refresh the dashboard after this returns.
export async function restoreFromBackup(file: string): Promise<{ restored: string }> {
  const { file: used } = await readBackup(file);
  // Validate it can survive another round of validation by going through the
  // same write path (touches the backup-rotation logic too).
  const content = await fs.readFile(path.join(CRON_DIR, used), "utf8");
  const parsed = JSON.parse(content);
  await writeWithBackup(parsed);
  return { restored: used };
}

// Convenience: legacy single-file recovery. Returns the backup filename used.
export async function recoverFromBackup(): Promise<string | null> {
  try {
    const { file } = await readBackup();
    await restoreFromBackup(file);
    return file;
  } catch (err: any) {
    if (/No backups available/.test(err.message)) return null;
    throw err;
  }
}
