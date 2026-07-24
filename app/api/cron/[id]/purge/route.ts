// app/api/cron/[id]/purge/route.ts — permanently delete a job from trash
import { NextResponse } from "next/server";
import { purge } from "@/lib/jobsStore";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing job id" }, { status: 400 });
  try {
    await purge(id);
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Failed to purge job" },
      { status: 500 }
    );
  }
}
