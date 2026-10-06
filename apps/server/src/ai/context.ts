/**
 * The snapshot of a company that goes to the model with every question.
 *
 * A language model cannot be trusted to add up a list of certificates, so it is
 * not asked to: the engine computes the totals, the percentages and the
 * compliance checks, and the model receives the answers already worked out. Its
 * job is to find the right number and explain it, not to produce one.
 *
 * Everything here leaves the building, so it is deliberately bounded and
 * deliberately inspectable. The same text is what the person sees when they ask
 * what is being sent.
 */
import {
  computeCapTable, ownershipByGroup, computePoolSummaries, complianceSummary,
  activeValuation, today, formatShares, formatPPS, formatMoney, formatPct,
  type CompanyData, type ComplianceOptions,
} from '@kosmitor/core';
import { config } from '../config.ts';

const line = (label: string, value: string | number): string => `${label}: ${value}`;

function table(headers: string[], rows: (string | number)[][]): string {
  return [headers.join(' | '), headers.map(() => '---').join(' | '), ...rows.map((r) => r.join(' | '))].join('\n');
}

export interface Snapshot {
  text: string;
  bytes: number;
  truncated: boolean;
}

/**
 * `compliance` is what the checks need beyond the records (total assets, the BOI
 * standing, titles, the ledger's cancellation dates); the route passes what the
 * dashboard and the Compliance page use, so the findings sent are the ones shown.
 */
export function captableSnapshot(
  company: Record<string, unknown>, data: CompanyData, asOf = today(), compliance: Omit<ComplianceOptions, 'asOf'> = {},
): Snapshot {
  const table_ = computeCapTable(data, { asOf, includeConvertibles: true });
  const t = table_.totals;
  const groups = ownershipByGroup(table_);
  const pools = computePoolSummaries(data, asOf);
  const valuation = activeValuation(data, asOf);
  // How long each list may run, ai.snapshot. Past a hundred or so holders the
  // roll-up says more than the list, and the list costs a fortune to send.
  const limits = config().ai.snapshot;
  const sections: string[] = [];
  let truncated = false;

  sections.push(['# Company', '',
    line('Name', String(company.name ?? 'the company')),
    line('Legal name', String(company.legalName ?? '—')),
    line('Jurisdiction', String(company.jurisdiction ?? '—')),
    line('Incorporated', String(company.incorporationDate ?? '—')),
    line('Figures as of', asOf),
  ].join('\n'));

  sections.push(['# Totals', '',
    line('Issued and outstanding shares', formatShares(t.outstanding)),
    line('As converted', formatShares(t.asConverted)),
    line('Options outstanding', `${formatShares(t.optionsOutstanding)} (${formatShares(t.optionsVested)} vested)`),
    line('RSUs outstanding', formatShares(t.rsusOutstanding)),
    line('Warrants outstanding', formatShares(t.warrantsOutstanding)),
    line('Convertibles, as converted', formatShares(t.convertibleAsConverted)),
    line('Unallocated option pool', formatShares(t.poolAvailable)),
    line('Fully diluted', formatShares(t.fullyDiluted)),
    line('Total authorized across classes', formatShares(t.authorized)),
    line('Capital raised', formatMoney(t.investedAmount)),
    line('Current fair market value per share', formatPPS(valuation)),
    line('Implied company value at that price', formatMoney(t.companyValue)),
    '',
    'Fully diluted is as converted plus options, RSUs, warrants, the unallocated pool and convertibles.',
  ].join('\n'));

  sections.push(['# Ownership by relationship', '',
    table(['Group', 'Fully diluted shares', 'Percent'],
      groups.map((g) => [g.label, formatShares(g.shares), formatPct(g.pct)])),
  ].join('\n'));

  sections.push(['# Share classes', '',
    table(['Class', 'Kind', 'Authorized', 'Outstanding', 'Available', 'Holders', 'Issue price', 'Invested', 'Liquidation preference'],
      table_.classes.map((c) => [c.name, c.kind, formatShares(c.authorized), formatShares(c.outstanding),
        formatShares(c.available), c.holders, formatPPS(c.pricePerShare), formatMoney(c.investedAmount),
        c.kind === 'PREFERRED' ? formatMoney(c.liquidationPreference) : '—'])),
  ].join('\n'));

  if (pools.length > 0) {
    sections.push(['# Equity plans', '',
      table(['Plan', 'Authorized', 'Granted', 'Exercised', 'Returned', 'Available', 'Used'],
        pools.map((p) => [p.name, formatShares(p.authorized), formatShares(p.granted), formatShares(p.exercised),
          formatShares(p.cancelledReturned), formatShares(p.available), formatPct(p.utilizationPct)])),
    ].join('\n'));
  }

  const holders = table_.rows.filter((r) => r.fullyDiluted > 0).sort((a, b) => b.fullyDiluted - a.fullyDiluted);
  const shown = holders.slice(0, limits.maxHolders);
  if (shown.length < holders.length) truncated = true;
  sections.push(['# Holders', '',
    `${holders.length} holder${holders.length === 1 ? '' : 's'} with a position${shown.length < holders.length ? `, the largest ${shown.length} listed` : ''}.`,
    '',
    table(['Name', 'Relationship', 'Outstanding', 'Options', 'RSUs', 'Warrants', 'Fully diluted', 'Percent', 'Voting percent', 'Invested', 'Value'],
      shown.map((r) => [r.name, r.relation, formatShares(r.outstanding), formatShares(r.optionsOutstanding),
        formatShares(r.rsusOutstanding), formatShares(r.warrantsOutstanding), formatShares(r.fullyDiluted),
        formatPct(r.fullyDilutedPct), formatPct(r.votingPct), formatMoney(r.investedAmount), formatMoney(r.currentValue)])),
  ].join('\n'));

  const live = data.convertibles.filter((c) => c.status === 'OUTSTANDING');
  if (live.length > 0) {
    const shownConvertibles = live.slice(0, limits.maxConvertibles);
    if (shownConvertibles.length < live.length) truncated = true;
    const nameOf = new Map(data.stakeholders.map((s) => [s.id, s.name]));
    sections.push(['# Outstanding convertibles', '',
      table(['Holder', 'Instrument', 'Principal', 'Issued', 'Valuation cap', 'Discount', 'Maturity'],
        shownConvertibles.map((c) => [nameOf.get(c.stakeholderId) ?? 'unknown', c.instrument, formatMoney(c.principal),
          c.issueDate, c.valuationCap ? formatMoney(c.valuationCap) : 'none',
          c.discount ? formatPct(c.discount) : 'none', c.maturityDate ?? '—'])),
    ].join('\n'));
  }

  if (data.valuations.length > 0) {
    sections.push(['# Valuations', '',
      table(['Effective', 'Type', 'Fair market value', 'Status', 'Provider'],
        [...data.valuations].sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate)).slice(0, limits.maxValuations)
          .map((v) => [v.effectiveDate, v.type, formatPPS(v.fairMarketValue), v.status, v.provider ?? '—'])),
    ].join('\n'));
  }

  const findings = complianceSummary(data, { ...compliance, asOf });
  if (findings.issues.length > 0) {
    sections.push(['# Open compliance findings', '',
      line('Score', `${findings.score} out of ${findings.scoring.start}`),
      line('Counts', `${findings.errors} error, ${findings.warnings} warning, ${findings.info} informational`),
      '',
      table(['Severity', 'Rule', 'What', 'Due'],
        findings.issues.slice(0, limits.maxComplianceFindings).map((i) => [i.severity, i.title, i.detail.replace(/\n/g, ' '), i.dueDate ?? '—'])),
    ].join('\n'));
  }

  if (truncated) {
    sections.push(['# Note', '',
      'Some lists above were shortened to keep this brief. Totals and percentages always cover every record, not just the rows shown.',
    ].join('\n'));
  }

  const text = sections.join('\n\n');
  return { text, bytes: Buffer.byteLength(text, 'utf8'), truncated };
}

export const SYSTEM_PROMPT = [
  'You answer questions about one company\'s capitalization table for someone who runs that company.',
  '',
  'The message below the line is a snapshot of their cap table, computed by the application from its own records.',
  'Treat it as the truth. Every total, percentage and compliance finding in it has already been calculated, so use',
  'the figures as given rather than deriving your own from the underlying rows.',
  '',
  'Rules you follow without exception:',
  '- If the snapshot does not contain the answer, say so and name the page of the app that would have it. Never guess',
  '  a number, and never invent a holder, a class, a document or a date.',
  '- Show the figures you used, so the person can check them against the page they came from.',
  '- Be brief. Answer in a few sentences, or a short list when the answer is genuinely a list.',
  '- You may explain how equity concepts work in general. You may not give legal, tax or investment advice, and you',
  '  say so plainly when a question calls for it rather than hedging your way through an answer.',
  '- The snapshot holds real people and real holdings. Answer the question that was asked and do not volunteer',
  '  personal details that were not.',
].join('\n');
