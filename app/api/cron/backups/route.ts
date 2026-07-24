// app/api/cron/backups/route.ts — list / preview / restore timestamped backups
import { NextResponse } from "next/server";
import { listBackups, readBackup, restoreFromBackup } from "@/lib/jobsStore";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const file = url.searchParams.get("file");
    if (file) {
      // Preview: return the parsed jobs file (no write).
      const { file: used, jobsFile } = await readBackup(file);
      return NextResponse.json({
        file: used,
        version: jobsFile.version,
        jobCount: jobsFile.jobs.length,
        trashCount: (jobsFile.trash ?? []).length,
        jobs: jobsFile.jobs,
        trash: jobsFile.trash,
      });
    }
    const backups = await listBackups();
    return NextResponse.json({ backups, retention: Number(process.env.BACKUP_RETENTION ?? 30) });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Backup listing failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { file?: string; action?: string };
    if (body.action === "restore" && body.file) {
      const result = await restoreFromBackup(body.file);
      return NextResponse.json({ ok: true, ...result });
    }
    return NextResponse.json({ error: "Unknown action. POST {\"action\":\"restore\",\"file\":\"<name>\"}" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Restore failed" }, { status: 500 });
  }
}
