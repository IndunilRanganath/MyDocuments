import type { Metadata, Viewport } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'MyDocuments — Your documents, privately', description: 'Your personal documents, securely stored.', applicationName: 'MyDocuments', manifest: '/manifest.webmanifest', appleWebApp: { capable: true, statusBarStyle: 'default', title: 'MyDocuments' }, icons: { icon: '/icons/icon.svg', apple: '/icons/apple-touch-icon.png' }, robots: { index: false, follow: false } };
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: [{ media: '(prefers-color-scheme: light)', color: '#f8f9f6' }, { media: '(prefers-color-scheme: dark)', color: '#151b17' }] };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
