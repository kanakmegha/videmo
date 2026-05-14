import { NextRequest, NextResponse } from "next/server";

const AGENT_URL = process.env.AGENT_API_URL ?? "http://localhost:8000";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const upstream = await fetch(`${AGENT_URL}/jobs/${id}/approve`, { method: "POST" });
    if (!upstream.ok) {
      return NextResponse.json({ error: "Could not approve job" }, { status: upstream.status });
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Agent service unavailable" }, { status: 503 });
  }
}
