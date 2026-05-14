import { NextRequest, NextResponse } from "next/server";

const AGENT_URL = process.env.AGENT_API_URL ?? "http://localhost:8000";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const upstream = await fetch(`${AGENT_URL}/jobs/${id}`);
    if (!upstream.ok) {
      return NextResponse.json({ error: "Job not found" }, { status: upstream.status });
    }
    const data = await upstream.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Agent service unavailable" }, { status: 503 });
  }
}
