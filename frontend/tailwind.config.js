/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "rgb(var(--c-ink) / <alpha-value>)",
        coal: "rgb(var(--c-coal) / <alpha-value>)",
        ash: "rgb(var(--c-ash) / <alpha-value>)",
        bone: "rgb(var(--c-bone) / <alpha-value>)",
        dim: "rgb(var(--c-dim) / <alpha-value>)",
        blood: "rgb(var(--c-blood) / <alpha-value>)",
        ember: "rgb(var(--c-ember) / <alpha-value>)",
      },
      fontFamily: {
        display: ['"Cormorant Garamond"', "Georgia", "serif"],
        mono: ['"IBM Plex Mono"', "ui-monospace", "Menlo", "monospace"],
      },
      boxShadow: { glow: "0 0 40px -8px rgb(var(--c-blood) / 0.55)" },
    },
  },
  plugins: [],
};
