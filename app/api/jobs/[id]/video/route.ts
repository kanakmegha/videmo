import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
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
  if (job.video_url.startsWith("http")) {
    return NextResponse.redirect(job.video_url, 302);
  }
  // Local dev: serve from /tmp/demogen-videos/{id}.webm
  const localPath = join(tmpdir(), "demogen-videos", `${id}.webm`);
  try {
    const data = await readFile(localPath);
    return new Response(data, {
      headers: {
        "Content-Type": "video/webm",
        "Content-Length": String(data.byteLength),
      },
    });
  } catch {
    return NextResponse.json({ error: "Video file not found" }, { status: 404 });
  }
}
