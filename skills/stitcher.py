import os
import sys
import shutil
from pathlib import Path
from PIL import Image, ImageSequence, ImageDraw
import moviepy as mp

# Set up BRAIN_DIR
BRAIN_DIR = Path(os.getenv("ANTIGRAVITY_BRAIN", "/Users/skanakmegha/.gemini/antigravity/brain/a9e5aec4-dc3e-4abe-8dfa-62c490efa781"))

def get_overlay_text(file_name):
    """Determine overlay text based on the interaction step in the filename."""
    if "step_1" in file_name: return "[System] Booting Agent... Analyzing Layout"
    if "step_2" in file_name: return "[Reasoning] Granting Permissions..."
    if "step_3" in file_name: return "[Alert] UI Change Delayed. Re-analyzing..."
    if "step_4" in file_name: return "[Success] Arena Interaction Live."
    return "[Agent] Processing..."

def stitch_videos(output_filename="final_demo.mp4"):
    print(f"Searching for recordings in {BRAIN_DIR}...")
    files = sorted(list(BRAIN_DIR.glob("interaction_step_*.webp")))
    if not files:
        print("No interaction clips found to stitch.")
        return

    print(f"Found {len(files)} clips. Processing with Cinematic Overlays...")
    clips = []
    
    tmp_dir = Path("./tmp_frames")
    if tmp_dir.exists():
        shutil.rmtree(tmp_dir)
    tmp_dir.mkdir(exist_ok=True)
    
    for f in files:
        print(f"Loading frames from {f.name}...")
        img = Image.open(f)
        frames = []
        overlay_text = get_overlay_text(f.name)
        
        for i, frame in enumerate(ImageSequence.Iterator(img)):
            res = frame.convert("RGB")
            draw = ImageDraw.Draw(res)
            # Black bar overlay
            bar_height = 40
            draw.rectangle([0, res.height - bar_height, res.width, res.height], fill="#000000")
            draw.text((20, res.height - 30), overlay_text, fill="#00FF00")
            
            p = tmp_dir / f"frame_{f.stem}_{i}.png"
            res.save(p)
            frames.append(str(p))
            
        if frames:
            # Using ImageSequenceClip from the main moviepy module in v2.x
            clips.append(mp.ImageSequenceClip(frames, fps=25))

    if not clips:
        print("No valid clips to stitch.")
        return

    print(f"Concatenating {len(clips)} clips...")
    final_clip = mp.concatenate_videoclips(clips, method="compose")
    
    print(f"Writing final video to {output_filename}...")
    final_clip.write_videofile(output_filename, codec="libx264")
    
    # Cleanup
    shutil.rmtree(tmp_dir)
    print("Synthesis complete.")

if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "final_demo.mp4"
    stitch_videos(out)
