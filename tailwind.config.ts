import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Primary accent — single indigo as required by PRD (Astra-style)
        brand: {
          50: '#eef2ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#6366f1', // primary
          600: '#4f46e5',
          700: '#4338ca',
          800: '#3730a3',
          900: '#312e81',
          950: '#1e1b4b',
        },
        // Neutral surface — off-white backgrounds and card layers
        surface: {
          0: '#ffffff',
          50: '#f8f9fb',
          100: '#f1f3f7',
          200: '#e8ecf2',
        },
        // Subtle border tones
        border: {
          DEFAULT: '#dde1e9',
          light: '#eaecf1',
          focus: '#6366f1',
        },
        // Muted text / secondary labels
        muted: {
          DEFAULT: '#6b7280',
          light: '#9ca3af',
          dark: '#374151',
        },
      },
      boxShadow: {
        // Soft shadow cards per Astra design language
        card: '0 1px 3px 0 rgba(0,0,0,0.06), 0 1px 2px -1px rgba(0,0,0,0.04)',
        'card-md': '0 4px 6px -1px rgba(0,0,0,0.07), 0 2px 4px -2px rgba(0,0,0,0.05)',
        'card-lg': '0 10px 15px -3px rgba(0,0,0,0.07), 0 4px 6px -4px rgba(0,0,0,0.05)',
      },
      borderRadius: {
        card: '0.5rem',  // 8px — consistent card radius
      },
      fontFamily: {
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
}

export default config
