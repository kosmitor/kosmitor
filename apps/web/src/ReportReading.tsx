/**
 * What the server read from a 409A report the valuation team uploaded, shared by
 * the team's page and the company's.
 *
 * The server reads the PDF's text and picks out the fair market value per common
 * share, the valuation date and the method (report-detect.ts). Each value comes
 * with the words it was read from and how sure the reading is, so a person can
 * see where it came from and check it. Nothing here records anything: the team
 * confirms the values when it delivers the report, and the company records the
 * 409A only after someone there has checked them and pressed the button.
 */
import { useId, useState } from 'react';
import { Icon } from './icons.tsx';
import { cx } from './ui.tsx';
import type { ReportDocument } from './ValuationReportField.tsx';
import type { RequestDocument } from './ValuationChecklist.tsx';

/** One value read from the report, with the words around it. */
export interface Detected<T> {
  value: T;
  /** The words the value was read from, as they appear in the report. */
  text: string;
  /** About 160 characters around them, so a person can see where it came from. */
  context: string;
  page: number;
  confidence: 'high' | 'medium' | 'low';
}

/** Everything read from one report. A value the server could not find is null. */
export interface ReportDetection {
  /** False when the PDF's text could not be read at all: a scan, an encrypted file, or not a PDF the server understands. */
  readable: boolean;
  /** Micro-cents per common share. */
  fairMarketValue: Detected<number> | null;
  /** YYYY-MM-DD. */
  valuationDate: Detected<string> | null;
  method: Detected<string> | null;
  candidates: { fairMarketValue: Detected<number>[]; valuationDate: Detected<string>[] };
}

/** The report as the team's page sees it. */
export interface DeskReport {
  document: { id: string; name: string; fileName: string | null; sizeBytes: number | string | null; createdAt: string } | null;
  detected: ReportDetection | null;
  /** What the team entered when it delivered the report, in micro-cents. Null until then. */
  fairMarketValue: number | null;
  method: string | null;
}

/**
 * The report as the company's page sees it: the document is one of the company's
 * own, opened through the vault. It is shaped like a document the request sent,
 * filed as the report rather than as an item of the checklist, with where the
 * vault keeps it and who it is shown to, since someone may have shared it since.
 * Null for a reader the vault does not show it to.
 */
export interface RequestReport {
  document: (Omit<RequestDocument, 'item' | 'sizeBytes'> & {
    item: 'REPORT'; sizeBytes: number | string | null; category: string; folder: string | null; status: string; visibility: string;
  }) | null;
  detected: ReportDetection | null;
  fairMarketValue: number | null;
  method: string | null;
}

/** True when the report gave nothing to fill in, whether or not its text could be read. */
export const nothingRead = (d: ReportDetection | null | undefined): boolean =>
  !d || !d.readable || (!d.fairMarketValue && !d.valuationDate && !d.method);

/** A price in micro-cents as a price field holds it, which parsePPS reads back: "0.42". */
export const priceField = (micro: number): string => String(micro / 1e6);

/**
 * The report's document in the shape the vault's opener takes. The team's upload
 * is filed for administrators only, unless someone at the company has shared it
 * since, and the visibility the server sends says which.
 */
export const reportDocumentOf = (report: RequestReport | null | undefined): ReportDocument | null => {
  const d = report?.document;
  if (!d) return null;
  return {
    id: d.id, name: d.name, fileName: d.fileName, mimeType: d.mimeType, hasBody: d.hasBody, createdAt: d.createdAt,
    sizeBytes: d.sizeBytes ?? null, category: d.category, folder: d.folder, status: d.status, visibility: d.visibility,
  };
};

/** The context with the words the value was read from marked, so the eye lands on them. */
function Context({ detected }: { detected: Detected<unknown> }) {
  const { context, text } = detected;
  let at = text ? context.indexOf(text) : -1;
  if (at < 0 && text) at = context.toLowerCase().indexOf(text.toLowerCase());
  return (
    <span>
      {at < 0 ? context : (
        <>
          {context.slice(0, at)}
          <mark className="rounded bg-amber-100 px-0.5 text-ink-900">{context.slice(at, at + text.length)}</mark>
          {context.slice(at + text.length)}
        </>
      )}
    </span>
  );
}

/** The small text buttons in a note: a taller hit area than the line they sit on, without moving the line. */
const NOTE_BUTTON = '-my-1 py-1 font-medium text-brand-600 hover:text-brand-700';

/**
 * The line under a field the report filled in. While the field holds what was
 * read, it says so, and asks for a second look when the reading was not sure of
 * itself. Once someone has typed something else, it says what the report reads
 * instead, with a button to put it back. Either way, the words it came from are
 * a click away.
 *
 * The note sits outside the field's label, so its sentence carries `id` for the
 * field to name in aria-describedby: a screen reader then says where the value
 * came from when the field is reached, not only what it holds. Its buttons name
 * the field, since a page has one note for each.
 */
export function ReadNote({ id, field, detected, shown, matches, onUse, unconfirmed = false }: {
  /** For the field's aria-describedby. */
  id: string;
  /** What the field holds, in words: "fair market value", "valuation date". */
  field: string;
  detected: Detected<unknown>;
  /** The value read, in words: "$0.4200", "Jun 30, 2026". */
  shown: string;
  /** Whether the field still holds the value read. */
  matches: boolean;
  /** Puts the value read back in the field. */
  onUse: () => void;
  /** On the company's form: the team did not enter this value when it delivered the report, so only the reading stands behind it. */
  unconfirmed?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const whereId = useId();
  const unsure = detected.confidence !== 'high';
  const warn = matches && (unsure || unconfirmed);
  return (
    <div className="mt-1.5 text-[12px]">
      <p className={cx('flex items-start gap-1.5', warn ? 'text-amber-800' : 'text-ink-500')}>
        <Icon name={warn ? 'alert' : 'sparkle'} className={cx('mt-px size-3.5 shrink-0', warn ? 'text-amber-600' : 'text-brand-500')} />
        <span className="min-w-0">
          <span id={id}>
            {matches
              ? unconfirmed ? 'Read from the report, not entered by the team. Check it.'
                : unsure ? 'Read from the report. Check this one.' : 'Read from the report.'
              : `The report reads ${shown}.`}
          </span>
          {!matches && (
            <>
              {' '}
              <button type="button" className={NOTE_BUTTON} onClick={onUse} aria-label={`Use the ${field} the report reads`}>Use it</button>
              <span className="text-ink-300" aria-hidden> ·</span>
            </>
          )}
          {' '}
          <button type="button" className={NOTE_BUTTON} aria-expanded={open} aria-controls={whereId}
            aria-label={`${open ? 'Hide' : 'Show'} where the ${field} was read`} onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide where' : 'Show where'}
          </button>
        </span>
      </p>
      {/* A report's table can come out as one long run of leader dots before the price, so the words break anywhere rather than run off a phone's screen. */}
      <p id={whereId} hidden={!open} className="mt-1 rounded-md bg-ink-50 px-2.5 py-1.5 leading-relaxed text-ink-700 [overflow-wrap:anywhere]">
        <span className="mr-1.5 whitespace-nowrap font-medium text-ink-500">Page {detected.page}:</span>
        “<Context detected={detected} />”
      </p>
    </div>
  );
}
