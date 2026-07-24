// app/api/cron/[id]/delete/route.ts — soft-delete (moves job to trash)
import { NextResponse } from "next/server";
import { softDelete } from "@/lib/jobsStore";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "Missing job id" }, { status: 400 });
  try {
    const result = await softDelete(id);
    return NextResponse.json({
      ok: true,
      action: result.action,
      deletedAtMs: result.entry.deletedAtMs,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Failed to delete job" },
      { status: 500 }
    );
  }
}
