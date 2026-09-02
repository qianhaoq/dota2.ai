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
        dota: {
          dark: '#121212',
          panel: '#1E1E1E',
          red: '#A93226',
          green: '#229954',
          blue: '#2471A3',
          gold: '#D4AF37',
          accent: '#E74C3C'
        }
      }
    }
  },
  plugins: [],
}
