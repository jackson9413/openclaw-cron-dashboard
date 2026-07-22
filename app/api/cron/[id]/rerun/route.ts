// app/api/cron/[id]/rerun/route.ts — invokes `openclaw cron run <id>` for one-shot rerun
import { NextResponse } from "next/server";
import { spawn } from "node:child_process";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "Missing job id" }, { status: 400 });
  }

  try {
    const { code, stdout, stderr } = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      const child = spawn("openclaw", ["cron", "run", id], {
        env: { ...process.env, PATH: process.env.PATH },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (err += d.toString()));
      child.on("close", (c) => resolve({ code: c, stdout: out, stderr: err }));
      child.on("error", (e) => resolve({ code: -1, stdout: out, stderr: err + "\n" + e.message }));
      // Safety: kill if it hangs (cron jobs can be long; we cap at 60s here, the cron itself has its own timeout)
      setTimeout(() => child.kill(), 60_000);
    });

    return NextResponse.json({
      ok: code === 0,
      exitCode: code,
      stdout,
      stderr,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Failed to invoke openclaw" },
      { status: 500 }
    );
  }
}
