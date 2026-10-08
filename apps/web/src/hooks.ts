import { useEffect, useState, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Scrolls to the element the URL hash names once the page has what it needs
 * (`ready`), so deep links such as /company#portal land on the right card.
 */
export function useScrollToHash(ready = true): void {
  const { hash, pathname } = useLocation();
  useEffect(() => {
    if (!ready || !hash) return;
    const el = document.getElementById(decodeURIComponent(hash.slice(1)));
    if (!el) return;
    const timer = setTimeout(() => el.scrollIntoView({ block: 'start', behavior: 'smooth' }), 50);
    return () => clearTimeout(timer);
  }, [ready, hash, pathname]);
}

/**
 * A page search box's state, seeded from `?q=` in the URL and following it
 * when a search result navigates to the same page again.
 */
export function useSearchQuery(): [string, (value: string) => void] {
  const { search } = useLocation();
  const fromUrl = new URLSearchParams(search).get('q') ?? '';
  const [value, setValue] = useState(fromUrl);
  useEffect(() => { if (fromUrl) setValue(fromUrl); }, [fromUrl]);
  return [value, setValue];
}

/**
 * Whether a media query matches now, following it as the window changes:
 * useMediaQuery('(max-width: 639px)') for a phone, '(pointer: coarse)' for a
 * touch screen. False where matchMedia is missing.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (changed) => {
      const list = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query) : null;
      list?.addEventListener('change', changed);
      return () => list?.removeEventListener('change', changed);
    },
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  );
}
