/** @type {import('tailwindcss').Config} */
export default {
    darkMode: 'media', // 跟随系统/浏览器深色模式
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                primary: '#1E90FF', // Dodger Blue (Darker than Sky Blue)
                'primary-dark': '#0000CD', // Medium Blue (Deep Blue)
                'primary-light': '#F0F8FF', // Alice Blue
            },
            animation: {
                'slide-down': 'slideDown 0.3s ease-out',
                'slide-left': 'slideLeft 0.3s ease-out',
            },
            keyframes: {
                slideDown: {
                    '0%': { transform: 'translateY(-100%)', opacity: '0' },
                    '100%': { transform: 'translateY(0)', opacity: '1' },
                },
                slideLeft: {
                    '0%': { transform: 'translateX(100%)', opacity: '0' },
                    '100%': { transform: 'translateX(0)', opacity: '1' },
                },
            },
        },
    },
    plugins: [],
}
