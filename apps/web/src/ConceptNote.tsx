/**
 * The explainer that opens every page: what this thing is, why it exists, and the
 * handful of facts worth knowing before touching it.
 *
 * Equity is full of terms that are obvious once and opaque the first fifty times,
 * so the summary is always on screen. The rest opens on request and the choice is
 * remembered, because someone who reads it on Monday should not be told again on
 * Tuesday. Content lives in concepts.ts; this file is only how it looks.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from './session.tsx';
import { CONCEPTS, type ConceptId } from './concepts.ts';
import { Icon } from './icons.tsx';
import { config } from './config.ts';

/**
 * The pages whose explanation this reader opened or closed by hand, in this
 * browser. Anything not listed follows the person's own preference, which lives
 * on the server and so goes with them. The list is kept per person, because a
 * shared computer should not hand one person's choices to the next.
 */
const LEGACY_STORE = 'kosmitor_concepts_open';
const storeFor = (userId: string | undefined) => `${LEGACY_STORE}:${userId ?? 'anonymous'}`;

/** Reading preferences is a convenience, never a correctness requirement, so failures are silent. */
function readChoices(userId: string | undefined): Record<string, boolean> {
  try {
    const own = localStorage.getItem(storeFor(userId));
    if (own != null) return JSON.parse(own) as Record<string, boolean>;
    // An earlier build kept one list for the whole browser, holding only pages
    // someone opened. The first person to read it takes it over and it is
    // retired, so the next person on a shared computer does not inherit it.
    const legacy = localStorage.getItem(LEGACY_STORE);
    if (legacy == null) return {};
    localStorage.setItem(storeFor(userId), legacy);
    localStorage.removeItem(LEGACY_STORE);
    return JSON.parse(legacy) as Record<string, boolean>;
  } catch { return {}; }
}

function writeChoice(userId: string | undefined, id: string, opened: boolean): void {
  try {
    // Kept either way, not only when opened: with explanations starting open, a
    // page someone closed has to stay closed, and forgetting it would reopen it.
    localStorage.setItem(storeFor(userId), JSON.stringify({ ...readChoices(userId), [id]: opened }));
  } catch { /* a private window still gets the panel, it just forgets */ }
}

/** How many pages this browser remembers a choice for, for this person. */
export const pageChoiceCount = (userId: string | undefined): number => Object.keys(readChoices(userId)).length;

/** Forgets every page's own choice for this person, so each follows the preference again. */
export function forgetPageChoices(userId: string | undefined): void {
  try {
    localStorage.setItem(storeFor(userId), '{}');
  } catch { /* nothing stored to forget */ }
}

export function ConceptNote({ id }: { id: ConceptId }) {
  const concept = CONCEPTS[id];
  const { user, canViewAll } = useSession();
  // Closed unless the reader asked otherwise: the summary alone answers the
  // question most of the time, and a page should open on its own content.
  const [open, setOpen] = useState(() => readChoices(user?.id)[id] ?? !!user?.explanationsOpen);
  if (!concept) return null;

  // Holders reach only their own pages, and a link anywhere else would bring them
  // straight back where they started, so those links are left out for them.
  const HOLDER_PAGES = ['/portal', '/documents', '/preferences'];
  const seeAlso = canViewAll ? concept.seeAlso : concept.seeAlso.filter((l) => HOLDER_PAGES.some((p) => l.to === p || l.to.startsWith(`${p}/`)));

  const toggle = () => {
    setOpen((was) => { writeChoice(user?.id, id, !was); return !was; });
  };

  return (
    <section aria-label={concept.title} className="mb-5 rounded-xl border border-ink-200/70 bg-ink-50/70 p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-white text-brand-600 ring-1 ring-ink-200/70">
          <Icon name="help" className="size-4" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-4">
            <h2 className="text-[14px] font-semibold leading-snug text-ink-900">{concept.title}</h2>
            <button type="button" onClick={toggle} aria-expanded={open}
              className="shrink-0 cursor-pointer text-[12px] font-medium text-brand-600 hover:text-brand-700">
              {open ? 'Show less' : 'Read more'}
            </button>
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-600">{concept.summary}</p>

          {open && (
            <div className="mt-3 space-y-3 border-t border-ink-200/70 pt-3">
              <p className="text-[13px] leading-relaxed text-ink-600">
                <span className="font-medium text-ink-800">Why it matters. </span>{concept.why}
              </p>

              <ul className="space-y-1.5">
                {concept.points.map((point) => (
                  <li key={point} className="flex gap-2 text-[13px] leading-relaxed text-ink-600">
                    <Icon name="check" className="mt-[3px] size-3.5 shrink-0 text-secondary-600" />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>

              {seeAlso.length > 0 && (
                <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
                  <span className="text-ink-500">See also</span>
                  {seeAlso.map((link) => (
                    <Link key={link.to} to={link.to} className="font-medium text-brand-600 hover:text-brand-700">
                      {link.label}
                    </Link>
                  ))}
                </p>
              )}

              <p className="text-[11px] leading-relaxed text-ink-400">{config.legal.disclaimer}</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
