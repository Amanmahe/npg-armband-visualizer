import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        highlight: "hsl(var(--highlight))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        input: "hsl(var(--input))",
      },
      keyframes: {
        blink: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.25" },
        },
        "fade-in-right": {
          "0%": { opacity: "0", transform: "translateX(4px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
      },
      animation: {
        blink: "blink 1.2s ease-in-out infinite",
        "fade-in-right": "fade-in-right 0.15s ease-out",
      },
    },
  },
  plugins: [],
};

export default config;
