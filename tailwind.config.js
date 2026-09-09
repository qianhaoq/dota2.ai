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
      },
      borderRadius: {
        'lg': '16px',
        'sm': '8px',
        'bubble': '16px',
        'bubble-corner': '4px',
        'composer': '16px',
      },
      maxWidth: {
        'content': '768px',
        '3xl': '48rem',
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
      },
      fontSize: {
        'body': ['14px', '22px'],
      },
    }
  },
  plugins: [],
}
