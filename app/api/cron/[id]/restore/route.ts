// app/api/cron/[id]/restore/route.ts — restore a job from trash
import { NextResponse } from "next/server";
import { restore } from "@/lib/jobsStore";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing job id" }, { status: 400 });
  try {
    const job = await restore(id);
    return NextResponse.json({ ok: true, job });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Failed to restore job" },
      { status: 500 }
    );
  }
}
