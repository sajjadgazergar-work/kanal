import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'KANAL',
  description: 'Run a Telegram channel the way a small agency would.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <a className="brand" href="/">
            KANAL
          </a>
          <nav aria-label="Primary">
            <a href="/">Today</a>
            <a href="/runs">Runs</a>
            <a href="/settings/providers">Providers</a>
          </nav>
        </header>
        <main className="site-main">{children}</main>
      </body>
    </html>
  );
}
