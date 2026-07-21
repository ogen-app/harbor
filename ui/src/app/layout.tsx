import type { Metadata } from 'next'
import './globals.css'
import { Geist, IBM_Plex_Mono } from "next/font/google";
import { cn } from "@/lib/utils";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});
const plexMono = IBM_Plex_Mono({subsets:['latin'],weight:'600',variable:'--font-plex-mono'});

export const metadata: Metadata = {
  title: "Ogen' Harbor",
  description: 'Control center for Ogen',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '32x32' },
      { url: '/favicon.svg', type: 'image/svg+xml' },
    ],
    apple: '/apple-touch-icon.png',
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={cn("font-sans", geist.variable, plexMono.variable)}>
      <body>
        {children}
      </body>
    </html>
  )
}
