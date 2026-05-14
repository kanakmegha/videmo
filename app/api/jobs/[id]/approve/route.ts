import { NextResponse } from "next/server";

// Approval is implicit: connecting to /execute-stream triggers execution.
// This stub exists for backwards compatibility.
export async function POST() {
  return NextResponse.json({ ok: true });
}
