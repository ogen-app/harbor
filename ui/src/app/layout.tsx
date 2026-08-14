import type { Metadata } from 'next'
import './globals.css'
import { Geist, Geist_Mono } from "next/font/google";
import { cn } from "@/lib/utils";

const geistSans = Geist({subsets:['latin'],variable:'--font-geist-sans'});
const geistMono = Geist_Mono({subsets:['latin'],variable:'--font-geist-mono'});

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
    <html lang="en" className={cn("font-sans", geistSans.variable, geistMono.variable)}>
      <body>
        {children}
      </body>
    </html>
  )
}
