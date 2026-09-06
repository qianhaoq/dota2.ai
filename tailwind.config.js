/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        display: ['Cinzel', 'serif'],
      },
      colors: {
        k3: {
          base: '#0A0A0B',
          surface: '#131316',
          elevated: '#1A1A1F',
          input: '#17171B',
          'border-subtle': '#26262C',
          'text-primary': '#E8E8EA',
          'text-secondary': '#9C9CA3',
          'text-tertiary': '#5C5C64',
          accent: '#D8FF3E',
          radiant: '#3DDC84',
          dire: '#F0524F',
        },
        dota: {
          dark: '#121212',
          panel: '#1E1E1E',
          red: '#F0524F',
          green: '#3DDC84',
          blue: '#2471A3',
          gold: '#D4AF37',
          accent: '#D8FF3E'
        }
      },
      borderRadius: {
        'bubble': '16px',
        'bubble-corner': '4px',
        'composer': '24px',
        'pill': '9999px',
      },
      maxWidth: {
        'content': '768px',
      },
      fontSize: {
        'body': ['14px', '22px'],
      },
    }
  },
  plugins: [],
}
