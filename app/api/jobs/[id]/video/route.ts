import { NextRequest, NextResponse } from "next/server";
import { getJob } from "@/lib/redis";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const job = await getJob(id);
  if (!job?.video_url) {
    return NextResponse.json({ error: "Video not ready" }, { status: 404 });
  }
  // Redirect directly to the Vercel Blob CDN URL
  return NextResponse.redirect(job.video_url, 302);
}
