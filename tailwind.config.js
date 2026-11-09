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
        // d2 tokens — warm ivory surfaces with aged gold and Dire rust accents.
        d2: {
          bg: '#f6f2e9',
          surface: '#fcfaf5',
          'surface-2': '#fffdf8',
          'surface-3': '#eee8dc',
          line: '#d7cfc0',
          'line-2': 'rgba(75, 62, 43, 0.13)',
          ink: '#29251f',
          'ink-2': '#484239',
          'ink-3': '#665f54',
          'ink-4': '#6a6357',
          disabled: '#989084',
          accent: '#8a5a16',
          'accent-hover': '#6f4510',
          'accent-bg': 'rgba(154, 102, 31, 0.10)',
          gold: '#946315',
          'gold-2': '#76500f',
          'gold-pale': '#5f3e09',
          coral: '#a74732',
          'coral-hover': '#893724',
          up: '#496b32',
          'up-bg': 'rgba(73, 107, 50, 0.11)',
          down: '#a13f2c',
          'down-bg': 'rgba(161, 63, 44, 0.09)',
          radiant: '#4f7034',
          dire: '#9a4d35',
          warn: '#9c432f',
          xp: '#126d9b',
          roshan: '#946315',
          str: '#9d430d',
          scrim: 'rgba(41, 37, 31, 0.48)',
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
