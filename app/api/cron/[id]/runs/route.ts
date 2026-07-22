// app/api/cron/[id]/runs/route.ts — full history for one job
import { NextResponse } from "next/server";
import { readRunsForJob } from "@/lib/cron";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const runs = await readRunsForJob(id, 100);
    return NextResponse.json({ jobId: id, runs, fetchedAt: Date.now() });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Failed to read runs" },
      { status: 500 }
    );
  }
}
