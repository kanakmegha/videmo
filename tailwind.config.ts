import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  "#f0f9ff",
          100: "#e0f2fe",
          400: "#38bdf8",
          500: "#0ea5e9",
          600: "#0284c7",
          700: "#0369a1",
        },
      },
      animation: {
        "fade-in":    "fadeIn 0.4s ease forwards",
        "slide-up":   "slideUp 0.35s ease forwards",
        "pulse-dot":  "pulseDot 1.4s ease-in-out infinite",
        "scan-line":  "scanLine 2s linear infinite",
      },
      keyframes: {
        fadeIn:    { from: { opacity: "0" },            to: { opacity: "1" } },
        slideUp:   { from: { opacity: "0", transform: "translateY(12px)" }, to: { opacity: "1", transform: "translateY(0)" } },
        pulseDot:  { "0%,100%": { opacity: "1" }, "50%": { opacity: "0.3" } },
        scanLine:  { from: { transform: "translateY(-100%)" }, to: { transform: "translateY(100vh)" } },
      },
    },
  },
  plugins: [],
};

export default config;
