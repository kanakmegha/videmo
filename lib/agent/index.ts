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
    // Sort pages: product/feature/ai/template pages first, then by demo_value
    const allPages = [...this.sitemap.values()].sort((a, b) => {
      const featureScore = (p: PageInfo) =>
        /product|features?|ai|templates?|pricing|showcase|demo|tour/i.test(p.url) ? 10 : 0;
      return (
        featureScore(b) + (b.demo_value ?? 0) - (featureScore(a) + (a.demo_value ?? 0))
      );
    });

    const pageList = allPages
      .map((p) => `  - ${p.url} | "${p.purpose || p.title}" | demo_value=${p.demo_value ?? "?"}/10`)
      .join("\n");

    const startInfo = this.sitemap.get(this.url);
    const startElements = (startInfo?.interactive_elements ?? []).slice(0, 25);

    // Detect hero input for AI tools (textarea/textbox on landing page)
    const heroInputEl = startElements.find(
      (el) => el.isInput || el.role === "textarea" || el.role === "textbox" || el.placeholder
    );

    // Best 2 feature pages (not the root URL)
    const featurePages = allPages.filter((p) => p.url !== this.url).slice(0, 2);

    const elementNames = startElements
      .map((e) => e.placeholder || e.name)
      .filter(Boolean)
      .slice(0, 15);

    const prompt = [
      "You are making a 60-second PRODUCT DEMO screen-recording for a potential customer.",
      "Your goal: show the product WORKING and delivering value — not marketing copy.",
      "",
      `Product URL: ${this.url}`,
      `Discovered pages (sorted by demo value):`,
      pageList,
      "",
      heroInputEl
        ? `Hero input found on landing page: placeholder="${heroInputEl.placeholder || heroInputEl.name}" (use this exact string as aria_name for the type step)`
        : "No text input on landing page — do NOT add a type step.",
      "",
      `Landing page clickable elements: ${JSON.stringify(elementNames)}`,
      `Best feature pages to visit: ${featurePages.map((p) => p.url).join(", ") || "none beyond root"}`,
      "",
      "=== DEMO SCRIPT RULES ===",
      `Step 1: action=navigate, url="${this.url}" — always start here.`,
      heroInputEl
        ? `Step 2: action=type, aria_name="${heroInputEl.placeholder || heroInputEl.name}", value="Build a modern hotel booking dashboard with dark theme" — use the hero input.`
        : `Step 2: action=scroll, value="700" — scroll to reveal the hero product screenshots.`,
      heroInputEl
        ? "Step 3: action=wait, value=\"6\" — wait for AI output."
        : `Step 3: action=scroll, value="1400" — continue scrolling to show core features.`,
      featurePages[0]
        ? `Step 4: action=navigate, url="${featurePages[0].url}" — go to the best feature page.`
        : "Step 4: action=scroll, value=\"2100\" — scroll deeper to show more features.",
      "Step 5: action=scroll, value=\"800\" — scroll through that page's feature sections.",
      featurePages[1]
        ? `Step 6 (optional): action=navigate, url="${featurePages[1].url}" — show a second feature area.`
        : "Step 6 (optional): action=scroll, value=\"1600\" — continue revealing features.",
      "Step 7 (optional): action=scroll, value=\"800\" — final scroll to show more.",
      "",
      "=== STRICT RULES ===",
      "- action must be EXACTLY one of: navigate, click, type, scroll, wait",
      "- NEVER click Home, Login, Sign up, or general nav links — these hide features not show them",
      "- NEVER click a link just to navigate when you can use action=navigate with the url directly",
      "- Only use action=click if there is a 'See how it works', 'Watch demo', or interactive feature button",
      "- aria_name must be the EXACT string from the element list above, not a description",
      "- 5–7 steps total",
      "- reasoning must explain WHAT PRODUCT FEATURE this step demonstrates",
      "",
      "OUTPUT: one raw JSON array, no markdown, no explanation:",
      '[{"action":"navigate","url":"...","aria_name":"","value":"","reasoning":"..."}]',
    ].join("\n");

    try {
      const reply = await askLLM(prompt, undefined, true);
      if (!reply) throw new Error("Empty LLM response");
      const m = reply.match(/\[[\s\S]*\]/);
      if (!m) throw new Error(`No JSON array found. LLM said: ${reply.slice(0, 200)}`);
      const raw = JSON.parse(m[0]) as PlanStep[];
      if (!Array.isArray(raw) || raw.length === 0) throw new Error("Empty plan");
      const steps = raw.map((s) => ({
        ...s,
        action: (s.action ?? "scroll").split(/[|\s]/)[0].toLowerCase().trim() as PlanStep["action"],
      }));
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

    // Prefer product/feature pages over generic pages
    const priorityPage = [...this.sitemap.values()]
      .filter((p) => p.url !== this.url)
      .sort((a, b) => {
        const featureScore = (p: PageInfo) =>
          /product|features?|ai|templates?|showcase|demo|tour/i.test(p.url) ? 10 : 0;
        return featureScore(b) + (b.demo_value ?? 0) - (featureScore(a) - (a.demo_value ?? 0));
      })[0];

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

  // ── Execute action ────────────────────────────────────────────────────────

  private async _performAction(page: Page, step: PlanStep, stepIndex: number): Promise<boolean> {
    try {
      switch (step.action) {
        case "navigate": {
          await this._navigateTo(page, step.url ?? this.url);
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
          const defaultText = step.value || "Build a modern hotel booking dashboard with dark theme";
          const nameIsUsable = name.trim().split(/\s+/).length <= 4;

          const tryType = async (text: string): Promise<boolean> => {
            const selectors = [
              ...(nameIsUsable && name
                ? [
                    page.getByPlaceholder(new RegExp(escapeRe(name), "i")).first(),
                    page.getByLabel(new RegExp(escapeRe(name), "i")).first(),
                    page.locator(`[aria-placeholder*="${name}" i]`).first(),
                    page.locator(`[placeholder*="${name}" i]`).first(),
                  ]
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
                  await loc.fill(text);
                  await sleep(400);
                  await loc.press("Enter");
                  await sleep(4000);
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
