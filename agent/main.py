import asyncio
import json
import uuid
from pathlib import Path
from typing import Dict, Any, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse
from pydantic import BaseModel, field_validator
from dotenv import load_dotenv

load_dotenv()

from agent_core import DemoAgent

app = FastAPI(title="DemoGen Agent API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory job registry — swap for Redis in production
jobs: Dict[str, Dict[str, Any]] = {}


class CreateJobRequest(BaseModel):
    url: str

    @field_validator("url")
    @classmethod
    def normalise_url(cls, v: str) -> str:
        v = v.strip()
        if not v.startswith(("http://", "https://")):
            v = "https://" + v
        return v


@app.post("/jobs", status_code=201)
async def create_job(body: CreateJobRequest):
    job_id = str(uuid.uuid4())
    events: list = []

    async def emit(event_type: str, data: dict):
        events.append({"type": event_type, "data": data})
        # Surface terminal status changes
        if event_type in ("complete", "error"):
            jobs[job_id]["status"] = "error" if event_type == "error" else "complete"

    agent = DemoAgent(job_id, body.url, emit)

    task = asyncio.create_task(agent.run())

    jobs[job_id] = {
        "id": job_id,
        "url": body.url,
        "status": "running",
        "agent": agent,
        "events": events,
        "task": task,
    }

    return {"job_id": job_id, "url": body.url}


@app.get("/jobs/{job_id}")
async def get_job(job_id: str):
    job = _get_or_404(job_id)
    return {
        "id": job_id,
        "url": job["url"],
        "status": job["status"],
        "event_count": len(job["events"]),
        "video_ready": bool(job["agent"].get_video_path()),
    }


@app.get("/jobs/{job_id}/stream")
async def stream_job(job_id: str):
    job = _get_or_404(job_id)

    async def generate():
        idx = 0
        while True:
            events = job["events"]
            while idx < len(events):
                ev = events[idx]
                payload = f"event: {ev['type']}\ndata: {json.dumps(ev['data'])}\n\n"
                yield payload
                idx += 1
                if ev["type"] in ("complete", "error"):
                    return
            if job["status"] in ("complete", "error"):
                break
            await asyncio.sleep(0.25)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/jobs/{job_id}/approve")
async def approve_job(job_id: str):
    job = _get_or_404(job_id)
    job["agent"].approved.set()
    return {"ok": True}


@app.get("/jobs/{job_id}/video")
async def get_video(job_id: str):
    job = _get_or_404(job_id)
    path = job["agent"].get_video_path()
    if not path or not Path(path).exists():
        raise HTTPException(status_code=404, detail="Video not ready yet.")
    return FileResponse(path, media_type="video/webm", filename=f"demo-{job_id[:8]}.webm")


@app.get("/health")
async def health():
    return {"status": "ok", "jobs": len(jobs)}


def _get_or_404(job_id: str) -> Dict[str, Any]:
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found.")
    return jobs[job_id]


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
