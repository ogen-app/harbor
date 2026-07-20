// Client-side auth for Harbor. The server owns sessions (HttpOnly cookie); this
// module drives the Google sign-in popup and talks to /api/auth/*.

export interface User {
  id: string
  email: string
  name: string
  picture: string
}

// Minimal typing for the Google Identity Services code client we use.
interface CodeResponse {
  code?: string
  error?: string
}
interface CodeClient {
  requestCode: () => void
}
interface GoogleOAuth2 {
  initCodeClient: (config: {
    client_id: string
    scope: string
    ux_mode: 'popup'
    callback: (response: CodeResponse) => void
    error_callback?: (error: { type?: string }) => void
  }) => CodeClient
}
declare global {
  interface Window {
    google?: { accounts: { oauth2: GoogleOAuth2 } }
  }
}

const GIS_SRC = 'https://accounts.google.com/gsi/client'

let gisPromise: Promise<void> | null = null

// loadGis injects the Google Identity Services script once and resolves when
// it's ready.
function loadGis(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve()
  if (gisPromise) return gisPromise
  gisPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = GIS_SRC
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => {
      gisPromise = null
      reject(new Error('Failed to load Google Identity Services'))
    }
    document.head.appendChild(script)
  })
  return gisPromise
}

export async function getAuthConfig(): Promise<{ googleClientId: string }> {
  const res = await fetch('/api/auth/config')
  if (!res.ok) throw new Error('Failed to load auth config')
  return res.json()
}

// getMe returns the signed-in user, or null when the session is missing/expired.
export async function getMe(): Promise<User | null> {
  const res = await fetch('/api/auth/me')
  if (res.status === 401) return null
  if (!res.ok) throw new Error('Failed to load current user')
  return res.json()
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' })
}

// loginWithGoogle opens the Google popup, exchanges the returned code with the
// backend, and resolves with the authenticated user. The session cookie is set
// by the backend response.
export async function loginWithGoogle(): Promise<User> {
  const { googleClientId } = await getAuthConfig()
  if (!googleClientId) {
    throw new Error('Google login is not configured on the server')
  }
  await loadGis()
  const oauth2 = window.google?.accounts?.oauth2
  if (!oauth2) throw new Error('Google Identity Services unavailable')

  const code = await new Promise<string>((resolve, reject) => {
    const client = oauth2.initCodeClient({
      client_id: googleClientId,
      scope: 'openid email profile',
      ux_mode: 'popup',
      callback: (response) => {
        if (response.error) return reject(new Error(response.error))
        if (!response.code) return reject(new Error('No authorization code returned'))
        resolve(response.code)
      },
      error_callback: (error) => {
        reject(new Error(error.type === 'popup_closed' ? 'Sign-in was cancelled' : 'Google sign-in failed'))
      },
    })
    client.requestCode()
  })

  const res = await fetch('/api/auth/google', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: string } | null
    if (detail?.error === 'email_not_allowed') {
      throw new Error('This Google account is not allowed to access Harbor.')
    }
    throw new Error('Login failed. Please try again.')
  }
  return res.json()
}
