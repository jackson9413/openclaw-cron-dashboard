// app/api/cron/route.ts — list jobs + recent runs
import { NextResponse } from "next/server";
import { readAllJobsWithRuns, isStale } from "@/lib/cron";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const jobs = await readAllJobsWithRuns(10);
    const annotated = jobs.map((job) => ({
      ...job,
      staleness: isStale(job, 24),
    }));
    return NextResponse.json({ jobs: annotated, fetchedAt: Date.now() });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Failed to read cron state" },
      { status: 500 }
    );
  }
}
