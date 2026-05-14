import os
import asyncio
import base64
import re
import json
import tempfile
from pathlib import Path
from typing import Callable, List, Dict, Any, Optional
from urllib.parse import urlparse

from playwright.async_api import async_playwright, Page, BrowserContext
from openai import AsyncOpenAI

try:
    from playwright_stealth import Stealth
    async def _apply_stealth(target):
        await Stealth().apply_stealth_async(target)
except ImportError:
    async def _apply_stealth(target):
        pass

HF_TOKEN = os.getenv("HF_TOKEN", "")

ROUTER_CLIENT = AsyncOpenAI(
    base_url="https://router.huggingface.co/v1",
    api_key=HF_TOKEN or "placeholder",
    default_headers={"x-wait-for-model": "true", "x-use-cache": "false"},
)

VISION_MODELS = [
    "meta-llama/Llama-3.2-11B-Vision-Instruct",
    "meta-llama/Llama-3.2-90B-Vision-Instruct",
    "google/gemma-3-27b-it",
    "Qwen/Qwen2-VL-7B-Instruct",
]

DOM_EXTRACT_JS = """
(() => {
    const items = [];
    const seen = new Set();
    const els = document.querySelectorAll(
        'button, a[href], input, textarea, [role="button"], [role="textbox"], [role="link"]'
    );
    els.forEach((el, i) => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;
        const name = (
            el.innerText ||
            el.value ||
            el.placeholder ||
            el.getAttribute('aria-label') ||
            el.title ||
            el.getAttribute('alt') ||
            ''
        ).trim().substring(0, 80);
        if (!name || seen.has(name)) return;
        seen.add(name);
        items.push({
            id: `el-${i}`,
            name,
            role: el.getAttribute('role') || el.tagName.toLowerCase(),
            aria_label: el.getAttribute('aria-label') || '',
            placeholder: el.placeholder || '',
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
        });
        if (items.length >= 60) return;
    });
    return items;
})()
"""


class SiteMap:
    def __init__(self):
        self.pages: Dict[str, dict] = {}

    def add_page(self, url: str, title: str, elements: List[dict]):
        self.pages[url] = {
            "url": url,
            "title": title,
            "purpose": "",
            "demo_value": 0,
            "interactive_elements": elements,
        }

    def top_pages(self, n: int = 5) -> List[str]:
        ranked = sorted(self.pages.values(), key=lambda p: p["demo_value"], reverse=True)
        return [p["url"] for p in ranked[:n] if p["demo_value"] > 0]


class DemoAgent:
    def __init__(self, job_id: str, url: str, emit: Callable):
        self.job_id = job_id
        self.url = url.rstrip("/")
        self.emit = emit
        self.sitemap = SiteMap()
        self.director_script: List[dict] = []
        self.approved = asyncio.Event()
        self._work_dir = Path(tempfile.mkdtemp(prefix=f"demo_{job_id[:8]}_"))
        self._video_path: Optional[str] = None

    async def _emit(self, event_type: str, data: dict):
        try:
            await self.emit(event_type, data)
        except Exception:
            pass

    def get_video_path(self) -> Optional[str]:
        return self._video_path

    # ── Main orchestration ────────────────────────────────────────────────────

    async def run(self):
        browser_ctx = None
        try:
            async with async_playwright() as p:
                video_dir = self._work_dir / "video"
                video_dir.mkdir(parents=True, exist_ok=True)
                profile_dir = self._work_dir / "profile"
                profile_dir.mkdir(parents=True, exist_ok=True)

                browser_ctx = await p.chromium.launch_persistent_context(
                    user_data_dir=str(profile_dir),
                    headless=True,
                    args=[
                        "--no-sandbox",
                        "--disable-setuid-sandbox",
                        "--disable-dev-shm-usage",
                        "--disable-blink-features=AutomationControlled",
                        "--disable-infobars",
                        "--window-size=1280,800",
                    ],
                    ignore_default_args=["--enable-automation"],
                    user_agent=(
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/122.0.0.0 Safari/537.36"
                    ),
                    record_video_dir=str(video_dir),
                    viewport={"width": 1280, "height": 800},
                )

                page = browser_ctx.pages[0] if browser_ctx.pages else await browser_ctx.new_page()
                await _apply_stealth(page)
                browser_ctx.on("page", lambda pg: asyncio.create_task(_apply_stealth(pg)))

                await self._emit("phase", {"phase": "discover", "message": "Crawling website…"})
                await self._discover(page)

                await self._emit("phase", {"phase": "strategize", "message": "Analysing pages…"})
                await self._strategize(page)

                await self._emit("phase", {"phase": "plan", "message": "Creating demo plan…"})
                await self._plan()
                await self._emit("plan_ready", {"steps": self.director_script})

                await self._emit("awaiting_approval", {
                    "message": "Review your demo plan and click Execute to start recording."
                })
                await asyncio.wait_for(self.approved.wait(), timeout=300)

                await self._emit("phase", {"phase": "execute", "message": "Recording demo…"})
                await self._execute(page)

                # Finalise video
                try:
                    vpath = await page.video.path()
                    await page.close()
                    await browser_ctx.close()
                    browser_ctx = None
                    self._video_path = str(vpath)
                    await self._emit("complete", {"video_path": self._video_path})
                except Exception as e:
                    await self._emit("complete", {"video_path": None, "error": str(e)})

        except asyncio.TimeoutError:
            await self._emit("error", {"message": "Timed out waiting for user approval (5 min limit)."})
        except Exception as e:
            import traceback
            await self._emit("error", {"message": str(e), "trace": traceback.format_exc()})
        finally:
            if browser_ctx:
                try:
                    await browser_ctx.close()
                except Exception:
                    pass

    # ── Phases ────────────────────────────────────────────────────────────────

    async def _discover(self, page: Page):
        parsed = urlparse(self.url)
        origin = f"{parsed.scheme}://{parsed.netloc}"

        queue: List[tuple[str, int]] = [(self.url, 0)]
        visited: set[str] = {self.url}

        while queue:
            url, depth = queue.pop(0)
            if depth > 1:
                continue
            try:
                await self._emit("discovering_page", {"url": url, "depth": depth})
                await page.goto(url, wait_until="domcontentloaded", timeout=20_000)
                await asyncio.sleep(1.5)

                elements = await self._extract_elements(page)
                title = await page.title()
                self.sitemap.add_page(url, title, elements)
                await self._emit("page_found", {"url": url, "title": title, "element_count": len(elements)})

                if depth < 1:
                    hrefs = await page.eval_on_selector_all(
                        "a[href]", "els => els.map(el => el.getAttribute('href'))"
                    )
                    for href in hrefs:
                        if not href:
                            continue
                        if href.startswith("/"):
                            full = f"{origin}{href}"
                        elif href.startswith(origin):
                            full = href
                        else:
                            continue
                        full = full.split("?")[0].split("#")[0].rstrip("/") or full
                        if full not in visited and len(visited) < 10:
                            visited.add(full)
                            queue.append((full, depth + 1))
            except Exception as e:
                await self._emit("discover_error", {"url": url, "error": str(e)})

    async def _strategize(self, page: Page):
        for url, info in self.sitemap.pages.items():
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=15_000)
                await asyncio.sleep(1)
                screenshot = await page.screenshot(type="jpeg", quality=55)
                b64 = base64.b64encode(screenshot).decode()

                prompt = (
                    f"Analyse this webpage: {url}\nTitle: {info['title']}\n\n"
                    "1. What is the core purpose of this page in one sentence?\n"
                    "2. Rate its Demo Value 1-10 (AI/dashboard=10, legal/error=1).\n"
                    "Respond ONLY in this format: Purpose: [text] | Value: [number]"
                )
                response = await self._ask_llm(prompt, b64)
                match = re.search(r"Purpose:\s*(.+?)\s*\|\s*Value:\s*(\d+)", response)
                if match:
                    purpose = match.group(1).strip()
                    value = min(10, int(match.group(2)))
                    has_input = any(
                        el.get("role") in ("input", "textarea", "textbox")
                        or el.get("placeholder")
                        for el in info.get("interactive_elements", [])
                    )
                    if has_input:
                        value = min(10, value + 2)
                    info["purpose"] = purpose
                    info["demo_value"] = value
                    await self._emit("page_scored", {"url": url, "purpose": purpose, "value": value})
            except Exception as e:
                await self._emit("score_error", {"url": url, "error": str(e)})

    async def _plan(self):
        context_str = "Discovered Pages:\n" + "\n".join(
            f"  - {url}: {p.get('purpose') or 'Unknown'} (value={p.get('demo_value', 0)}/10)"
            for url, p in self.sitemap.pages.items()
        )
        start_elements = self.sitemap.pages.get(self.url, {}).get("interactive_elements", [])[:30]

        prompt = (
            "You are a Senior Product Demo Director. Output a compelling demo script.\n\n"
            f"{context_str}\n\n"
            f"Start URL: {self.url}\n"
            f"Landing page elements:\n{json.dumps(start_elements, indent=2)}\n\n"
            "RULES:\n"
            "1. Step 1 must be navigate to the start URL.\n"
            "2. Identify and TYPE into the main hero input (AI prompt, search, or signup).\n"
            "   Use this demo value: 'Build a modern SaaS dashboard with dark theme'\n"
            "3. Add a wait step after typing (AI generation takes time).\n"
            "4. Scroll to reveal the full output.\n"
            "5. Navigate to the highest-value secondary page (pricing or features).\n"
            "6. 5–8 steps total.\n\n"
            "OUTPUT: A raw JSON array, no markdown fences:\n"
            '[{"action":"navigate|click|type|scroll|wait","url":"...","aria_name":"...","value":"...","reasoning":"..."}]'
        )

        try:
            response = await self._ask_llm(prompt)
            arr_match = re.search(r"\[.*\]", response, re.DOTALL)
            if not arr_match:
                raise ValueError("No JSON array in LLM response")
            self.director_script = json.loads(arr_match.group(0))
        except Exception as e:
            await self._emit("plan_fallback", {"error": str(e)})
            self.director_script = [
                {"action": "navigate", "url": self.url, "reasoning": "Open the website"},
                {"action": "scroll", "value": "600", "reasoning": "Show landing page features"},
                {"action": "scroll", "value": "1200", "reasoning": "Explore more of the page"},
            ]

    async def _execute(self, page: Page):
        for i, action in enumerate(self.director_script):
            await self._emit("step_start", {
                "index": i,
                "total": len(self.director_script),
                "action": action.get("action", ""),
                "reasoning": action.get("reasoning", ""),
                "aria_name": action.get("aria_name", ""),
                "value": action.get("value", ""),
            })
            success = await self._perform_action(page, action)
            await self._emit("step_complete", {"index": i, "success": success})
            await asyncio.sleep(1.2)

    # ── Helpers ───────────────────────────────────────────────────────────────

    async def _perform_action(self, page: Page, action: dict) -> bool:
        atype = action.get("action", "")
        name = action.get("aria_name", "")
        value = action.get("value", "")

        try:
            if atype == "navigate":
                target = action.get("url") or self.url
                await page.goto(target, wait_until="domcontentloaded", timeout=20_000)
                await asyncio.sleep(2)

            elif atype == "click":
                if not name:
                    return False
                loc = page.get_by_role("button", name=re.compile(re.escape(name), re.I)).first
                if not await loc.count():
                    loc = page.get_by_text(name, exact=False).first
                if await loc.count():
                    await loc.scroll_into_view_if_needed()
                    await loc.hover()
                    await asyncio.sleep(0.3)
                    await loc.click(timeout=5_000)
                    await asyncio.sleep(1.5)

            elif atype == "type":
                candidates = []
                if name:
                    candidates = [
                        page.get_by_placeholder(re.compile(re.escape(name), re.I)).first,
                        page.get_by_label(re.compile(re.escape(name), re.I)).first,
                    ]
                candidates.append(page.get_by_role("textbox").first)
                candidates.append(page.locator("textarea").first)

                for loc in candidates:
                    try:
                        if await loc.count() and await loc.is_visible():
                            await loc.scroll_into_view_if_needed()
                            await loc.hover()
                            await asyncio.sleep(0.2)
                            text = value or "Build a modern SaaS dashboard with dark theme"
                            await loc.fill(text)
                            await asyncio.sleep(0.4)
                            await loc.press("Enter")
                            await asyncio.sleep(4)
                            break
                    except Exception:
                        continue

            elif atype == "scroll":
                amount = int(value) if str(value).lstrip("-").isdigit() else 700
                await page.mouse.wheel(0, amount)
                await asyncio.sleep(1)

            elif atype == "wait":
                duration = min(int(value) if str(value).isdigit() else 3, 10)
                await asyncio.sleep(duration)

            return True
        except Exception:
            return False

    async def _extract_elements(self, page: Page) -> List[dict]:
        try:
            result = await page.evaluate(DOM_EXTRACT_JS)
            return result if isinstance(result, list) else []
        except Exception:
            return []

    async def _ask_llm(self, prompt: str, b64_img: Optional[str] = None) -> str:
        content: List[dict] = [{"type": "text", "text": prompt}]
        if b64_img:
            content.append({
                "type": "image_url",
                "image_url": {"url": f"data:image/jpeg;base64,{b64_img}"},
            })
        messages = [{"role": "user", "content": content}]

        for model in VISION_MODELS:
            try:
                resp = await ROUTER_CLIENT.chat.completions.create(
                    model=model, messages=messages, max_tokens=900
                )
                return resp.choices[0].message.content or ""
            except Exception:
                continue
        return ""
