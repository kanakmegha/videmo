import { copyFile, mkdtemp, readFile, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import OpenAI from "openai";
import type { BrowserContext, Page } from "playwright-core";
import type { PlanStep, PageInfo } from "../types";

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
      const resp = await llm.chat.completions.create({
        model,
        messages: [{ role: "user", content }],
        max_tokens: 1200,
        timeout: 20_000,
      });
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

const DOM_SCRIPT = `(() => {
  const seen = new Set();
  const items = [];
  document.querySelectorAll(
    'button, a[href], input, textarea, [role="button"], [role="textbox"], [contenteditable="true"]'
  ).forEach((el, i) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const s = getComputedStyle(el);
    if (s.display==='none'||s.visibility==='hidden'||s.opacity==='0') return;
    const name = (el.innerText||el.value||el.placeholder||
      el.getAttribute('aria-label')||el.getAttribute('aria-placeholder')||'').trim().slice(0,100);
    if (!name || seen.has(name)) return;
    seen.add(name);
    items.push({
      id:'el-'+i, name,
      role: el.getAttribute('role')||el.tagName.toLowerCase(),
      aria_label: el.getAttribute('aria-label')||'',
      placeholder: el.placeholder||el.getAttribute('aria-placeholder')||'',
      x: Math.round(r.left+r.width/2),
      y: Math.round(r.top+r.height/2),
      isInput: ['INPUT','TEXTAREA'].includes(el.tagName) || el.getAttribute('contenteditable')==='true',
    });
    if (items.length>=80) return;
  });
  return items;
})()`;

// ── DemoAgent ─────────────────────────────────────────────────────────────────

type Emit = (type: string, data: Record<string, unknown>) => void;

// Stable directory for local video serving (persists across requests)
const LOCAL_VIDEO_DIR = join(tmpdir(), "demogen-videos");

export class DemoAgent {
  private sitemap = new Map<string, PageInfo>();

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

      await this.emit("phase", { phase: "plan", message: "Building action plan…" });
      const steps = await this._plan();
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
        const ok = await this._performAction(page, step);
        await this.emit("step_complete", { index: i, success: ok });
        await sleep(1200);
      }

      // Finalise: close page so Playwright flushes the video file
      const videoPath = await page.video()?.path();
      await page.close();
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
            "1. One-sentence purpose?\n" +
            "2. Demo Value 1-10 (AI tool/interactive=10, legal/error=1)?\n" +
            "Format EXACTLY: Purpose: [text] | Value: [number]",
          b64,
          false // use vision model
        );

        const m = reply.match(/Purpose:\s*(.+?)\s*\|\s*Value:\s*(\d+)/i);
        if (m) {
          const hasInput = info.interactive_elements?.some(
            (el) => el.isInput || el.placeholder || el.role === "textbox"
          );
          info.purpose = m[1].trim();
          info.demo_value = Math.min(10, parseInt(m[2], 10) + (hasInput ? 2 : 0));
          await this.emit("page_scored", {
            url,
            purpose: info.purpose,
            value: info.demo_value,
          });
        } else {
          // Even if LLM returns garbage, emit something so the UI has context
          await this.emit("score_error", {
            url,
            error: "LLM did not return expected format",
          });
        }
      } catch (e) {
        await this.emit("score_error", { url, error: String(e) });
      }
    }
  }

  // ── Plan ─────────────────────────────────────────────────────────────────

  private async _plan(): Promise<PlanStep[]> {
    const pageList = [...this.sitemap.values()]
      .map(
        (p) =>
          `  - ${p.url}: ${p.purpose || p.title} (demo_value=${p.demo_value ?? "?"}/10)`
      )
      .join("\n");

    const startInfo = this.sitemap.get(this.url);
    const startElements = (startInfo?.interactive_elements ?? []).slice(0, 30);

    const prompt =
      "You are a Senior Product Demo Director. Create a compelling, specific demo script.\n\n" +
      `Target site: ${this.url}\n` +
      `Discovered pages:\n${pageList}\n\n` +
      `Landing page elements (use these exact names):\n${JSON.stringify(startElements, null, 2)}\n\n` +
      "SCRIPT RULES:\n" +
      "1. navigate to the start URL first.\n" +
      "2. Find and TYPE into the main hero input/AI prompt box.\n" +
      "   Use this demo value: 'Build a modern hotel booking dashboard with dark theme'\n" +
      "3. Add a wait step (value: 5) for AI to generate.\n" +
      "4. scroll down to reveal the full generated output.\n" +
      "5. Navigate to the highest demo_value secondary page.\n" +
      "6. scroll to showcase that page's features.\n" +
      "7. 5–8 steps total. Use exact element names from the list above.\n\n" +
      "OUTPUT: a single raw JSON array, no markdown, no explanation:\n" +
      '[{"action":"navigate|click|type|scroll|wait","url":"...","aria_name":"...","value":"...","reasoning":"..."}]';

    try {
      const reply = await askLLM(prompt, undefined, true); // text-only, faster
      if (!reply) throw new Error("Empty LLM response");
      const m = reply.match(/\[[\s\S]*\]/);
      if (!m) throw new Error(`No JSON array found. LLM said: ${reply.slice(0, 200)}`);
      const steps = JSON.parse(m[0]) as PlanStep[];
      if (!Array.isArray(steps) || steps.length === 0) throw new Error("Empty plan");
      await this.emit("plan_llm", { used: true, steps: steps.length });
      return steps;
    } catch (e) {
      await this.emit("plan_fallback", {
        used: true,
        error: String(e),
        message: "LLM planning failed — using smart element-based fallback",
      });
      return this._buildSmartFallback();
    }
  }

  // ── Smart fallback: builds a real plan from discovered element data ────────

  private _buildSmartFallback(): PlanStep[] {
    const steps: PlanStep[] = [];
    const mainPage = this.sitemap.get(this.url);

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

    if (heroInput) {
      steps.push({
        action: "type",
        aria_name: heroInput.placeholder || heroInput.name || heroInput.aria_label,
        value: "Build a modern hotel booking dashboard with dark theme",
        reasoning: `Type a demo prompt into the hero input "${heroInput.name}"`,
      });
      steps.push({
        action: "wait",
        value: "5",
        reasoning: "Wait for AI generation to complete",
      });
      steps.push({
        action: "scroll",
        value: "800",
        reasoning: "Scroll to reveal the generated output",
      });
      steps.push({
        action: "scroll",
        value: "1600",
        reasoning: "Continue scrolling to show the full result",
      });
    } else {
      // No input found — explore the page with scrolls
      steps.push({ action: "scroll", value: "700",  reasoning: "Explore the landing page" });
      steps.push({ action: "scroll", value: "1400", reasoning: "Show more features" });
      steps.push({ action: "scroll", value: "2100", reasoning: "Reveal footer and CTAs" });
    }

    // Navigate to the highest-value secondary page
    const secondary = [...this.sitemap.values()]
      .filter((p) => p.url !== this.url)
      .sort((a, b) => (b.demo_value ?? 0) - (a.demo_value ?? 0))[0];

    // Prefer pricing or features pages even if not scored
    const priorityPage =
      secondary ??
      [...this.sitemap.values()].find(
        (p) =>
          p.url !== this.url &&
          /pricing|features|enterprise|plans/i.test(p.url)
      );

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

  // ── Execute action ────────────────────────────────────────────────────────

  private async _performAction(page: Page, step: PlanStep): Promise<boolean> {
    try {
      switch (step.action) {
        case "navigate": {
          await page.goto(step.url ?? this.url, {
            waitUntil: "domcontentloaded",
            timeout: 20_000,
          });
          await sleep(2000);
          break;
        }

        case "click": {
          if (!step.aria_name) return false;
          const re = new RegExp(escapeRe(step.aria_name), "i");
          const loc = page.getByRole("button", { name: re }).first();
          if (!(await loc.count())) {
            const fallback = page.getByText(step.aria_name, { exact: false }).first();
            if (!(await fallback.count())) return false;
            await fallback.click({ timeout: 5000 });
          } else {
            await loc.scrollIntoViewIfNeeded();
            await loc.hover();
            await sleep(300);
            await loc.click({ timeout: 5000 });
          }
          await sleep(1500);
          break;
        }

        case "type": {
          const name = step.aria_name ?? "";
          const text = step.value || "Build a modern hotel booking dashboard with dark theme";

          // Try progressively broader selectors until one sticks
          const selectors = [
            ...(name
              ? [
                  page.getByPlaceholder(new RegExp(escapeRe(name), "i")).first(),
                  page.getByLabel(new RegExp(escapeRe(name), "i")).first(),
                  page.locator(`[aria-placeholder*="${name}" i]`).first(),
                ]
              : []),
            page.locator("textarea").first(),
            page.getByRole("textbox").first(),
            page.locator('[contenteditable="true"]').first(),
            page.locator("input[type=text]").first(),
          ];

          let typed = false;
          for (const loc of selectors) {
            try {
              if ((await loc.count()) && (await loc.isVisible())) {
                await loc.scrollIntoViewIfNeeded();
                await loc.click();
                await sleep(200);
                await loc.fill(text);
                await sleep(400);
                await loc.press("Enter");
                await sleep(4000); // wait for AI response
                typed = true;
                break;
              }
            } catch {
              continue;
            }
          }
          if (!typed) return false;
          break;
        }

        case "scroll": {
          const amount = parseInt(step.value ?? "700", 10) || 700;
          await page.mouse.wheel(0, amount);
          await sleep(1000);
          break;
        }

        case "wait": {
          const ms = Math.min(parseInt(step.value ?? "3", 10) * 1000, 10_000);
          await sleep(ms);
          break;
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
