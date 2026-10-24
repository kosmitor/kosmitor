/**
 * A company's cap table and its history as an Open Cap Format 1.2.0 package
 * (docs/ocf.md, "Export").
 *
 * The rows hold each security's state of today and the ledger says what happened to it
 * since (docs/design/dated-ledger.md), the way OCF records it: an issuance, then dated
 * transfers, repurchases, cancellations, exercises and conversions. So each security is
 * written as the issuance it started as, rebuilt from today's row and its entries, then
 * its events in order. A partial event on a certificate leaves the rest on a balance
 * certificate (`<rowId>.b<n>`), as OCF expects; grants, warrants and convertibles keep
 * one security throughout. Quantities are in the shares of each event's own date, as
 * the ledger keeps them, and splits are TX_STOCK_CLASS_SPLITs.
 *
 * The package is the cap table as of its `as_of` (today): securities issued and events
 * dated after it are left out, as are unissued securities (drafts, awaiting approval or
 * signatures). What OCF has no field for travels in the Kosmitor note (notes.ts), and
 * what the package cannot say, or says differently, is listed in the manifest's comments.
 *
 * Options a leaver loses without a ledger entry (the part unvested when they leave,
 * and an option's vested part when its exercise window closes: awardPosition and
 * awardIsLive in packages/core/src/captable.ts) are written as dated cancellations, so
 * any reader sees them go; their note says Kosmitor works them out itself.
 *
 * Output is deterministic: two exports of the same company differ only in the
 * manifest's generated_at, as_of and checksums.
 */
import { createHash } from 'node:crypto';
import {
  activeValuation, addDays, addMonths, awardOutstanding, awardPosition, enginePolicy, normalizeSplits, roundShares, splitFactor, today,
  type Award, type CompanyData, type Convertible, type Issuance, type ShareClass, type VestingSchedule, type Warrant,
} from '@kosmitor/core';
import { all, concurrently, one, toCamelAll } from '../db.ts';
import { getCompanyData } from '../store.ts';
import { zip } from '../xlsx-writer.ts';
import * as C from './convert.ts';
import { commentsWith, mfnComment, writeNote } from './notes.ts';
import { termsFromSchedule, vestingsFor } from './vesting.ts';
import {
  CONDITION, OCF_MANIFEST_PATH, OCF_PACKAGE_FILES, OCF_VERSION, TERMINATION_WINDOW_REASONS, TRIGGER, ocfId,
  type OcfConversionTrigger, type OcfConvertibleIssuance, type OcfEquityCompensationIssuance, type OcfFileRef, type OcfIssuer,
  type OcfItemsFile, type OcfManifest, type OcfObject, type OcfPackage, type OcfStakeholder, type OcfStockClass,
  type OcfStockIssuance, type OcfStockLegendTemplate, type OcfStockPlan, type OcfTransaction, type OcfValuation,
  type OcfVestingTerms, type OcfWarrantIssuance,
} from './types.ts';

type Row = Record<string, unknown>;
interface TxRow {
  id: string; type: string; date: string; stakeholderId: string | null; counterpartyId: string | null; securityId: string | null;
  shareClassId: string | null; quantity: number | null; pricePerShare: number | null; amount: number | null; memo: string | null;
  createdAt: string; field: string | null; adoptedSecurityId: string | null; resultingSecurityId: string | null;
}
interface ExerciseRow {
  id: string; awardId: string; exerciseDate: string; quantity: number; issuanceId: string | null;
  method: string | null; fmvAtExercise: number | null; sharesIssued: number | null;
}

/** Not on the cap table yet, so not in the package. */
const UNISSUED = new Set(['DRAFT', 'PENDING_APPROVAL', 'PENDING_SIGNATURE']);
/** Ledger entries with no OCF transaction that are worth a word in the manifest. */
const UNMAPPED = new Set(['SECONDARY_SALE', 'RETIREMENT', 'DIVIDEND']);
/** Phase of a transaction among those of its date (docs/ocf.md, "Order of the transaction items"). */
const PHASE = { adjustment: 0, issuance: 1, start: 2, event: 3, balance: 4, vesting: 5 } as const;

/** Compares by each key in turn, as plain strings or numbers, so the order never depends on a locale. */
const by = <T>(...keys: ((x: T) => string | number)[]) => (a: T, b: T): number => {
  for (const key of keys) {
    const x = key(a), y = key(b);
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
};
const validDate = (v: unknown): string | undefined => (typeof v === 'string' && C.isCalendarDate(v) ? v : undefined);
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
/** The manifest's first comments, which every package has; those after them say what the package leaves out or shows differently. */
export const STANDARD_COMMENTS = 2;
/** A ledger entry's memo as a reason: without the "(OCF <id>)" an import adds to say which transaction it recorded. */
const memoText = (v: unknown): string | undefined => text(typeof v === 'string' ? v.replace(/\s*\(OCF [^()]*\)$/, '') : v);
const shortId = (id: string): string => id.slice(-6).toUpperCase();
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export interface OcfExportOptions {
  /** The manifest's as_of: today unless a test says otherwise. */
  asOf?: string;
  generatedAt?: string;
}

/**
 * The package: the manifest first, then every file OCF_PACKAGE_FILES names (with no
 * items when there is nothing), with the manifest's checksums of the bytes
 * serializeOcf writes.
 */
export async function buildOcfPackage(companyId: string, opts: OcfExportOptions = {}): Promise<OcfPackage> {
  const asOf = opts.asOf ?? today();
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const data = await getCompanyData(companyId);
  const q = async <T>(sql: string): Promise<T[]> => toCamelAll<T>(await all(sql, companyId));
  const [company, stakeholderRows, issuanceRows, awardRows, warrantRows, convertibleRows, classRows, valuationRows, adjustmentRows, txRows, exerciseRows] = await concurrently([
    async () => toCamelAll<Row>([(await one('SELECT name, legal_name, incorporation_date, jurisdiction, ein, address, currency FROM companies WHERE id = ?', companyId)) ?? {}])[0],
    () => q<Row>('SELECT id, legal_name, employee_id, phone, address, city, region, postal_code, country, secondary_email, signatory_name, signatory_email, title, department, notes FROM stakeholders WHERE company_id = ?'),
    () => q<Row>('SELECT id, federal_exemption, state_exemption, board_approval_date, created_at FROM issuances WHERE company_id = ?'),
    () => q<Row>('SELECT id, created_at FROM awards WHERE company_id = ?'),
    () => q<Row>('SELECT id, created_at FROM warrants WHERE company_id = ?'),
    () => q<Row>('SELECT id, created_at, board_approval_date AS convertible_board_approval_date, funds_received_on, funds_reference FROM convertibles WHERE company_id = ?'),
    () => q<Row>('SELECT id, legend FROM share_classes WHERE company_id = ?'),
    () => q<Row>('SELECT id, enterprise_value, method FROM valuations WHERE company_id = ?'),
    () => q<Row>('SELECT id, created_at FROM pool_adjustments WHERE company_id = ?'),
    () => q<TxRow>(`SELECT id, type, date, stakeholder_id, counterparty_id, security_id, share_class_id, quantity, price_per_share, amount, memo, created_at,
                    field, adopted_security_id, resulting_security_id FROM transactions WHERE company_id = ? ORDER BY date, created_at, id`),
    () => q<ExerciseRow>('SELECT id, award_id, exercise_date, quantity, issuance_id, method, fmv_at_exercise, shares_issued FROM exercises WHERE company_id = ? ORDER BY exercise_date, created_at, id'),
  ]);
  return new Exporter(companyId, data, {
    company: company ?? {}, asOf, generatedAt,
    stakeholders: indexed(stakeholderRows), issuances: indexed(issuanceRows), created: indexed([...awardRows, ...warrantRows, ...convertibleRows, ...adjustmentRows]),
    classes: indexed(classRows), valuations: indexed(valuationRows), transactions: txRows, exercises: exerciseRows,
  }).build();
}

const indexed = (rows: Row[]): Map<string, Row> => new Map(rows.map((r) => [String(r.id), r]));

interface Raw {
  company: Row; asOf: string; generatedAt: string;
  stakeholders: Map<string, Row>; issuances: Map<string, Row>; created: Map<string, Row>;
  classes: Map<string, Row>; valuations: Map<string, Row>; transactions: TxRow[]; exercises: ExerciseRow[];
}

interface Item { item: OcfTransaction; date: string; phase: number; createdAt: string; order: number }

/** A certificate, or a restricted stock award exported as one, on its way to the transactions file. */
interface StockRow {
  id: string; holder: string; classId: string; issueDate: string; price: number; quantity: number; createdAt: string;
  customId: string; scheduleId: string | null; vestingStart: string | null; boardApprovalDate?: string;
  exemptions: { description: string; jurisdiction: string }[]; planId?: string; issuanceType?: 'RSA';
  note: string | null;
  /** What a person wrote about it (its notes), as plain comments on its issuance. */
  comments: (string | undefined)[];
  /** The entries that take shares off it, with what was synthesized for states the ledger does not date. */
  moves: Move[];
  /** The issued quantity, rebuilt so that the moves end at today's row. */
  issued: number;
}
interface Move {
  id: string; type: 'TRANSFER' | 'REPURCHASE' | 'CANCELLATION' | 'CONVERSION' | 'VESTING_ACCELERATION';
  date: string; createdAt: string; quantity: number; reason: string; price: number | null; amount: number | null;
  counterpartyId: string | null; result: string | null;
  /** The ledger entry's own type (a cancellation may be a FORFEITURE or an EXPIRATION). */
  entryType?: string;
  /** The move that closes the row: it takes whatever is left. */
  closing?: boolean;
}

class Exporter {
  private readonly currency: string;
  private readonly notes: string[] = [];
  private readonly items: Item[] = [];
  private readonly ledger = new Map<string, TxRow[]>();
  private readonly results = new Map<string, string | null>();
  private readonly claimed = new Set<string>();
  private readonly terms = new Map<string, { terms: OcfVestingTerms; exact: boolean }>();
  private readonly classes: ShareClass[];
  private readonly firstCommon: ShareClass | undefined;
  private readonly issuances: Issuance[];
  private readonly awards: Award[];
  private readonly warrants: Warrant[];
  private readonly convertibles: Convertible[];
  private readonly corrected: string[] = [];
  private readonly amended: string[] = [];
  /** Options a leaver lost with no ledger entry, written as cancellations. */
  private readonly lapsed: string[] = [];
  /** The exercise on record behind each grant EXERCISE entry, by the entry's id. */
  private readonly exerciseOf = new Map<string, ExerciseRow>();
  /** Restricted stock awards whose shares are a certificate on record, by the certificate's id. */
  private readonly rsaOfCertificate = new Map<string, Award>();
  /** Securities and valuations dated after as_of, left out. */
  private later = 0;
  private laterValuations = 0;
  private order = 0;
  private readonly asOf: string;

  private readonly companyId: string;
  private readonly data: CompanyData;
  private readonly raw: Raw;

  constructor(companyId: string, data: CompanyData, raw: Raw) {
    this.companyId = companyId;
    this.data = data;
    this.raw = raw;
    this.currency = C.currencyOf(raw.company.currency as string | null);
    this.classes = data.shareClasses.slice().sort(by((c) => c.issueDate, (c) => c.name, (c) => c.id));
    this.firstCommon = this.classes.find((c) => c.kind === 'COMMON');
    this.asOf = raw.asOf;
    // Issued, and on or before as_of: the package is the cap table of that day.
    const inPackage = <T extends { status: string }>(list: T[], date: (x: T) => string): T[] => list.filter((x) => {
      if (UNISSUED.has(x.status)) return false;
      if (date(x) > this.asOf) { this.later++; return false; }
      return true;
    });
    this.issuances = inPackage(data.issuances, (i) => i.issueDate).sort(by((i) => i.issueDate, (i) => i.id));
    this.awards = inPackage(data.awards, (a) => a.grantDate).sort(by((a) => a.grantDate, (a) => a.id));
    this.warrants = inPackage(data.warrants, (w) => w.issueDate).sort(by((w) => w.issueDate, (w) => w.id));
    this.convertibles = inPackage(data.convertibles, (c) => c.issueDate).sort(by((c) => c.issueDate, (c) => c.id));
    for (const t of raw.transactions) {
      if (!t.securityId) continue;
      const list = this.ledger.get(t.securityId);
      if (list) list.push(t); else this.ledger.set(t.securityId, [t]);
    }
  }

  private money = (cents: number) => C.ocfMoney(cents, this.currency);
  private price = (micros: number) => C.ocfPrice(micros, this.currency);
  private k = (from: string | null, to: string): number => splitFactor(this.data, from, to);
  private entries = (id: string): TxRow[] => this.ledger.get(id) ?? [];
  private createdAt = (id: string): string => String(this.raw.created.get(id)?.createdAt ?? this.raw.issuances.get(id)?.createdAt ?? '');
  private holderName = (id: string | null): string => this.data.stakeholders.find((s) => s.id === id)?.name ?? 'another holder';
  /** An event dated after as_of: left out, and counted for the manifest. */
  private future(date: string): boolean {
    if (date <= this.asOf) return false;
    this.later++;
    return true;
  }
  private push(item: OcfTransaction, phase: number, createdAt: string, sortDate = item.date): void {
    this.items.push({ item, date: sortDate, phase, createdAt, order: this.order++ });
  }

  build(): OcfPackage {
    const unissued = this.data.issuances.length + this.data.awards.length + this.data.warrants.length + this.data.convertibles.length
      - this.issuances.length - this.awards.length - this.warrants.length - this.convertibles.length - this.later;
    if (unissued > 0) this.notes.push(`${plural(unissued, 'security', 'securities')} not yet issued (${unissued === 1 ? 'a draft, or awaiting' : 'drafts, or awaiting'} approval or signatures) ${unissued === 1 ? 'is' : 'are'} not included.`);

    const issuer = this.issuer();
    const stakeholders = this.stakeholders();
    const { stockClasses, legends } = this.stockClasses();
    const plans = this.plans();
    const valuations = this.valuations();
    this.resolveResults();
    this.certificates();
    this.grants();
    this.warrantsOut();
    this.convertiblesOut();
    this.splits();
    this.otherEntries();
    if (this.corrected.length) this.notes.push(`Share counts corrected after issue are shown as corrected from the issue date: ${this.corrected.join(', ')}.`);
    if (this.amended.length) this.notes.push(`Terms, holders or dates corrected after issue are shown as they read now: ${this.amended.join(', ')}.`);
    if (this.lapsed.length) this.notes.push(`Options a holder lost on leaving, which Kosmitor works out from the leaving date with no ledger entry, are given as cancellations: ${this.lapsed.join(', ')}.`);

    const vestingTerms = [...this.terms.values()].map((t) => t.terms).sort(by((t) => t.name, (t) => t.id));
    const approximate = [...this.terms.values()].filter((t) => !t.exact).map((t) => t.terms.name).sort();
    if (approximate.length) this.notes.push(`OCF's vesting conditions cannot state these schedules exactly, so each security on them also lists its own vestings: ${approximate.join('; ')}.`);

    this.items.sort(by((i) => i.date, (i) => i.phase, (i) => i.createdAt, (i) => i.order));
    const transactions = this.cutAtAsOf(this.items.map((i) => i.item));
    const later = this.later + this.laterValuations;
    if (later) {
      this.notes.push(`Securities, events and valuations dated after ${this.asOf}, the date of this package, are not included: ${later}.`);
    }

    const files: { path: string; json: OcfItemsFile }[] = OCF_PACKAGE_FILES.map(({ fileType, path }) => ({
      path,
      json: {
        file_type: fileType,
        items: {
          OCF_STAKEHOLDERS_FILE: stakeholders, OCF_STOCK_CLASSES_FILE: stockClasses, OCF_STOCK_LEGEND_TEMPLATES_FILE: legends,
          OCF_STOCK_PLANS_FILE: plans, OCF_VESTING_TERMS_FILE: vestingTerms, OCF_VALUATIONS_FILE: valuations,
          OCF_TRANSACTIONS_FILE: transactions, OCF_FINANCINGS_FILE: [], OCF_DOCUMENTS_FILE: [],
        }[fileType] as OcfObject[],
      },
    }));
    const refs = (fileType: string): OcfFileRef[] => files.filter((f) => f.json.file_type === fileType)
      .map((f) => ({ filepath: `./${f.path}`, md5: createHash('md5').update(serializeOcf(f.json)).digest('hex') }));
    const manifest: OcfManifest = {
      file_type: 'OCF_MANIFEST_FILE',
      ocf_version: OCF_VERSION,
      issuer,
      as_of: this.raw.asOf,
      generated_at: this.raw.generatedAt,
      comments: [
        `Exported by Kosmitor from ${String(this.raw.company.name ?? 'the company')}.`,
        'Kosmitor-specific details are kept in comments beginning kosmitor:1:.',
        ...this.notes,
      ],
      stock_plans_files: refs('OCF_STOCK_PLANS_FILE'),
      stock_legend_templates_files: refs('OCF_STOCK_LEGEND_TEMPLATES_FILE'),
      stock_classes_files: refs('OCF_STOCK_CLASSES_FILE'),
      vesting_terms_files: refs('OCF_VESTING_TERMS_FILE'),
      valuations_files: refs('OCF_VALUATIONS_FILE'),
      transactions_files: refs('OCF_TRANSACTIONS_FILE'),
      stakeholders_files: refs('OCF_STAKEHOLDERS_FILE'),
    };
    return { files: [{ path: OCF_MANIFEST_PATH, json: manifest }, ...files] };
  }

  /**
   * The transactions on or before as_of. A vesting start is a term of its security,
   * kept with it whatever its date; anything about a security that is not in the
   * package goes with it.
   */
  private cutAtAsOf(items: OcfTransaction[]): OcfTransaction[] {
    const kept = items.filter((t) => t.object_type === 'TX_VESTING_START' || t.date <= this.asOf);
    const issued = new Set(kept.filter((t) => /_ISSUANCE$/.test(t.object_type)).map((t) => t.security_id));
    const out = kept.filter((t) => !t.security_id || issued.has(t.security_id));
    this.later += items.filter((t) => t.object_type !== 'TX_VESTING_START').length - out.filter((t) => t.object_type !== 'TX_VESTING_START').length;
    return out;
  }

  // -------------------------------------------------------------------------
  // Issuer, stakeholders, classes, plans, valuations
  // -------------------------------------------------------------------------

  private issuer(): OcfIssuer {
    const c = this.raw.company;
    const name = text(c.name) ?? 'Company';
    const legalName = text(c.legalName) ?? name;
    const formation = C.formationOf(c.jurisdiction as string | null);
    const jurisdiction = text(c.jurisdiction);
    if (!formation.understood) {
      this.notes.push(jurisdiction
        ? `The jurisdiction "${jurisdiction}" is not a US state, a Canadian province or a country Kosmitor knows, so the country of formation is given as the US; the jurisdiction as typed is in the issuer's Kosmitor note.`
        : 'No jurisdiction is on record, so the country of formation is given as the US.');
    }
    let formationDate = validDate(c.incorporationDate);
    if (!formationDate) {
      const dates = [...this.classes.map((x) => x.issueDate), ...this.issuances.map((i) => i.issueDate), ...this.awards.map((a) => a.grantDate),
        ...this.warrants.map((w) => w.issueDate), ...this.convertibles.map((x) => x.issueDate)].filter((d) => validDate(d)).sort();
      formationDate = dates[0] ?? this.raw.asOf;
      this.notes.push(`The incorporation date is not on record; the formation date given is ${dates[0] ? 'the earliest date on the cap table' : 'the export date'}, ${formationDate}.`);
    }
    const issuer: OcfIssuer = {
      id: this.companyId, object_type: 'ISSUER', legal_name: legalName,
      ...(name !== legalName ? { dba: name } : {}),
      formation_date: formationDate,
      country_of_formation: formation.country,
      ...(formation.subdivision ? { country_subdivision_of_formation: formation.subdivision } : {}),
    };
    const ein = text(c.ein);
    if (ein) issuer.tax_ids = [{ tax_id: ein, country: 'US' }];
    // An address takes the country of formation, so only when that country is known; else the note keeps it.
    const address = text(c.address);
    if (address && formation.understood) issuer.address = { address_type: 'LEGAL', street_suite: address, country: formation.country };
    const comments = commentsWith([], writeNote({
      address: address && !formation.understood ? address : undefined, jurisdiction: jurisdiction && !formation.understood ? jurisdiction : undefined,
    }));
    if (comments) issuer.comments = comments;
    return issuer;
  }

  private stakeholders(): OcfStakeholder[] {
    const keptInNote: string[] = [];
    const items = this.data.stakeholders.slice().sort(by((s) => s.name, (s) => s.id)).map((s) => {
      const x = this.raw.stakeholders.get(s.id) ?? {};
      const legalName = text(x.legalName) ?? s.name;
      const institution = C.STAKEHOLDER_TYPE_TO_OCF[s.type] === 'INSTITUTION';
      const out: OcfStakeholder = {
        id: s.id, object_type: 'STAKEHOLDER', name: { legal_name: legalName },
        stakeholder_type: C.STAKEHOLDER_TYPE_TO_OCF[s.type] ?? 'INDIVIDUAL',
      };
      const employeeId = text(x.employeeId);
      if (employeeId) out.issuer_assigned_id = employeeId;
      out.current_relationship = C.RELATION_TO_OCF[s.relation] ?? 'OTHER';
      const note: Record<string, unknown> = {};
      const emails = [s.email, x.secondaryEmail as string | null].map(text).filter((e): e is string => !!e && C.EMAIL.test(e))
        .map((email_address) => ({ email_type: 'OTHER' as const, email_address }));
      // An address OCF's email format refuses still travels, in the note.
      const refused = (v: unknown): string | undefined => { const e = text(v); return e && !C.EMAIL.test(e) ? e : undefined; };
      note.email = refused(s.email);
      note.secondaryEmail = refused(x.secondaryEmail);
      const phone = text(x.phone);
      const phones = phone && C.PHONE.test(phone) ? [{ phone_type: 'OTHER' as const, phone_number: phone }] : [];
      if (phone && !phones.length) note.phone = phone;
      if (emails.length || phones.length) out.contact_info = { ...(emails.length ? { emails } : {}), ...(phones.length ? { phone_numbers: phones } : {}) };
      const signatory = text(x.signatoryName);
      if (institution && signatory) {
        const email = [x.signatoryEmail as string | null, s.email].map(text).find((e) => !!e && C.EMAIL.test(e));
        // OCF's primary contact needs an email or a phone besides the name; without one the note keeps the signatory.
        if (email) out.primary_contact = { name: { legal_name: signatory }, emails: [{ email_type: 'OTHER', email_address: email }] };
        else Object.assign(note, { signatory, signatoryEmail: refused(x.signatoryEmail) });
      }
      const country = [x.country as string | null, s.taxCountry].map((v) => text(v)?.toUpperCase()).find((v) => !!v && C.COUNTRY.test(v));
      const parts = { street: text(x.address), city: text(x.city), region: text(x.region), postal: text(x.postalCode) };
      if (parts.street || parts.city || parts.region || parts.postal) {
        if (country) {
          out.addresses = [{
            address_type: 'CONTACT', ...(parts.street ? { street_suite: parts.street } : {}), ...(parts.city ? { city: parts.city } : {}),
            ...(parts.region && C.SUBDIVISION.test(parts.region.toUpperCase()) ? { country_subdivision: parts.region.toUpperCase() } : {}),
            country, ...(parts.postal ? { postal_code: parts.postal } : {}),
          }];
          if (parts.region && !C.SUBDIVISION.test(parts.region.toUpperCase())) note.region = parts.region;
        } else {
          note.address = [parts.street, parts.city, parts.region, parts.postal, text(x.country)].filter(Boolean).join(', ');
        }
      }
      if (s.name !== legalName) note.name = s.name;
      if (s.type === 'TRUST' || s.type === 'FUND') note.type = s.type;
      Object.assign(note, {
        title: text(x.title), department: text(x.department), startDate: validDate(s.startDate), terminationDate: validDate(s.terminationDate),
        taxCountry: text(s.taxCountry), taxState: text(s.taxState),
      });
      if (s.boardSeat) {
        Object.assign(note, { boardSeat: true, boardSeatStart: validDate(s.boardSeatStart), boardSeatEnd: validDate(s.boardSeatEnd), boardDesignatedBy: s.boardDesignatedBy ?? undefined });
      } else if (s.relation === 'BOARD_MEMBER') note.boardSeat = false;
      if (note.email || note.secondaryEmail || note.signatory) keptInNote.push(s.name);
      const comments = commentsWith([text(x.notes)], writeNote(note));
      if (comments) out.comments = comments;
      return out;
    });
    if (keptInNote.length) {
      this.notes.push(`Emails OCF's format does not accept, and signatories with no email, are kept only in Kosmitor's notes: ${keptInNote.join(', ')}.`);
    }
    return items;
  }

  private stockClasses(): { stockClasses: OcfStockClass[]; legends: OcfStockLegendTemplate[] } {
    const legends: OcfStockLegendTemplate[] = [];
    const stockClasses = this.classes.map((c) => {
      const prefixes = new Map<string, number>();
      for (const i of this.issuances) {
        const m = i.shareClassId === c.id ? /^([A-Za-z]+-?)\d/.exec(i.certificateNo ?? '') : null;
        if (m) prefixes.set(m[1], (prefixes.get(m[1]) ?? 0) + 1);
      }
      const prefix = [...prefixes.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? (c.kind === 'COMMON' ? 'CS-' : 'PS-');
      const out: OcfStockClass = {
        id: c.id, object_type: 'STOCK_CLASS', name: c.name, class_type: c.kind, default_id_prefix: prefix,
        initial_shares_authorized: C.ocfNumeric(c.authorized), votes_per_share: C.ocfNumeric(c.votesPerShare),
        par_value: this.price(c.parValue), price_per_share: this.price(c.originalIssuePrice), seniority: C.ocfNumeric(c.seniority),
      };
      if (c.kind === 'PREFERRED') {
        out.liquidation_preference_multiple = C.ocfNumeric(c.liquidationMultiple);
        if (c.participation === 'CAPPED_PARTICIPATING' && c.participationCap != null) out.participation_cap_multiple = C.ocfNumeric(c.participationCap);
        if (this.firstCommon && c.conversionRatio > 0) {
          out.conversion_rights = [{
            type: 'STOCK_CLASS_CONVERSION_RIGHT',
            conversion_mechanism: {
              type: 'RATIO_CONVERSION', conversion_price: this.price(c.originalIssuePrice / c.conversionRatio),
              ratio: C.ocfRatio(c.conversionRatio), rounding_type: 'NORMAL',
            },
            converts_to_stock_class_id: this.firstCommon.id,
          }];
        }
      }
      const comments = commentsWith([], writeNote({
        issueDate: c.issueDate, participation: c.participation, participationCap: c.participationCap, dividendType: c.dividendType,
        dividendRate: c.dividendRate, dividendCompounding: c.dividendCompounding, dividendsParticipateInResidual: c.dividendsParticipateInResidual,
        antiDilution: c.antiDilution, payToPlay: c.payToPlay, isConvertible: c.isConvertible,
      }));
      if (comments) out.comments = comments;
      const legend = text(this.raw.classes.get(c.id)?.legend);
      if (legend) legends.push({ id: ocfId.legend(c.id), object_type: 'STOCK_LEGEND_TEMPLATE', name: `${c.name} legend`, text: legend });
      return out;
    });
    return { stockClasses, legends };
  }

  private legendsOf = (classId: string): string[] => (text(this.raw.classes.get(classId)?.legend) ? [ocfId.legend(classId)] : []);

  private plans(): OcfStockPlan[] {
    const pools = this.data.pools.slice().sort(by((p) => p.name, (p) => p.id));
    for (const p of pools) {
      const own = p.boardApprovalDate ?? p.shareholderApprovalDate ?? null;
      const adjustments = this.data.poolAdjustments.filter((a) => a.poolId === p.id)
        .sort(by((a) => a.date, (a) => this.createdAt(a.id), (a) => a.id));
      adjustments.forEach((a, i) => {
        const reserved = p.authorized * this.k(own, a.date) + adjustments.slice(0, i + 1).reduce((s, b) => s + b.amount * this.k(b.date, a.date), 0);
        this.push({
          id: a.id, object_type: 'TX_STOCK_PLAN_POOL_ADJUSTMENT', date: a.date, stock_plan_id: p.id,
          shares_reserved: C.ocfNumeric(roundShares(reserved)), ...(text(a.reason) ? { comments: [text(a.reason)!] } : {}),
        }, PHASE.adjustment, this.createdAt(a.id));
      });
    }
    return pools.map((p) => {
      const out: OcfStockPlan = {
        id: p.id, object_type: 'STOCK_PLAN', plan_name: p.name, initial_shares_reserved: C.ocfNumeric(p.authorized),
        ...(validDate(p.boardApprovalDate) ? { board_approval_date: p.boardApprovalDate! } : {}),
        ...(validDate(p.shareholderApprovalDate) ? { stockholder_approval_date: p.shareholderApprovalDate! } : {}),
        default_cancellation_behavior: p.returnForfeituresToPool ? 'RETURN_TO_POOL' : 'RETIRE',
        stock_class_ids: [p.shareClassId],
      };
      const comments = commentsWith([], writeNote({ evergreenPercent: p.evergreenPercent ?? undefined, planType: p.planType !== 'STOCK_PLAN' ? p.planType : undefined }));
      if (comments) out.comments = comments;
      return out;
    });
  }

  private valuations(): OcfValuation[] {
    const out: OcfValuation[] = [];
    const left: Record<string, number> = {};
    for (const v of this.data.valuations.slice().sort(by((x) => x.effectiveDate, (x) => x.id))) {
      if (v.status === 'DRAFT') { left['draft'] = (left['draft'] ?? 0) + 1; continue; }
      if (v.effectiveDate > this.asOf) { this.laterValuations++; continue; }
      if (v.type !== '409A' || !this.firstCommon) { left[v.type] = (left[v.type] ?? 0) + 1; continue; }
      const x = this.raw.valuations.get(v.id) ?? {};
      const item: OcfValuation = {
        id: v.id, object_type: 'VALUATION', ...(text(v.provider) ? { provider: text(v.provider)! } : {}),
        price_per_share: this.price(v.fairMarketValue), effective_date: v.effectiveDate, stock_class_id: this.firstCommon.id, valuation_type: '409A',
      };
      const comments = commentsWith([], writeNote({
        type: v.type, status: v.status, expirationDate: validDate(v.expirationDate), method: text(x.method),
        enterpriseValue: x.enterpriseValue == null ? undefined : Number(x.enterpriseValue), reportUrl: v.reportUrl && /^https?:\/\//i.test(v.reportUrl) ? v.reportUrl : undefined,
      }));
      if (comments) item.comments = comments;
      out.push(item);
    }
    const types = Object.keys(left).filter((t) => t !== 'draft').sort();
    const other = types.reduce((s, t) => s + left[t], 0);
    if (other) {
      this.notes.push(this.firstCommon || types.some((t) => t !== '409A')
        ? `${plural(other, 'valuation')} of a type OCF ${OCF_VERSION} has no place for (${types.join(', ')}) ${other === 1 ? 'is' : 'are'} not included.`
        : `${plural(other, 'valuation')} ${other === 1 ? 'is' : 'are'} not included: the company has no common class to price.`);
    }
    if (left['draft']) this.notes.push(`${plural(left['draft'], 'draft valuation')} ${left['draft'] === 1 ? 'is' : 'are'} not included.`);
    return out;
  }

  // -------------------------------------------------------------------------
  // Vesting
  // -------------------------------------------------------------------------

  private termsFor(scheduleId: string | null): { schedule: VestingSchedule; terms: OcfVestingTerms; exact: boolean } | null {
    const schedule = scheduleId ? this.data.vestingSchedules.find((s) => s.id === scheduleId) : undefined;
    if (!schedule) return null;
    let t = this.terms.get(schedule.id);
    if (!t) this.terms.set(schedule.id, t = termsFromSchedule(schedule));
    return { schedule, ...t };
  }

  /**
   * The vesting fields of an issuance on a schedule, and what follows the issuance: its
   * TX_VESTING_START and a TX_VESTING_EVENT per milestone achieved by as_of. Each is
   * dated when it happened but placed right after the issuance it is about (issued on
   * `issuedOn`), so a reader taking the file in order never meets one before its
   * security: the file is in the order things became known, which is date order but
   * for a vesting start before the issue date, or a balance's, dated as the original's.
   */
  private vesting(securityId: string, scheduleId: string | null, quantity: number, start: string | null, issuedOn: string, balance = false): {
    fields: { vesting_terms_id?: string; vestings?: { date: string; amount: string }[] };
    follow: { item: OcfTransaction; phase: number; sortDate?: string }[];
  } {
    const v = this.termsFor(scheduleId);
    if (!v || !start) return { fields: {}, follow: [] };
    const achieved = (v.schedule.kind === 'MILESTONE' ? v.schedule.milestones ?? [] : []).filter((m) => validDate(m.achievedDate) && m.achievedDate! <= this.asOf);
    const events = new Map(achieved.map((m) => [CONDITION.milestone(m.id), m.achievedDate!]));
    const follow: { item: OcfTransaction; phase: number; sortDate?: string }[] = [{
      item: { id: ocfId.vestingStart(securityId), object_type: 'TX_VESTING_START', date: start, security_id: securityId, vesting_condition_id: CONDITION.start },
      phase: balance ? PHASE.balance : PHASE.start, sortDate: issuedOn,
    }];
    for (const m of achieved) {
      follow.push({
        item: { id: ocfId.milestoneEvent(securityId, m.id), object_type: 'TX_VESTING_EVENT', date: m.achievedDate!, security_id: securityId, vesting_condition_id: CONDITION.milestone(m.id) },
        phase: PHASE.vesting, sortDate: m.achievedDate! < issuedOn ? issuedOn : m.achievedDate!,
      });
    }
    const vestings = vestingsFor(v.schedule, v.terms, quantity, start, events);
    return { fields: { vesting_terms_id: v.schedule.id, ...(vestings ? { vestings } : {}) }, follow };
  }

  /** An issuance, then its vesting start and events. */
  private pushIssuance(item: OcfTransaction, phase: number, createdAt: string, follow: { item: OcfTransaction; phase: number; sortDate?: string }[]): void {
    this.push(item, phase, createdAt);
    for (const f of follow) this.push(f.item, f.phase, createdAt, f.sortDate);
  }

  // -------------------------------------------------------------------------
  // Resulting securities
  // -------------------------------------------------------------------------

  /**
   * The certificate each transfer, exercise and conversion created: the entry's
   * resulting_security_id, the exercise on record for an exercise, or else one dated
   * the event, of the holder and class, that no other entry has claimed (preferring
   * one whose notes name the source). Entries are taken in date order, so an earlier
   * event claims first.
   */
  private resolveResults(): void {
    const issued = new Set(this.issuances.map((i) => i.id));
    for (const t of this.raw.transactions) if (t.resultingSecurityId && issued.has(t.resultingSecurityId)) this.claimed.add(t.resultingSecurityId);
    const usedExercises = new Set<string>();
    const issuedQuantity = (i: Issuance): number => this.issuedQuantityOf(i);
    const pick = (fits: (i: Issuance) => boolean, names: string[]): string | null => {
      const candidates = this.issuances.filter((i) => !this.claimed.has(i.id) && fits(i));
      const named = candidates.find((i) => names.some((n) => n && (i.notes ?? '').includes(n)));
      const chosen = named ?? candidates[0];
      if (!chosen) return null;
      this.claimed.add(chosen.id);
      return chosen.id;
    };
    // The exercise on record behind each grant exercise: its method, fair market value and the shares it issued.
    const exercisesUsed = new Set<string>();
    for (const t of this.raw.transactions) {
      if (t.type !== 'EXERCISE' || !t.securityId) continue;
      const fits = (x: ExerciseRow) => !exercisesUsed.has(x.id) && x.awardId === t.securityId && x.exerciseDate === t.date && t.quantity != null && Math.abs(Number(x.quantity) - t.quantity) <= 1e-4;
      const ex = this.raw.exercises.find((x) => fits(x) && (!t.resultingSecurityId || x.issuanceId === t.resultingSecurityId)) ?? this.raw.exercises.find(fits);
      if (ex) { exercisesUsed.add(ex.id); this.exerciseOf.set(t.id, ex); }
    }
    for (const t of this.raw.transactions) {
      if (!t.securityId || !['TRANSFER', 'EXERCISE', 'CONVERSION'].includes(t.type)) continue;
      if (t.resultingSecurityId && issued.has(t.resultingSecurityId)) { this.results.set(t.id, t.resultingSecurityId); continue; }
      const cert = this.issuances.find((i) => i.id === t.securityId);
      const award = this.awards.find((a) => a.id === t.securityId);
      const warrant = this.warrants.find((w) => w.id === t.securityId);
      const convertible = this.convertibles.find((c) => c.id === t.securityId);
      let result: string | null = null;
      if (cert && t.type === 'TRANSFER') {
        result = pick((i) => i.stakeholderId === t.counterpartyId && i.shareClassId === cert.shareClassId && i.issueDate === t.date
          && t.quantity != null && Math.abs(issuedQuantity(i) - t.quantity) <= 1e-4, [cert.certificateNo ?? '', cert.id]);
      } else if (cert && t.type === 'CONVERSION') {
        result = pick((i) => i.stakeholderId === cert.stakeholderId && i.issueDate === t.date && i.id !== cert.id, [cert.certificateNo ?? '', cert.id]);
      } else if (award && t.type === 'EXERCISE') {
        const ex = this.raw.exercises.find((x) => !usedExercises.has(x.id) && x.awardId === award.id && x.exerciseDate === t.date
          && t.quantity != null && Math.abs(Number(x.quantity) - t.quantity) <= 1e-4 && x.issuanceId && issued.has(x.issuanceId) && !this.claimed.has(x.issuanceId));
        if (ex) { usedExercises.add(ex.id); this.claimed.add(ex.issuanceId!); result = ex.issuanceId; }
        else result = pick((i) => i.sourceAwardId === award.id && i.issueDate === t.date, [award.label ?? '', award.id]);
      } else if (warrant && t.type === 'EXERCISE') {
        result = pick((i) => i.stakeholderId === warrant.stakeholderId && i.shareClassId === warrant.shareClassId && i.issueDate === t.date && !i.sourceAwardId,
          [`warrant ${warrant.id}`]);
      } else if (convertible && t.type === 'CONVERSION') {
        const into = convertible.convertedIntoShareClassId ?? t.shareClassId;
        result = pick((i) => i.stakeholderId === convertible.stakeholderId && (!into || i.shareClassId === into) && i.issueDate === (convertible.convertedOn ?? t.date) && !i.sourceAwardId,
          ['conversion', convertible.label ?? '']);
      }
      this.results.set(t.id, result);
    }
  }

  // -------------------------------------------------------------------------
  // Certificates and restricted stock
  // -------------------------------------------------------------------------

  /** The quantity a certificate was issued with: its ISSUANCE entry's, else today's. */
  private issuedQuantityOf(i: Issuance): number {
    const creation = this.entries(i.id).find((e) => e.type === 'ISSUANCE' && e.quantity != null);
    return creation ? Number(creation.quantity) : i.quantity;
  }

  private certificates(): void {
    const rows: StockRow[] = [];
    // A restricted stock award is issued shares. When a certificate on record is those shares (it names the
    // award, or has its holder, class, date and count), the certificate carries the award; otherwise the
    // award is a stock issuance of its own.
    const standalone: Award[] = [];
    for (const a of this.awards.filter((x) => x.type === 'RSA')) {
      const poolClass = this.data.pools.find((p) => p.id === a.poolId)?.shareClassId;
      const free = (i: Issuance) => !this.rsaOfCertificate.has(i.id);
      const cert = this.issuances.find((i) => free(i) && i.sourceAwardId === a.id)
        ?? this.issuances.find((i) => free(i) && !i.sourceAwardId && i.stakeholderId === a.stakeholderId && (!poolClass || i.shareClassId === poolClass)
          && i.issueDate === a.grantDate && Math.abs(this.issuedQuantityOf(i) - a.quantity) <= 1e-4);
      if (cert) this.rsaOfCertificate.set(cert.id, a); else standalone.push(a);
    }
    const merged: string[] = [];

    for (const i of this.issuances) {
      const x = this.raw.issuances.get(i.id) ?? {};
      const own = this.entries(i.id);
      const moves = this.stockMoves(own, ['TRANSFER', 'REPURCHASE', 'CANCELLATION', 'CONVERSION'], i.issueDate);
      const label = i.certificateNo ?? shortId(i.id);
      this.foldCorrections(own, label);
      const closingType = ({ TRANSFERRED: 'TRANSFER', REPURCHASED: 'REPURCHASE', CANCELLED: 'CANCELLATION', CONVERTED: 'CONVERSION' } as Record<string, Move['type']>)[i.status];
      const takes = moves.filter((m) => m.type !== 'VESTING_ACCELERATION');
      let issued: number;
      if (i.status === 'OUTSTANDING' || !closingType) {
        issued = roundShares(i.quantity + takes.reduce((s, m) => s + m.quantity / this.k(i.issueDate, m.date), 0));
        if (i.status !== 'OUTSTANDING') this.closeUndated(moves, i.id, i.issueDate, i.status, label);
      } else {
        const closing = takes.filter((m) => m.type === closingType).at(-1);
        if (closing) {
          closing.closing = true;
          const before = takes.slice(0, takes.indexOf(closing));
          const after = takes.slice(takes.indexOf(closing) + 1);
          for (const m of after) moves.splice(moves.indexOf(m), 1);
          if (after.length) this.notes.push(`Entries recorded after certificate ${label} closed are not included.`);
          issued = roundShares(i.quantity + before.reduce((s, m) => s + m.quantity / this.k(i.issueDate, m.date), 0));
        } else {
          issued = roundShares(i.quantity + takes.reduce((s, m) => s + m.quantity / this.k(i.issueDate, m.date), 0));
          this.closeUndated(moves, i.id, i.issueDate, i.status, label);
        }
      }
      const federal = text(x.federalExemption), state = text(x.stateExemption);
      const rsa = this.rsaOfCertificate.get(i.id);
      const pool = rsa ? this.data.pools.find((p) => p.id === rsa.poolId) : undefined;
      if (rsa) merged.push(`${rsa.label ?? shortId(rsa.id)} (${label})`);
      rows.push({
        id: i.id, holder: i.stakeholderId, classId: i.shareClassId, issueDate: i.issueDate, price: i.pricePerShare, quantity: i.quantity,
        createdAt: String(x.createdAt ?? ''), customId: label, scheduleId: i.vestingScheduleId, vestingStart: i.vestingScheduleId ? (i.vestingStartDate ?? i.issueDate) : null,
        boardApprovalDate: validDate(x.boardApprovalDate),
        exemptions: [
          ...(federal ? [{ description: C.FEDERAL_EXEMPTION_LABELS[federal] ?? federal, jurisdiction: 'US' }] : []),
          ...(state ? [{ description: state, jurisdiction: 'US' }] : []),
        ],
        ...(rsa ? { planId: pool?.id, issuanceType: 'RSA' as const } : {}),
        note: writeNote({
          earlyExercised: i.earlyExercised || undefined, election83bFiledOn: validDate(i.election83bFiledOn), unnumbered: i.certificateNo ? undefined : true,
          rsaAward: rsa ? this.rsaAwardNote(rsa, i) : undefined,
        }),
        comments: [text(i.notes)],
        moves, issued,
      });
    }
    if (merged.length) this.notes.push(`Restricted stock awards are given with the certificates of their shares, as stock issuances with issuance_type RSA: ${merged.join(', ')}.`);

    if (standalone.length) {
      this.notes.push(`Restricted stock awards with no certificate on record are given as stock issuances with issuance_type RSA and their plan. Kosmitor counts such shares only once a certificate is issued, so another tool shows them as outstanding where Kosmitor does not: ${standalone.map((a) => a.label ?? shortId(a.id)).join(', ')}.`);
    }
    for (const a of standalone) {
      const own = this.entries(a.id);
      const label = a.label ?? shortId(a.id);
      this.foldCorrections(own, label);
      const moves = this.stockMoves(own, ['CANCELLATION', 'FORFEITURE', 'EXPIRATION'], a.grantDate);
      const explained = moves.filter((m) => m.type === 'CANCELLATION').reduce((s, m) => s + m.quantity / this.k(a.grantDate, m.date), 0);
      const unexplained = roundShares(a.cancelledQuantity - explained);
      if (unexplained > 1e-6) {
        moves.unshift({ id: ocfId.undated(a.id, 'cancelled'), type: 'CANCELLATION', date: a.grantDate, createdAt: '', quantity: unexplained, reason: 'Cancelled (no date on record)', price: null, amount: null, counterpartyId: null, result: null });
        this.notes.push(`Cancellations with no date on record are dated the grant: ${label}.`);
      }
      const pool = this.data.pools.find((p) => p.id === a.poolId);
      const classId = pool?.shareClassId ?? this.firstCommon?.id ?? '';
      rows.push({
        id: a.id, holder: a.stakeholderId, classId, issueDate: a.grantDate, price: a.strikePrice, quantity: a.quantity, createdAt: this.createdAt(a.id),
        customId: label, scheduleId: a.vestingScheduleId, vestingStart: a.vestingStartDate, boardApprovalDate: validDate(a.boardApprovalDate), exemptions: [],
        planId: pool?.id, issuanceType: 'RSA',
        note: writeNote({ award: { label: a.label, ptepMonths: a.ptepMonths, expirationDate: validDate(a.expirationDate) ?? null, fmvAtGrant: Math.round(a.fmvAtGrant) } }),
        comments: [text(a.notes)],
        moves, issued: a.quantity,
      });
    }
    for (const row of rows) this.walkStock(row);
  }

  /** The restricted stock award a certificate is the shares of, for the certificate's note: what the award records beyond it. */
  private rsaAwardNote(a: Award, i: Issuance): Record<string, unknown> {
    const label = a.label ?? shortId(a.id);
    this.foldCorrections(this.entries(a.id), label);
    const ownTerms = a.vestingScheduleId && a.vestingScheduleId !== i.vestingScheduleId ? this.termsFor(a.vestingScheduleId) : null;
    const entries = this.entries(a.id).filter((e) => (e.type === 'CANCELLATION' || e.type === 'FORFEITURE' || e.type === 'EXPIRATION') && e.quantity != null && e.date <= this.asOf)
      .map((e) => ({ date: e.date < a.grantDate ? a.grantDate : e.date, type: e.type, quantity: Number(e.quantity) }));
    return {
      label: a.label, ptepMonths: a.ptepMonths, expirationDate: validDate(a.expirationDate) ?? null, fmvAtGrant: Math.round(a.fmvAtGrant),
      quantity: a.quantity, grantDate: a.grantDate, price: Math.round(a.strikePrice),
      ...(ownTerms ? { vestingTermsId: ownTerms.schedule.id } : {}),
      ...(a.vestingStartDate && a.vestingStartDate !== (i.vestingStartDate ?? i.issueDate) ? { vestingStartDate: a.vestingStartDate } : {}),
      ...(entries.length ? { entries } : {}),
    };
  }

  /** A security's entries that take shares off it (in the shares of their date), and its accelerations, in order. */
  private stockMoves(entries: TxRow[], types: string[], ownDate: string): Move[] {
    const out: Move[] = [];
    for (const e of entries) {
      if (e.type === 'VESTING_ACCELERATION' || types.includes(e.type)) {
        if (e.quantity == null) continue;
        const type = (e.type === 'FORFEITURE' || e.type === 'EXPIRATION' ? 'CANCELLATION' : e.type) as Move['type'];
        out.push({
          id: e.id, type, date: e.date < ownDate ? ownDate : e.date, createdAt: e.createdAt, quantity: Number(e.quantity),
          reason: memoText(e.memo) ?? (e.type === 'FORFEITURE' ? 'Forfeited' : e.type === 'EXPIRATION' ? 'Expired' : e.type === 'VESTING_ACCELERATION' ? 'Accelerated' : 'Cancelled'),
          price: e.pricePerShare, amount: e.amount, counterpartyId: e.counterpartyId, result: this.results.get(e.id) ?? null, entryType: e.type,
        });
      }
    }
    return out;
  }

  /** A closed security with no entry for its closing: a cancellation of what is left, dated its last event or its own date. */
  private closeUndated(moves: Move[], id: string, ownDate: string, status: string, label: string): void {
    const last = moves.filter((m) => m.type !== 'VESTING_ACCELERATION').at(-1);
    moves.push({
      id: ocfId.undated(id, 'closed'), type: 'CANCELLATION', date: last?.date ?? ownDate, createdAt: '~', quantity: 0,
      reason: `Closed (${status.toLowerCase()}) with no date on record`, price: null, amount: null, counterpartyId: null, result: null, closing: true,
    });
    this.notes.push(`${label} is closed (${status.toLowerCase()}) with no date on record; it is shown as cancelled on ${last?.date ?? ownDate}.`);
  }

  /** Counts corrected after issue are folded into the issue (the row has the corrected count); terms read as they are now. */
  private foldCorrections(entries: TxRow[], label: string): void {
    for (const e of entries) {
      if (e.type !== 'CORRECTION' || e.field === 'deleted') continue;
      if (e.field === 'quantity' || e.field === 'exercisedQuantity' || e.field === 'cancelledQuantity') this.corrected.push(`${label} (corrected on ${e.date})`);
      else this.amended.push(`${label} (${e.field} on ${e.date})`);
    }
  }

  private walkStock(row: StockRow): void {
    const kOf = (d: string): number => this.k(row.issueDate, d);
    const issue = (securityId: string, quantity: number, date: string, price: number, phase: number, n = 0): void => {
      const vesting = this.vesting(securityId, row.scheduleId, roundShares(quantity), row.vestingStart, date, phase === PHASE.balance);
      const item: OcfStockIssuance = {
        // A balance certificate is a certificate of its own: its number says which ("CS-1-B2").
        id: ocfId.issuance(securityId), object_type: 'TX_STOCK_ISSUANCE', date, security_id: securityId, custom_id: n ? `${row.customId}-B${n}` : row.customId,
        stakeholder_id: row.holder, ...(row.boardApprovalDate ? { board_approval_date: row.boardApprovalDate } : {}),
        security_law_exemptions: row.exemptions, stock_class_id: row.classId, ...(row.planId ? { stock_plan_id: row.planId } : {}),
        share_price: this.price(price), quantity: C.ocfNumeric(roundShares(quantity)),
        ...vesting.fields,
        stock_legend_ids: this.legendsOf(row.classId),
        ...(row.issuanceType ? { issuance_type: row.issuanceType } : {}),
      };
      const comments = commentsWith(n ? [] : row.comments, row.note);
      if (comments) item.comments = comments;
      this.pushIssuance(item, phase, row.createdAt, vesting.follow);
    };
    issue(row.id, row.issued, row.issueDate, row.price, PHASE.issuance);
    let current = row.id, remaining = row.issued, n = 0;
    for (const m of row.moves) {
      if (this.future(m.date)) continue;
      const base = { id: m.id, date: m.date, security_id: current };
      if (m.type === 'VESTING_ACCELERATION') {
        this.push({ ...base, object_type: 'TX_VESTING_ACCELERATION', quantity: C.ocfNumeric(m.quantity), reason_text: m.reason }, PHASE.vesting, m.createdAt);
        continue;
      }
      if (remaining <= 1e-9) continue;
      const k = kOf(m.date);
      const units = m.closing ? remaining : Math.min(remaining, m.quantity / k);
      const quantity = C.ocfNumeric(roundShares(units * k));
      remaining = m.closing ? 0 : roundShares(remaining - units);
      let tx: OcfTransaction;
      if (m.type === 'TRANSFER' && m.result) {
        tx = { ...base, object_type: 'TX_STOCK_TRANSFER', quantity, resulting_security_ids: [m.result], ...(m.amount ? { consideration_text: `${C.centsToAmount(m.amount)} ${this.currency}` } : {}) };
      } else if (m.type === 'TRANSFER') {
        tx = { ...base, object_type: 'TX_STOCK_CANCELLATION', quantity, reason_text: `Transferred to ${this.holderName(m.counterpartyId)}; the receiving certificate is not on record` };
        this.notes.push(`The certificate a transfer created is not on record; the transfer is shown as a cancellation: ${row.customId} on ${m.date}.`);
      } else if (m.type === 'REPURCHASE') {
        tx = { ...base, object_type: 'TX_STOCK_REPURCHASE', quantity, price: this.price(m.price ?? row.price / k), ...(m.amount ? { consideration_text: `${C.centsToAmount(m.amount)} ${this.currency}` } : {}) };
      } else if (m.type === 'CONVERSION') {
        tx = { ...base, object_type: 'TX_STOCK_CONVERSION', quantity_converted: quantity, resulting_security_ids: m.result ? [m.result] : [] };
      } else {
        tx = { ...base, object_type: 'TX_STOCK_CANCELLATION', quantity, reason_text: m.reason };
        const note = writeNote({ type: m.entryType === 'FORFEITURE' || m.entryType === 'EXPIRATION' || m.entryType === 'CANCELLATION' ? m.entryType : undefined });
        if (note) tx.comments = [note];
      }
      if (remaining > 1e-6) {
        const balance = ocfId.balance(row.id, ++n);
        tx.balance_security_id = balance;
        this.push(tx, PHASE.event, m.createdAt);
        issue(balance, remaining * k, m.date, row.price / k, PHASE.balance, n);
        current = balance;
      } else {
        this.push(tx, PHASE.event, m.createdAt);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Grants
  // -------------------------------------------------------------------------

  private grants(): void {
    for (const a of this.awards) {
      if (a.type === 'RSA') continue;
      const comp = C.compensationOf(a.type)!;
      const label = a.label ?? shortId(a.id);
      const own = this.entries(a.id);
      this.foldCorrections(own, label);
      const pool = this.data.pools.find((p) => p.id === a.poolId);
      const createdAt = this.createdAt(a.id);
      const start = a.vestingStartDate || a.grantDate;
      const vesting = this.vesting(a.id, a.vestingScheduleId, a.quantity, start, a.grantDate);
      const item: OcfEquityCompensationIssuance = {
        id: ocfId.issuance(a.id), object_type: 'TX_EQUITY_COMPENSATION_ISSUANCE', date: a.grantDate, security_id: a.id, custom_id: label,
        stakeholder_id: a.stakeholderId, ...(validDate(a.boardApprovalDate) ? { board_approval_date: a.boardApprovalDate! } : {}),
        security_law_exemptions: [],
        ...(pool ? { stock_plan_id: pool.id, stock_class_id: pool.shareClassId } : {}),
        compensation_type: comp.compensationType, ...(comp.optionGrantType ? { option_grant_type: comp.optionGrantType } : {}),
        quantity: C.ocfNumeric(a.quantity),
        ...(comp.price ? { [comp.price]: this.price(a.strikePrice) } : {}),
        early_exercisable: a.earlyExerciseAllowed,
        ...vesting.fields,
        expiration_date: validDate(a.expirationDate) ?? null,
        termination_exercise_windows: TERMINATION_WINDOW_REASONS.map((reason) => ({ reason, period: Math.max(0, Math.round(a.ptepMonths)), period_type: 'MONTHS' as const })),
      };
      const comments = commentsWith([text(a.notes)], writeNote({
        type: comp.noted ? a.type : undefined, fmvAtGrant: a.fmvAtGrant > 0 ? Math.round(a.fmvAtGrant) : undefined, rsuLiquidityCondition: a.rsuLiquidityCondition || undefined,
        // OCF's null expiration date is read as unknown by many tools; Kosmitor's means none.
        noExpiration: validDate(a.expirationDate) ? undefined : true, unnumbered: a.label ? undefined : true,
      }));
      if (comments) item.comments = comments;
      this.pushIssuance(item, PHASE.issuance, createdAt, vesting.follow);
      if (validDate(a.acceptedDate) && !this.future(a.acceptedDate!)) {
        this.push({ id: ocfId.acceptance(a.id), object_type: 'TX_EQUITY_COMPENSATION_ACCEPTANCE', date: a.acceptedDate!, security_id: a.id }, PHASE.start, createdAt);
      }

      let exercised = 0, cancelled = 0;
      for (const e of own) {
        if (e.quantity == null) continue;
        const base = { id: e.id, date: e.date < a.grantDate ? a.grantDate : e.date, security_id: a.id };
        const quantity = C.ocfNumeric(Number(e.quantity));
        const units = Number(e.quantity) / this.k(a.grantDate, base.date);
        if (e.type === 'EXERCISE') {
          exercised += units;
          if (this.future(base.date)) continue;
          const result = this.results.get(e.id) ?? null;
          // How it was exercised, at what fair market value and for how many shares: the exercise on record.
          const ex = this.exerciseOf.get(e.id);
          const method = ex?.method && ['CASH', 'CASHLESS', 'NET_EXERCISE', 'PROMISSORY_NOTE'].includes(ex.method) ? ex.method : undefined;
          const note = writeNote({
            method, fmvAtExercise: ex?.fmvAtExercise != null ? Math.round(Number(ex.fmvAtExercise)) : undefined,
            sharesIssued: ex?.sharesIssued != null ? Number(ex.sharesIssued) : undefined, amount: e.amount != null ? Math.round(Number(e.amount)) : undefined,
          });
          const noted = note ? { comments: [note] } : {};
          if (a.type === 'RSU' || a.type === 'PHANTOM') {
            const price = ex?.fmvAtExercise != null ? Number(ex.fmvAtExercise) : activeValuation(this.data, base.date);
            this.push({ ...base, object_type: 'TX_EQUITY_COMPENSATION_RELEASE', settlement_date: base.date, release_price: this.price(price),
              quantity, resulting_security_ids: result ? [result] : [], ...noted }, PHASE.event, e.createdAt);
          } else {
            this.push({ ...base, object_type: 'TX_EQUITY_COMPENSATION_EXERCISE', quantity, resulting_security_ids: result ? [result] : [], ...noted }, PHASE.event, e.createdAt);
          }
          if (!result) this.notes.push(`The shares issued on an exercise of ${label} on ${base.date} are not on record.`);
        } else if (e.type === 'CANCELLATION' || e.type === 'FORFEITURE' || e.type === 'EXPIRATION') {
          cancelled += units;
          if (this.future(base.date)) continue;
          this.push({ ...base, object_type: 'TX_EQUITY_COMPENSATION_CANCELLATION', quantity,
            reason_text: memoText(e.memo) ?? (e.type === 'FORFEITURE' ? 'Forfeited' : e.type === 'EXPIRATION' ? 'Expired' : 'Cancelled'),
            comments: [writeNote({ type: e.type })!] }, PHASE.event, e.createdAt);
        } else if (e.type === 'VESTING_ACCELERATION') {
          if (this.future(base.date)) continue;
          this.push({ ...base, object_type: 'TX_VESTING_ACCELERATION', quantity, reason_text: memoText(e.memo) ?? 'Accelerated' }, PHASE.vesting, e.createdAt);
        }
      }
      // Counts the ledger does not explain (an import's, a grant older than the ledger) hold from the grant date, as every view reads them.
      const undatedExercise = roundShares(a.exercisedQuantity - exercised);
      if (undatedExercise > 1e-6) {
        this.push({ id: ocfId.undated(a.id, 'exercised'), object_type: 'TX_EQUITY_COMPENSATION_EXERCISE', date: a.grantDate, security_id: a.id,
          quantity: C.ocfNumeric(undatedExercise), resulting_security_ids: [], comments: ['Exercised; no date on record'] }, PHASE.event, '');
        this.notes.push(`Exercises of ${label} with no date on record are dated the grant.`);
      }
      let undatedCancel = roundShares(a.cancelledQuantity - cancelled);
      // A grant closed by an edit, with options left that no entry explains, is closed from its grant date, as every view reads it.
      if (['CANCELLED', 'EXPIRED', 'FORFEITED', 'EXERCISED'].includes(a.status)) {
        undatedCancel = Math.max(undatedCancel, roundShares(a.quantity - a.exercisedQuantity - cancelled));
      }
      if (undatedCancel > 1e-6) {
        this.push({ id: ocfId.undated(a.id, 'cancelled'), object_type: 'TX_EQUITY_COMPENSATION_CANCELLATION', date: a.grantDate, security_id: a.id,
          quantity: C.ocfNumeric(undatedCancel), reason_text: 'Cancelled; no date on record' }, PHASE.event, '');
        this.notes.push(`Cancellations of ${label} with no date on record are dated the grant.`);
      }
      this.lapses(a, label);
    }
  }

  /**
   * What a leaver loses with no ledger entry, as Kosmitor reads it (awardPosition and
   * awardIsLive in packages/core/src/captable.ts): the part of a grant unvested on the
   * day they leave (or on its grant date, if granted after), and, for an ISO or NSO,
   * the vested part left the day its exercise window has closed. Each is a dated
   * cancellation in the shares of its date, noted as a lapse Kosmitor works out itself;
   * a grant that expires first needs none, as its expiration date says it.
   */
  private lapses(a: Award, label: string): void {
    const holder = this.data.stakeholders.find((s) => s.id === a.stakeholderId);
    const left = validDate(holder?.terminationDate);
    if (!left || a.status !== 'OUTSTANDING') return;
    const expired = (on: string) => !!a.expirationDate && a.expirationDate < on;
    const at = (on: string) => {
      const d = normalizeSplits(this.data, on);
      const award = d.awards.find((x) => x.id === a.id);
      return { award, schedule: award ? d.vestingSchedules.find((v) => v.id === award.vestingScheduleId) : undefined };
    };
    const lapse = (what: 'lapsed' | 'window-closed', on: string, quantity: number): void => {
      if (quantity <= 1e-6) return;
      const window = what === 'window-closed';
      this.push({
        id: ocfId.lapse(a.id, what), object_type: 'TX_EQUITY_COMPENSATION_CANCELLATION', date: on, security_id: a.id, quantity: C.ocfNumeric(roundShares(quantity)),
        reason_text: window ? `Exercise window closed after ${this.holderName(a.stakeholderId)} left` : `Unvested when ${this.holderName(a.stakeholderId)} left`,
        comments: [writeNote({ type: window ? 'EXPIRATION' : 'FORFEITURE', lapse: window ? 'window' : 'termination' })!],
      }, PHASE.event, '~');
      this.lapsed.push(`${label} (${window ? 'window closed' : 'unvested'} on ${on})`);
    };
    const from = a.grantDate > left ? a.grantDate : left;
    const option = a.type === 'ISO' || a.type === 'NSO';
    const closes = option ? addDays(addMonths(left, a.ptepMonths ?? enginePolicy().postTerminationExerciseMonths), 1) : null;
    if (from > this.asOf || expired(from)) return;
    const then = at(from);
    if (!then.award || then.award.status !== 'OUTSTANDING') return;
    if (closes && closes <= from) {
      // Granted after the window had closed: nothing of it is ever live.
      lapse('window-closed', from, awardOutstanding(then.award));
      return;
    }
    lapse('lapsed', from, awardOutstanding(then.award) - awardPosition(then.award, then.schedule, left, from).outstanding);
    if (!closes || closes > this.asOf || expired(closes)) return;
    const later = at(closes);
    if (later.award && later.award.status === 'OUTSTANDING') lapse('window-closed', closes, awardPosition(later.award, later.schedule, left, closes).outstanding);
  }

  // -------------------------------------------------------------------------
  // Warrants
  // -------------------------------------------------------------------------

  private warrantsOut(): void {
    let n = 0;
    for (const w of this.warrants) {
      // A warrant has no number column: one an import kept in its notes ("Warrant number: WX-7; purchase price: 100.00 USD"), else W-n by issue date.
      const lines = (w.notes ?? '').split('\n');
      const kept = /^Warrant number: (.{1,120}?)(?:; purchase price: (\d+\.\d{2}) ([A-Z]{3}))?$/.exec(lines[0] ?? '');
      n++;
      const label = kept?.[1] ?? `W-${n}`;
      const purchase = kept?.[2] && kept[3] === this.currency ? C.scaleDecimal(kept[2], 2)?.value ?? 0 : 0;
      const plain = text((kept ? lines.slice(1) : lines).join('\n'));
      const own = this.entries(w.id);
      // A count lowered after the issue date is a dated cancellation of part of the warrant (an import's, or a correction);
      // any other correction is folded into the issue.
      const lowered = own.filter((e) => e.type === 'CORRECTION' && e.field === 'quantity' && e.quantity != null && Number(e.quantity) < 0 && e.date > w.issueDate && e.date <= this.asOf);
      this.foldCorrections(own.filter((e) => !lowered.includes(e)), label);
      const issued = roundShares(w.quantity + lowered.reduce((sum, e) => sum - Number(e.quantity) / this.k(w.issueDate, e.date), 0));
      const createdAt = this.createdAt(w.id);
      const item: OcfWarrantIssuance = {
        id: ocfId.issuance(w.id), object_type: 'TX_WARRANT_ISSUANCE', date: w.issueDate, security_id: w.id, custom_id: label,
        stakeholder_id: w.stakeholderId, security_law_exemptions: [],
        quantity: C.ocfNumeric(issued), exercise_price: this.price(w.strikePrice), purchase_price: this.money(purchase),
        exercise_triggers: [{
          type: 'ELECTIVE_AT_WILL', trigger_id: TRIGGER.warrantExercise,
          conversion_right: {
            type: 'WARRANT_CONVERSION_RIGHT',
            conversion_mechanism: { type: 'FIXED_AMOUNT_CONVERSION', converts_to_quantity: C.ocfNumeric(issued) },
            converts_to_stock_class_id: w.shareClassId,
          },
        }],
        ...(validDate(w.expirationDate) ? { warrant_expiration_date: w.expirationDate! } : {}),
        quantity_source: 'INSTRUMENT_FIXED',
        comments: commentsWith([plain], writeNote({ netExercise: w.netExercise })),
      };
      if (!item.comments) delete item.comments;
      this.push(item, PHASE.issuance, createdAt);
      let exercised = 0, ended = false;
      for (const e of own) {
        if (e.quantity == null) continue;
        const date = e.date < w.issueDate ? w.issueDate : e.date;
        if (e.type === 'EXERCISE') {
          exercised += Number(e.quantity) / this.k(w.issueDate, date);
          if (this.future(date)) continue;
          const result = this.results.get(e.id) ?? null;
          const method = /^(CASH|NET_EXERCISE) exercise/.exec(e.memo ?? '')?.[1];
          this.push({ id: e.id, object_type: 'TX_WARRANT_EXERCISE', date, security_id: w.id, trigger_id: TRIGGER.warrantExercise,
            resulting_security_ids: result ? [result] : [],
            comments: commentsWith([], writeNote({ quantity: Number(e.quantity), method, amount: e.amount != null ? Math.round(Number(e.amount)) : undefined })) }, PHASE.event, e.createdAt);
          if (!result) this.notes.push(`The shares issued on an exercise of warrant ${label} on ${date} are not on record.`);
        } else if (e.type === 'CANCELLATION' || e.type === 'EXPIRATION') {
          ended = true;
          if (this.future(date)) continue;
          this.push({ id: e.id, object_type: 'TX_WARRANT_CANCELLATION', date, security_id: w.id, quantity: C.ocfNumeric(Number(e.quantity)),
            reason_text: memoText(e.memo) ?? (e.type === 'EXPIRATION' ? 'Expired' : 'Cancelled'), comments: [writeNote({ type: e.type })!] }, PHASE.event, e.createdAt);
        } else if (lowered.includes(e)) {
          this.push({ id: e.id, object_type: 'TX_WARRANT_CANCELLATION', date, security_id: w.id, quantity: C.ocfNumeric(-Number(e.quantity)),
            reason_text: memoText(e.memo) ?? 'Part of the warrant cancelled', comments: [writeNote({ type: 'CORRECTION' })!] }, PHASE.event, e.createdAt);
        }
      }
      const undated = roundShares(w.exercisedQuantity - exercised);
      if (undated > 1e-6) {
        this.push({ id: ocfId.undated(w.id, 'exercised'), object_type: 'TX_WARRANT_EXERCISE', date: w.issueDate, security_id: w.id, trigger_id: TRIGGER.warrantExercise,
          resulting_security_ids: [], comments: ['Exercised; no date on record', writeNote({ quantity: undated })!] }, PHASE.event, '');
        this.notes.push(`Exercises of warrant ${label} with no date on record are dated its issue.`);
      }
      if (!ended && (w.status === 'CANCELLED' || w.status === 'EXPIRED')) {
        const left = roundShares(w.quantity - w.exercisedQuantity);
        this.push({ id: ocfId.undated(w.id, 'closed'), object_type: 'TX_WARRANT_CANCELLATION', date: w.issueDate, security_id: w.id, quantity: C.ocfNumeric(Math.max(0, left)),
          reason_text: `${w.status === 'EXPIRED' ? 'Expired' : 'Cancelled'}; no date on record` }, PHASE.event, '~');
        this.notes.push(`Warrant ${label} is ${w.status.toLowerCase()} with no date on record; it is shown as ended on its issue date.`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // SAFEs and notes
  // -------------------------------------------------------------------------

  private convertiblesOut(): void {
    for (const c of this.convertibles) {
      const label = c.label ?? shortId(c.id);
      const own = this.entries(c.id);
      this.foldCorrections(own, label);
      const createdAt = this.createdAt(c.id);
      const kind = C.convertibleTypeOf(c.instrument);
      const terms = {
        ...(c.discount > 0 ? { conversion_discount: C.ocfPercentage(c.discount) } : {}),
        ...(c.valuationCap != null ? { conversion_valuation_cap: this.money(c.valuationCap) } : {}),
      };
      const compounding = C.COMPOUNDING_TO_OCF[c.compounding] ?? C.COMPOUNDING_TO_OCF.SIMPLE;
      const mechanism = kind.mechanism === 'SAFE_CONVERSION'
        ? { type: 'SAFE_CONVERSION', conversion_mfn: c.mfn, ...terms, ...(kind.timing ? { conversion_timing: kind.timing } : {}) }
        : {
          type: 'CONVERTIBLE_NOTE_CONVERSION', interest_rates: [{ rate: C.ocfPercentage(c.interestRate), accrual_start_date: c.issueDate }],
          day_count_convention: 'ACTUAL_365', interest_payout: 'DEFERRED', interest_accrual_period: compounding.accrualPeriod,
          compounding_type: compounding.compoundingType, ...terms, conversion_mfn: c.mfn,
        };
      const right = { type: 'CONVERTIBLE_CONVERSION_RIGHT' as const, conversion_mechanism: mechanism, converts_to_future_round: true };
      const triggers: OcfConversionTrigger[] = [{
        type: 'AUTOMATIC_ON_CONDITION', trigger_id: TRIGGER.conversion, nickname: 'Next equity financing',
        trigger_condition: c.qualifiedFinancingMinimum ? `An equity financing raising at least ${C.centsToAmount(c.qualifiedFinancingMinimum)} ${this.currency}` : 'The next equity financing',
        conversion_right: right,
      }];
      if (validDate(c.maturityDate)) triggers.push({ type: 'AUTOMATIC_ON_DATE', trigger_id: TRIGGER.maturity, nickname: 'Maturity', trigger_date: c.maturityDate!, conversion_right: right });
      const elections = own.filter((e) => e.type === 'MFN_ELECTION' && e.adoptedSecurityId && e.date <= this.asOf).map((e) => ({ date: e.date, adoptedSecurityId: e.adoptedSecurityId! }));
      // OCF has no MFN election: the terms here are the ones issued, and a sentence says which were adopted and when.
      const adoptedLabel = (id: string) => { const x = this.data.convertibles.find((y) => y.id === id); return x ? x.label ?? shortId(x.id) : 'another SAFE'; };
      const elected = elections.map((e) => mfnComment(adoptedLabel(e.adoptedSecurityId), e.date));
      for (const e of elections) this.notes.push(`${label} elected the terms of ${adoptedLabel(e.adoptedSecurityId)} on ${e.date} (MFN); its conversion terms in the package are as issued.`);
      const raw = this.raw.created.get(c.id) ?? {};
      const board = validDate(c.boardApprovalDate) ?? validDate(raw.convertibleBoardApprovalDate);
      const item: OcfConvertibleIssuance = {
        id: ocfId.issuance(c.id), object_type: 'TX_CONVERTIBLE_ISSUANCE', date: c.issueDate, security_id: c.id, custom_id: label,
        stakeholder_id: c.stakeholderId, ...(board ? { board_approval_date: board } : {}),
        security_law_exemptions: [], investment_amount: this.money(c.principal), convertible_type: kind.convertibleType,
        conversion_triggers: triggers, seniority: 1,
      };
      const comments = commentsWith([text(c.notes), ...elected], writeNote({
        instrument: c.instrument, compounding: kind.mechanism === 'CONVERTIBLE_NOTE_CONVERSION' ? c.compounding : undefined,
        qualifiedFinancingMinimum: c.qualifiedFinancingMinimum ?? undefined, proRataRight: c.proRataRight || undefined,
        mfnElections: elections.length ? elections : undefined,
        fundsReceivedOn: validDate(raw.fundsReceivedOn), fundsReference: text(raw.fundsReference), unnumbered: c.label ? undefined : true,
      }));
      if (comments) item.comments = comments;
      this.push(item, PHASE.issuance, createdAt);

      let settled = false;
      for (const e of own) {
        const date = e.date < c.issueDate ? c.issueDate : e.date;
        const base = { id: e.id, date, security_id: c.id };
        if (settled && ['CONVERSION', 'REPAYMENT', 'CANCELLATION'].includes(e.type)) continue;
        if (['CONVERSION', 'REPAYMENT', 'CANCELLATION'].includes(e.type) && date > this.asOf) { settled = true; this.later++; continue; }
        if (e.type === 'CONVERSION') {
          settled = true;
          const result = this.results.get(e.id) ?? null;
          this.push({ ...base, object_type: 'TX_CONVERTIBLE_CONVERSION', trigger_id: TRIGGER.conversion, reason_text: memoText(e.memo) ?? 'Converted',
            quantity_converted: C.ocfNumeric(c.principal / 100), resulting_security_ids: result ? [result] : [] }, PHASE.event, e.createdAt);
          if (!result) this.notes.push(`The shares issued on the conversion of ${label} are not on record.`);
        } else if (e.type === 'REPAYMENT') {
          settled = true;
          // OCF's amount is the value cancelled: the principal. The cash repaid, interest included, is in the reason and the note.
          const repaid = e.amount != null ? Math.round(Number(e.amount)) : null;
          this.push({ ...base, object_type: 'TX_CONVERTIBLE_CANCELLATION', amount: this.money(c.principal),
            reason_text: repaid != null ? `Repaid ${C.centsToAmount(repaid)} ${this.currency}` : 'Repaid',
            comments: [writeNote({ type: 'REPAYMENT', repaid: repaid ?? undefined })!] }, PHASE.event, e.createdAt);
        } else if (e.type === 'CANCELLATION') {
          settled = true;
          this.push({ ...base, object_type: 'TX_CONVERTIBLE_CANCELLATION', amount: this.money(c.principal), reason_text: memoText(e.memo) ?? 'Cancelled',
            comments: [writeNote({ type: 'CANCELLATION' })!] }, PHASE.event, e.createdAt);
        }
      }
      if (!settled && c.status !== 'OUTSTANDING') {
        if (c.status === 'CONVERTED') {
          const date = validDate(c.convertedOn) ?? c.issueDate;
          this.push({ id: ocfId.undated(c.id, 'closed'), object_type: 'TX_CONVERTIBLE_CONVERSION', date, security_id: c.id, trigger_id: TRIGGER.conversion,
            reason_text: 'Converted', quantity_converted: C.ocfNumeric(c.principal / 100), resulting_security_ids: [] }, PHASE.event, '~');
        } else {
          this.push({ id: ocfId.undated(c.id, 'closed'), object_type: 'TX_CONVERTIBLE_CANCELLATION', date: c.issueDate, security_id: c.id,
            amount: this.money(c.principal), reason_text: c.status === 'REPAID' ? 'Repaid; no date on record' : 'Cancelled; no date on record' }, PHASE.event, '~');
        }
        this.notes.push(`${label} is ${c.status.toLowerCase()} with no ledger entry for it; it is shown as settled on ${c.status === 'CONVERTED' ? validDate(c.convertedOn) ?? c.issueDate : c.issueDate}.`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Splits and what is left
  // -------------------------------------------------------------------------

  private splits(): void {
    for (const s of this.data.stockSplits.slice().sort(by((x) => x.date, (x) => x.id))) {
      for (const c of this.classes) {
        const inUse = c.issueDate <= s.date || this.issuances.some((i) => i.shareClassId === c.id && i.issueDate <= s.date);
        if (!inUse) continue;
        this.push({ id: ocfId.split(s.id, c.id), object_type: 'TX_STOCK_CLASS_SPLIT', date: s.date, stock_class_id: c.id, split_ratio: C.ocfRatio(s.ratio) },
          PHASE.adjustment, '');
      }
    }
  }

  private otherEntries(): void {
    const counts: Record<string, number> = {};
    for (const t of this.raw.transactions) if (UNMAPPED.has(t.type)) counts[t.type] = (counts[t.type] ?? 0) + 1;
    const types = Object.keys(counts).sort();
    const n = types.reduce((s, t) => s + counts[t], 0);
    if (n) this.notes.push(`${plural(n, 'ledger entry', 'ledger entries')} with no OCF transaction (${types.join(', ')}) ${n === 1 ? 'is' : 'are'} not included.`);
  }
}

/** A file's bytes as the package holds them: two-space JSON and a final newline. */
export const serializeOcf = (json: unknown): Buffer => Buffer.from(`${JSON.stringify(json, null, 2)}\n`, 'utf8');

/** The package as a .ocf.zip, its files flat at the root. */
export function ocfZip(pkg: OcfPackage): Buffer {
  return zip(pkg.files.map((f) => ({ name: f.path, data: serializeOcf(f.json) })));
}
