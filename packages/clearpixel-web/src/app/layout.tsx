import type { Metadata } from 'next';
import { Plus_Jakarta_Sans, JetBrains_Mono, Caveat } from 'next/font/google';
import './globals.css';

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-sans',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

const caveat = Caveat({
  subsets: ['latin'],
  weight: ['600', '700'],
  variable: '--font-hand',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'ClearPixel.ai — Studio cutouts. Zero uploads.',
  description:
    'Full-resolution background removal in your browser. Private, instant, free. Powered by WebGPU & Rust WASM.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${plusJakarta.variable} ${jetbrainsMono.variable} ${caveat.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-dvh bg-[#F8FAFF] text-[#0F172A] dark:bg-[#09090B] dark:text-[#FAFAFA] font-sans transition-colors duration-150">
        {children}
      </body>
    </html>
  );
}
