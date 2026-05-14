import { mkdir, mkdtemp, readFile, rm } from "fs/promises";
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

const VISION_MODELS = [
  "meta-llama/Llama-3.2-11B-Vision-Instruct",
  "meta-llama/Llama-3.2-90B-Vision-Instruct",
  "Qwen/Qwen2-VL-7B-Instruct",
];

async function askLLM(prompt: string, b64Img?: string): Promise<string> {
  const content: OpenAI.ChatCompletionContentPart[] = [
    { type: "text", text: prompt },
  ];
  if (b64Img) {
    content.push({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${b64Img}` },
    });
  }
  for (const model of VISION_MODELS) {
    try {
      const resp = await llm.chat.completions.create({
        model,
        messages: [{ role: "user", content }],
        max_tokens: 900,
      });
      return resp.choices[0]?.message.content ?? "";
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
  let executablePath: string;
  let extraArgs: string[] = [];

  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    // Serverless: use @sparticuz/chromium (pre-built minimal binary)
    const chromium = (await import("@sparticuz/chromium")).default;
    executablePath = await chromium.executablePath();
    extraArgs = chromium.args;
  } else {
    // Local dev: use playwright's own installed chromium
    const { execSync } = await import("child_process");
    try {
      executablePath = execSync(
        "node -e \"const {chromium}=require('playwright');chromium.executablePath().then(console.log)\"",
        { encoding: "utf8" }
      ).trim();
    } catch {
      executablePath = "";
    }
  }

  const { chromium } = await import("playwright-core");

  return chromium.launchPersistentContext(profileDir, {
    executablePath: executablePath || undefined,
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

// ── DOM extraction script ─────────────────────────────────────────────────────

const DOM_SCRIPT = `(() => {
  const seen = new Set();
  const items = [];
  document.querySelectorAll(
    'button, a[href], input, textarea, [role="button"], [role="textbox"]'
  ).forEach((el, i) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const s = getComputedStyle(el);
    if (s.display==='none'||s.visibility==='hidden'||s.opacity==='0') return;
    const name = (el.innerText||el.value||el.placeholder||
      el.getAttribute('aria-label')||'').trim().slice(0,80);
    if (!name || seen.has(name)) return;
    seen.add(name);
    items.push({
      id:'el-'+i, name,
      role: el.getAttribute('role')||el.tagName.toLowerCase(),
      aria_label: el.getAttribute('aria-label')||'',
      placeholder: el.placeholder||'',
      x: Math.round(r.left+r.width/2),
      y: Math.round(r.top+r.height/2),
    });
    if (items.length>=60) return;
  });
  return items;
})()`;

// ── DemoAgent ─────────────────────────────────────────────────────────────────

type Emit = (type: string, data: Record<string, unknown>) => void;

export class DemoAgent {
  private sitemap = new Map<string, PageInfo>();

  constructor(
    private jobId: string,
    private url: string,
    private emit: Emit
  ) {}

  // ─ Phase 1: plan (discover + strategise + plan) ───────────────────────────

  async planPhase(): Promise<PlanStep[]> {
    const profileDir = await mkdtemp(join(tmpdir(), `dg-plan-`));
    let ctx: BrowserContext | null = null;
    try {
      ctx = await launchContext(profileDir);
      const page = ctx.pages()[0] ?? (await ctx.newPage());

      await this.emit("phase", { phase: "discover", message: "Crawling website…" });
      await this._discover(page);

      await this.emit("phase", { phase: "strategize", message: "Analysing pages…" });
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
    const profileDir = await mkdtemp(join(tmpdir(), `dg-exec-`));
    const videoDir   = await mkdtemp(join(tmpdir(), `dg-vid-`));
    let ctx: BrowserContext | null = null;
    try {
      ctx = await launchContext(profileDir, videoDir);
      const page = ctx.pages()[0] ?? (await ctx.newPage());

      await this.emit("phase", { phase: "execute", message: "Recording demo…" });

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        await this.emit("step_start", {
          index: i, total: steps.length,
          action: step.action,
          reasoning: step.reasoning ?? "",
          aria_name: step.aria_name ?? "",
          value: step.value ?? "",
        });
        const ok = await this._performAction(page, step);
        await this.emit("step_complete", { index: i, success: ok });
        await sleep(1200);
      }

      // Finalise video
      const videoPath = await page.video()?.path();
      await page.close();
      await ctx.close();
      ctx = null;

      if (!videoPath) return null;

      // Upload to Vercel Blob
      const { put } = await import("@vercel/blob");
      const fileData = await readFile(videoPath);
      const blob = await put(`demos/${this.jobId}.webm`, fileData, {
        access: "public",
        contentType: "video/webm",
        addRandomSuffix: false,
      });
      return blob.url;
    } finally {
      await ctx?.close().catch(() => {});
      await rm(profileDir, { recursive: true, force: true });
      await rm(videoDir,   { recursive: true, force: true });
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

        const elements: PageInfo["interactive_elements"] =
          (await page.evaluate(DOM_SCRIPT).catch(() => [])) as PageInfo["interactive_elements"];
        const title = await page.title();

        this.sitemap.set(url, { url, title, element_count: elements.length, interactive_elements: elements });
        await this.emit("page_found", { url, title, element_count: elements.length });

        if (depth < 1) {
          const hrefs: string[] = await page
            .$$eval("a[href]", (els) => els.map((el) => el.getAttribute("href") ?? ""))
            .catch(() => []);

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
    // Score at most 6 pages to stay within LLM budget / time limits
    const entries = [...this.sitemap.entries()].slice(0, 6);
    for (const [url, info] of entries) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
        await sleep(1000);
        const buf = await page.screenshot({ type: "jpeg", quality: 55 });
        const b64 = buf.toString("base64");

        const reply = await askLLM(
          `Analyse this webpage: ${url}\nTitle: ${info.title}\n\n` +
            "1. One-sentence purpose?\n" +
            "2. Demo Value 1-10 (AI/interactive=10, legal/404=1)?\n" +
            "Respond ONLY as: Purpose: [text] | Value: [number]",
          b64
        );

        const m = reply.match(/Purpose:\s*(.+?)\s*\|\s*Value:\s*(\d+)/);
        if (m) {
          const value = Math.min(10, parseInt(m[2], 10));
          const boost = info.interactive_elements?.some(
            (el) => el.placeholder || el.role === "textbox" || el.role === "textarea"
          )
            ? 2
            : 0;
          info.purpose = m[1].trim();
          info.demo_value = Math.min(10, value + boost);
          await this.emit("page_scored", {
            url,
            purpose: info.purpose,
            value: info.demo_value,
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
      .map((p) => `  - ${p.url}: ${p.purpose ?? "Unknown"} (value=${p.demo_value ?? 0}/10)`)
      .join("\n");

    const startElements = (
      this.sitemap.get(this.url)?.interactive_elements ?? []
    ).slice(0, 25);

    const prompt =
      "You are a Senior Product Demo Director. Output a compelling demo script.\n\n" +
      `Discovered Pages:\n${pageList}\n\n` +
      `Start URL: ${this.url}\n` +
      `Landing page elements:\n${JSON.stringify(startElements, null, 2)}\n\n` +
      "RULES:\n" +
      "1. Step 1: navigate to start URL.\n" +
      "2. Find the hero input (AI prompt / search / signup box) and TYPE:\n" +
      "   'Build a modern SaaS dashboard with dark theme'\n" +
      "3. Add a wait step for AI generation.\n" +
      "4. Scroll to reveal the full output.\n" +
      "5. Navigate to the highest-value secondary page.\n" +
      "6. 5–8 steps total. Be precise about element names.\n\n" +
      "OUTPUT: raw JSON array only — no markdown:\n" +
      '[{"action":"navigate|click|type|scroll|wait","url":"...","aria_name":"...","value":"...","reasoning":"..."}]';

    try {
      const reply = await askLLM(prompt);
      const m = reply.match(/\[[\s\S]*\]/);
      if (!m) throw new Error("No JSON array in LLM response");
      const steps = JSON.parse(m[0]) as PlanStep[];
      await this.emit("plan_fallback", { used: false });
      return steps;
    } catch (e) {
      await this.emit("plan_fallback", { used: true, error: String(e) });
      return [
        { action: "navigate", url: this.url, reasoning: "Open the website" },
        { action: "scroll", value: "700", reasoning: "Explore landing page" },
        { action: "scroll", value: "1400", reasoning: "Show more features" },
      ];
    }
  }

  // ── Execute action ────────────────────────────────────────────────────────

  private async _performAction(page: Page, step: PlanStep): Promise<boolean> {
    try {
      switch (step.action) {
        case "navigate": {
          const target = step.url ?? this.url;
          await page.goto(target, { waitUntil: "domcontentloaded", timeout: 20_000 });
          await sleep(2000);
          break;
        }
        case "click": {
          if (!step.aria_name) return false;
          const re = new RegExp(escapeRe(step.aria_name), "i");
          const loc =
            page.getByRole("button", { name: re }).first() ??
            page.getByText(step.aria_name, { exact: false }).first();
          if (!(await loc.count())) return false;
          await loc.scrollIntoViewIfNeeded();
          await loc.hover();
          await sleep(300);
          await loc.click({ timeout: 5000 });
          await sleep(1500);
          break;
        }
        case "type": {
          const candidates = step.aria_name
            ? [
                page.getByPlaceholder(new RegExp(escapeRe(step.aria_name), "i")).first(),
                page.getByLabel(new RegExp(escapeRe(step.aria_name), "i")).first(),
              ]
            : [];
          candidates.push(page.getByRole("textbox").first());
          candidates.push(page.locator("textarea").first());

          for (const loc of candidates) {
            try {
              if ((await loc.count()) && (await loc.isVisible())) {
                await loc.scrollIntoViewIfNeeded();
                await loc.hover();
                await sleep(200);
                const text =
                  step.value || "Build a modern SaaS dashboard with dark theme";
                await loc.fill(text);
                await sleep(400);
                await loc.press("Enter");
                await sleep(3500);
                break;
              }
            } catch {
              continue;
            }
          }
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
