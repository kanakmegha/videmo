import { Redis } from "@upstash/redis";
import type { PlanStep } from "./types";

export type JobStatus =
  | "planning"
  | "awaiting_approval"
  | "executing"
  | "complete"
  | "error";

export interface Job {
  id: string;
  url: string;
  status: JobStatus;
  steps: PlanStep[];
  video_url: string | null;
  error: string | null;
  created_at: number;
}

// Lazily initialise so the module can be imported even without env vars
let _redis: Redis | null = null;
function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  }
  return _redis;
}

const TTL = 60 * 60 * 24; // 24 hours

export async function createJob(id: string, url: string): Promise<Job> {
  const job: Job = {
    id,
    url,
    status: "planning",
    steps: [],
    video_url: null,
    error: null,
    created_at: Date.now(),
  };
  await getRedis().set(`job:${id}`, JSON.stringify(job), { ex: TTL });
  return job;
}

export async function getJob(id: string): Promise<Job | null> {
  const raw = await getRedis().get<string>(`job:${id}`);
  if (!raw) return null;
  // @upstash/redis auto-parses JSON when the stored value is a JSON string
  return typeof raw === "string" ? JSON.parse(raw) : (raw as Job);
}

export async function updateJob(
  id: string,
  patch: Partial<Omit<Job, "id" | "url" | "created_at">>
): Promise<void> {
  const existing = await getJob(id);
  if (!existing) return;
  const updated: Job = { ...existing, ...patch };
  await getRedis().set(`job:${id}`, JSON.stringify(updated), { ex: TTL });
}

// ── User input (pause/resume during execution) ────────────────────────────────

export async function setUserInput(jobId: string, text: string): Promise<void> {
  await getRedis().set(`job:${jobId}:user_input`, text, { ex: 300 });
}

export async function popUserInput(jobId: string): Promise<string | null> {
  const val = await getRedis().getdel(`job:${jobId}:user_input`);
  return typeof val === "string" ? val : null;
}
