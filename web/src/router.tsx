/**
 * Five pages, one history API, no dependency.
 *
 * React Router would be the reflex, and for an application with nested layouts, data
 * loaders and route-level code splitting it earns its size. This has five flat
 * routes and one layout. What it needs is `pushState`, a `popstate` listener and an
 * anchor that does not reload the page — about forty lines, all of them visible here
 * rather than configured somewhere else.
 *
 * The part that is easy to get wrong, and the reason `Link` is not just an `onClick`:
 * an anchor must stay an anchor. Ctrl-click, ⌘-click, middle-click and "open in new
 * tab" all have to keep working, which means a real `href` and a click handler that
 * declines anything but a plain left click.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react'

export interface NavigateOptions {
  /** Replace rather than push — for redirects nobody should be able to go back to. */
  replace?: boolean
}

export interface Router {
  path: string
  navigate: (to: string, options?: NavigateOptions) => void
}

const RouterContext = createContext<Router | null>(null)

export function RouterProvider({ children }: { children: ReactNode }): ReactNode {
  const [path, setPath] = useState(() => window.location.pathname)

  useEffect(() => {
    // The back button, and anything else that moves through history without us.
    const onPopState = (): void => {
      setPath(window.location.pathname)
    }
    window.addEventListener('popstate', onPopState)
    return () => {
      window.removeEventListener('popstate', onPopState)
    }
  }, [])

  const navigate = useCallback((to: string, options: NavigateOptions = {}): void => {
    if (to === window.location.pathname) return
    if (options.replace === true) window.history.replaceState(null, '', to)
    else window.history.pushState(null, '', to)
    setPath(to)
  }, [])

  const value = useMemo<Router>(() => ({ path, navigate }), [path, navigate])
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>
}

export function useRouter(): Router {
  const router = useContext(RouterContext)
  if (router === null) throw new Error('useRouter() outside a RouterProvider')
  return router
}

/** True when `to` is the current page, or an ancestor of it. */
export function isActive(path: string, to: string): boolean {
  if (to === '/') return path === '/'
  return path === to || path.startsWith(`${to}/`)
}

export interface LinkProps {
  to: string
  children: ReactNode
  className?: string
  /** Fires only on an in-app navigation — closing a mobile menu, for instance. */
  onNavigate?: () => void
  /**
   * Highlight only on an exact match, not on a descendant path. The primary nav wants
   * prefix matching — a detail path still lights the section it sits under — but a
   * flat tab strip whose own base path (e.g. `/settings`) is a literal prefix of every
   * other tab would otherwise always read as current alongside whichever tab is
   * actually open.
   */
  exact?: boolean
}

export function Link({ to, children, className, onNavigate, exact = false }: LinkProps): ReactNode {
  const { path, navigate } = useRouter()
  const active = exact ? path === to : isActive(path, to)

  const onClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    // Anything but a plain left click belongs to the browser: a modifier means "new
    // tab" or "download", and swallowing it is the most irritating bug a hand-rolled
    // router can have.
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return
    }
    event.preventDefault()
    navigate(to)
    onNavigate?.()
  }

  return (
    <a
      href={to}
      onClick={onClick}
      className={className}
      // Announced by screen readers as the current page, and the hook the nav styles
      // its active item with — one source of truth for "where am I".
      aria-current={active ? 'page' : undefined}
    >
      {children}
    </a>
  )
}
