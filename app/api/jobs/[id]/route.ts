import { NextRequest, NextResponse } from "next/server";
import { getJob } from "@/lib/redis";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const job = await getJob(id);
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({
    id: job.id,
    url: job.url,
    status: job.status,
    video_url: job.video_url,
  });
}
