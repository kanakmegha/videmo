import { NextRequest, NextResponse } from "next/server";
import { setUserInput } from "@/lib/redis";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { text } = await req.json();
  if (!text || typeof text !== "string") {
    return NextResponse.json({ error: "text required" }, { status: 400 });
  }
  await setUserInput(id, text.trim());
  return NextResponse.json({ ok: true });
}
