/**
 * Privacy mode, as React sees it.
 *
 * Mirrors `theme/ThemeContext.tsx`: state, applied to the document via a
 * `useEffect` rather than inline during render, so the attribute and the
 * localStorage write happen exactly once per change rather than once per
 * render. There is no "system" state here — unlike colour scheme, the
 * platform has no opinion on whether money should be blurred, so the only
 * two states are on and off.
 *
 * **The keyboard shortcut.** Ctrl/Cmd+Shift+E. Chosen by elimination against
 * what the three major browsers already bind on Ctrl/Cmd+Shift: N and P are
 * both "new private/incognito window" (Firefox binds P, Chrome and Edge bind
 * N, and legacy Edge/IE bound P too — either letter collides with one of
 * them), B toggles the bookmarks bar, T reopens a closed tab, and Delete
 * opens "clear browsing data". E is free on all three as of this writing.
 * Skipped entirely while focus is in a text field or anything editable, so
 * it can never swallow a keystroke someone was typing.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { applyPrivacy, storedEnabled } from './privacy.ts'

export interface PrivacyState {
  enabled: boolean
  setEnabled: (enabled: boolean) => void
}

const PrivacyContext = createContext<PrivacyState | null>(null)

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function PrivacyProvider({ children }: { children: ReactNode }): ReactNode {
  const [enabled, setEnabled] = useState<boolean>(storedEnabled)

  useEffect(() => {
    applyPrivacy(enabled)
  }, [enabled])

  const toggle = useCallback(() => {
    setEnabled((current) => !current)
  }, [])

  useEffect(() => {
    const onKeydown = (event: KeyboardEvent): void => {
      const combo = (event.metaKey || event.ctrlKey) && event.shiftKey
      if (!combo || event.key.toLowerCase() !== 'e') return
      if (isEditableTarget(event.target)) return
      event.preventDefault()
      toggle()
    }
    window.addEventListener('keydown', onKeydown)
    return () => {
      window.removeEventListener('keydown', onKeydown)
    }
  }, [toggle])

  const value = useMemo<PrivacyState>(() => ({ enabled, setEnabled }), [enabled])

  return <PrivacyContext.Provider value={value}>{children}</PrivacyContext.Provider>
}

export function usePrivacy(): PrivacyState {
  const state = useContext(PrivacyContext)
  if (state === null) throw new Error('usePrivacy() outside a PrivacyProvider')
  return state
}
