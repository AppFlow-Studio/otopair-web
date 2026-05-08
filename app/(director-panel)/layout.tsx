import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Otopair Admin',
  robots: 'noindex, nofollow',
}

export default function DirectorPanelLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
