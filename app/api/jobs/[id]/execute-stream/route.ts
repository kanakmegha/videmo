import { NextRequest } from "next/server";
import { getJob, updateJob } from "@/lib/redis";
import { DemoAgent } from "@/lib/agent";

export const dynamic = "force-dynamic";
export const maxDuration = 180; // 3 min — Vercel Fluid Compute

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const job = await getJob(id);
  if (!job) {
    return new Response("Job not found", { status: 404 });
  }
  if (!job.steps?.length) {
    return new Response("No plan found — run plan-stream first", { status: 400 });
  }

  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (type: string, data: Record<string, unknown>) => {
        controller.enqueue(
          enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      };

      try {
        await updateJob(id, { status: "executing" });

        const agent = new DemoAgent(id, job.url, async (type, data) => {
          send(type, data);
        });

        const videoUrl = await agent.executePhase(job.steps);

        await updateJob(id, {
          status: "complete",
          video_url: videoUrl,
        });
        send("complete", { video_url: videoUrl });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        send("error", { message: msg });
        await updateJob(id, { status: "error", error: msg });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}
