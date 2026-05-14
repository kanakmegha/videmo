from huggingface_hub.inference._generated.types import zero_shot_image_classification
from huggingface_hub.inference._generated.types import zero_shot_image_classification
from huggingface_hub.inference._generated.types import zero_shot_image_classification
import os
import asyncio
import base64
import re
import datetime
import json
import shutil
import subprocess
import hashlib
import tempfile
from pathlib import Path
from playwright.async_api import async_playwright, Page, BrowserContext
from typing import Optional, List, Set, Dict, Any, TypedDict
from openai import OpenAI
from playwright_stealth import Stealth
import sqlite3
import shutil

def steal_chrome_cookies(self, domain_filter: str = None) -> list:
    """Copy login cookies from your real Chrome into Playwright."""
    chrome_cookies_path = Path.home() / "Library/Application Support/Google/Chrome/Default/Cookies"
    
    if not chrome_cookies_path.exists():
        print("[Auth] Chrome cookies not found.")
        return []

    # Copy DB (Chrome locks it while open)
    tmp = Path(tempfile.mktemp(suffix=".db"))
    shutil.copy2(chrome_cookies_path, tmp)
    
    cookies = []
    try:
        conn = sqlite3.connect(tmp)
        cursor = conn.cursor()
        cursor.execute("""
            SELECT host_key, name, value, path, 
                   expires_utc, is_secure, is_httponly
            FROM cookies
            WHERE host_key LIKE ?
        """, (f"%{domain_filter}%" if domain_filter else "%",))
        
        for row in cursor.fetchall():
            cookies.append({
                "name": row[1],
                "value": row[2],
                "domain": row[0],
                "path": row[3],
                "secure": bool(row[5]),
                "httpOnly": bool(row[6]),
                "sameSite": "Lax"
            })
        conn.close()
    except Exception as e:
        print(f"[Auth] Cookie read failed: {e}")
    finally:
        tmp.unlink(missing_ok=True)
    
    print(f"[Auth] Stolen {len(cookies)} cookies from Chrome.")
    return cookies
async def stealth(page_or_context):
    """Bridge for playwright-stealth v2.0.3+ to support await stealth(page)"""
    await Stealth().apply_stealth_async(page_or_context)

# --- CONFIG & HEURISTICS ---
HF_TOKEN = os.getenv("HF_TOKEN")
if not HF_TOKEN:
    try:
        from dotenv import load_dotenv
        load_dotenv()
        HF_TOKEN = os.getenv("HF_TOKEN")
    except ImportError:
        pass

if not HF_TOKEN:
    raise EnvironmentError("HF_TOKEN environment variable not set.")

ROUTER_CLIENT = OpenAI(
    base_url="https://router.huggingface.co/v1",
    api_key=HF_TOKEN,
    default_headers={"x-wait-for-model": "true", "x-use-cache": "false"}
)

VISION_MODELS = [
    "meta-llama/Llama-3.2-11B-Vision-Instruct",
    "meta-llama/Llama-3.2-90B-Vision-Instruct",
    "google/gemma-3-27b-it",
    "Qwen/Qwen2-VL-7B-Instruct"
]

BRAIN_DIR = Path("/Users/skanakmegha/.gemini/antigravity/brain/2498d2b1-393a-405e-bca7-c5387220e0f1")
REC_DIR = Path("./recordings")
REC_DIR.mkdir(exist_ok=True)

class PageInfo(TypedDict):
    url: str
    title: str
    purpose: str
    demo_value: int # 1-10
    interactive_elements: List[dict]

class SiteMap:
    def __init__(self):
        self.pages: Dict[str, PageInfo] = {}
        self.global_features: List[str] = []
        self.scout_log: List[Dict[str, str]] = [] # DiscoveryLog

    def add_scout_entry(self, url: str, summary: str, thumbnail: str):
        self.scout_log.append({
            "url": url,
            "summary": summary,
            "thumbnail": thumbnail
        })

    def add_page(self, url: str, title: str, elements: List[dict]):
        self.pages[url] = {
            "url": url,
            "title": title,
            "purpose": "Pending Analysis",
            "demo_value": 0,
            "interactive_elements": elements
        }

    def get_highest_value_pages(self) -> List[str]:
        sorted_pages = sorted(self.pages.values(), key=lambda x: x["demo_value"], reverse=True)
        return [p["url"] for p in sorted_pages if p["demo_value"] > 0]

class StateEngine:
    def __init__(self, start_url: str, persistent: bool = True, profile_path: str = None):
        self.start_url = start_url
        self.persistent = persistent
        self.profile_path = profile_path
        
        # Use a stable local directory by default to remember logins
        # FORCE PRIMARY CHROME PROFILE: Targeting root system Chrome path
        self.session_data_dir = str(Path.home() / "Library/Application Support/Google/Chrome")
        
        if not self.persistent:
            self.session_data_dir = tempfile.mkdtemp(prefix="antigravity_volatile_")
            print(f"[StateEngine] Using VOLATILE session (will be deleted): {self.session_data_dir}")
        else:
            Path(self.session_data_dir).mkdir(exist_ok=True)
            print(f"[StateEngine] Using PERSISTENT session (remembers logins): {self.session_data_dir}")

        self.sitemap = SiteMap()
        self.session = {
            "browser": None,
            "ctx": None,
            "pg": None,
            "step": 0,
            "director_script": [],
            "current_node": "PRE_AUTH"
        }
    def steal_chrome_cookies(self, domain_filter: str = None) -> list:
        """
        Instead of decrypting cookies (complex on macOS),
        copy Chrome's entire Default profile so Playwright 
        inherits the full authenticated session.
        """
        chrome_default = Path.home() / "Library/Application Support/Google/Chrome/Default"
        antigravity_default = Path(self.session_data_dir) / "Default"
    
        if not chrome_default.exists():
            print("[Auth] Chrome Default profile not found.")
            return []
    
    # Items to copy that carry session/login state
        items_to_copy = [
        "Cookies",
        "Local Storage",
        "Session Storage", 
        "IndexedDB",
        "Login Data",
        "Web Data",
        "Preferences"
    ]
    
        antigravity_default.mkdir(parents=True, exist_ok=True)
    
        for item in items_to_copy:
            src = chrome_default / item
            dst = antigravity_default / item
            if src.exists():
                try:
                    if src.is_dir():
                        if dst.exists():
                            shutil.rmtree(dst)
                        shutil.copytree(src, dst)
                    else:
                        shutil.copy2(src, dst)
                        print(f"[Auth] Copied: {item}")
                except Exception as e:
                    print(f"[Auth] Skipped {item}: {e}")
    
        print("[Auth] Full Chrome session copied → should be auto-logged in.")
        return []  # No need to inject cookies manually, they're already in the profile
    async def spawn_browser(self, p, record: bool = False):
        print("[StateEngine] Connecting to your existing Chrome via CDP...")
    
        try:
            # Connect directly to YOUR running Chrome
            browser = await p.chromium.connect_over_cdp("http://localhost:9222")
        
            # Use the existing context (your real logged-in session)
            if browser.contexts:
                self.session["ctx"] = browser.contexts[0]
            else:
                self.session["ctx"] = await browser.new_context()
        
            # Use existing page or open new one
            pages = self.session["ctx"].pages
            if pages:
                self.session["pg"] = pages[0]
            else:
                self.session["pg"] = await self.session["ctx"].new_page()
        
            await stealth(self.session["pg"])
            self.session["ctx"].on("page", lambda pg: asyncio.create_task(self.setup_popup(pg)))
        
            print(f"[StateEngine] Connected! Navigating to {self.start_url}...")
            await self.session["pg"].goto(self.start_url, wait_until="domcontentloaded", timeout=30000)
            return self.session["pg"]
        
        except Exception as e:
            print(f"[StateEngine] CDP connection failed: {e}")
            print("Make sure Chrome is running with: --remote-debugging-port=9222")
            raise
    async def setup_popup(self, p):
        """Configure popups with stealth and auto-login logic."""
        try:
            await stealth(p)
            await p.wait_for_load_state("load")
            print("[Actor] OAuth Popup Detected. Handling Account Picker...")
            # Automatically click the first available account or a specific email
            account = p.locator("[data-authuser]").first or p.get_by_text("@gmail.com").first
            if await account.is_visible():
                print(f"[Actor] Clicking account: {await account.inner_text()}")
                await account.click()
        except: pass

    async def node_pre_auth(self) -> str:
        """Stage: PRE-FLIGHT AUTH. Polling for manual login completion."""
        print("\n>>> Stage: PRE-FLIGHT AUTH")
        await self.session["pg"].goto(self.start_url, wait_until="load")
        
        page_content = (await self.session["pg"].content()).lower()
        auth_indicators = ["sign in", "log in", "login", "create account"]
        
        if any(kw in page_content for kw in auth_indicators):
            print("\n" + "="*50)
            print("[ACTION REQUIRED] Please complete the Google Login manually.")
            print("The agent is waiting for a dashboard or successful auth...")
            print("="*50 + "\n")
            
            try:
                # Poll for success: Either a user menu or the absence of 'Sign In'
                # v0 specific: look for the user avatar or specific dashboard markers
                await self.session["pg"].wait_for_selector("[data-testid='user-menu'], .user-avatar, button:has-text('New Chat')", timeout=60000)
                print(">>> Auth Detected! Transitioning to Autonomous Mode...")
            except Exception:
                print(">>> Auth wait timed out or not detected. Proceeding as guest...")
        
        return "DISCOVER"

    async def run(self):
        async with async_playwright() as p:
            try:
                # Phase 1: Pre-Flight Auth (No Video)
                await self.spawn_browser(p, record=False)
                await self.node_pre_auth()
                
                # Phase 2: Pre-Scout (Reconnaissance)
                self.session["current_node"] = await self.node_pre_scout()
                
                # Phase 3: Production Recording (Close and Relaunch with Video)
                print("[StateEngine] Finalizing Recon Stage. Relaunching for Cinematic Recording...")
                await self.spawn_browser(p, record=True)
                
                while self.session["current_node"] != "FINISH":
                    node = self.session["current_node"]
                    print(f"\n[StateEngine] Transitioning to: {node}")
                    
                    if self.session["pg"].is_closed():
                        print("[StateEngine] Page closed. Re-spawning...")
                        await self.spawn_browser(p)

                    if node == "PRE_AUTH":
                        self.session["current_node"] = await self.node_pre_auth()
                    elif node == "DISCOVER":
                        self.session["current_node"] = await self.node_discover()
                    elif node == "STRATEGIZE":
                        self.session["current_node"] = await self.node_strategize()
                    elif node == "PLAN":
                        self.session["current_node"] = await self.node_plan()
                    elif node == "ACT":
                        self.session["current_node"] = await self.node_act()
                    else:
                        break
            except Exception as e:
                import traceback
                print(f"[StateEngine] Critical Failure: {e}")
                traceback.print_exc()
            finally:
                await self.cleanup()

    async def node_discover(self) -> str:
        print("[Mapper] Initiating Accessibility-Tree Crawl...")
        queue = [(self.start_url, 0)]
        visited = {self.start_url}
        
        while queue:
            url, depth = queue.pop(0)
            if depth > 1: continue
            
            try:
                print(f"[Mapper] Crawling: {url}")
                await self.session["pg"].goto(url, wait_until="load", timeout=20000)
                await asyncio.sleep(2) # Allow hydration
                
                # Accessibility Snapshot with Fallback
                elements = []
                accessibility = getattr(self.session["pg"], "accessibility", None)
                if accessibility:
                    try:
                        snapshot = await accessibility.snapshot()
                        elements = self.parse_accessibility_tree(snapshot)
                    except Exception as e:
                        print(f"[Mapper] Accessibility snapshot failed: {e}")
                
                if not elements:
                    print("[Mapper] Falling back to standard DOM extraction...")
                    elements = await self.fallback_dom_extract(self.session["pg"])
                
                self.sitemap.add_page(url, await self.session["pg"].title(), elements)
                
                # Extract links for BFS
                links = await self.session["pg"].query_selector_all('a')
                for link in links:
                    href = await link.get_attribute('href')
                    if href and (href.startswith('/') or self.start_url in href):
                        full_url = href if href.startswith('http') else f"{self.start_url.rstrip('/')}/{href.lstrip('/')}"
                        if full_url not in visited and len(visited) < 8:
                            visited.add(full_url)
                            queue.append((full_url, depth + 1))
                print(f"[Mapper] Scouted: {url}")
            except Exception as e:
                print(f"[Mapper] Failed to scout {url}: {e}")
        
        return "DISCOVER"

    async def node_pre_scout(self) -> str:
        """Stage: PRE-SCOUT. Visit top 5 links and identify Hero flows."""
        print("[Pre-Scout] Initiating high-fidelity site reconnaissance...")
        pg = self.session["pg"]
        await pg.goto(self.start_url, wait_until="load")
        
        # Identify top 5 actionable links
        links = await pg.query_selector_all('a')
        scout_targets = []
        for link in links:
            href = await link.get_attribute('href')
            text = await link.inner_text()
            if href and (href.startswith('/') or self.start_url in href) and text.strip():
                full_url = href if href.startswith('http') else f"{self.start_url.rstrip('/')}/{href.lstrip('/')}"
                if full_url != self.start_url and full_url not in [t[0] for t in scout_targets]:
                    scout_targets.append((full_url, text.strip()))
            if len(scout_targets) >= 5: break
            
        for url, label in scout_targets:
            try:
                print(f"[Pre-Scout] Scouting: {label} ({url})")
                await pg.goto(url, wait_until="networkidle", timeout=10000)
                await asyncio.sleep(1)
                
                # Take thumbnail and get summary via vision
                thumb_path = REC_DIR / f"thumb_{hashlib.md5(url.encode()).hexdigest()[:8]}.jpg"
                await pg.screenshot(path=str(thumb_path), type="jpeg", quality=50)
                
                b64_img = base64.b64encode(thumb_path.read_bytes()).decode('utf-8')
                prompt = "Describe this page in one sentence. Focus on its primary interactive feature or value."
                summary = await self.ask_vision(prompt, b64_img)
                
                self.sitemap.add_scout_entry(url, summary, str(thumb_path))
            except: continue
            
        return "DISCOVER"

    async def fallback_dom_extract(self, page: Page) -> list:
        """Extract high-fidelity interactive elements using AXTree prioritization."""
        elements = []
        # Filter for visible and enabled elements only
        selectors = [
            "button:visible:not([disabled])",
            "a:visible:not([disabled])",
            "input:visible:not([disabled])",
            "[role='button']:visible",
            "[role='link']:visible"
        ]
        for selector in selectors:
            try:
                nodes = await page.query_selector_all(selector)
                for node in nodes:
                    # Check visibility heuristic
                    is_visible = await node.evaluate("el => el.offsetWidth > 0 && el.offsetHeight > 0 && window.getComputedStyle(el).display !== 'none'")
                    if not is_visible: continue
                    
                    name = await node.inner_text() or await node.get_attribute("aria-label") or await node.get_attribute("placeholder")
                    role = await node.get_attribute("role") or selector.split(":")[0].strip("[]'")
                    
                    if name and name.strip():
                        elements.append({
                            "role": role,
                            "name": name.strip()[:50],
                            "id": hashlib.md5(name.encode()).hexdigest()[:8]
                        })
            except: continue
        return elements

    def parse_accessibility_tree(self, node: dict, elements: list = None) -> list:
        if elements is None: elements = []
        
        role = node.get("role")
        name = node.get("name")
        if role in ["button", "link", "textbox", "checkbox", "menuitem"] and name:
            elements.append({
                "role": role,
                "name": name,
                "description": node.get("description", ""),
                "id": hashlib.md5(f"{role}{name}".encode()).hexdigest()[:8]
            })
            
        for child in node.get("children", []):
            self.parse_accessibility_tree(child, elements)
        return elements

    async def node_strategize(self) -> str:
        print("[Strategist] Analyzing Site Features & Value...")
        for url, info in self.sitemap.pages.items():
            try:
                await self.session["pg"].goto(url, wait_until="load", timeout=15000)
                screenshot = await self.session["pg"].screenshot(type="jpeg")
                b64_img = base64.b64encode(screenshot).decode('utf-8')
                
                prompt = (
                    f"Analyze this page: {url}. Title: {info['title']}.\n"
                    "1. What is the core purpose of this page?\n"
                    "2. Rate its 'Demo Value' from 1-10 (e.g., Dashboards are 10, Terms are 1).\n"
                    "Output in format: Purpose: [text] | Value: [number]"
                )
                
                response = await self.ask_vision(prompt, b64_img)
                match = re.search(r"Purpose: (.*) \| Value: (\d+)", response)
                if match:
                    val = int(match.group(2))
                    # Prioritize pages with input boxes for Hero Interactions
                    has_inputs = any(el.get("tag") in ["input", "textarea"] for el in info.get("interactive_elements", []))
                    if has_inputs: val += 3
                    
                    info["purpose"] = match.group(1)
                    info["demo_value"] = val
                    print(f"[Strategist] Page: {url} -> Value: {info['demo_value']}")
            except: continue
        
        return "PLAN"

    async def node_plan(self) -> str:
        print("[Director] Building Global Action Sequence...")
        high_value_pages = self.sitemap.get_highest_value_pages()
        
        context = "Site Map:\n" + "\n".join([f"- {url}: {p['purpose']} (Value: {p['demo_value']})" for url, p in self.sitemap.pages.items()])
        scout_info = "Discovery Log (Pre-Scout):\n" + "\n".join([f"- {s['url']}: {s['summary']}" for s in self.sitemap.scout_log])
        
        prompt = (
            "You are a Senior Product Marketer & Demo Director. Create a high-converting, cinematic action sequence.\n"
            f"{context}\n\n"
            f"{scout_info}\n\n"
            "STRATEGY:\n"
            "1. Use the Discovery Log to prioritize high-value flows (e.g., editors, dashboards) over static pages (Students, FAQ).\n"
            "2. Start at Home.\n"
            "3. Identify the 'Hero Input' (e.g., search, prompt box).\n"
            "4. TYPE a high-value demonstration prompt.\n"
            "5. WAIT for results (mutation).\n"
            "6. SCROLL to showcase depth.\n"
            "7. Finish at the most interactive page found during Pre-Scout.\n\n"
            "Output JSON only: [{\"action\": \"navigate|click|type|scroll|wait_mutation\", \"url\": \"...\", \"aria_name\": \"...\", \"value\": \"...\", \"reasoning\": \"...\"}]"
        )
        
        # Get elements for the start page to help targeting
        elements = self.sitemap.pages.get(self.start_url, {}).get("interactive_elements", [])
        el_list = json.dumps(elements[:40])
        
        try:
            response = await self.ask_vision(f"{prompt}\n\nAvailable Elements on Landing:\n{el_list}")
            self.session["director_script"] = json.loads(re.search(r"\[.*\]", response, re.DOTALL).group(0))
            print(f"[Director] Cinematic Script generated with {len(self.session['director_script'])} steps.")
        except:
            print("[Director] Planning failed. Using fallback.")
            self.session["director_script"] = [
                {"action": "navigate", "url": self.start_url},
                {"action": "scroll", "reasoning": "Explore landing"}
            ]
            
        return "ACT"

    async def node_act(self) -> str:
        print("[Actor] Executing Action Sequence with Vision-Check...")
        for action in self.session["director_script"]:
            if self.session["pg"].is_closed(): break
            
            # --- PROACTIVE SIGNUP ASSISTANT ---
            page_content = (await self.session["pg"].content()).lower()
            auth_triggers = ["sign up", "create account", "log in", "login", "register", "join now"]
            
            if any(kw in page_content for kw in auth_triggers):
                print("[Assistant] Authentication/Signup screen detected.")
                
                # 1. Try to auto-click "Continue with Google" if it exists (Very common 'easy' path)
                google_btn = self.session["pg"].get_by_role("button", name=re.compile("google", re.I)).first
                if await google_btn.is_visible():
                    print("[Assistant] Found 'Continue with Google'. Attempting auto-login...")
                    try:
                        await google_btn.click(timeout=3000)
                        await asyncio.sleep(3)
                        # Check if we moved past the wall
                        if not any(kw in (await self.session["pg"].content()).lower() for kw in auth_triggers):
                            print("[Assistant] Auto-login successful!")
                            continue
                    except: pass

                # 2. Try to close intrusive popups
                close_btn = self.session["pg"].get_by_role("button", name=re.compile("close|dismiss|maybe later", re.I)).first
                if await close_btn.is_visible():
                    print("[Assistant] Closing intrusive signup popup...")
                    await close_btn.click()
                    await asyncio.sleep(1)
                else:
                    print("\n" + "!"*50)
                    print("USER ACTION REQUIRED: SIGNUP WALL DETECTED")
                    print(f"Goal: {action.get('reasoning')}")
                    print("HINT: Please complete the signup/login manually in the browser window.")
                    print("I will wait for 30 seconds for you to clear this gate...")
                    print("!"*50 + "\n")
                    await asyncio.sleep(30)
            
            print(f"\n[Actor Action]: {action.get('action')} -> {action.get('reasoning')}")
            
            # 1. Capture State Before
            before_url = self.session["pg"].url
            
            # 2. Perform Action
            success = await self.perform_autonomous_action(action)
            
            # 3. Vision-Check (Self-Correction)
            if success:
                await asyncio.sleep(2)
                after_url = self.session["pg"].url
                
                if before_url == after_url:
                    print("[Actor] URL unchanged. Checking for visual mutation (Modals)...")
                    # Check for modals using z-index heuristic via JS
                    has_modal = await self.session["pg"].evaluate("""() => {
                        const elements = document.querySelectorAll('div');
                        for (let el of elements) {
                            const z = window.getComputedStyle(el).zIndex;
                            if (z && !isNaN(z) && parseInt(z) > 100) return true;
                        }
                        return false;
                    }""")
                    if has_modal:
                        print("[Actor] Mutation detected: A high z-index overlay (modal) appeared.")
            
        return "FINISH"

    async def perform_autonomous_action(self, action: dict) -> bool:
        pg = self.session["pg"]
        ctx = self.session["ctx"]
        atype = action.get("action")
        name = action.get("aria_name")
        
        try:
            # --- HUMAN-LIKE PACING: ZOOM & HOVER ---
            if atype in ["click", "type"]:
                await pg.evaluate("document.body.style.zoom = '1.1'") # Subtle zoom for focus
                
            if atype == "navigate":
                await pg.goto(action.get("url"), wait_until="load")
            elif atype == "click" and name:
                # Hover first
                loc = pg.locator(f'button:has-text("{name}")').first or pg.get_by_role("button", name=re.compile(name, re.I)).first or pg.get_by_text(name).first
                await loc.hover()
                await asyncio.sleep(0.5) # Hover-to-intent
                
                async with ctx.expect_page(timeout=8000) as popup_info:
                    await loc.click(timeout=5000)
                
                popup = await popup_info.value
                if popup:
                    await stealth(popup)
                    await popup.wait_for_load_state("load")
                    account = popup.get_by_text("kanakmegha@gmail.com").first or popup.locator("[data-authuser]").first
                    if await account.is_visible():
                        await account.click()
                    await asyncio.sleep(3)
            elif atype == "type" and name:
                loc = pg.get_by_label(name).first or pg.get_by_placeholder(name).first or pg.locator(f'input:near(:text("{name}"))').first
                await loc.hover()
                await asyncio.sleep(0.3)
                await loc.fill(action.get("value", "Demo Input"), timeout=5000)
                await loc.press("Enter")
                # Wait for result mutation
                await pg.wait_for_load_state("networkidle")
                await asyncio.sleep(2)
            elif atype == "scroll":
                await pg.mouse.wheel(0, 800)
            elif atype == "wait_mutation":
                print("[Actor] Waiting for UI mutation (AI Generation)...")
                await asyncio.sleep(5) # Direct wait for demo purposes
            
            await pg.evaluate("document.body.style.zoom = '1.0'") # Reset zoom
            await asyncio.sleep(1.5)
            return True
        except Exception:
            return False

    async def ask_vision(self, prompt: str, b64_img: str = None) -> str:
        messages = [{"role": "user", "content": [{"type": "text", "text": prompt}]}]
        if b64_img:
            messages[0]["content"].append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64_img}"}})
            
        for model in VISION_MODELS:
            try:
                response = ROUTER_CLIENT.chat.completions.create(model=model, messages=messages, max_tokens=500)
                return response.choices[0].message.content
            except: continue
        return ""

    async def cleanup(self):
        print("[StateEngine] Finalizing Video & Cleaning Context...")
        
        # Explicitly close to finalize .webm
        if self.session["pg"]:
            try:
                video_path = await self.session["pg"].video.path()
                print(f"[StateEngine] Video Artifact Saved: {os.path.abspath(video_path)}")
                await self.session["pg"].close()
            except: pass
            
        if self.session["ctx"]: 
            await self.session["ctx"].close()
        
        # Only clean up if NOT persistent to preserve logins/cookies
        # Only clean up if NOT persistent to preserve logins/cookies
        if not self.persistent and os.path.exists(self.session_data_dir):
            print(f"[StateEngine] Cleaning up volatile data: {self.session_data_dir}")
            shutil.rmtree(self.session_data_dir)

if __name__ == "__main__":
    import sys
    import argparse
    
    parser = argparse.ArgumentParser(description="Antigravity Autonomous Web-to-Demo Agent")
    parser.add_argument("url", nargs="?", default="https://v0.dev", help="The start URL")
    parser.add_argument("--persistent", action="store_true", default=True, help="Maintain session data across runs")
    parser.add_argument("--profile-path", type=str, help="Custom Chrome profile path")
    parser.add_argument("--volatile", action="store_false", dest="persistent", help="Use a temporary session")
    
    args = parser.parse_args()
    
    engine = StateEngine(args.url, persistent=args.persistent)
    asyncio.run(engine.run())
