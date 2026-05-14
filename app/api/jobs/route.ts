import { NextRequest, NextResponse } from "next/server";
import { createJob } from "@/lib/redis";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    let url: string = (body.url ?? "").trim();
    if (!url) return NextResponse.json({ error: "url is required" }, { status: 400 });
    if (!url.startsWith("http://") && !url.startsWith("https://")) url = `https://${url}`;

    const { randomUUID } = await import("crypto");
    const id = randomUUID();
    await createJob(id, url);

    return NextResponse.json({ job_id: id, url }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create job" },
      { status: 500 }
    );
  }
}
