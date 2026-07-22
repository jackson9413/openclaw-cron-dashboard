/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: "#0a0a0b",
        panel: "#15151a",
        border: "#26262e",
        muted: "#8a8a96",
        accent: "#7c9aff",
        ok: "#5ad19a",
        warn: "#f5b942",
        err: "#ef5b5b",
      },
    },
  },
  plugins: [],
};
