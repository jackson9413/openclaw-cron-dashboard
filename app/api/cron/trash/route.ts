// app/api/cron/trash/route.ts — list soft-deleted jobs
import { NextResponse } from "next/server";
import { listTrash } from "@/lib/jobsStore";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const trash = await listTrash();
    return NextResponse.json({ trash, fetchedAt: Date.now() });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Failed to read trash" },
      { status: 500 }
    );
  }
}
