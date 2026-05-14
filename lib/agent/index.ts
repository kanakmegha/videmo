import { copyFile, mkdtemp, readFile, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import OpenAI from "openai";
import type { BrowserContext, Page } from "playwright-core";
import type {
  PlanStep, PageInfo, PageCategory, ProductProfile,
  TraceAction, ExplorationChain,
} from "../types";

// ── LLM ───────────────────────────────────────────────────────────────────────

const llm = new OpenAI({
  baseURL: "https://router.huggingface.co/v1",
  apiKey: process.env.HF_TOKEN ?? "placeholder",
  defaultHeaders: { "x-wait-for-model": "true", "x-use-cache": "false" },
});

// Vision models — used for screenshot-based page scoring
const VISION_MODELS = [
  "meta-llama/Llama-3.2-11B-Vision-Instruct",
  "Qwen/Qwen2-VL-7B-Instruct",
  "meta-llama/Llama-3.2-90B-Vision-Instruct",
];

// Text-only models — faster and more available; used for planning
const TEXT_MODELS = [
  "meta-llama/Llama-3.1-8B-Instruct",
  "Qwen/Qwen2.5-7B-Instruct",
  "mistralai/Mistral-7B-Instruct-v0.3",
  ...VISION_MODELS, // fallback to vision models if text-only fail
];

async function askLLM(
  prompt: string,
  b64Img?: string,
  textOnly = false
): Promise<string> {
  const content: OpenAI.ChatCompletionContentPart[] = [
    { type: "text", text: prompt },
  ];
  if (b64Img) {
    content.push({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${b64Img}` },
    });
  }

  const models = textOnly ? TEXT_MODELS : VISION_MODELS;

  for (const model of models) {
    try {
      const resp = await llm.chat.completions.create(
        { model, messages: [{ role: "user", content }], max_tokens: 1200 },
        { timeout: 20_000 }
      );
      const text = resp.choices[0]?.message.content ?? "";
      if (text.trim()) return text;
    } catch {
      continue;
    }
  }
  return "";
}

// ── Browser factory ───────────────────────────────────────────────────────────

async function launchContext(
  profileDir: string,
  videoDir?: string
): Promise<BrowserContext> {
  let executablePath: string | undefined;
  let extraArgs: string[] = [];

  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    const chromium = (await import("@sparticuz/chromium")).default;
    executablePath = await chromium.executablePath();
    extraArgs = chromium.args;
  }
  // Local dev: playwright-core will use the system path if executablePath is undefined,
  // so just ensure `npx playwright install chromium` has been run once.

  const { chromium } = await import("playwright-core");

  return chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless: true,
    args: [
      ...extraArgs,
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--hide-scrollbars",
      // swiftshader (software GL) is needed on Linux/cloud to prevent black frames;
      // on macOS it can cause white frames, so only apply it there
      ...(process.platform === "linux" ? ["--use-gl=swiftshader", "--enable-webgl"] : []),
    ],
    ignoreDefaultArgs: ["--enable-automation"],
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    recordVideo: videoDir
      ? { dir: videoDir, size: { width: 1280, height: 800 } }
      : undefined,
    viewport: { width: 1280, height: 800 },
  });
}

// ── DOM extraction ────────────────────────────────────────────────────────────

// Pre-Plan Filter: extract only HERO elements — drop footer/nav/social noise so the
// LLM sees the actionable elements (inputs + primary CTAs) without distraction.
const DOM_SCRIPT = `(() => {
  const seen = new Set();
  const items = [];
  const NOISE = /privacy|terms|cookie|footer|copyright|©|github|twitter|linkedin|facebook|instagram|youtube|tiktok|discord|imprint|legal|status|changelog|careers/i;

  const isInFooter = (el) => {
    let p = el;
    while (p && p !== document.body) {
      const tag = p.tagName?.toLowerCase();
      const role = p.getAttribute?.('role');
      if (tag === 'footer' || role === 'contentinfo') return true;
      p = p.parentElement;
    }
    return false;
  };

  document.querySelectorAll(
    'button, a[href], input, textarea, [role="button"], [role="textbox"], [role="menuitem"], [contenteditable="true"]'
  ).forEach((el, i) => {
    if (isInFooter(el)) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const s = getComputedStyle(el);
    if (s.display==='none'||s.visibility==='hidden'||s.opacity==='0') return;
    const name = (el.innerText||el.value||el.placeholder||
      el.getAttribute('aria-label')||el.getAttribute('aria-placeholder')||'').trim().slice(0,100);
    if (!name || seen.has(name)) return;
    if (NOISE.test(name)) return; // skip footer/social/legal links
    seen.add(name);
    const isInput = ['INPUT','TEXTAREA'].includes(el.tagName) || el.getAttribute('contenteditable')==='true';
    items.push({
      id:'el-'+i, name,
      role: el.getAttribute('role')||el.tagName.toLowerCase(),
      aria_label: el.getAttribute('aria-label')||'',
      placeholder: el.placeholder||el.getAttribute('aria-placeholder')||'',
      x: Math.round(r.left+r.width/2),
      y: Math.round(r.top+r.height/2),
      isInput,
      // y position helps the LLM identify hero elements (above the fold) vs below
      aboveFold: r.top < 800,
    });
    if (items.length>=50) return;
  });

  // Sort: inputs first, then buttons in viewport top-to-bottom, prefer above-the-fold
  items.sort((a, b) => {
    if (a.isInput !== b.isInput) return a.isInput ? -1 : 1;
    if (a.aboveFold !== b.aboveFold) return a.aboveFold ? -1 : 1;
    return a.y - b.y;
  });
  return items;
})()`;

// ── DemoAgent ─────────────────────────────────────────────────────────────────

type Emit = (type: string, data: Record<string, unknown>) => void;

// Stable directory for local video serving (persists across requests)
const LOCAL_VIDEO_DIR = join(tmpdir(), "demogen-videos");

export class DemoAgent {
  private sitemap        = new Map<string, PageInfo>();
  private profile: ProductProfile | null = null;
  private globalTraceLog: ExplorationChain[] = [];
  private scoutDeadline  = 0; // ms timestamp — abort scout when exceeded

  // ── ActionRegistry ────────────────────────────────────────────────────────
  // Each interaction is fingerprinted so the agent never repeats itself.
  // Action ID = hash(url + element_name + action_type + position)
  private actionHistory  = new Set<string>(); // performed at least once
  private blacklist      = new Set<string>(); // performed AND produced no state change
  private urlVisitsInChain = new Map<string, number>(); // for loop detection

  private _actionId(url: string, name: string, action: string, x = 0, y = 0): string {
    // Cheap deterministic hash — collisions extremely unlikely here
    const raw = `${url}|${name.trim().toLowerCase()}|${action}|${Math.round(x / 20) * 20}|${Math.round(y / 20) * 20}`;
    let h = 0;
    for (let i = 0; i < raw.length; i++) h = ((h << 5) - h + raw.charCodeAt(i)) | 0;
    return `a${h}`;
  }

  constructor(
    private jobId: string,
    private url: string,
    private emit: Emit
  ) {}

  // ─ Phase 1: discover + strategise + plan ─────────────────────────────────

  async planPhase(): Promise<PlanStep[]> {
    const profileDir = await mkdtemp(join(tmpdir(), "dg-plan-"));
    let ctx: BrowserContext | null = null;
    try {
      ctx = await launchContext(profileDir);
      const page = ctx.pages()[0] ?? (await ctx.newPage());

      await this.emit("phase", { phase: "discover", message: "Crawling website…" });
      await this._discover(page);

      await this.emit("phase", { phase: "strategize", message: "Analysing pages with AI…" });
      await this._strategize(page);

      await this.emit("phase", { phase: "plan", message: "Profiling product…" });
      this.profile = await this._deepAnalyze(page);

      await this.emit("phase", { phase: "plan", message: "Building action plan…" });
      const steps = await this._plan(this.profile);
      return steps;
    } finally {
      await ctx?.close().catch(() => {});
      await rm(profileDir, { recursive: true, force: true });
    }
  }

  // ─ Phase 2: execute ───────────────────────────────────────────────────────

  async executePhase(steps: PlanStep[]): Promise<string | null> {
    const profileDir = await mkdtemp(join(tmpdir(), "dg-exec-"));
    const videoDir   = await mkdtemp(join(tmpdir(), "dg-vid-"));
    let ctx: BrowserContext | null = null;
    try {
      ctx = await launchContext(profileDir, videoDir);
      const page = ctx.pages()[0] ?? (await ctx.newPage());

      await this.emit("phase", { phase: "execute", message: "Recording demo…" });

      // Always open the target URL first — guarantees the recording has real content
      // even if the first plan step is somehow missing or the navigate fails later
      await this._navigateTo(page, this.url);

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        await this.emit("step_start", {
          index: i,
          total: steps.length,
          action: step.action,
          reasoning: step.reasoning ?? "",
          aria_name: step.aria_name ?? "",
          value: step.value ?? "",
        });
        const ok = await this._performAction(page, step, i);
        await this.emit("step_complete", { index: i, success: ok });
        await sleep(1200);
      }

      // Finalise: MUST close page first — Playwright only flushes the video file after close
      await page.close();
      const videoPath = await page.video()?.path(); // safe to call now
      await ctx.close();
      ctx = null;

      if (!videoPath) return null;

      // ── Storage: Vercel Blob (production) or local file (dev) ──────────────
      if (process.env.BLOB_READ_WRITE_TOKEN) {
        const { put } = await import("@vercel/blob");
        const fileData = await readFile(videoPath);
        const blob = await put(`demos/${this.jobId}.webm`, fileData, {
          access: "public",
          contentType: "video/webm",
          addRandomSuffix: false,
        });
        await rm(videoDir, { recursive: true, force: true });
        return blob.url;
      } else {
        // Local dev: copy to a stable path and serve via /api/jobs/[id]/video
        await mkdir(LOCAL_VIDEO_DIR, { recursive: true });
        const stablePath = join(LOCAL_VIDEO_DIR, `${this.jobId}.webm`);
        await copyFile(videoPath, stablePath);
        await rm(videoDir, { recursive: true, force: true });
        return `/api/jobs/${this.jobId}/video`; // relative URL served by Next.js
      }
    } finally {
      await ctx?.close().catch(() => {});
      await rm(profileDir, { recursive: true, force: true });
      // videoDir is cleaned up inside the try block above; this is a safety net
      await rm(videoDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // ── Discover ─────────────────────────────────────────────────────────────

  private async _discover(page: Page) {
    const { origin } = new URL(this.url);
    const queue: [string, number][] = [[this.url, 0]];
    const visited = new Set<string>([this.url]);

    while (queue.length) {
      const [url, depth] = queue.shift()!;
      if (depth > 1) continue;
      try {
        await this.emit("discovering_page", { url, depth });
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
        await sleep(1500);

        const elements = (await page
          .evaluate(DOM_SCRIPT)
          .catch(() => [])) as PageInfo["interactive_elements"];
        const title = await page.title();

        this.sitemap.set(url, {
          url,
          title,
          element_count: elements?.length ?? 0,
          interactive_elements: elements,
        });
        await this.emit("page_found", {
          url,
          title,
          element_count: elements?.length ?? 0,
        });

        if (depth < 1) {
          const hrefs = await page
            .$$eval("a[href]", (els) =>
              els.map((el) => el.getAttribute("href") ?? "")
            )
            .catch(() => [] as string[]);

          for (const href of hrefs) {
            if (!href) continue;
            const full = href.startsWith("/")
              ? `${origin}${href}`
              : href.startsWith(origin)
              ? href
              : null;
            if (!full) continue;
            const clean = full.split("?")[0].split("#")[0];
            if (!visited.has(clean) && visited.size < 10) {
              visited.add(clean);
              queue.push([clean, depth + 1]);
            }
          }
        }
      } catch (e) {
        await this.emit("discover_error", { url, error: String(e) });
      }
    }

    // After static crawl, run Deep Chain Exploration on the homepage
    await this._deepScoutRoot(page);
  }

  // ── Deep Chain Exploration ───────────────────────────────────────────────
  // Recursively click interactive elements, detect state changes, score chains.
  // Budget: 45s total, depth 3, breadth 4 per node — fits within plan-stream's
  // 120s maxDuration alongside strategize + deep analyze.

  private async _deepScoutRoot(page: Page) {
    this.scoutDeadline = Date.now() + 45_000;
    try {
      await page.goto(this.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await sleep(1500);
      await this.emit("phase", { phase: "discover", message: "Deep-scouting interactive chains…" });
      await this._deepScout(page, [], 0);
      await this.emit("scout_complete", {
        chains: this.globalTraceLog.length,
        deepest: Math.max(0, ...this.globalTraceLog.map((c) => c.length)),
      });
    } catch (e) {
      await this.emit("scout_error", { error: String(e) });
    }
  }

  private async _snapshotState(page: Page): Promise<{ url: string; size: number; topZ: number }> {
    const url = page.url();
    const data = await page.evaluate(() => {
      const size = (document.body?.innerHTML?.length ?? 0);
      let topZ = 0;
      document.querySelectorAll("*").forEach((el) => {
        const z = parseInt(getComputedStyle(el).zIndex, 10);
        if (Number.isFinite(z) && z > topZ) topZ = z;
      });
      return { size, topZ };
    }).catch(() => ({ size: 0, topZ: 0 }));
    return { url, ...data };
  }

  private _detectChange(
    before: { url: string; size: number; topZ: number },
    after:  { url: string; size: number; topZ: number }
  ): { changed: TraceAction["state_change"]; delta: number } {
    if (before.url !== after.url) return { changed: "url", delta: 0 };
    if (after.topZ > before.topZ + 100 && after.size > before.size + 50) {
      return { changed: "modal", delta: after.size - before.size };
    }
    const growth = after.size - before.size;
    if (growth > 200) return { changed: "dom_growth", delta: growth };
    return { changed: null, delta: 0 };
  }

  private async _backtrack(page: Page, before: { url: string }): Promise<void> {
    try {
      if (page.url() !== before.url) {
        await page.goBack({ waitUntil: "domcontentloaded", timeout: 8_000 });
      } else {
        // DOM-only change (modal/sidebar) — try Escape, then click body
        await page.keyboard.press("Escape").catch(() => {});
        await sleep(300);
      }
      await sleep(800);
    } catch {
      // Hard reset
      await page.goto(this.url, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
      await sleep(1000);
    }
  }

  private async _deepScout(page: Page, path: TraceAction[], depth: number): Promise<void> {
    const MAX_DEPTH = 3;
    const MAX_BREADTH = 4;
    if (depth >= MAX_DEPTH) {
      this._commitChain(path);
      return;
    }
    if (Date.now() > this.scoutDeadline) {
      this._commitChain(path);
      return;
    }

    // Get top-N actionable elements at the current state
    const elements = (await page.evaluate(DOM_SCRIPT).catch(() => [])) as
      | { name: string; role: string; x: number; y: number; isInput?: boolean; aboveFold?: boolean }[]
      | [];

    // Skip inputs in chain exploration — they need typed values, not bare clicks.
    // Skip tiny links and elements far below the fold.
    // Skip elements already in actionHistory or blacklist (ActionRegistry).
    const currentUrl = page.url();
    const candidates = (elements as { name: string; role: string; x: number; y: number; isInput?: boolean; aboveFold?: boolean }[])
      .filter((el) => !el.isInput && el.name && el.name.length < 60)
      .filter((el) => {
        const id = this._actionId(currentUrl, el.name, "click", el.x, el.y);
        return !this.actionHistory.has(id) && !this.blacklist.has(id);
      })
      .slice(0, MAX_BREADTH);

    // Dead-End Rule: every action on this page is already exhausted
    if (candidates.length === 0) {
      this._commitChain(path);
      return;
    }

    // Loop Detection: same URL hit > 3 times in this chain — reset to home
    const visits = (this.urlVisitsInChain.get(currentUrl) ?? 0) + 1;
    this.urlVisitsInChain.set(currentUrl, visits);
    if (visits > 3) {
      await this.emit("loop_detected", { url: currentUrl, visits });
      this.urlVisitsInChain.clear();
      await page.goto(this.url, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
      await sleep(1000);
      this._commitChain(path);
      return;
    }

    let anyChildAdvanced = false;

    for (const el of candidates) {
      if (Date.now() > this.scoutDeadline) break;

      const actionId = this._actionId(currentUrl, el.name, "click", el.x, el.y);
      const before = await this._snapshotState(page);

      // Try click — quietly skip if it fails
      try {
        const safe = el.name.replace(/[^\w\s'-]/g, "").trim();
        const loc = page
          .getByRole("button", { name: new RegExp(escapeRe(safe), "i") })
          .or(page.getByRole("link", { name: new RegExp(escapeRe(safe), "i") }))
          .or(page.locator(`a:has-text("${safe}")`))
          .or(page.locator(`button:has-text("${safe}")`))
          .first();
        if (!(await loc.count())) continue;
        this.actionHistory.add(actionId); // record attempt BEFORE click
        await loc.click({ timeout: 4_000, force: false });
        await sleep(1000);
      } catch {
        continue;
      }

      const after = await this._snapshotState(page);
      const change = this._detectChange(before, after);

      if (!change.changed) {
        this.blacklist.add(actionId); // dead end — never try again
        continue;
      }

      const action: TraceAction = {
        element_name: el.name,
        element_role: el.role,
        state_change: change.changed,
        delta_size: change.delta,
        url_after: after.url,
      };

      anyChildAdvanced = true;
      const nextPath = [...path, action];
      await this.emit("chain_extended", {
        depth: nextPath.length,
        action: action.element_name,
        change: change.changed,
      });

      await this._deepScout(page, nextPath, depth + 1);
      await this._backtrack(page, before);
    }

    if (!anyChildAdvanced && path.length > 0) {
      this._commitChain(path);
    }
  }

  private _commitChain(path: TraceAction[]) {
    if (path.length === 0) return;
    const roles = new Set(path.map((a) => a.element_role));
    const chain: ExplorationChain = {
      start_url: this.url,
      actions: path,
      length: path.length,
      diversity: roles.size,
      score: path.length * roles.size,
    };
    this.globalTraceLog.push(chain);
  }

  // ── Strategise ────────────────────────────────────────────────────────────

  private async _strategize(page: Page) {
    const entries = [...this.sitemap.entries()].slice(0, 6);
    for (const [url, info] of entries) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
        await sleep(800);
        const buf = await page.screenshot({ type: "jpeg", quality: 50 });
        const b64 = buf.toString("base64");

        const reply = await askLLM(
          `Webpage: ${url}\nTitle: ${info.title}\n\n` +
          "Analyse this page for a product demo video using the rubric below.\n\n" +
          "CATEGORY — pick exactly one:\n" +
          "  HERO_FEATURE = AI generator, prompt box, interactive builder, live canvas\n" +
          "  DASHBOARD    = live data, charts, analytics, project/task view\n" +
          "  EDITOR       = document editor, code editor, design canvas, form builder\n" +
          "  FORM         = sign-up, contact, enterprise enquiry, request-demo form\n" +
          "  STATIC       = marketing copy, blog, press, pricing table (no interaction)\n" +
          "  AUTH         = login, register, password reset\n\n" +
          "SCORE — start at 5, apply these adjustments:\n" +
          "  +5 has AI/generative input (text box that triggers AI output)\n" +
          "  +4 shows real-time output or live preview\n" +
          "  +4 has interactive editor or canvas\n" +
          "  +3 has dashboard with live/dynamic data\n" +
          "  +3 has multi-step workflow\n" +
          "  -3 purely static/marketing page\n" +
          "  -5 login, sign-up, form, or auth page\n" +
          "Clamp final score to 0–10.\n\n" +
          "1. One-sentence purpose?\n" +
          "2. Category from list above?\n" +
          "3. Final score?\n" +
          "Format EXACTLY: Purpose: [text] | Category: [CATEGORY] | Value: [score]",
          b64,
          false
        );

        const m = reply.match(/Purpose:\s*(.+?)\s*\|\s*Category:\s*(\w+)\s*\|\s*Value:\s*(\d+)/i);
        if (m) {
          info.purpose  = m[1].trim();
          info.category = (m[2].trim().toUpperCase() as PageCategory) ?? "STATIC";
          info.demo_value = Math.min(10, Math.max(0, parseInt(m[3], 10)));
          await this.emit("page_scored", {
            url,
            purpose: info.purpose,
            category: info.category,
            value: info.demo_value,
          });
        } else {
          await this.emit("score_error", { url, error: "LLM did not return expected format" });
        }
      } catch (e) {
        await this.emit("score_error", { url, error: String(e) });
      }
    }
  }

  // ── Deep Analyse ──────────────────────────────────────────────────────────
  // Visits the homepage, extracts real page content, and asks the LLM to
  // produce a structured ProductProfile used to drive a site-specific plan.

  private async _deepAnalyze(page: Page): Promise<ProductProfile> {
    const fallback: ProductProfile = {
      product_name: new URL(this.url).hostname.replace(/^www\./, ""),
      product_category: "other",
      core_action: "explore the product features",
      hero_input_placeholder: null,
      hero_button_text: null,
      hero_nav_link: null,
      demo_input_value: "Build a modern hotel booking dashboard with dark mode",
      demo_wow_moment: "new content appears on the page",
      page_sections: [],
    };

    try {
      await page.goto(this.url, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await sleep(2000);

      // Extract all text (truncated to keep prompt manageable)
      const text = await page
        .evaluate(() => (document.body.innerText ?? "").slice(0, 2500))
        .catch(() => "");

      // Extract visible inputs with their metadata
      const inputs = await page.evaluate(() =>
        Array.from(
          document.querySelectorAll('input, textarea, [contenteditable="true"]')
        )
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          })
          .map((el) => ({
            type: (el as HTMLInputElement).type || el.tagName.toLowerCase(),
            placeholder: (el as HTMLInputElement).placeholder || el.getAttribute("aria-placeholder") || "",
            label: el.getAttribute("aria-label") || "",
          }))
          .filter((el) => el.placeholder || el.label)
          .slice(0, 10)
      ).catch(() => [] as { type: string; placeholder: string; label: string }[]);

      // All visible button labels
      const buttons = await page.evaluate(() =>
        Array.from(document.querySelectorAll('button, [role="button"]'))
          .map((el) => (el as HTMLElement).innerText?.trim())
          .filter(Boolean)
          .slice(0, 20)
      ).catch(() => [] as string[]);

      // Nav links (text + href)
      const navLinks = await page.evaluate(() =>
        Array.from(document.querySelectorAll("nav a, header a"))
          .map((el) => ({
            text: (el as HTMLElement).innerText?.trim(),
            href: (el as HTMLAnchorElement).href,
          }))
          .filter((el) => el.text && el.href && !el.href.includes("#"))
          .slice(0, 15)
      ).catch(() => [] as { text: string; href: string }[]);

      const buf = await page.screenshot({ type: "jpeg", quality: 60 }).catch(() => null);

      const prompt =
        "You are analyzing a web product to plan a cinematic demo video.\n\n" +
        `Page text content:\n${text}\n\n` +
        `Buttons found: ${JSON.stringify(buttons)}\n` +
        `Input fields found: ${JSON.stringify(inputs)}\n` +
        `Navigation links: ${JSON.stringify(navLinks)}\n\n` +
        "Answer ONLY with a valid JSON object, no other text:\n" +
        JSON.stringify({
          product_name: "exact product name",
          product_category: "speech_ai | coding_tool | design_tool | data_tool | productivity | ecommerce | other",
          core_action: "the single most impressive thing this product lets you do in one sentence",
          hero_input_placeholder: "exact placeholder of the most important input, or null",
          hero_button_text: "exact text of the primary CTA button, or null",
          hero_nav_link: "full URL of the most feature-rich page (not homepage), or null",
          demo_input_value: "a specific impressive input tailored to this product — for speech tools: a sentence to speak; for coding tools: a feature to build; for design tools: a design to create",
          demo_wow_moment: "one sentence: what visual change happens after the user triggers the core action",
          page_sections: ["list", "of", "visible", "section", "headings", "on", "homepage"],
        }, null, 2);

      const reply = await askLLM(prompt, buf?.toString("base64"), !buf);
      const m = reply.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("No JSON object in reply");
      const parsed = JSON.parse(m[0]) as ProductProfile;

      // ── Validate LLM output against actual discovered elements ──
      // The LLM often hallucinates placeholder/button text — null those out
      const buttonSet = new Set(buttons.map((b) => b?.toLowerCase().trim()).filter(Boolean));
      const placeholderSet = new Set(
        inputs.map((i) => (i.placeholder || i.label).toLowerCase().trim()).filter(Boolean)
      );

      if (parsed.hero_button_text) {
        const cleaned = parsed.hero_button_text.toLowerCase().trim();
        const words = cleaned.split(/\s+/).length;
        // Must be short (real button text), and must actually exist in the buttons list
        if (words > 5 || !buttonSet.has(cleaned)) {
          parsed.hero_button_text = null;
        }
      }
      if (parsed.hero_input_placeholder) {
        const cleaned = parsed.hero_input_placeholder.toLowerCase().trim();
        if (!placeholderSet.has(cleaned) && cleaned.split(/\s+/).length > 6) {
          parsed.hero_input_placeholder = null;
        }
      }
      // Reject generic demo inputs that signal an LLM cop-out
      if (parsed.demo_input_value && /^(hello world|test|testing|123|abc|sample|example|new content|foo|bar)\b/i.test(parsed.demo_input_value.trim())) {
        parsed.demo_input_value = fallback.demo_input_value;
      }

      await this.emit("product_profiled", {
        product_name: parsed.product_name,
        category: parsed.product_category,
        core_action: parsed.core_action,
        hero_input_placeholder: parsed.hero_input_placeholder,
        hero_button_text: parsed.hero_button_text,
      });
      return parsed;
    } catch {
      return fallback;
    }
  }

  // ── Plan ─────────────────────────────────────────────────────────────────

  private async _plan(profile: ProductProfile): Promise<PlanStep[]> {
    // ── Build the plan ALGORITHMICALLY from validated profile + discovered DOM ──
    // The LLM is no longer allowed to author the structure — it hallucinates
    // placeholder text and removes navigate steps. We build PlanStep objects
    // directly here, using only data we can verify exists on the page.

    const catRank: Record<string, number> = {
      HERO_FEATURE: 5, EDITOR: 4, DASHBOARD: 3, FORM: 0, STATIC: 0, AUTH: -5,
    };
    const allPages = [...this.sitemap.values()].sort((a, b) =>
      (catRank[b.category ?? "STATIC"] ?? 0) + (b.demo_value ?? 0) -
      (catRank[a.category ?? "STATIC"] ?? 0) - (a.demo_value ?? 0)
    );

    // Find an actual text input from discovered elements (validated, not LLM-claimed)
    const realInput = [...this.sitemap.values()]
      .flatMap((p) => p.interactive_elements ?? [])
      .find((el) => el.isInput || el.role === "textarea" || el.role === "textbox");

    // Find a real visible CTA button from discovered elements
    const realCtaButton = [...this.sitemap.values()]
      .flatMap((p) => p.interactive_elements ?? [])
      .find((el) => !el.isInput && el.aboveFold !== false && el.name && el.name.length < 40);

    const inputSelector =
      profile.hero_input_placeholder ?? realInput?.placeholder ?? realInput?.name ?? null;
    const buttonSelector =
      profile.hero_button_text ?? realCtaButton?.name ?? null;

    const act2Url =
      profile.hero_nav_link && profile.hero_nav_link !== this.url
        ? profile.hero_nav_link
        : (allPages.find((p) => p.url !== this.url && (p.demo_value ?? 0) >= 6)?.url ?? null);

    const act3Page = allPages.find(
      (p) => p.url !== this.url && p.url !== act2Url && (p.demo_value ?? 0) >= 4
    );

    const productName = profile.product_name || new URL(this.url).hostname;
    const steps: PlanStep[] = [];

    // ── ACT 1: HOOK (0–10s) ──
    steps.push({
      action: "navigate",
      url: this.url,
      reasoning: `Open ${productName} homepage`,
    });
    steps.push({
      action: "scroll",
      scroll_amount: 350,
      reasoning: `Reveal the ${productName} hero section`,
    });

    // ── Maximum Value Path: use the highest-scoring explored chain ──
    const sortedChains = [...this.globalTraceLog].sort((a, b) => b.score - a.score);
    const heroChain = sortedChains[0];
    const spotlights = sortedChains.slice(1, 3).filter((c) => c.score >= 2);
    const usedActions = new Set<string>();

    // ── ACT 2: HERO ACTION (10–40s) — guaranteed real interaction ──
    if (act2Url) {
      steps.push({
        action: "navigate",
        url: act2Url,
        reasoning: `Navigate to the primary feature area`,
      });
    }

    // Hero chain takes priority over input/button heuristics when it's strong
    if (heroChain && heroChain.score >= 3) {
      for (const action of heroChain.actions.slice(0, 3)) {
        usedActions.add(action.element_name);
        steps.push({
          action: "click",
          selector_strategy: "button_text",
          selector_value: action.element_name,
          aria_name: action.element_name,
          reasoning: `Click "${action.element_name}" — explored chain showed this reveals ${action.state_change === "url" ? "a new page" : action.state_change === "modal" ? "an interactive modal" : "new product UI"}`,
        });
        steps.push({
          action: "wait_for_mutation",
          value: "6",
          reasoning: "Wait for UI to settle",
        });
      }
      steps.push({
        action: "scroll",
        scroll_amount: 500,
        reasoning: "Reveal the result of the interaction",
      });
    } else if (inputSelector) {
      steps.push({
        action: "type",
        selector_strategy: "placeholder",
        selector_value: inputSelector,
        aria_name: inputSelector,
        value: profile.demo_input_value,
        reasoning: `Type a demo input to trigger ${profile.core_action}`,
      });
      steps.push({
        action: "wait_for_mutation",
        value: "15",
        reasoning: `Wait for ${profile.demo_wow_moment}`,
      });
      steps.push({
        action: "scroll",
        scroll_amount: 600,
        reasoning: "Reveal the generated output",
      });
    } else if (buttonSelector) {
      steps.push({
        action: "click",
        selector_strategy: "button_text",
        selector_value: buttonSelector,
        aria_name: buttonSelector,
        reasoning: `Click "${buttonSelector}" to trigger ${profile.core_action}`,
      });
      steps.push({
        action: "wait_for_mutation",
        value: "10",
        reasoning: `Wait for ${profile.demo_wow_moment}`,
      });
      steps.push({
        action: "scroll",
        scroll_amount: 600,
        reasoning: "Show what the interaction revealed",
      });
    } else {
      // Last resort — couldn't find any actionable element
      steps.push({
        action: "scroll",
        scroll_amount: 800,
        reasoning: `Showcase ${profile.core_action}`,
      });
    }

    // ── ACT 3: DEPTH (40–60s) — Feature Spotlights from secondary chains ──
    const spotlightActions = spotlights
      .flatMap((c) => c.actions.slice(0, 1))
      .filter((a) => !usedActions.has(a.element_name))
      .slice(0, 2);

    if (spotlightActions.length > 0) {
      for (const action of spotlightActions) {
        steps.push({
          action: "click",
          selector_strategy: "button_text",
          selector_value: action.element_name,
          aria_name: action.element_name,
          reasoning: `Click "${action.element_name}" to spotlight another ${productName} feature`,
        });
        steps.push({
          action: "wait_for_mutation",
          value: "5",
          reasoning: "Let the feature surface",
        });
      }
      steps.push({
        action: "scroll",
        scroll_amount: 500,
        reasoning: `Close out the ${productName} demo`,
      });
    } else if (act3Page) {
      steps.push({
        action: "navigate",
        url: act3Page.url,
        reasoning: `Show ${act3Page.purpose || act3Page.title}`,
      });
      steps.push({
        action: "scroll",
        scroll_amount: 700,
        reasoning: `Showcase additional ${productName} capabilities`,
      });
    } else {
      steps.push({
        action: "scroll",
        scroll_amount: 800,
        reasoning: `Continue exploring ${productName}`,
      });
    }

    await this.emit("plan_built", {
      product: productName,
      steps: steps.length,
      has_input: !!inputSelector,
      has_button: !!buttonSelector,
      has_secondary_page: !!act3Page,
      hero_chain_score: heroChain?.score ?? 0,
      hero_chain_length: heroChain?.length ?? 0,
      spotlights: spotlights.length,
    });
    return steps;
  }

  // ── Smart fallback: builds a real plan from discovered element data ────────

  private _buildSmartFallback(profile?: ProductProfile): PlanStep[] {
    const steps: PlanStep[] = [];
    const mainPage = this.sitemap.get(this.url);
    const demoText = profile?.demo_input_value ?? "Build a modern hotel booking dashboard with dark mode";

    steps.push({
      action: "navigate",
      url: this.url,
      reasoning: "Open the website",
    });

    // Find the best text input on the main page
    const inputs = (mainPage?.interactive_elements ?? []).filter(
      (el) =>
        el.isInput ||
        el.role === "textarea" ||
        el.role === "textbox" ||
        el.role === "input" ||
        el.placeholder
    );
    const heroInput = inputs[0];

    // Use profile data first, then discovered DOM, then last-resort heuristics
    const heroPlaceholder = profile?.hero_input_placeholder || heroInput?.placeholder || heroInput?.name;
    const heroButton = profile?.hero_button_text || mainPage?.interactive_elements?.find(
      (el) => !el.isInput && el.aboveFold !== false
    )?.name;

    if (heroPlaceholder) {
      // Have an input — TYPE first (most impressive demo step)
      steps.push({
        action: "type",
        selector_strategy: "placeholder",
        selector_value: heroPlaceholder,
        aria_name: heroPlaceholder,
        value: demoText,
        reasoning: `Type a demo input to trigger ${profile?.core_action ?? "the main feature"}`,
      });
      steps.push({
        action: "wait_for_mutation",
        value: "15",
        reasoning: `Wait for ${profile?.demo_wow_moment ?? "output to appear"}`,
      });
      steps.push({
        action: "scroll",
        scroll_amount: 700,
        reasoning: "Reveal the generated output",
      });
    } else if (heroButton) {
      // No input but we have a hero CTA — CLICK it (still real interaction)
      steps.push({
        action: "scroll",
        scroll_amount: 300,
        reasoning: "Reveal the hero section",
      });
      steps.push({
        action: "click",
        aria_name: heroButton,
        selector_strategy: "button_text",
        selector_value: heroButton,
        reasoning: `Click the primary CTA "${heroButton}" to start the demo`,
      });
      steps.push({
        action: "wait_for_mutation",
        value: "8",
        reasoning: "Wait for the interface to respond",
      });
    } else {
      // Truly nothing actionable — at least scroll meaningfully
      steps.push({ action: "scroll", scroll_amount: 400, reasoning: `Reveal the ${profile?.product_name ?? "product"} hero section` });
      steps.push({ action: "scroll", scroll_amount: 800, reasoning: `Showcase ${profile?.core_action ?? "the product features"}` });
    }

    const catRank: Record<string, number> = {
      HERO_FEATURE: 5, EDITOR: 4, DASHBOARD: 3, FORM: 0, STATIC: 0, AUTH: -5,
    };
    const priorityPage = [...this.sitemap.values()]
      .filter((p) => p.url !== this.url && (p.demo_value ?? 0) >= 4)
      .sort((a, b) =>
        (catRank[b.category ?? "STATIC"] ?? 0) + (b.demo_value ?? 0) -
        (catRank[a.category ?? "STATIC"] ?? 0) - (a.demo_value ?? 0)
      )[0];

    if (priorityPage) {
      steps.push({
        action: "navigate",
        url: priorityPage.url,
        reasoning: `Visit ${priorityPage.title || priorityPage.url} to show the full product`,
      });
      steps.push({
        action: "scroll",
        value: "800",
        reasoning: "Showcase this page's content",
      });
    }

    return steps;
  }

  // ── Navigate helper ───────────────────────────────────────────────────────
  // Robust navigation: tries "load" (waits for JS to run), falls back to
  // "domcontentloaded", then waits extra time for SPA rendering.

  private async _navigateTo(page: Page, url: string): Promise<void> {
    try {
      await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    } catch {
      // fallback if "load" times out (e.g. site keeps loading resources forever)
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
      } catch {
        // best-effort — page might still have content
      }
    }
    // Wait for the body to have visible content (catches SPA hydration delay)
    await page.waitForSelector("body:not(:empty)", { timeout: 8_000 }).catch(() => {});
    // Extra pause so JS frameworks (React/Next.js) finish rendering
    await sleep(3000);
  }

  // ── Wait for user-provided input via Redis ────────────────────────────────

  private async _waitForUserInput(timeoutMs: number): Promise<string | null> {
    const { popUserInput } = await import("../redis");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const text = await popUserInput(this.jobId);
      if (text) return text;
      await sleep(2000);
    }
    return null;
  }

  // ── Find element coordinates from sitemap (for coordinate-based clicks) ──

  private _findInputCoords(): { x: number; y: number } | null {
    for (const [, pageInfo] of this.sitemap) {
      for (const el of pageInfo.interactive_elements ?? []) {
        if (el.isInput || el.role === "textarea" || el.role === "textbox" || el.placeholder) {
          return { x: el.x, y: el.y };
        }
      }
    }
    return null;
  }

  // ── Smooth scroll — increments of 150px with 100ms delays ────────────────

  private async _smoothScroll(page: Page, totalPx: number): Promise<void> {
    const step = 150;
    let scrolled = 0;
    while (scrolled < totalPx) {
      const chunk = Math.min(step, totalPx - scrolled);
      await page.mouse.wheel(0, chunk);
      scrolled += chunk;
      await sleep(100);
    }
    await sleep(600); // brief pause after scroll settles
  }

  // ── Smart DOM-change wait — polls every 500ms instead of fixed sleep ──────

  private async _waitForDOMChange(page: Page, timeoutMs = 8000): Promise<void> {
    try {
      const initial = await page.evaluate(() => document.body.innerHTML.length);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await sleep(500);
        const current = await page.evaluate(() => document.body.innerHTML.length);
        if (current !== initial) {
          await sleep(1500); // let the new content finish rendering
          return;
        }
      }
    } catch {
      await sleep(3000); // fallback if evaluate fails
    }
  }

  // ── Execute action ────────────────────────────────────────────────────────

  private async _performAction(page: Page, step: PlanStep, stepIndex: number): Promise<boolean> {
    // ActionRegistry guardrail: skip click/type if exact action was already done
    // (Scroll, wait, navigate, wait_for_mutation are idempotent — never skipped.)
    if (step.action === "click" || step.action === "type") {
      const sel = step.selector_value || step.aria_name || "";
      if (sel) {
        const id = this._actionId(page.url(), sel, step.action);
        if (this.actionHistory.has(id) || this.blacklist.has(id)) {
          await this.emit("action_skipped", { reason: "already_performed", id, step: stepIndex });
          return false;
        }
        this.actionHistory.add(id);
      }
    }

    const originalAction = step.action;
    try {
      // Snapshot state BEFORE action so we can detect redundant clicks
      const beforeState =
        originalAction === "click" ? await this._snapshotState(page) : null;

      switch (step.action) {
        case "navigate": {
          await this._navigateTo(page, step.url ?? this.url);
          break;
        }

        case "click": {
          if (!step.aria_name) return false;

          // Strip decorative characters (→, •, «, emoji, etc.) that break matching
          const cleanName = step.aria_name.replace(/[^\w\s'-]/g, "").trim();
          const fullRe  = new RegExp(escapeRe(step.aria_name), "i");
          const cleanRe = new RegExp(escapeRe(cleanName), "i");

          // Try every likely element type — modern sites rarely use plain <button>
          const candidates = [
            page.getByRole("button", { name: fullRe }).first(),
            page.getByRole("link",   { name: fullRe }).first(),
            page.getByRole("button", { name: cleanRe }).first(),
            page.getByRole("link",   { name: cleanRe }).first(),
            page.locator(`a:has-text("${cleanName}")`).first(),
            page.locator(`button:has-text("${cleanName}")`).first(),
            page.locator(`[role="button"]:has-text("${cleanName}")`).first(),
            page.locator(`[role="tab"]:has-text("${cleanName}")`).first(),
            page.getByText(cleanName, { exact: false }).first(),
          ];

          let clicked = false;
          for (const loc of candidates) {
            try {
              if ((await loc.count()) && (await loc.isVisible())) {
                await loc.scrollIntoViewIfNeeded();
                await loc.hover();
                await sleep(200);
                await loc.click({ timeout: 6000 });
                // Wait for any navigation or animation triggered by the click
                await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
                await sleep(2000);
                clicked = true;
                break;
              }
            } catch { continue; }
          }
          return clicked;
        }

        case "type": {
          // Prefer selector_value (from deep-analyse) over aria_name (legacy)
          const name = step.selector_value || step.aria_name || "";
          const strategy = step.selector_strategy ?? "placeholder";
          const defaultText = step.value || "Build a modern hotel booking dashboard with dark theme";
          const nameIsUsable = name.trim().split(/\s+/).length <= 4;

          const tryType = async (text: string): Promise<boolean> => {
            const nameRe = nameIsUsable && name ? new RegExp(escapeRe(name), "i") : null;
            const selectors = [
              // Strategy-aware primary selectors
              ...(nameRe && strategy === "placeholder"
                ? [page.getByPlaceholder(nameRe).first(), page.locator(`[placeholder*="${name}" i]`).first()]
                : []),
              ...(nameRe && strategy === "aria_label"
                ? [page.getByLabel(nameRe).first()]
                : []),
              ...(nameRe && strategy === "text"
                ? [page.getByText(name, { exact: false }).first()]
                : []),
              // Generic fallbacks
              ...(nameRe && strategy === "placeholder"
                ? [page.locator(`[aria-placeholder*="${name}" i]`).first()]
                : []),
              page.locator("textarea:visible").first(),
              page.getByRole("textbox").first(),
              page.locator('[contenteditable="true"]:visible').first(),
              page.locator("input[type=text]:visible").first(),
              page.locator("input[type=search]:visible").first(),
              page.locator("input[type=email]:visible").first(),
              page.locator("input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):visible").first(),
            ];
            for (const loc of selectors) {
              try {
                if ((await loc.count()) && (await loc.isVisible())) {
                  await loc.scrollIntoViewIfNeeded();
                  await loc.click();
                  await sleep(300);
                  await loc.pressSequentially(text, { delay: 40 }); // human-like typing
                  await sleep(300);
                  await loc.press("Enter");
                  await this._waitForDOMChange(page, 8000); // smart wait for output
                  return true;
                }
              } catch { continue; }
            }
            return false;
          };

          let typed = await tryType(defaultText);

          // Coordinate-based fallback — use discovered element positions from planning
          if (!typed) {
            const coords = this._findInputCoords();
            if (coords) {
              try {
                await page.mouse.click(coords.x, coords.y);
                await sleep(300);
                await page.keyboard.type(defaultText, { delay: 25 });
                await page.keyboard.press("Enter");
                await sleep(4000);
                typed = true;
              } catch { /* fall through to user prompt */ }
            }
          }

          // Ask the user to provide the text — never skip a type step
          if (!typed) {
            await this.emit("input_required", {
              step_index: stepIndex,
              message: `Could not find the text input automatically. Type your demo text below and click Submit — the agent will use it to continue recording.`,
              default_value: defaultText,
            });

            const userText = await this._waitForUserInput(120_000);
            if (userText) {
              // One more attempt with user-provided text
              typed = await tryType(userText);
              if (!typed) {
                // Last resort: coordinate click with user text
                const coords = this._findInputCoords();
                if (coords) {
                  try {
                    await page.mouse.click(coords.x, coords.y);
                    await sleep(300);
                    await page.keyboard.type(userText, { delay: 25 });
                    await page.keyboard.press("Enter");
                    await sleep(4000);
                    typed = true;
                  } catch { /* give up gracefully */ }
                }
              }
            }
          }

          // Return success even if typing ultimately failed — don't drop the step
          // from the video; the recording continues regardless
          return typed;
        }

        case "scroll": {
          const amount = step.scroll_amount ?? (parseInt(step.value ?? "700", 10) || 700);
          await this._smoothScroll(page, amount);
          break;
        }

        case "wait": {
          const ms = Math.min(parseInt(step.value ?? "3", 10) * 1000, 10_000);
          await sleep(ms);
          break;
        }

        case "wait_for_mutation": {
          const maxMs = Math.min(parseInt(step.value ?? "15", 10) * 1000, 15_000);
          await this._waitForDOMChange(page, maxMs);
          break;
        }
      }

      // Post-click state-change check: if the click produced nothing, blacklist
      // it so any later step that resolves to the same selector won't re-try.
      if (originalAction === "click" && beforeState) {
        const after = await this._snapshotState(page);
        const change = this._detectChange(beforeState, after);
        if (!change.changed) {
          const sel = step.selector_value || step.aria_name || "";
          if (sel) {
            this.blacklist.add(this._actionId(page.url(), sel, "click"));
            await this.emit("action_blacklisted", { reason: "no_state_change", step: stepIndex });
          }
        }
      }

      return true;
    } catch {
      return false;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
