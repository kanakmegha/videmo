"use client";

import { Download, Video } from "lucide-react";

interface Props {
  jobId: string;
}

export default function VideoPlayer({ jobId }: Props) {
  const videoUrl = `/api/jobs/${jobId}/video`;

  return (
    <div className="glass rounded-2xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <Video className="w-4 h-4 text-brand-400" />
          <span className="text-xs font-medium text-zinc-300">Demo Recording</span>
        </div>
        <a
          href={videoUrl}
          download={`demo-${jobId.slice(0, 8)}.webm`}
          className="btn-secondary text-xs px-3 py-1.5"
        >
          <Download className="w-3.5 h-3.5" />
          Download
        </a>
      </div>
      <div className="bg-black aspect-video">
        <video
          src={videoUrl}
          controls
          autoPlay
          className="w-full h-full"
          poster=""
        >
          Your browser does not support the video tag.
        </video>
      </div>
    </div>
  );
}
