import { NextRequest } from "next/server";

const AGENT_URL = process.env.AGENT_API_URL ?? "http://localhost:8000";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const upstream = await fetch(`${AGENT_URL}/jobs/${id}/stream`, {
      headers: { Accept: "text/event-stream", "Cache-Control": "no-cache" },
      // @ts-expect-error — Node.js fetch supports duplex
      duplex: "half",
    });

    if (!upstream.ok) {
      return new Response(`event: error\ndata: {"message":"Job not found"}\n\n`, {
        status: 404,
        headers: { "Content-Type": "text/event-stream" },
      });
    }

    return new Response(upstream.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch {
    return new Response(`event: error\ndata: {"message":"Agent service unavailable"}\n\n`, {
      status: 503,
      headers: { "Content-Type": "text/event-stream" },
    });
  }
}
