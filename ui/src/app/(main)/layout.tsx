import { AppSidebar } from '@/components/layout/AppSidebar'

// Harbor is served as a static export embedded in the Go binary, so this layout
// stays fully static — no server-only APIs (e.g. `cookies()`). The sidebar
// persists its collapsed state client-side via localStorage (see AppSidebar).
export default function MainLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <AppSidebar />
      {children}
    </div>
  )
}
