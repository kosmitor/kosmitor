/**
 * Compares the cap table the app computes from an export with the export's own
 * figures, level by level — internal checks, class totals, holder × class,
 * grants, percentages — and accounts for every difference.
 *
 * A difference is put down to one of five causes: the import read the data
 * wrong ("import mapping"), a confirmed app bug from the math audit ("known
 * bug", with its ID), two right answers under different definitions
 * ("definition"), an export that is wrong or does not add up ("source system"),
 * or none of these ("unexplained": each one is a possible new bug). A total that
 * differs only because the figures under it differ takes their cause, and says so.
 */
import {
  computeCapTable, awardIsLive, accruedInterest, addMonths, roundShares, shareValue, splitFactor,
  type CompanyData, type CapTable, type Award, type VestingSchedule,
} from '@ct/core';
import { LABELLED_TOTALS, type SourceFigures, type GrantLine, type CertificateLine, type Line, type Measure } from './source.ts';

export type Level = 'import' | 'internal' | 'class' | 'holder' | 'grant' | 'percent';
export const LEVELS: Level[] = ['import', 'internal', 'class', 'holder', 'grant', 'percent'];
export type Category = 'import mapping' | 'known bug' | 'definition' | 'source system' | 'unexplained';
export const CATEGORIES: Category[] = ['import mapping', 'known bug', 'definition', 'source system', 'unexplained'];
export type Unit = 'shares' | 'count' | 'cents' | 'price' | 'pct' | 'date' | 'text';

export interface Explanation {
  category: Category;
  bug?: string | null;
  note: string;
  /** False when the difference only follows from others listed separately. */
  root?: boolean;
}
type Explainer = (c: Comparison) => Explanation | null;

export interface Comparison {
  level: Level;
  key: string;
  field: string;
  unit: Unit;
  source: number | string | null;
  app: number | string | null;
  tolerance: number;
  /** Where the export states it. */
  where: string;
  explainers: Explainer[];
  /** App minus export, once compared; null when they agree (or for text that differs). */
  difference: number | null;
  differs: boolean;
  explanation: Explanation | null;
}

/** A row the import could not read. */
export interface ImportIssue { file: string; sheet: string; row: number; kind: string; holder: string | null; label: string | null; className: string | null; messages: string[] }

export interface CompareContext {
  asOf: string;
  /** The date the imported ledgers are as of, when it is later than asOf (a history check). */
  dataAsOf: string | null;
  includeUnallocatedPool: boolean;
  includeConvertibles: boolean;
  ptepMonths: number;
  optionTermYears: number;
  importIssues: ImportIssue[];
  /** The certificates as the imported ledgers state them, issued and outstanding. */
  ledgerCertificates: CertificateLine[];
}

export const keyOf = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
/** "CS-Common", "Common Stock" and "Common" are one class. */
export const classKey = (s: string): string => keyOf(s.replace(/^[A-Z]{1,5}\s*-\s*(?=\S)/, '')).replace(/\s+(stock|shares)$/, '');
const isInteger = (n: number): boolean => Math.abs(n - Math.round(n)) < 1e-9;
const plural = (n: number, word: string): string => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

export class Comparer {
  readonly comparisons: Comparison[] = [];
  private readonly data: CompanyData;
  private readonly table: CapTable;
  private readonly src: SourceFigures;
  private readonly ctx: CompareContext;
  private readonly holderById: Map<string, CompanyData['stakeholders'][number]>;

  constructor(data: CompanyData, table: CapTable, src: SourceFigures, ctx: CompareContext) {
    this.data = data;
    this.table = table;
    this.src = src;
    this.ctx = ctx;
    this.holderById = new Map(data.stakeholders.map((s) => [s.id, s]));
  }

  private add(c: Omit<Comparison, 'difference' | 'differs' | 'explanation' | 'explainers' | 'tolerance' | 'where'> & Partial<Pick<Comparison, 'explainers' | 'tolerance' | 'where'>>): Comparison {
    const full: Comparison = { explainers: [], tolerance: 0, where: '', ...c, difference: null, differs: false, explanation: null };
    if (typeof full.source === 'number' && typeof full.app === 'number') {
      const d = full.app - full.source;
      full.differs = Math.abs(d) > full.tolerance + 1e-9;
      full.difference = full.differs ? roundShares(d) : null;
    } else {
      full.differs = (full.source ?? '') !== (full.app ?? '');
    }
    this.comparisons.push(full);
    return full;
  }

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  /** The class a name means: the same name, else the same class written another way ("CS-Common", "Common Stock"), preferring one with shares. */
  private appClass(name: string) {
    const exact = this.table.classes.find((c) => keyOf(c.name) === keyOf(name));
    if (exact) return exact;
    const loose = this.table.classes.filter((c) => classKey(c.name) === classKey(name));
    return loose.find((c) => c.outstanding > 0) ?? loose[0];
  }
  private appPool(name: string) {
    return this.table.pools.find((p) => keyOf(p.name) === keyOf(name));
  }
  /** The class or plan a summary line is about, by any of its labels. */
  private classOfLine(line: Line) {
    for (const a of line.aliases) { const c = this.appClass(a); if (c) return c; }
    return undefined;
  }
  private poolOfLine(line: Line) {
    for (const a of line.aliases) { const p = this.appPool(a); if (p) return p; }
    return undefined;
  }
  private labelledAs(line: Line): Measure | undefined {
    return LABELLED_TOTALS.find(([, re]) => line.aliases.some((a) => re.test(keyOf(a))))?.[0];
  }
  private appRow(holder: string) {
    return this.table.rows.find((r) => keyOf(r.name) === keyOf(holder));
  }
  private awardFor(g: GrantLine): Award | undefined {
    const holder = this.data.stakeholders.find((s) => keyOf(s.name) === keyOf(g.holder));
    if (g.label) return this.data.awards.find((a) => a.label != null && keyOf(a.label) === keyOf(g.label!));
    return this.data.awards.find((a) => a.stakeholderId === holder?.id && a.quantity === g.granted && (g.strike == null || a.strikePrice === g.strike));
  }
  private issuesFor(match: (i: ImportIssue) => boolean): ImportIssue[] {
    return this.ctx.importIssues.filter(match);
  }

  /** What the cap table shows for one grant on a date: the table computed with that grant alone. */
  private perAward(award: Award, date = this.ctx.asOf): { live: boolean; outstanding: number; vested: number; unvested: number } {
    const t = computeCapTable({ ...this.data, awards: [award], issuances: [], warrants: [], convertibles: [] }, { asOf: date, includeUnallocatedPool: false });
    const row = t.rows.find((r) => r.stakeholderId === award.stakeholderId);
    const holder = this.holderById.get(award.stakeholderId);
    return {
      live: awardIsLive(award, date, holder?.terminationDate ?? null),
      outstanding: (row?.optionsOutstanding ?? 0) + (row?.rsusOutstanding ?? 0),
      vested: row?.optionsVested ?? 0,
      unvested: row?.optionsUnvested ?? 0,
    };
  }

  // -------------------------------------------------------------------------
  // Explainers
  // -------------------------------------------------------------------------

  /** A figure made of others takes their causes when their differences add up to its own. */
  private fromParts(parts: () => Comparison[], what: string): Explainer {
    return (c) => {
      const differing = parts().filter((p) => p.differs && p.difference != null);
      if (differing.length === 0 || c.difference == null) return null;
      const sum = differing.reduce((s, p) => s + p.difference!, 0);
      if (Math.abs(sum - c.difference) > c.tolerance + differing.reduce((s, p) => s + p.tolerance, 0) + 1e-6) return null;
      return this.inherit(differing, `follows from ${plural(differing.length, `${what} difference`)}`);
    };
  }

  /** A percentage or derived figure that moves whenever the shares under it do. */
  private followsFrom(bases: () => (Comparison | undefined)[], what: string): Explainer {
    return () => {
      const differing = bases().filter((b): b is Comparison => !!b && b.differs);
      return differing.length ? this.inherit(differing, `follows from the ${what}`) : null;
    };
  }

  private inherit(parts: Comparison[], note: string): Explanation {
    const explained = parts.filter((p) => p.explanation);
    const lead = [...explained].sort((a, b) => Math.abs(b.difference ?? 0) - Math.abs(a.difference ?? 0))[0];
    const bugs = [...new Set(explained.map((p) => p.explanation!.bug).filter((b): b is string => !!b))];
    const categories = [...new Set(explained.map((p) => p.explanation!.category))];
    return {
      category: lead?.explanation?.category ?? 'unexplained',
      bug: bugs.length ? bugs.join(' ') : null,
      note: `${note}${categories.length > 1 ? ` (${categories.join(', ')})` : ''}`,
      root: false,
    };
  }

  private importExplainer(match: (i: ImportIssue) => boolean, what: string): Explainer {
    return () => {
      const issues = this.issuesFor(match);
      if (!issues.length) return null;
      const first = issues[0];
      return { category: 'import mapping', note: `${plural(issues.length, `${what} row`)} did not import (${first.sheet} row ${first.row}: ${first.messages[0] ?? 'error'})` };
    };
  }

  private historyExplainer(hasLaterEvents: () => boolean, what: string): Explainer {
    return () => (this.ctx.dataAsOf && this.ctx.asOf < this.ctx.dataAsOf && hasLaterEvents()
      ? { category: 'known bug', bug: 'CAP-1', note: `the ledgers are as of ${this.ctx.dataAsOf}; the app applies their ${what} to an earlier date because imported quantities carry no date` }
      : null);
  }

  // -------------------------------------------------------------------------
  // Grants
  // -------------------------------------------------------------------------

  private grantComparisons = new Map<GrantLine, { outstanding?: Comparison; vested?: Comparison }>();

  compareGrants(): void {
    const { src } = this;
    for (const g of src.grants) {
      const award = this.awardFor(g);
      const key = `${g.label ?? '(no grant ID)'} — ${g.holder}`;
      const holder = award ? this.holderById.get(award.stakeholderId) : undefined;
      const app = award ? this.perAward(award) : null;
      const sourceOutstanding = g.outstanding ?? (g.granted != null ? g.granted - g.exercised - g.cancelled : null);
      const notImported = this.importExplainer((i) => i.kind === 'grants' && ((!!g.label && i.label === g.label) || (!g.label && i.holder === g.holder)), 'grant');
      const entry: { outstanding?: Comparison; vested?: Comparison } = {};
      this.grantComparisons.set(g, entry);

      entry.outstanding = this.add({
        level: 'grant', key, field: 'outstanding', unit: 'shares', source: sourceOutstanding, app: app?.outstanding ?? 0, where: g.where,
        explainers: [
          notImported,
          () => (!award ? { category: 'import mapping', note: 'the grant is not in the imported data' } : null),
          () => this.explainGrantOutstanding(g, award!, holder, app!),
          this.historyExplainer(() => !!award && (award.exercisedQuantity + award.cancelledQuantity > 0 || award.status !== 'OUTSTANDING'), 'exercised and cancelled quantities'),
        ],
      });
      if (!award) continue;
      const later = this.historyExplainer(() => true, 'exercised and cancelled quantities');
      this.add({ level: 'grant', key, field: 'exercised', unit: 'shares', source: g.exercised, app: award.exercisedQuantity, where: g.where, explainers: [later] });
      this.add({ level: 'grant', key, field: 'cancelled', unit: 'shares', source: g.cancelled, app: award.cancelledQuantity, where: g.where, explainers: [later] });
      if (g.strike != null) this.add({ level: 'grant', key, field: 'exercise price', unit: 'price', source: g.strike, app: award.strikePrice, where: g.where });
      if (src.columns.grantExpiration && g.expiration) this.add({ level: 'grant', key, field: 'expiration', unit: 'date', source: g.expiration, app: award.expirationDate, where: g.where });

      // Vesting is compared for options the app still counts; a closed grant's vesting is moot.
      const isOption = award.type !== 'RSU' && award.type !== 'PHANTOM' && award.type !== 'RSA';
      if (!app!.live || !isOption) continue;
      if (g.vested != null) {
        const sourceVested = src.columns.grantVestedExercised ? g.vested - (g.vestedExercised ?? 0) : g.vested;
        entry.vested = this.add({
          level: 'grant', key, field: 'vested', unit: 'shares', source: sourceVested, app: app!.vested, where: g.where,
          explainers: [() => this.explainVested(sourceVested, award, holder, app!.vested)],
        });
      }
      if (g.unvested != null) {
        this.add({
          level: 'grant', key, field: 'unvested', unit: 'shares', source: g.unvested, app: app!.unvested, where: g.where,
          explainers: [this.followsFrom(() => [entry.vested, entry.outstanding], 'vested and outstanding counts of this grant')],
        });
      }
    }
  }

  private explainGrantOutstanding(g: GrantLine, award: Award, holder: CompanyData['stakeholders'][number] | undefined, app: { live: boolean; outstanding: number; vested: number; unvested: number }): Explanation | null {
    const { ctx } = this;
    const source = g.outstanding ?? (g.granted ?? 0) - g.exercised - g.cancelled;
    const left = holder?.terminationDate && holder.terminationDate <= ctx.asOf ? holder.terminationDate : null;
    if (left && award.type !== 'RSA') {
      const windowEnd = addMonths(left, award.ptepMonths ?? ctx.ptepMonths);
      if (app.live && app.outstanding > source && (Math.abs(app.outstanding - source - app.unvested) < 1e-6 || Math.abs(source - app.vested) < 1e-6)) {
        return { category: 'known bug', bug: 'CAP-4', note: `the holder left on ${left}; the app keeps the ${plural(app.unvested, 'unvested share')} outstanding until the exercise window closes, the export does not` };
      }
      if (!app.live && source > app.outstanding && ctx.asOf > windowEnd) {
        return { category: 'import mapping', note: `the export states no exercise window; the import gives every grant ${ctx.ptepMonths} months (equity.postTerminationExerciseMonths), which closed on ${windowEnd}. Check the grant's actual window` };
      }
    }
    if (award.expirationDate && award.expirationDate < ctx.asOf && source > app.outstanding) {
      return this.src.columns.grantExpiration
        ? { category: 'source system', note: `the grant expired on ${award.expirationDate} and the export still counts it` }
        : { category: 'import mapping', note: `the export states no expiration date; the import assumed ${ctx.optionTermYears} years (equity.optionTermYears), which ended on ${award.expirationDate}` };
    }
    if (award.grantDate > ctx.asOf) return { category: 'definition', note: `granted on ${award.grantDate}, after the as-of date` };
    if (award.status !== 'OUTSTANDING' && g.granted != null && g.exercised + g.cancelled >= g.granted && source > 0) {
      return { category: 'source system', note: 'the export lists the grant as outstanding although its exercised and cancelled shares use it up' };
    }
    return null;
  }

  private explainVested(source: number, award: Award, holder: CompanyData['stakeholders'][number] | undefined, appVested: number): Explanation | null {
    if (!isInteger(appVested)) return { category: 'known bug', bug: 'VA-8', note: `the app vests a fraction of a share (${appVested})` };
    if (!this.src.columns.grantVestedExercised && award.exercisedQuantity > 0 && Math.abs(source - (appVested + award.exercisedQuantity)) < 1e-6) {
      return { category: 'definition', note: `the export's vested count includes the ${plural(award.exercisedQuantity, 'exercised share')}; the app's counts vested options still outstanding` };
    }
    const schedule = this.data.vestingSchedules.find((s) => s.id === award.vestingScheduleId);
    if (schedule) {
      const cutoff = holder?.terminationDate && holder.terminationDate < this.ctx.asOf ? holder.terminationDate : this.ctx.asOf;
      for (const alt of roundingAlternatives(schedule, award.quantity, award.vestingStartDate, cutoff)) {
        if (Math.abs(alt.vested - award.exercisedQuantity - source) < 1e-6 && Math.abs(alt.vested - award.exercisedQuantity - appVested) > 1e-6) {
          return { category: 'definition', note: `the export ${alt.name}; the app floors the running total (OCF CUMULATIVE_ROUND_DOWN)` };
        }
      }
    }
    for (let days = 1; days <= 31; days++) {
      for (const sign of [1, -1]) {
        const date = shiftDays(this.ctx.asOf, sign * days);
        if (Math.abs(this.perAward(award, date).vested - source) < 1e-6) {
          const when = `${plural(days, 'day')} ${sign > 0 ? 'later' : 'earlier'}`;
          return days === 1
            ? { category: 'definition', note: `the export matches the app's figure one day ${sign > 0 ? 'later' : 'earlier'}: the two date a vesting day differently (on the anniversary or the day after)` }
            : { category: 'unexplained', note: `the export matches the app's figure ${when}` };
        }
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Holders
  // -------------------------------------------------------------------------

  private holderComparisons = new Map<string, Map<string, Comparison>>();
  private holderCmp(holder: string, field: string): Comparison | undefined {
    return this.holderComparisons.get(keyOf(holder))?.get(field);
  }
  private grantOutstandingFor(holder: string, plan?: string): Comparison[] {
    return [...this.grantComparisons.entries()]
      .filter(([g]) => keyOf(g.holder) === keyOf(holder) && (plan == null || (g.plan != null && keyOf(g.plan) === keyOf(plan))))
      .map(([, c]) => c.outstanding).filter((c): c is Comparison => !!c);
  }

  compareHolders(): void {
    const { src, table } = this;
    type Holder = { name: string; where: string; shares: Map<string, number>; options: number | null; outstanding?: number; fullyDiluted?: number; principal?: number };
    const holders = new Map<string, Holder>();
    const holderFor = (name: string, where: string): Holder => {
      let h = holders.get(keyOf(name));
      if (!h) { h = { name, where, shares: new Map(), options: null }; holders.set(keyOf(name), h); }
      return h;
    };
    const fromOwnership = !!src.ownership;
    let statesOptions = !fromOwnership;
    if (src.ownership) {
      for (const line of src.ownership.lines) {
        const h = holderFor(line.name, line.where);
        for (const [header, n] of line.securities) {
          const cls = this.appClass(header);
          if (cls) h.shares.set(cls.name, (h.shares.get(cls.name) ?? 0) + n);
          else if (this.appPool(header) || /outside (of )?(a |the )?plan|non.?plan/i.test(header)) { h.options = (h.options ?? 0) + n; statesOptions = true; }
        }
        if (line.values.options != null) { h.options = line.values.options; statesOptions = true; }
        if (line.values.outstanding != null) h.outstanding = line.values.outstanding;
        if (line.values.fullyDiluted != null) h.fullyDiluted = line.values.fullyDiluted;
      }
    } else {
      for (const c of src.certificates) {
        if (!c.className || c.outstanding == null) continue;
        const cls = this.appClass(c.className);
        const h = holderFor(c.holder, c.where);
        const name = cls?.name ?? c.className;
        h.shares.set(name, (h.shares.get(name) ?? 0) + c.outstanding);
      }
      for (const g of src.grants) {
        const h = holderFor(g.holder, g.where);
        const n = g.outstanding ?? (g.granted != null ? g.granted - g.exercised - g.cancelled : 0);
        h.options = (h.options ?? 0) + n;
      }
    }
    for (const c of src.convertibles) {
      if (c.status && !/outstanding|active|open|issued/i.test(c.status)) continue;
      const h = holderFor(c.holder, c.where);
      h.principal = (h.principal ?? 0) + (c.principalOutstanding ?? c.principal ?? 0);
    }
    // What the export states at all: a holder the app shows and the export leaves out is compared against nothing, but only for what the export covers.
    const statesShares = fromOwnership ? src.ownership!.lines.some((l) => [...l.securities.keys()].some((h) => this.appClass(h))) : src.certificates.length > 0;
    statesOptions &&= fromOwnership || src.grants.length > 0;
    for (const r of table.rows) {
      const covered = (statesShares && r.outstanding > 0) || (statesOptions && r.optionsOutstanding + r.rsusOutstanding > 0);
      if (covered && !holders.has(keyOf(r.name))) holderFor(r.name, '(not in the export)');
    }

    const classNames = new Set([...holders.values()].flatMap((h) => [...h.shares.keys()]));
    for (const h of holders.values()) {
      const row = this.appRow(h.name);
      const mine = new Map<string, Comparison>();
      this.holderComparisons.set(keyOf(h.name), mine);
      const certificatesOf = (cls: string) => this.ctx.ledgerCertificates.filter((c) => keyOf(c.holder) === keyOf(h.name) && c.className && classKey(c.className) === classKey(cls));
      for (const cls of classNames) {
        const source = h.shares.get(cls) ?? 0;
        const app = row?.holdings.find((x) => classKey(x.className) === classKey(cls))?.shares ?? 0;
        if (source === 0 && app === 0) continue;
        mine.set(`shares:${cls}`, this.add({
          level: 'holder', key: h.name, field: `${cls} shares`, unit: 'shares', source, app, where: h.where,
          explainers: [
            this.importExplainer((i) => i.kind === 'captable' && i.holder != null && keyOf(i.holder) === keyOf(h.name), 'certificate'),
            this.historyExplainer(() => certificatesOf(cls).some((c) => c.issued != null && c.outstanding != null && c.issued > c.outstanding), 'transfers and repurchases'),
          ],
        }));
      }
      const appOptions = (row?.optionsOutstanding ?? 0) + (row?.rsusOutstanding ?? 0);
      if (statesOptions && (h.options != null || appOptions > 0)) {
        mine.set('options', this.add({
          level: 'holder', key: h.name, field: 'options and RSUs outstanding', unit: 'shares', source: h.options ?? 0, app: appOptions, where: h.where,
          explainers: [this.fromParts(() => this.grantOutstandingFor(h.name), 'grant')],
        }));
      }
      if (fromOwnership && h.outstanding != null) {
        mine.set('outstanding', this.add({
          level: 'holder', key: h.name, field: 'issued and outstanding', unit: 'shares', source: h.outstanding, app: row?.outstanding ?? 0, where: h.where,
          explainers: [this.fromParts(() => [...mine.entries()].filter(([k]) => k.startsWith('shares:')).map(([, c]) => c), 'class')],
        }));
      }
      if (fromOwnership && h.fullyDiluted != null) {
        mine.set('fullyDiluted', this.add({
          level: 'holder', key: h.name, field: 'fully diluted', unit: 'shares', source: h.fullyDiluted, app: row?.fullyDiluted ?? 0, where: h.where,
          explainers: [
            this.fromParts(() => [...mine.entries()].filter(([k]) => k.startsWith('shares:') || k === 'options').map(([, c]) => c), 'share and option'),
            (c) => (this.ctx.includeConvertibles && row && c.difference != null && Math.abs(c.difference - row.convertibleAsConverted) < 1
              ? { category: 'definition', note: 'the app adds its estimate of shares for this holder\'s SAFEs and notes; the export does not' } : null),
          ],
        }));
      }
      if (src.convertibles.length && (h.principal != null || (row?.convertiblePrincipal ?? 0) > 0)) {
        mine.set('principal', this.add({
          level: 'holder', key: h.name, field: 'SAFE and note principal', unit: 'cents', source: h.principal ?? 0, app: row?.convertiblePrincipal ?? 0, where: h.where,
          explainers: [this.importExplainer((i) => i.kind === 'convertibles' && i.holder != null && keyOf(i.holder) === keyOf(h.name), 'convertible')],
        }));
      }
    }

    // Interest a note has accrued, where the export states it.
    for (const c of src.convertibles) {
      if (c.interest == null) continue;
      const holder = this.data.stakeholders.find((s) => keyOf(s.name) === keyOf(c.holder));
      const app = this.data.convertibles.find((x) => (c.label ? x.label != null && keyOf(x.label) === keyOf(c.label) : x.stakeholderId === holder?.id && x.principal === c.principal));
      const live = app && app.status === 'OUTSTANDING' && app.issueDate <= this.ctx.asOf;
      this.add({
        level: 'holder', key: `${c.label ?? '(no ID)'} — ${c.holder}`, field: 'accrued interest', unit: 'cents', source: c.interest, app: live ? accruedInterest(app, this.ctx.asOf) : 0, where: c.where, tolerance: 1,
        explainers: [
          () => (!app ? { category: 'import mapping', note: 'the instrument is not in the imported data' } : null),
          () => {
            if (!app || app.compounding !== 'SIMPLE') return null;
            const days = Math.round((Date.parse(this.ctx.asOf) - Date.parse(app.issueDate)) / 86_400_000);
            const actual365 = Math.round((app.principal * app.interestRate * days) / 365);
            return Math.abs(actual365 - c.interest!) <= 1
              ? { category: 'known bug', bug: 'CR-5', note: 'the export counts days over a 365-day year; the app counts years of 365.25 days' } : null;
          },
        ],
      });
    }

    if (src.voting) {
      for (const line of src.voting.lines) {
        const row = this.appRow(line.name);
        if (line.values.votes == null) continue;
        const mine = this.holderComparisons.get(keyOf(line.name));
        const votes = this.add({
          level: 'holder', key: line.name, field: 'votes', unit: 'shares', source: line.values.votes, app: row?.votes ?? 0, where: line.where,
          explainers: [
            () => (row && !isInteger(row.votes) ? { category: 'known bug', bug: 'CAP-13', note: `the app keeps a fraction of a vote (${row.votes})` } : null),
            this.fromParts(() => [...(mine?.entries() ?? [])].filter(([k]) => k.startsWith('shares:')).map(([, c]) => c), 'class'),
          ],
        });
        if (mine) mine.set('votes', votes);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Classes, plans and totals
  // -------------------------------------------------------------------------

  private totalCmp = new Map<string, Comparison>();
  private classCmp = new Map<string, Comparison>();
  private poolCmp = new Map<string, Comparison>();

  compareClasses(): void {
    const { src, table, data } = this;
    const summary = src.summary;
    const classLines = new Map<string, Line>();
    const poolLines = new Map<string, Line>();
    const labelled: Partial<Record<Measure, { value: number; where: string }>> = {};
    for (const line of summary?.lines ?? []) {
      const cls = this.classOfLine(line);
      const pool = this.poolOfLine(line);
      if (cls) classLines.set(cls.name, line);
      else if (pool) poolLines.set(pool.name, line);
      else {
        const m = this.labelledAs(line);
        if (m && line.values[m] != null) labelled[m] ??= { value: line.values[m]!, where: line.where };
      }
    }
    if (summary?.total) for (const [m, v] of Object.entries(summary.total.values) as [Measure, number][]) labelled[m] ??= { value: v, where: summary.total.where };

    // Share classes: the summary's line, or what the certificate ledger adds up to.
    const ledgerSums = new Map<string, { value: number; where: string }>();
    for (const c of src.certificates) {
      if (!c.className || c.outstanding == null) continue;
      const name = this.appClass(c.className)?.name ?? c.className;
      const prev = ledgerSums.get(name);
      ledgerSums.set(name, { value: (prev?.value ?? 0) + c.outstanding, where: prev?.where ?? c.where });
    }
    // A class the app has and the export does not mention is a difference, provided the export lists classes at all.
    const statesClasses = classLines.size > 0 || ledgerSums.size > 0;
    const classNames = new Set([...classLines.keys(), ...ledgerSums.keys(), ...(statesClasses ? table.classes.filter((c) => c.outstanding > 0).map((c) => c.name) : [])]);
    for (const name of classNames) {
      const line = classLines.get(name);
      const app = this.appClass(name);
      const source = line?.values.outstanding ?? ledgerSums.get(name)?.value ?? 0;
      const holderParts = () => [...this.holderComparisons.values()].map((m) => m.get(`shares:${app?.name ?? name}`)).filter((c): c is Comparison => !!c);
      this.classCmp.set(name, this.add({
        level: 'class', key: name, field: 'outstanding', unit: 'shares', source, app: app?.outstanding ?? 0,
        where: line?.where ?? `${ledgerSums.get(name)?.where ?? ''} (ledger total)`,
        explainers: [
          this.fromParts(holderParts, 'holder'),
          this.importExplainer((i) => i.kind === 'captable' && i.className != null && classKey(i.className) === classKey(name), 'certificate'),
        ],
      }));
      if (line?.values.available != null && app) {
        this.add({
          level: 'class', key: name, field: 'available', unit: 'shares', source: line.values.available, app: app.available, where: line.where,
          explainers: [() => this.explainClassAvailable(app, line.values.available!)],
        });
      }
      if (line?.values.invested != null && app) {
        const certs = src.certificates.filter((c) => c.className && classKey(c.className) === classKey(name));
        this.add({
          level: 'class', key: name, field: 'capital contribution', unit: 'cents', source: line.values.invested, app: app.investedAmount, where: line.where,
          tolerance: Math.max(1, certs.length),
          explainers: [(c) => {
            // A price shown to four decimals is off by at most half a hundredth of a cent a share.
            const recomputed = certs.reduce((s, x) => s + shareValue(x.outstanding ?? 0, x.price ?? 0), 0);
            const bound = certs.reduce((s, x) => s + (x.outstanding ?? 0) * 0.005, 0) + certs.length;
            return Math.abs(recomputed - app.investedAmount) <= certs.length && Math.abs(c.difference ?? 0) <= bound
              ? { category: 'import mapping', note: 'within what a price per share rounded to four decimals accounts for: the export states the amounts paid, the app multiplies the shares by the rounded price' } : null;
          }],
        });
      }
    }

    // Plans: the summary's plan line, or the footer under the grants.
    const poolNames = new Set([...poolLines.keys(), ...table.pools.map((p) => p.name)]);
    for (const name of poolNames) {
      const pool = this.appPool(name);
      const line = poolLines.get(name);
      const footer = src.planFooters.find((f) => f.plan != null && keyOf(f.plan) === keyOf(name)) ?? (table.pools.length === 1 ? src.planFooters[0] : undefined);
      const authorized = line?.values.authorized ?? footer?.authorized;
      if (authorized != null) this.add({ level: 'class', key: `plan: ${name}`, field: 'authorized', unit: 'shares', source: authorized, app: pool?.authorized ?? 0, where: line?.where ?? footer!.where });
      const grantsIn = () => [...this.grantComparisons.entries()]
        .filter(([g]) => (g.plan != null && keyOf(g.plan) === keyOf(name)) || (g.plan == null && table.pools.length === 1)).map(([, c]) => c.outstanding).filter((c): c is Comparison => !!c);
      if (line?.values.options != null) {
        const appOptions = data.awards.filter((a) => a.poolId === pool?.poolId).reduce((s, a) => s + this.perAward(a).outstanding, 0);
        this.add({ level: 'class', key: `plan: ${name}`, field: 'options outstanding', unit: 'shares', source: line.values.options, app: appOptions, where: line.where, explainers: [this.fromParts(grantsIn, 'grant')] });
      }
      const available = line?.values.available ?? footer?.available ?? (table.pools.length === 1 && poolLines.size === 0 ? labelled.available?.value : undefined);
      if (available != null) {
        this.poolCmp.set(name, this.add({
          level: 'class', key: `plan: ${name}`, field: 'available', unit: 'shares', source: available, app: pool?.available ?? 0,
          where: line?.where ?? footer?.where ?? labelled.available?.where ?? '',
          explainers: [this.poolExplainer(grantsIn), this.lapsedExplainer(pool?.poolId ?? null), this.importExplainer((i) => i.kind === 'grants', 'grant')],
        }));
      }
    }

    // Totals.
    const grantParts = () => [...this.grantComparisons.values()].map((c) => c.outstanding).filter((c): c is Comparison => !!c);
    const optionsSource = labelled.options?.value ?? (poolLines.size ? [...poolLines.values()].reduce((s, l) => s + (l.values.options ?? 0), 0) : undefined);
    if (optionsSource != null) {
      this.totalCmp.set('options', this.add({
        level: 'class', key: 'total', field: 'options and RSUs outstanding', unit: 'shares', source: optionsSource,
        app: table.totals.optionsOutstanding + table.totals.rsusOutstanding, where: labelled.options?.where ?? [...poolLines.values()][0]?.where ?? '',
        explainers: [this.fromParts(grantParts, 'grant')],
      }));
    }
    if (labelled.available != null && !(table.pools.length === 1 && this.poolCmp.size === 1 && poolLines.size === 0 && !src.planFooters[0]?.available)) {
      this.totalCmp.set('available', this.add({
        level: 'class', key: 'total', field: 'pool available', unit: 'shares', source: labelled.available.value, app: table.totals.poolAvailable, where: labelled.available.where,
        explainers: [
          this.poolExplainer(grantParts),
          this.lapsedExplainer(null),
          () => (!this.ctx.includeUnallocatedPool ? { category: 'definition', note: 'run with the unallocated pool left out of fully diluted' } : null),
          this.importExplainer((i) => i.kind === 'grants', 'grant'),
        ],
      }));
    }
    if (labelled.outstanding != null) {
      this.totalCmp.set('outstanding', this.add({
        level: 'class', key: 'total', field: 'outstanding', unit: 'shares', source: labelled.outstanding.value, app: table.totals.outstanding, where: labelled.outstanding.where,
        explainers: [this.fromParts(() => [...this.classCmp.values()], 'class')],
      }));
    }
    if (labelled.warrants != null) {
      this.totalCmp.set('warrants', this.add({ level: 'class', key: 'total', field: 'warrants outstanding', unit: 'shares', source: labelled.warrants.value, app: table.totals.warrantsOutstanding, where: labelled.warrants.where }));
    }
    if (labelled.fullyDiluted != null) {
      const fdParts = () => [
        ...[...this.classCmp.entries()].map(([name, c]) => ({ ...c, difference: c.difference == null ? null : c.difference * (data.shareClasses.find((s) => s.name === name)?.conversionRatio ?? 1) })),
        ...['options', 'warrants'].map((k) => this.totalCmp.get(k)).filter((c): c is Comparison => !!c),
        ...(this.totalCmp.get('available') ? [this.totalCmp.get('available')!] : [...this.poolCmp.values()]),
      ] as Comparison[];
      this.totalCmp.set('fullyDiluted', this.add({
        level: 'class', key: 'total', field: 'fully diluted', unit: 'shares', source: labelled.fullyDiluted.value, app: table.totals.fullyDiluted, where: labelled.fullyDiluted.where,
        explainers: [
          this.fromParts(fdParts, 'class, option and pool'),
          (c) => (c.difference != null && Math.abs(c.difference - table.totals.poolAvailable) < 1e-6 && this.ctx.includeUnallocatedPool
            ? { category: 'definition', note: 'the export leaves the unallocated pool out of fully diluted; the app counts it (run with --no-pool to match)' } : null),
          (c) => (c.difference != null && this.ctx.includeConvertibles && Math.abs(c.difference - table.totals.convertibleAsConverted) < 1
            ? { category: 'definition', note: 'the app adds its SAFE and note estimates to fully diluted; the export does not' } : null),
        ],
      }));
    }

    // SAFEs and notes.
    const live = data.convertibles.filter((c) => c.status === 'OUTSTANDING' && c.issueDate <= this.ctx.asOf);
    const srcLive = src.convertibles.filter((c) => !c.status || /outstanding|active|open|issued/i.test(c.status));
    if (src.convertibles.length) {
      const principalParts = () => [...this.holderComparisons.values()].map((m) => m.get('principal')).filter((c): c is Comparison => !!c);
      this.add({ level: 'class', key: 'SAFEs and notes', field: 'outstanding instruments', unit: 'count', source: srcLive.length, app: live.length, where: src.convertibles[0].where,
        explainers: [this.importExplainer((i) => i.kind === 'convertibles', 'convertible')] });
      this.add({ level: 'class', key: 'SAFEs and notes', field: 'principal outstanding', unit: 'cents', source: srcLive.reduce((s, c) => s + (c.principalOutstanding ?? c.principal ?? 0), 0),
        app: live.reduce((s, c) => s + c.principal, 0), where: src.convertibles[0].where, explainers: [this.fromParts(principalParts, 'holder')] });
    }
  }

  /**
   * A plan's available shares move opposite to its grants: an option the app
   * keeps outstanding is one the plan has not got back, and a grant that did
   * not import is one the plan never gave out.
   */
  private poolExplainer(grants: () => Comparison[]): Explainer {
    return (c) => {
      const differing = grants().filter((g) => g.differs && g.difference != null);
      if (!differing.length || c.difference == null) return null;
      let expected = 0;
      for (const g of differing) {
        const line = [...this.grantComparisons.entries()].find(([, e]) => e.outstanding === g)?.[0];
        const missing = line && !this.awardFor(line);
        expected += -g.difference! + (missing ? line!.exercised : 0);
      }
      return Math.abs(expected - c.difference) < 1e-6 ? this.inherit(differing, `follows from ${plural(differing.length, 'grant difference')}`) : null;
    };
  }

  /**
   * Since CAP-8 the app's "available" for a class is authorized less issued and
   * less what the class must keep reserved: the plan's grants and unallocated
   * reserve, warrants and, in common, what preferred converts into (NVCA model
   * COI reservation covenant). An export that sets aside less, often only the
   * plan, differs by that definition.
   */
  private explainClassAvailable(cls: CapTable['classes'][number], source: number): Explanation | null {
    const plans = this.table.pools.filter((p) => this.data.pools.find((x) => x.id === p.poolId)?.shareClassId === cls.shareClassId);
    const plan = plans.reduce((s, p) => s + p.authorized - p.exercised, 0);
    const conversion = cls.kind === 'COMMON'
      ? this.table.classes.filter((c) => c.kind === 'PREFERRED' && this.data.shareClasses.find((x) => x.id === c.shareClassId)?.isConvertible !== false).reduce((s, c) => s + c.asConverted, 0) : 0;
    const warrants = roundShares(cls.reserved - plan - conversion);
    const others = [conversion > 0 && 'what preferred converts into', warrants > 1e-6 && 'warrants'].filter(Boolean).join(' and ');
    const setAside = roundShares(cls.authorized - cls.outstanding - source);
    if (Math.abs(setAside) < 1e-6 && cls.reserved > 0) {
      return { category: 'definition', note: `the export sets nothing aside; the app keeps ${plural(cls.reserved, 'share')} reserved for the plan, warrants and conversion` };
    }
    if (plan > 0 && others && Math.abs(setAside - plan) < 1e-6) {
      return { category: 'definition', note: `the export sets aside only the plan's ${plural(plan, 'share')}; the app also keeps ${(cls.reserved - plan).toLocaleString('en-US')} reserved for ${others}` };
    }
    return null;
  }

  /**
   * The app returns to the plan the unvested options of a holder who has left,
   * on the day they left ("Unvested shares are returned to the equity pool",
   * Carta, How to terminate stakeholders); an export may return them only once
   * a cancellation is recorded.
   */
  private lapsedExplainer(poolId: string | null): Explainer {
    return (c) => {
      if (c.difference == null || c.difference <= 0) return null;
      const lapsed = this.data.awards.reduce((sum, a) => {
        const left = this.holderById.get(a.stakeholderId)?.terminationDate;
        if ((poolId != null && a.poolId !== poolId) || a.type === 'RSA' || !left || left > this.ctx.asOf || !awardIsLive(a, this.ctx.asOf, left)) return sum;
        const granted = roundShares((a.quantity - a.exercisedQuantity - a.cancelledQuantity) * splitFactor(this.data, a.grantDate, this.ctx.asOf));
        return sum + Math.max(0, granted - this.perAward(a).outstanding);
      }, 0);
      return lapsed > 0 && Math.abs(c.difference - lapsed) < 1e-6
        ? { category: 'definition', note: `the app returns the ${plural(lapsed, 'unvested option')} of holders who left to the plan on the day they left; the export does not until a cancellation is recorded` }
        : null;
    };
  }

  // -------------------------------------------------------------------------
  // Internal checks
  // -------------------------------------------------------------------------

  compareInternal(): void {
    const { src, table } = this;
    const sourceCheck = (key: string, field: string, stated: number, sum: number, where: string, explainers: Explainer[] = []) =>
      this.add({ level: 'internal', key: `export: ${key}`, field, unit: 'shares', source: stated, app: sum, where,
        explainers: [...explainers, () => ({ category: 'source system', note: `the export's own figures do not add up: it states ${stated.toLocaleString('en-US')}, its lines add up to ${sum.toLocaleString('en-US')}` })] });

    // The summary against the ledgers and the ownership table.
    const ledgerByClass = new Map<string, number>();
    for (const c of src.certificates) if (c.className && c.outstanding != null) ledgerByClass.set(classKey(c.className), (ledgerByClass.get(classKey(c.className)) ?? 0) + c.outstanding);
    for (const line of src.summary?.lines ?? []) {
      const sum = line.aliases.map((a) => ledgerByClass.get(classKey(a))).find((n) => n != null);
      if (sum != null && line.values.outstanding != null) sourceCheck(`${line.name}`, 'summary vs certificate ledger', line.values.outstanding, sum, line.where);
    }
    if (src.ownership) {
      const columns = new Map<string, number>();
      for (const l of src.ownership.lines) for (const [h, n] of l.securities) columns.set(h, (columns.get(h) ?? 0) + n);
      for (const [h, sum] of columns) {
        const stated = src.summary?.lines.find((l) => l.aliases.some((a) => classKey(a) === classKey(h)))?.values.outstanding ?? ledgerByClass.get(classKey(h));
        if (stated != null) sourceCheck(h, 'ownership column vs summary', stated, sum, src.ownership.lines[0].where);
      }
      for (const [m, label] of [['fullyDilutedPct', 'fully diluted %'], ['outstandingPct', 'outstanding %']] as [Measure, string][]) {
        const lines = [...src.ownership.lines, ...(src.ownership.pool ? [src.ownership.pool] : [])].filter((l) => l.values[m] != null);
        if (!lines.length) continue;
        const sum = lines.reduce((s, l) => s + l.values[m]!, 0);
        const tol = (src.ownership.pctTolerance[m] ?? 1e-6) * lines.length;
        this.add({ level: 'internal', key: 'export: ownership table', field: `${label} adds up to 100%`, unit: 'pct', source: 1, app: sum, tolerance: tol, where: lines[0].where,
          explainers: [() => (m === 'fullyDilutedPct' && !src.ownership!.pool ? { category: 'definition', note: 'the table has no line for the unallocated pool, which makes up the rest' } : null),
            () => ({ category: 'source system', note: 'the export\'s percentages do not add up to 100%' })] });
      }
    }
    for (const t of src.ledgerTotals) {
      if (t.kind === 'captable' && t.values.outstanding != null) {
        const sum = src.certificates.filter((c) => c.where.includes(`› ${t.sheet},`)).reduce((s, c) => s + (c.outstanding ?? 0), 0);
        sourceCheck(`${t.sheet} total line`, 'outstanding', t.values.outstanding, sum, t.where);
      }
      if (t.kind === 'grants' && t.values.granted != null) {
        const sum = src.grants.filter((g) => g.where.includes(`› ${t.sheet},`)).reduce((s, g) => s + (g.granted ?? 0), 0);
        sourceCheck(`${t.sheet} total line`, 'granted', t.values.granted, sum, t.where);
      }
    }
    // Each grant: outstanding is what is left of the grant.
    for (const g of src.grants) {
      if (g.outstanding == null || g.granted == null) continue;
      const award = this.awardFor(g);
      const holder = award ? this.holderById.get(award.stakeholderId) : undefined;
      sourceCheck(`${g.label ?? g.holder}`, 'outstanding = granted − exercised − cancelled', g.outstanding, g.granted - g.exercised - g.cancelled, g.where, [() => {
        if (!award) return { category: 'import mapping', note: 'the grant did not import, so whether the export treats options as lapsed cannot be checked' };
        if (!holder?.terminationDate || holder.terminationDate > this.ctx.asOf) return null;
        return Math.abs(this.perAward(award).vested - g.outstanding!) < 1e-6
          ? { category: 'definition', note: `the holder left on ${holder.terminationDate}; the export already treats the unvested options as lapsed though it records no cancellation` } : null;
      }]);
    }
    // The plan footer: available is what the grants have not used.
    for (const f of src.planFooters) {
      if (f.authorized == null || f.available == null) continue;
      const grants = src.grants.filter((g) => f.plan == null || g.plan == null || keyOf(g.plan) === keyOf(f.plan));
      const used = grants.reduce((s, g) => s + (g.granted ?? 0) - g.cancelled, 0);
      sourceCheck(`plan ${f.plan ?? ''}`.trim(), 'available = authorized − granted + cancelled', f.available, f.authorized - used, f.where);
    }
    // The summary's fully diluted total against its parts.
    if (src.summary) {
      const fd = src.summary.lines.find((l) => /fully diluted/i.test(l.name))?.values.fullyDiluted ?? src.summary.total?.values.fullyDiluted;
      const classLines = src.summary.lines.filter((l) => this.classOfLine(l) && l.values.outstanding != null);
      const labelledAs = (m: Measure) => src.summary!.lines.find((l) => this.labelledAs(l) === m)?.values[m];
      const options = labelledAs('options') ?? src.summary.lines.filter((l) => this.poolOfLine(l)).reduce((s, l) => s + (l.values.options ?? 0), 0);
      const available = labelledAs('available') ?? src.summary.lines.filter((l) => this.poolOfLine(l)).reduce((s, l) => s + (l.values.available ?? 0), 0);
      if (fd != null && classLines.length) {
        const sum = classLines.reduce((s, l) => s + l.values.outstanding! * (this.data.shareClasses.find((c) => c.id === this.classOfLine(l)!.shareClassId)?.conversionRatio ?? 1), 0) + (options ?? 0) + (available ?? 0);
        sourceCheck('summary', 'fully diluted = classes + options + available', fd, sum, src.summary.lines[0].where);
      }
    }

    // The app's own table.
    const appCheck = (key: string, field: string, expected: number, actual: number, tolerance = 0, unit: Unit = 'shares') =>
      this.add({ level: 'internal', key: `app: ${key}`, field, unit, source: expected, app: actual, tolerance, where: '(computed)',
        explainers: [() => ({ category: 'unexplained', note: 'the app\'s cap table does not hold together' })] });
    const t = table.totals;
    appCheck('totals', 'fully diluted = as-converted + options + RSUs + warrants + pool + convertibles', t.asConverted + t.optionsOutstanding + t.rsusOutstanding + t.warrantsOutstanding + t.poolAvailable + t.convertibleAsConverted, t.fullyDiluted, 1e-6);
    appCheck('totals', 'fully diluted = holders + pool', table.rows.reduce((s, r) => s + r.fullyDiluted, 0) + t.poolAvailable, t.fullyDiluted, 1e-6);
    appCheck('totals', 'outstanding = classes', table.classes.reduce((s, c) => s + c.outstanding, 0), t.outstanding, 1e-6);
    if (t.fullyDiluted > 0) appCheck('totals', 'fully diluted % adds up to 100%', 1, table.rows.reduce((s, r) => s + r.fullyDilutedPct, 0) + t.poolAvailable / t.fullyDiluted, 1e-9, 'pct');
    if (t.outstanding > 0) appCheck('totals', 'outstanding % adds up to 100%', 1, table.rows.reduce((s, r) => s + r.outstandingPct, 0), 1e-9, 'pct');
    if (t.votes > 0) appCheck('totals', 'voting % adds up to 100%', 1, table.rows.reduce((s, r) => s + r.votingPct, 0), 1e-9, 'pct');
    for (const r of table.rows) {
      appCheck(r.name, 'vested + unvested = options outstanding', r.optionsOutstanding, r.optionsVested + r.optionsUnvested, 1e-6);
      appCheck(r.name, 'holdings = outstanding', r.outstanding, r.holdings.reduce((s, h) => s + h.shares, 0), 1e-6);
    }
    for (const p of table.pools) appCheck(`plan ${p.name}`, 'authorized = available + granted − returned', p.authorized, p.available + p.granted - p.cancelledReturned, 1e-6);
  }

  // -------------------------------------------------------------------------
  // Percentages, last
  // -------------------------------------------------------------------------

  comparePercentages(): void {
    const { src, table } = this;
    const pct = (holder: string, measure: Measure, line: Line, tolerance: number) => {
      const row = this.appRow(holder);
      const [field, app, base, total] = measure === 'fullyDilutedPct'
        ? ['fully diluted %', row?.fullyDilutedPct ?? 0, 'fullyDiluted', 'fullyDiluted']
        : measure === 'outstandingPct' ? ['outstanding %', row?.outstandingPct ?? 0, 'outstanding', 'outstanding']
          : ['voting %', row?.votingPct ?? 0, 'votes', 'votes'];
      this.add({
        level: 'percent', key: holder, field, unit: 'pct', source: line.values[measure]!, app, tolerance, where: line.where,
        explainers: [
          this.followsFrom(() => [this.holderCmp(holder, base), this.totalCmp.get(total)], 'share counts it divides'),
          (c) => this.explainPercentBase(line, measure, c),
        ],
      });
    };
    for (const table_ of [src.ownership, src.voting]) {
      if (!table_) continue;
      for (const line of table_.lines) {
        for (const m of ['fullyDilutedPct', 'outstandingPct', 'votingPct'] as Measure[]) {
          if (line.values[m] != null) pct(line.name, m, line, table_.pctTolerance[m] ?? 1e-6);
        }
      }
    }
    for (const line of src.summary?.lines ?? []) {
      const cls = this.classOfLine(line);
      if (!cls) continue;
      if (line.values.fullyDilutedPct != null) {
        this.add({ level: 'percent', key: cls.name, field: 'fully diluted %', unit: 'pct', source: line.values.fullyDilutedPct, app: cls.ownershipPct,
          tolerance: src.summary!.pctTolerance.fullyDilutedPct ?? 1e-6, where: line.where,
          explainers: [this.followsFrom(() => [this.classCmp.get(cls.name), this.totalCmp.get('fullyDiluted')], 'share counts it divides')] });
      }
      if (line.values.outstandingPct != null && table.totals.outstanding > 0) {
        this.add({ level: 'percent', key: cls.name, field: 'outstanding %', unit: 'pct', source: line.values.outstandingPct, app: cls.outstanding / table.totals.outstanding,
          tolerance: src.summary!.pctTolerance.outstandingPct ?? 1e-6, where: line.where,
          explainers: [this.followsFrom(() => [this.classCmp.get(cls.name), this.totalCmp.get('outstanding')], 'share counts it divides')] });
      }
    }
  }

  /** A percentage that divides by another total than the app's: which total the export's own figures imply. */
  private explainPercentBase(line: Line, measure: Measure, c: Comparison): Explanation | null {
    if (measure !== 'fullyDilutedPct' || typeof c.source !== 'number' || c.source <= 0) return null;
    const shares = line.values.fullyDiluted ?? this.appRow(line.name)?.fullyDiluted;
    if (!shares) return null;
    const implied = shares / c.source;
    const t = this.table.totals;
    if (Math.abs(implied - (t.fullyDiluted - t.poolAvailable)) <= Math.max(1, implied * c.tolerance / c.source)) {
      return { category: 'definition', note: 'the export divides by fully diluted without the unallocated pool; the app includes it (run with --no-pool to match)' };
    }
    return { category: 'unexplained', note: `the export's percentage implies a fully diluted total of about ${Math.round(implied).toLocaleString('en-US')}` };
  }

  // -------------------------------------------------------------------------

  /** Accounts for every difference, lowest level first so totals can lean on what is under them. */
  classify(): void {
    const order: Level[] = ['import', 'grant', 'holder', 'class', 'internal', 'percent'];
    for (const level of order) {
      for (const c of this.comparisons.filter((x) => x.level === level && x.differs)) {
        let found: Explanation | null = null;
        for (const e of c.explainers) { found = e(c); if (found) break; }
        c.explanation = found ? { root: true, ...found } : { category: 'unexplained', note: 'none of the known causes accounts for it', root: true };
      }
    }
  }

  addImportIssues(): void {
    for (const i of this.ctx.importIssues) {
      this.add({
        level: 'import', key: `${i.sheet} row ${i.row}`, field: i.kind, unit: 'text',
        source: [i.holder, i.label, i.className].filter(Boolean).join(' · ') || 'row', app: 'not imported', where: `${i.file} › ${i.sheet}, row ${i.row}`,
        explainers: [() => ({ category: 'import mapping', note: i.messages.join('; ') })],
      });
    }
  }
}

/** Shares vested under the usual alternatives to the app's rounding, for a time-based schedule. */
export function roundingAlternatives(schedule: VestingSchedule, quantity: number, start: string, cutoff: string): { name: string; vested: number }[] {
  const months = { MONTHLY: 1, QUARTERLY: 3, ANNUAL: 12 }[schedule.frequency as 'MONTHLY' | 'QUARTERLY' | 'ANNUAL'];
  if (schedule.kind !== 'TIME' || !months || schedule.immediatePortion || schedule.durationMonths % months) return [];
  const n = schedule.durationMonths / months;
  const cliff = Math.floor(schedule.cliffMonths / months);
  let p = 0;
  while (p < n && addMonths(start, (p + 1) * months) <= cutoff) p++;
  if (p < cliff) return [];
  if (p >= n) return [];
  const each = quantity / n;
  return [
    { name: 'rounds each tranche down and puts the remainder in the last', vested: p * Math.floor(each) },
    { name: 'rounds each tranche to the nearest share', vested: p * Math.round(each) },
    { name: 'rounds each tranche up', vested: Math.min(quantity, p * Math.ceil(each)) },
    { name: 'rounds the running total to the nearest share', vested: Math.round((quantity * p) / n) },
    { name: 'rounds the cliff down and each later tranche down', vested: Math.floor((quantity * cliff) / n) + (p - cliff) * Math.floor(each) },
  ];
}

function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
