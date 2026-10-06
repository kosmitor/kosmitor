import { useEffect, useState } from 'react';
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
