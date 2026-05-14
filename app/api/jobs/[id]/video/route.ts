import { NextRequest } from "next/server";

const AGENT_URL = process.env.AGENT_API_URL ?? "http://localhost:8000";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const upstream = await fetch(`${AGENT_URL}/jobs/${id}/video`);
    if (!upstream.ok) {
      return new Response("Video not ready", { status: 404 });
    }
    return new Response(upstream.body, {
      headers: {
        "Content-Type": "video/webm",
        "Content-Disposition": `attachment; filename="demo-${id.slice(0, 8)}.webm"`,
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return new Response("Agent service unavailable", { status: 503 });
  }
}
