import { Link } from 'react-router-dom';
import { Badge } from '../../ui.tsx';
import { config } from '../../config.ts';

/**
 * How a compliance score is drawn on its gauge, in brand.colors.status: good in
 * the top band of compliance.scoring.bands, bad in the bottom one, warning in
 * between. `scoring` is what the server scored with, when it says; otherwise the
 * page's own copy of the settings. `filled` is the share of the ring to draw.
 */
export function scoreGauge(score: number, scoring: { start: number; bands: { min: number }[] } = config.compliance.scoring) {
  const { good, warning, bad, track } = config.brand.colors.status;
  const { start, bands } = scoring;
  const found = bands.findIndex((b) => score >= b.min);
  const band = found === -1 ? bands.length - 1 : found;
  return {
    color: band === 0 ? good : band === bands.length - 1 ? bad : warning,
    track,
    filled: start > 0 ? Math.min(1, Math.max(0, score / start)) : 0,
  };
}

/** Where each finding's rule is worked on. */
export const RULE_SECTIONS: Record<string, string> = {
  '83B_DEADLINE': '/compliance/83b',
  ISO_100K: '/compliance/iso-100k',
  RULE_701: '/compliance/rule-701',
  RULE_701_DISCLOSURE: '/compliance/rule-701',
  VALUATION_409A: '/compliance/409a',
  STRIKE_BELOW_FMV: '/compliance/409a',
  FORM_3921: '/compliance/form-3921',
  BOI_REPORT: '/compliance/boi',
  BOI_UPDATE: '/compliance/boi',
};

export const RULE_LABELS: Record<string, string> = {
  '83B_DEADLINE': '83(b) election',
  ISO_100K: 'ISO $100K limit',
  RULE_701: 'Rule 701',
  RULE_701_DISCLOSURE: 'Rule 701 disclosure',
  VALUATION_409A: '409A valuation',
  STRIKE_BELOW_FMV: 'Strike price',
  BOARD_APPROVAL: 'Board approval',
  OVER_ISSUANCE: 'Authorized shares',
  AUTHORIZED_CAPACITY: 'Authorized shares',
  POOL_OVERALLOCATED: 'Plan reserve',
  PTEP_EXPIRED: 'Exercise window',
  PTEP_EXPIRING: 'Exercise window',
  GRANT_EXPIRED: 'Grant expiry',
  GRANT_EXPIRING: 'Grant expiry',
  NOTE_MATURED: 'Note maturity',
  NOTE_MATURING: 'Note maturity',
  FORM_3921: 'Form 3921',
  BOI_REPORT: 'BOI reporting',
  BOI_UPDATE: 'BOI reporting',
};

/** A finding's rule as a badge that opens the section where it is dealt with. */
export function RuleBadge({ rule }: { rule: string }) {
  const label = RULE_LABELS[rule] ?? rule;
  const to = RULE_SECTIONS[rule];
  if (!to) return <Badge tone="neutral">{label}</Badge>;
  return <Link to={to} className="hover:opacity-80"><Badge tone="brand">{label} →</Badge></Link>;
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, ['success' | 'warning' | 'danger' | 'neutral' | 'info', string]> = {
    FILED: ['success', 'Filed'], OPEN: ['warning', 'Window open'], CLOSED: ['danger', 'Window closed'],
    NOTHING_TO_FILE: ['neutral', 'Nothing to file'], UPCOMING: ['info', 'Year in progress'], DUE: ['warning', 'Due'], OVERDUE: ['danger', 'Overdue'],
  };
  const [tone, label] = map[status] ?? ['neutral', status];
  return <Badge tone={tone}>{label}</Badge>;
}
