/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    screens: {
      'xs': '375px',
      'sm': '640px',
      'md': '768px',
      'lg': '1024px',
      'xl': '1280px',
      '2xl': '1536px',
    },
    extend: {
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        display: ['Cinzel', 'serif'],
        // V3 (docs/design/tactical-coach-v3/docs/tokens.json): titles may be serif, body stays sans.
        v3display: ['Georgia', 'Noto Serif CJK SC', 'Songti SC', 'serif'],
      },
      colors: {
        // V3 tactical palette (tokens.json) alongside k3; k3 classes used by CoachView stay untouched.
        v3: {
          base: '#0b1013',
          panel: '#11191d',
          raised: '#182329',
          line: '#2a383f',
          text: '#e9e6df',
          muted: '#a3b0b5',
          quiet: '#82969e',
          primary: '#9f493a',
          'primary-text': '#fff0e9',
          gold: '#c3a679',
          information: '#87c7df',
          risk: '#ee9a87',
        },
        k3: {
          base: '#0B0B0C',
          surface: '#141416',
          elevated: '#1C1C1F',
          input: '#18181B',
          'border-subtle': 'rgba(255, 255, 255, 0.08)',
          'text-primary': '#EDEDEF',
          'text-secondary': '#9B9BA2',
          'text-tertiary': '#63636B',
          'primary-bg': '#F5F5F5',
          'primary-text': '#0B0B0C',
          radiant: '#7C8F5A',
          'radiant-muted': '#5A6B42',
          dire: '#A65F52',
          'dire-muted': '#7A4A40',
        },
        // d2 tokens — Dota2 v4 气质 (钱浩认可 2026-10-25)
        // Dark Dota theme: Bunker #12181C, gold #C79123, coral CTA #FF6046.
        d2: {
          bg: '#0b1014',
          surface: '#12181c',
          'surface-2': '#1b1e21',
          'surface-3': '#23262e',
          line: '#36363e',
          'line-2': 'rgba(255, 255, 255, 0.07)',
          ink: '#eee9df',
          'ink-2': '#d3d6d8',
          'ink-3': '#a3aab1',
          'ink-4': '#8b929a',
          disabled: '#5a6269',
          accent: '#c79123',
          'accent-hover': '#d9a63a',
          'accent-bg': 'rgba(199, 145, 35, 0.12)',
          gold: '#c79123',
          'gold-2': '#ebcf87',
          'gold-pale': '#f8e8b9',
          coral: '#ff6046',
          'coral-hover': '#ff7a62',
          up: '#94ad63',
          'up-bg': 'rgba(148, 173, 99, 0.15)',
          down: '#ff806b',
          'down-bg': 'rgba(168, 56, 6, 0.12)',
          radiant: '#94ad63',
          dire: '#d1734d',
          warn: '#ea6953',
          xp: '#1a9fff',
          roshan: '#c79123',
          str: '#b9500b',
          scrim: 'rgba(11, 16, 20, 0.85)',
        },
      },
      borderRadius: {
        'lg': '16px',
        'sm': '8px',
        'bubble': '16px',
        'bubble-corner': '4px',
        'composer': '16px',
        // d2 radii (handoff §2)
        'd2-card': '16px',
        'd2-control': '10px',
        'd2-sheet': '24px',
        'd2-chip': '999px',
        'd2-avatar': '8px',
      },
      boxShadow: {
        // d2 elevation (handoff §2): sh-1 / sh-2 (cards) / sh-3 (overlays) / sheet
        'd2-1': '0 1px 2px rgba(15, 23, 42, 0.06)',
        'd2-2': '0 1px 2px rgba(15, 23, 42, 0.06), 0 4px 12px rgba(15, 23, 42, 0.06)',
        'd2-3': '0 2px 4px rgba(15, 23, 42, 0.06), 0 12px 32px rgba(15, 23, 42, 0.10)',
        'd2-sheet': '0 -8px 40px rgba(15, 23, 42, 0.14)',
      },
      maxWidth: {
        'content': '768px',
        '3xl': '48rem',
        // d2 layout widths (handoff §2): chat column 720, evidence panel 420
        'd2-chat': '720px',
        'd2-panel': '420px',
      },
      transitionDuration: {
        // d2 motion (handoff §2): 150–220ms, sheet 320ms
        'd2-fast': '150ms',
        'd2-base': '180ms',
        'd2-slow': '220ms',
        'd2-sheet': '320ms',
      },
      transitionTimingFunction: {
        'd2-out': 'ease-out',
        'd2-sheet': 'cubic-bezier(0.32, 0.72, 0, 1)',
      },
      // k3 8px grid: 1–6 are 8/16/24/32/40/48px. `w-5`/`w-6` are 40/48, not Tailwind defaults (20/24).
      // Dense mobile rows (chip avatars, picker previews) should use w-7/w-8 or arbitrary px.
      spacing: {
        '1': '8px',
        '2': '16px',
        '3': '24px',
        '4': '32px',
        '5': '40px',
        '6': '48px',
        // d2 spacing scale (handoff §2): 4/8/12/16/24/32/48. The 1–6 keys above
        // are the k3 8px grid, so v2 code should use these d2-* keys (or
        // explicit arbitrary values) instead of bare numeric utilities.
        'd2-4': '4px',
        'd2-8': '8px',
        'd2-12': '12px',
        'd2-16': '16px',
        'd2-24': '24px',
        'd2-32': '32px',
        'd2-48': '48px',
      },
      fontSize: {
        'body': ['14px', '22px'],
        // d2 type scale (handoff §2): size/line-height pairs
        'd2-12': ['12px', '16px'],
        'd2-13': ['13px', '18px'],
        'd2-15': ['15px', '22px'],
        'd2-17': ['17px', '24px'],
        'd2-22': ['22px', '28px'],
      },
    }
  },
  plugins: [],
}
