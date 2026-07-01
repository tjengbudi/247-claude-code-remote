import type { Metadata, Viewport } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { Toaster } from '@/components/ui/sonner';
import { Providers } from '@/components/Providers';
import './globals.css';
import '@/styles/design-system.css';

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f97316' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0f' },
  ],
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  // Android: resize content when virtual keyboard appears (instead of panning)
  interactiveWidget: 'resizes-content',
};

export const metadata: Metadata = {
  title: '247 - The Vibe Company',
  description: '247 - Web terminal access to Claude Code from anywhere',
  applicationName: '247',
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3001'),
  openGraph: {
    title: '247 - The Vibe Company',
    description:
      'Web terminal access to Claude Code from anywhere. Control your AI coding sessions remotely.',
    url: process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3001',
    siteName: '247',
    locale: 'en_US',
    type: 'website',
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: '247 - Web terminal access to Claude Code',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: '247 - The Vibe Company',
    description:
      'Web terminal access to Claude Code from anywhere. Control your AI coding sessions remotely.',
    images: ['/og-image.png'],
  },
  robots: {
    index: true,
    follow: true,
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: '247',
  },
  icons: {
    icon: [
      { url: '/icon-192x192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/apple-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="bg-background text-foreground min-h-screen font-sans antialiased">
        <Providers>{children}</Providers>
        <Toaster />
      </body>
    </html>
  );
}
