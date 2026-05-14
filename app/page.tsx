"use client";

import { useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  Globe,
  Sparkles,
  Video,
  CheckCircle2,
  ArrowRight,
  Zap,
  Shield,
  Star,
} from "lucide-react";

const EXAMPLE_URLS = ["v0.dev", "linear.app", "vercel.com", "notion.so"];

export default function HomePage() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;

    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }

      const { job_id } = await res.json();
      router.push(`/jobs/${job_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setLoading(false);
    }
  }

  return (
    <main className="flex-1 flex flex-col">
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 py-4 border-b border-zinc-800/50">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-brand-500 flex items-center justify-center">
            <Video className="w-4 h-4 text-white" />
          </div>
          <span className="font-bold text-zinc-100">DemoGen</span>
        </div>
        <div className="flex items-center gap-6">
          <a href="#how-it-works" className="text-sm text-zinc-400 hover:text-zinc-100 transition-colors">
            How it works
          </a>
          <a href="#pricing" className="text-sm text-zinc-400 hover:text-zinc-100 transition-colors">
            Pricing
          </a>
          <button className="btn-secondary text-xs px-4 py-2">Sign in</button>
        </div>
      </nav>

      {/* Hero */}
      <section className="flex-1 flex flex-col items-center justify-center px-4 py-24 text-center relative overflow-hidden">
        {/* Background glow */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-brand-500/10 rounded-full blur-[100px]" />
        </div>

        <div className="relative z-10 max-w-3xl mx-auto">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-brand-500/10 border border-brand-500/20 text-brand-400 text-xs font-medium mb-8">
            <Sparkles className="w-3 h-3" />
            AI-powered demo generation
          </div>

          <h1 className="text-5xl sm:text-6xl font-extrabold tracking-tight mb-6 leading-tight">
            Turn any website into a{" "}
            <span className="gradient-text">stunning demo video</span>
          </h1>

          <p className="text-lg text-zinc-400 mb-10 max-w-xl mx-auto leading-relaxed">
            Paste a URL. Our AI crawls the site, devises a cinematic action plan, and
            records a polished demo video — in minutes, not hours.
          </p>

          {/* URL Form */}
          <form onSubmit={handleSubmit} className="max-w-xl mx-auto w-full">
            <div className="flex gap-3 glass rounded-2xl p-2">
              <div className="flex items-center gap-2 pl-3 flex-1 min-w-0">
                <Globe className="w-4 h-4 text-zinc-500 shrink-0" />
                <input
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://your-product.com"
                  className="flex-1 bg-transparent border-none outline-none text-sm text-zinc-100 placeholder-zinc-500 min-w-0"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={loading}
                />
              </div>
              <button
                type="submit"
                disabled={loading || !url.trim()}
                className="btn-primary shrink-0"
              >
                {loading ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Starting…
                  </>
                ) : (
                  <>
                    Generate Demo
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </div>

            {error && (
              <p className="mt-3 text-sm text-red-400 text-left px-1">{error}</p>
            )}

            <div className="flex flex-wrap items-center justify-center gap-2 mt-4">
              <span className="text-xs text-zinc-600">Try:</span>
              {EXAMPLE_URLS.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => setUrl(`https://${ex}`)}
                  className="text-xs text-zinc-500 hover:text-brand-400 transition-colors underline underline-offset-2"
                >
                  {ex}
                </button>
              ))}
            </div>
          </form>

          {/* Trust badges */}
          <div className="flex flex-wrap items-center justify-center gap-6 mt-12 text-zinc-500 text-xs">
            <span className="flex items-center gap-1.5">
              <Shield className="w-3.5 h-3.5 text-emerald-500" /> No account required
            </span>
            <span className="flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 text-yellow-500" /> Results in 2–4 min
            </span>
            <span className="flex items-center gap-1.5">
              <Star className="w-3.5 h-3.5 text-brand-400" /> Works on any public URL
            </span>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="px-6 py-20 border-t border-zinc-800/50">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-2xl font-bold text-center mb-3">How it works</h2>
          <p className="text-center text-zinc-400 text-sm mb-12">Three phases, fully automated.</p>

          <div className="grid sm:grid-cols-3 gap-6">
            {STEPS.map((step, i) => (
              <div key={i} className="glass rounded-2xl p-6 flex flex-col gap-4">
                <div className="w-10 h-10 rounded-xl bg-brand-500/15 flex items-center justify-center">
                  <step.icon className="w-5 h-5 text-brand-400" />
                </div>
                <div>
                  <div className="text-xs text-zinc-500 font-medium mb-1">Step {i + 1}</div>
                  <h3 className="font-semibold text-sm mb-2">{step.title}</h3>
                  <p className="text-xs text-zinc-400 leading-relaxed">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="px-6 py-20 border-t border-zinc-800/50">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-2xl font-bold text-center mb-3">Simple pricing</h2>
          <p className="text-center text-zinc-400 text-sm mb-12">Start free. Scale as you grow.</p>

          <div className="grid sm:grid-cols-3 gap-6">
            {PLANS.map((plan, i) => (
              <div
                key={i}
                className={`glass rounded-2xl p-6 flex flex-col gap-5 ${
                  plan.highlight ? "border-brand-500/50 ring-1 ring-brand-500/20" : ""
                }`}
              >
                {plan.highlight && (
                  <div className="badge bg-brand-500/15 text-brand-400 border border-brand-500/20 w-fit">
                    Most popular
                  </div>
                )}
                <div>
                  <h3 className="font-bold text-lg">{plan.name}</h3>
                  <div className="text-3xl font-extrabold mt-1">
                    {plan.price}
                    {plan.price !== "Free" && (
                      <span className="text-sm font-normal text-zinc-400">/mo</span>
                    )}
                  </div>
                </div>
                <ul className="space-y-2 flex-1">
                  {plan.features.map((f, j) => (
                    <li key={j} className="flex items-center gap-2 text-sm text-zinc-300">
                      <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                      {f}
                    </li>
                  ))}
                </ul>
                <button className={plan.highlight ? "btn-primary w-full justify-center" : "btn-secondary w-full justify-center"}>
                  {plan.cta}
                </button>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-zinc-800/50 px-6 py-6 flex items-center justify-between text-xs text-zinc-600">
        <span>© 2025 DemoGen. All rights reserved.</span>
        <div className="flex gap-4">
          <a href="#" className="hover:text-zinc-400 transition-colors">Privacy</a>
          <a href="#" className="hover:text-zinc-400 transition-colors">Terms</a>
        </div>
      </footer>
    </main>
  );
}

const STEPS = [
  {
    icon: Globe,
    title: "AI Crawls & Analyses",
    desc: "The agent discovers pages, scores them by demo value, and identifies key interactive elements.",
  },
  {
    icon: Sparkles,
    title: "Plan is Presented",
    desc: "A step-by-step action plan is shown to you before anything runs. Review and approve it.",
  },
  {
    icon: Video,
    title: "Demo is Recorded",
    desc: "The agent executes the plan in a headless browser, producing a cinematic .webm video.",
  },
];

const PLANS = [
  {
    name: "Free",
    price: "Free",
    highlight: false,
    cta: "Get started",
    features: ["3 demo videos / month", "720p resolution", "Public sharing link", "Community support"],
  },
  {
    name: "Pro",
    price: "$19",
    highlight: true,
    cta: "Start free trial",
    features: ["50 demo videos / month", "1080p resolution", "Custom branding", "Priority queue", "Email support"],
  },
  {
    name: "Team",
    price: "$79",
    highlight: false,
    cta: "Contact us",
    features: ["Unlimited demos", "4K resolution", "Custom domain", "Team workspace", "Dedicated support"],
  },
];
