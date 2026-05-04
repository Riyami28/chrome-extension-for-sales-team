/** @type {import('tailwindcss').Config}
 *
 * ZopDev design-system bridge.
 *
 * Rather than sweep every V1 component's Tailwind classes, we remap the
 * scales the existing code already uses so the whole app inherits the
 * brand automatically:
 *
 *   slate-*   → ZopDev ink/line ladder (cream text on dark surfaces)
 *   violet-*  → zop-orange  (primary accent / CTA)
 *   emerald-* → zop-green   (success, "live")
 *   red-*     → err (#F87171)
 *   amber-*   → warn (#FBBF24)
 *
 * Standing rules from tokens.css are enforced globally:
 *   - border-radius scale collapses to 0 (with a single pill exception)
 *   - font-family defaults to Space Grotesk / JetBrains Mono
 *
 * Brand classes are also exposed directly: bg-zop-orange, text-ink-2, etc.
 */
export default {
  content: ["./src/**/*.{ts,tsx}", "./sidebar.html", "./popup.html"],
  theme: {
    // Full override of the borderRadius scale — sharp corners everywhere.
    // One pill escape hatch for status dots per tokens.css.
    borderRadius: {
      none: "0",
      DEFAULT: "0",
      sm: "0",
      md: "0",
      lg: "0",
      xl: "0",
      "2xl": "0",
      "3xl": "0",
      full: "9999px",
      pill: "9999px",
    },
    extend: {
      fontFamily: {
        sans: ["'Space Grotesk'", "system-ui", "-apple-system", "sans-serif"],
        mono: ["'JetBrains Mono'", "ui-monospace", "'SF Mono'", "Menlo", "monospace"],
      },
      letterSpacing: {
        body: "-0.02em",
        heading: "-0.03em",
        display: "-0.05em",
        meta: "0.14em",
      },
      colors: {
        // Brand-level aliases
        "zop-blue": "#2A4494",
        "zop-orange": "#F58549",
        "zop-green": "#7FB236",
        "zop-black": "#0A0A0A",
        "zop-cream": "#F0EBDB",
        ink: {
          DEFAULT: "#F0EBDB",
          2: "#D4CDB5",
          3: "#A8A195",
          4: "#8A8378",
          5: "#5A5A62",
        },
        line: {
          DEFAULT: "#2A2A34",
          2: "#3A3A46",
          3: "#55555E",
        },
        surface: {
          0: "#060608",
          1: "#0E0E12",
          2: "#15151A",
          3: "#1C1C24",
          4: "#252530",
        },

        // Remaps so existing V1 Tailwind classes inherit brand.
        slate: {
          50: "#F0EBDB",
          100: "#F0EBDB",
          200: "#F0EBDB",
          300: "#D4CDB5",
          400: "#A8A195",
          500: "#A8A195",
          600: "#5A5A62",
          700: "#3A3A46",
          800: "#2A2A34",
          900: "#0E0E12",
          950: "#060608",
        },
        violet: {
          50: "#FDE7D9",
          100: "#FBD0B3",
          200: "#F9B98E",
          300: "#F7A268",
          400: "#F58549",
          500: "#F58549",
          600: "#F58549",
          700: "#D46A36",
          800: "#A04D25",
          900: "#6F3417",
          950: "#451F0D",
        },
        indigo: {
          400: "#F58549",
          500: "#F58549",
          600: "#F58549",
          700: "#D46A36",
        },
        emerald: {
          400: "#7FB236",
          500: "#7FB236",
          600: "#7FB236",
          700: "#5F871F",
        },
        green: {
          400: "#7FB236",
          500: "#7FB236",
          600: "#7FB236",
        },
        red: {
          300: "#FCA5A5",
          400: "#F87171",
          500: "#F87171",
          600: "#EF4444",
          700: "#B91C1C",
          900: "#6F1212",
        },
        amber: {
          300: "#FCD34D",
          400: "#FBBF24",
          500: "#FBBF24",
          600: "#D97706",
        },
        yellow: {
          400: "#FBBF24",
          500: "#FBBF24",
        },
      },
      boxShadow: {
        // Hard offset shadows (no blur radius) — tokens.css standing rule.
        "hover-orange": "0 8px 0 -4px #F58549",
        "hover-blue": "0 8px 0 -4px #2A4494",
        "hover-green": "0 8px 0 -4px #7FB236",
        "hover-ink": "0 4px 0 -2px #F0EBDB",
        toast: "0 8px 0 -4px #F58549",
      },
    },
  },
  plugins: [],
};
