import { AppSidebar } from '@/components/layout/AppSidebar'
import { AuthProvider } from '@/components/auth/AuthProvider'
import { AuthGuard } from '@/components/auth/AuthGuard'

// Harbor serves the UI as a static export (no SSR), so auth is enforced on the
// client: AuthProvider resolves the current user and AuthGuard redirects
// anonymous visitors to /login. Real protection lives on the API — every data
// route requires the session cookie; these pages are just shells.
export default function MainLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <AuthProvider>
      <AuthGuard>
        <div className="flex h-screen overflow-hidden bg-background">
          <AppSidebar />
          {children}
        </div>
      </AuthGuard>
    </AuthProvider>
  )
}
