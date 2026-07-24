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
//   1. Copies the current file to jobs.json.bak (overwrites prior backup)
//   2. Validates the new shape (must have version + at least one of jobs/trash)
//   3. Writes atomically via tmp + rename so a mid-write crash can't corrupt
//
// Calling code does NOT need to also `openclaw cron rm` for soft-delete — only
// for true `purge()` (hard delete).

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const CRON_DIR = path.join(os.homedir(), ".openclaw", "cron");
const JOBS_FILE = path.join(CRON_DIR, "jobs.json");
const BACKUP_FILE = path.join(CRON_DIR, "jobs.json.bak");

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

// Atomic write with a one-step backup. Re-validates before writing.
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

  // 1) Backup the existing file (best-effort).
  try {
    await fs.copyFile(JOBS_FILE, BACKUP_FILE);
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
    // No prior file — skip backup. Nothing to preserve.
  }

  // 2) Write atomically: tmp file, then rename over the original.
  const tmp = `${JOBS_FILE}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await fs.rename(tmp, JOBS_FILE);
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

// Best-effort restore from the .bak file. Returns true if recovery happened.
export async function recoverFromBackup(): Promise<boolean> {
  try {
    const raw = await fs.readFile(BACKUP_FILE, "utf8");
    JSON.parse(raw); // validate before swapping
    await fs.copyFile(BACKUP_FILE, JOBS_FILE);
    return true;
  } catch (err: any) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}
