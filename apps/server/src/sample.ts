/**
 * A fictional company for demos, screenshots and import tests: Marlowe
 * Systems, Inc. — three founders, a Series Seed, an option plan with a departed
 * employee's exercise and cancellation, a post-money SAFE bridge with one
 * cancelled instrument, a 409A history, approvals in flight, a grant awaiting
 * signature, an investor update and an offer letter. Every name, address,
 * email, date and number is invented. The same records are written out as
 * Pulley-style workbooks so the import wizard can be tried without anyone's
 * real data.
 *
 *   npm run sample --workspace=@kosmitor/server           create (skips if it exists) and write the workbooks
 *   npm run sample --workspace=@kosmitor/server -- --replace   delete the existing sample company first
 *   npm run sample --workspace=@kosmitor/server -- --files-only  only write the workbooks
 */
import './env.ts';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { insert, all, one, run, migrate, close, transaction } from './db.ts';
import { createUser, findUserByEmail } from './auth.ts';
import { deleteCompany } from './company-admin.ts';
import { STANDARD_SCHEDULES, dollarsToCents as $, dollarsToPPS as pps, addMonths } from '@kosmitor/core';
import { xlsx, type Cell } from './xlsx-writer.ts';
import { BUILT_IN_TEMPLATES, renderTemplate } from './templates.ts';
import { config, vestingTemplates } from './config.ts';
import { awardFace } from './certificate-face.ts';

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const now = () => new Date().toISOString();
const STD = '4 years, 1 year cliff, monthly';
const ADVISOR = '2 years, monthly (advisor)';

export const SAMPLE_COMPANY = {
  name: 'Marlowe Systems', legalName: 'Marlowe Systems, Inc.', entityType: 'C_CORP', jurisdiction: 'Delaware', incorporationDate: '2022-03-08',
  fiscalYearEnd: '12-31', ein: '84-3127760', address: '440 Bryant Street, San Francisco, CA 94107', website: 'marlowe.example',
  certificateTerms: 'The shares may not be transferred without first being offered to the Company under the right of first refusal in the bylaws, and are subject to the drag-along in the voting agreement dated May 3, 2023.',
  paymentInstructions: 'Wire the exercise price to Marlowe Systems, Inc. (First Meridian Bank, routing 121000000, account ending 4471) with your name and grant number as the reference, then confirm in the portal.',
};

type Person = { key: string; name: string; email: string | null; type: 'INDIVIDUAL' | 'ENTITY' | 'FUND'; relation: string; title: string | null; department: string | null; start: string | null; end: string | null; state: string };
export const PEOPLE: Person[] = [
  { key: 'avery', name: 'Avery Stone', email: 'founder@example.com', type: 'INDIVIDUAL', relation: 'FOUNDER', title: 'Co-founder & CEO', department: 'Leadership', start: '2022-03-08', end: null, state: 'CA' },
  { key: 'mira', name: 'Mira Castellanos', email: 'mira@marlowe.example', type: 'INDIVIDUAL', relation: 'FOUNDER', title: 'Co-founder & CTO', department: 'Leadership', start: '2022-03-08', end: null, state: 'CA' },
  { key: 'theo', name: 'Theo Lindqvist', email: 'theo@marlowe.example', type: 'INDIVIDUAL', relation: 'FOUNDER', title: 'Co-founder & COO', department: 'Leadership', start: '2022-03-08', end: null, state: 'NY' },
  { key: 'sana', name: 'Sana Qureshi', email: 'sana@marlowe.example', type: 'INDIVIDUAL', relation: 'EMPLOYEE', title: 'Staff Engineer', department: 'Engineering', start: '2022-05-25', end: null, state: 'CA' },
  { key: 'julien', name: 'Julien Moreau', email: 'julien@marlowe.example', type: 'INDIVIDUAL', relation: 'EMPLOYEE', title: 'Software Engineer', department: 'Engineering', start: '2022-09-05', end: null, state: 'WA' },
  { key: 'ada', name: 'Ada Okonkwo', email: 'ada@marlowe.example', type: 'INDIVIDUAL', relation: 'EMPLOYEE', title: 'Product Designer', department: 'Product', start: '2023-05-08', end: null, state: 'CA' },
  { key: 'felix', name: 'Felix Brandt', email: 'felix@marlowe.example', type: 'INDIVIDUAL', relation: 'EMPLOYEE', title: 'Account Executive', department: 'Sales', start: '2023-07-25', end: null, state: 'TX' },
  { key: 'oscar', name: 'Oscar Delgado', email: 'oscar.delgado@mail.example', type: 'INDIVIDUAL', relation: 'FORMER_EMPLOYEE', title: 'Software Engineer', department: 'Engineering', start: '2023-10-09', end: '2025-02-21', state: 'CA' },
  { key: 'yuki', name: 'Yuki Tanaka', email: 'yuki@marlowe.example', type: 'INDIVIDUAL', relation: 'EMPLOYEE', title: 'Software Engineer', department: 'Engineering', start: '2024-01-01', end: null, state: 'CA' },
  { key: 'leila', name: 'Leila Haddad', email: 'leila@marlowe.example', type: 'INDIVIDUAL', relation: 'EMPLOYEE', title: 'Customer Success Lead', department: 'Customer', start: '2024-02-12', end: null, state: 'IL' },
  { key: 'nina', name: 'Nina Petrova', email: 'nina@marlowe.example', type: 'INDIVIDUAL', relation: 'EMPLOYEE', title: 'Data Scientist', department: 'Engineering', start: '2024-08-12', end: null, state: 'CA' },
  { key: 'tomas', name: 'Tomás Rivera', email: 'tomas@marlowe.example', type: 'INDIVIDUAL', relation: 'EMPLOYEE', title: 'Software Engineer', department: 'Engineering', start: '2026-08-25', end: null, state: 'CA' },
  { key: 'imani', name: 'Dr. Imani Baptiste', email: 'imani@baptiste.example', type: 'INDIVIDUAL', relation: 'ADVISOR', title: 'Technical advisor', department: null, start: '2022-05-25', end: null, state: 'MA' },
  { key: 'gideon', name: 'Gideon Marsh', email: 'gideon@marsh.example', type: 'INDIVIDUAL', relation: 'ADVISOR', title: 'Go-to-market advisor', department: null, start: '2023-08-25', end: null, state: 'CO' },
  { key: 'beatrix', name: 'Beatrix Holm', email: 'beatrix@holm.example', type: 'INDIVIDUAL', relation: 'BOARD_MEMBER', title: 'Independent director', department: null, start: '2024-05-25', end: null, state: 'NY' },
  { key: 'larkspur', name: 'Larkspur Ventures Fund II, L.P.', email: 'ir@larkspur.example', type: 'FUND', relation: 'INVESTOR', title: null, department: null, start: null, end: null, state: 'DE' },
  { key: 'tidewater', name: 'Tidewater Seed Partners', email: 'deals@tidewater.example', type: 'FUND', relation: 'INVESTOR', title: null, department: null, start: null, end: null, state: 'DE' },
  { key: 'aldergrove', name: 'Alder Grove Capital SPV', email: 'spv@aldergrove.example', type: 'ENTITY', relation: 'INVESTOR', title: null, department: null, start: null, end: null, state: 'DE' },
  { key: 'beacon', name: 'Beacon Street Angels LLC', email: 'hello@beaconstreet.example', type: 'ENTITY', relation: 'INVESTOR', title: null, department: null, start: null, end: null, state: 'MA' },
  { key: 'summit', name: 'Summit Ridge Family Office', email: 'office@summitridge.example', type: 'ENTITY', relation: 'INVESTOR', title: null, department: null, start: null, end: null, state: 'CO' },
  { key: 'orbital', name: 'Orbital Founders Fund', email: 'team@orbitalff.example', type: 'FUND', relation: 'INVESTOR', title: null, department: null, start: null, end: null, state: 'CA' },
  { key: 'cobalt', name: 'Cobalt Bay Ventures', email: 'ir@cobaltbay.example', type: 'FUND', relation: 'INVESTOR', title: null, department: null, start: null, end: null, state: 'CA' },
  { key: 'quill', name: 'Quill & Compass Holdings', email: 'invest@quillcompass.example', type: 'ENTITY', relation: 'INVESTOR', title: null, department: null, start: null, end: null, state: 'NY' },
  { key: 'wren', name: 'Wren Capital', email: 'partners@wren.example', type: 'FUND', relation: 'INVESTOR', title: null, department: null, start: null, end: null, state: 'DE' },
  { key: 'dev', name: 'Dev Anand', email: 'dev.anand@mail.example', type: 'INDIVIDUAL', relation: 'INVESTOR', title: 'Angel investor', department: null, start: null, end: null, state: 'CA' },
  { key: 'priyanka', name: 'Priyanka Nair', email: 'priyanka.nair@mail.example', type: 'INDIVIDUAL', relation: 'INVESTOR', title: 'Angel investor', department: null, start: null, end: null, state: 'WA' },
  { key: 'samuel', name: 'Samuel Oduya', email: null, type: 'INDIVIDUAL', relation: 'INVESTOR', title: 'Angel investor', department: null, start: null, end: null, state: 'GA' },
];

type Certificate = { no: string; holder: string; qty: number; price: number; date: string; schedule?: string; vestStart?: string; filed83b?: string | null; board: string; source?: string };
export const COMMON: Certificate[] = [
  { no: 'CS-1', holder: 'avery', qty: 5_600_000, price: 0.0001, date: '2022-03-08', schedule: STD, vestStart: '2022-03-08', filed83b: '2022-03-18', board: '2022-03-08' },
  { no: 'CS-2', holder: 'mira', qty: 4_000_000, price: 0.0001, date: '2022-03-08', schedule: STD, vestStart: '2022-03-08', filed83b: '2022-03-18', board: '2022-03-08' },
  { no: 'CS-3', holder: 'theo', qty: 1_400_000, price: 0.0001, date: '2022-03-08', schedule: STD, vestStart: '2022-03-08', filed83b: '2022-03-21', board: '2022-03-08' },
  { no: 'CS-4', holder: 'imani', qty: 50_000, price: 0.0001, date: '2022-05-25', schedule: ADVISOR, vestStart: '2022-05-25', filed83b: '2022-06-03', board: '2022-05-25' },
  { no: 'CS-5', holder: 'gideon', qty: 40_000, price: 0.05, date: '2023-08-25', schedule: ADVISOR, vestStart: '2023-08-25', filed83b: null, board: '2023-08-25' },
  { no: 'EX-1', holder: 'oscar', qty: 23_437, price: 0.10, date: '2025-05-08', board: '2023-10-30', source: 'OPT-5' },
];
export const SEED_PRICE = 0.42;
export const SEED: Certificate[] = [
  { no: 'SSP-1', holder: 'larkspur', qty: 1_190_476, price: SEED_PRICE, date: '2023-05-03', board: '2023-04-28' },
  { no: 'SSP-2', holder: 'tidewater', qty: 595_238, price: SEED_PRICE, date: '2023-05-03', board: '2023-04-28' },
  { no: 'SSP-3', holder: 'aldergrove', qty: 238_095, price: SEED_PRICE, date: '2023-05-03', board: '2023-04-28' },
  { no: 'SSP-4', holder: 'beacon', qty: 119_048, price: SEED_PRICE, date: '2023-05-03', board: '2023-04-28' },
  { no: 'SSP-5', holder: 'summit', qty: 119_048, price: SEED_PRICE, date: '2023-05-03', board: '2023-04-28' },
  { no: 'SSP-6', holder: 'dev', qty: 59_524, price: SEED_PRICE, date: '2023-05-03', board: '2023-04-28' },
  { no: 'SSP-7', holder: 'priyanka', qty: 59_524, price: SEED_PRICE, date: '2023-05-03', board: '2023-04-28' },
];

export const PLAN = { name: '2022 Stock Plan', authorized: 1_800_000, boardApprovalDate: '2022-03-25', shareholderApprovalDate: '2022-03-25' };
type Grant = { label: string; holder: string; type: 'ISO' | 'NSO'; qty: number; strike: number; date: string; vestStart: string; schedule: string; exercised: number; cancelled: number; status: string };
export const GRANTS: Grant[] = [
  { label: 'OPT-1', holder: 'sana', type: 'ISO', qty: 220_000, strike: 0.02, date: '2022-06-24', vestStart: '2022-05-25', schedule: STD, exercised: 0, cancelled: 0, status: 'OUTSTANDING' },
  { label: 'OPT-2', holder: 'julien', type: 'ISO', qty: 120_000, strike: 0.02, date: '2022-09-26', vestStart: '2022-09-05', schedule: STD, exercised: 0, cancelled: 0, status: 'OUTSTANDING' },
  { label: 'OPT-3', holder: 'ada', type: 'ISO', qty: 100_000, strike: 0.10, date: '2023-06-05', vestStart: '2023-05-08', schedule: STD, exercised: 0, cancelled: 0, status: 'OUTSTANDING' },
  { label: 'OPT-4', holder: 'felix', type: 'ISO', qty: 80_000, strike: 0.10, date: '2023-08-14', vestStart: '2023-07-25', schedule: STD, exercised: 0, cancelled: 0, status: 'OUTSTANDING' },
  { label: 'OPT-5', holder: 'oscar', type: 'ISO', qty: 75_000, strike: 0.10, date: '2023-10-30', vestStart: '2023-10-09', schedule: STD, exercised: 23_437, cancelled: 51_563, status: 'CANCELLED' },
  { label: 'OPT-6', holder: 'yuki', type: 'ISO', qty: 90_000, strike: 0.10, date: '2024-01-08', vestStart: '2024-01-01', schedule: STD, exercised: 0, cancelled: 0, status: 'OUTSTANDING' },
  { label: 'OPT-7', holder: 'leila', type: 'ISO', qty: 60_000, strike: 0.10, date: '2024-02-26', vestStart: '2024-02-12', schedule: STD, exercised: 0, cancelled: 0, status: 'OUTSTANDING' },
  { label: 'OPT-8', holder: 'nina', type: 'ISO', qty: 110_000, strike: 0.10, date: '2024-08-26', vestStart: '2024-08-12', schedule: STD, exercised: 0, cancelled: 0, status: 'OUTSTANDING' },
  { label: 'OPT-9', holder: 'gideon', type: 'NSO', qty: 30_000, strike: 0.10, date: '2023-08-25', vestStart: '2023-08-25', schedule: ADVISOR, exercised: 0, cancelled: 0, status: 'OUTSTANDING' },
  { label: 'OPT-10', holder: 'beatrix', type: 'NSO', qty: 60_000, strike: 0.10, date: '2024-05-25', vestStart: '2024-05-25', schedule: ADVISOR, exercised: 0, cancelled: 0, status: 'OUTSTANDING' },
];
/** Issued on the platform after the export: it waits for the holder's signature and is not in the workbooks. */
export const PENDING_GRANT: Grant = { label: 'OPT-11', holder: 'tomas', type: 'ISO', qty: 70_000, strike: 0.22, date: '2026-09-08', vestStart: '2026-08-25', schedule: STD, exercised: 0, cancelled: 0, status: 'PENDING_SIGNATURE' };
export const EXERCISE = { grant: 'OPT-5', quantity: 23_437, date: '2025-05-08', fmv: 0.18, certificate: 'EX-1', cancelledOn: '2025-05-21' };

type Safe = { label: string; holder: string; principal: number; date: string; cap: number | null; discount: number; mfn: boolean; proRata: boolean; status: string; funded: string | null };
export const SAFES: Safe[] = [
  { label: 'SAFE-1', holder: 'orbital', principal: 500_000, date: '2024-02-07', cap: 18_000_000, discount: 0, mfn: false, proRata: true, status: 'OUTSTANDING', funded: '2024-02-09' },
  { label: 'SAFE-2', holder: 'cobalt', principal: 400_000, date: '2024-02-07', cap: 18_000_000, discount: 0, mfn: false, proRata: true, status: 'OUTSTANDING', funded: '2024-02-13' },
  { label: 'SAFE-3', holder: 'quill', principal: 250_000, date: '2024-02-23', cap: 18_000_000, discount: 0, mfn: false, proRata: false, status: 'OUTSTANDING', funded: '2024-02-26' },
  { label: 'SAFE-4', holder: 'wren', principal: 200_000, date: '2024-04-03', cap: 20_000_000, discount: 0, mfn: false, proRata: false, status: 'OUTSTANDING', funded: '2024-04-05' },
  { label: 'SAFE-5', holder: 'samuel', principal: 50_000, date: '2024-04-03', cap: 20_000_000, discount: 0, mfn: false, proRata: false, status: 'OUTSTANDING', funded: '2024-04-08' },
  { label: 'SAFE-6', holder: 'dev', principal: 50_000, date: '2024-05-13', cap: null, discount: 0, mfn: true, proRata: false, status: 'OUTSTANDING', funded: '2024-05-14' },
  { label: 'SAFE-7', holder: 'beacon', principal: 100_000, date: '2024-05-13', cap: 20_000_000, discount: 0, mfn: false, proRata: false, status: 'OUTSTANDING', funded: '2024-05-17' },
  { label: 'SAFE-8', holder: 'summit', principal: 100_000, date: '2024-06-08', cap: 20_000_000, discount: 0, mfn: false, proRata: false, status: 'CANCELLED', funded: null },
  { label: 'SAFE-9', holder: 'larkspur', principal: 100_000, date: '2024-06-08', cap: 18_000_000, discount: 0, mfn: false, proRata: true, status: 'OUTSTANDING', funded: '2024-06-11' },
];
export const VALUATIONS: [string, number, string, string][] = [
  ['2022-04-24', 0.02, '2023-04-23', 'SUPERSEDED'], ['2023-05-13', 0.10, '2024-05-12', 'SUPERSEDED'], ['2025-06-24', 0.18, '2026-06-23', 'SUPERSEDED'], ['2026-03-25', 0.22, '2027-03-24', 'ACTIVE'],
];

/** The figures the sample adds up to; the import test reconciles against them. */
export const SAMPLE_TOTALS = (() => {
  const common = COMMON.reduce((s, c) => s + c.qty, 0);
  const seed = SEED.reduce((s, c) => s + c.qty, 0);
  const granted = GRANTS.reduce((s, g) => s + g.qty, 0);
  const cancelled = GRANTS.reduce((s, g) => s + g.cancelled, 0);
  const exercised = GRANTS.reduce((s, g) => s + g.exercised, 0);
  const optionsOutstanding = granted - cancelled - exercised;
  const poolAvailable = PLAN.authorized - granted + cancelled;
  return {
    stakeholders: PEOPLE.length, commonOutstanding: common, seedOutstanding: seed, seedInvested: SEED.reduce((s, c) => s + Math.round(c.qty * c.price * 100), 0),
    granted, optionsOutstanding, poolAvailable, safesOutstanding: SAFES.filter((s) => s.status === 'OUTSTANDING').length,
    safePrincipal: SAFES.filter((s) => s.status === 'OUTSTANDING').reduce((s, x) => s + x.principal, 0),
    fullyDiluted: common + seed + optionsOutstanding + poolAvailable,
  };
})();

/** The date the workbooks are as of. */
export const SAMPLE_AS_OF = '2026-09-15';

const person = (key: string): Person => PEOPLE.find((p) => p.key === key)!;

/**
 * A grant's vested shares on a date, as the export states them: whole months
 * from the vesting start, nothing before the cliff, the running total rounded
 * down, and no vesting after the holder leaves. Worked out here from the
 * schedule's terms rather than by the engine, so the reconciliation test checks
 * the engine against figures it did not produce.
 */
function vestedOn(g: Grant, date: string): number {
  const [months, cliff] = g.schedule === STD ? [48, 12] : [24, 0];
  const end = person(g.holder).end;
  const cutoff = end && end < date ? end : date;
  const [y0, m0, d0] = g.vestStart.split('-').map(Number);
  const [y1, m1, d1] = cutoff.split('-').map(Number);
  const elapsed = (y1 - y0) * 12 + (m1 - m0) - (d1 < d0 ? 1 : 0);
  return elapsed < cliff ? 0 : Math.floor((g.qty * Math.min(elapsed, months)) / months);
}
const label = (s: string): string => s.charAt(0) + s.slice(1).toLowerCase().replace('_', ' ');
const usd = (n: number): string => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Two workbooks laid out the way a cap table export tends to be: a stakeholder
 * report, and a cap table with a summary, an ownership table and one sheet per
 * security type. The summary, the ownership table and the grants' outstanding
 * and vested columns are the export's own figures, which the reconcile tool
 * checks the app against.
 */
export function buildWorkbooks(): { stakeholderReport: Buffer; capTable: Buffer } {
  const stakeholders: Cell[][] = [
    ['Name', 'Email', 'Type', 'Relationship', 'Title', 'Department', 'Start Date', 'Termination Date', 'Tax Country', 'Tax State'],
    ...PEOPLE.map((p) => [p.name, p.email, label(p.type), label(p.relation), p.title, p.department, p.start, p.end, 'US', p.state] as Cell[]),
  ];
  const certRows = (rows: Certificate[]): Cell[][] => [
    ['Stakeholder', 'Email', 'Certificate ID', 'Shares Outstanding', 'Price Per Share', 'Issue Date', 'Vesting Schedule', 'Vesting Start Date', '83(b) Filed', 'Board Approval Date'],
    ...rows.map((c) => [person(c.holder).name, person(c.holder).email, c.no, c.qty, c.price, c.date, c.schedule ?? null, c.vestStart ?? null, c.filed83b ?? null, c.board] as Cell[]),
  ];
  const summary: Cell[][] = [
    [SAMPLE_COMPANY.legalName, null], ['Cap table as of', SAMPLE_AS_OF], [null, null],
    ['Security', 'Shares Outstanding'], ['Common', SAMPLE_TOTALS.commonOutstanding], ['Series Seed Preferred', SAMPLE_TOTALS.seedOutstanding],
    ['Options Outstanding', SAMPLE_TOTALS.optionsOutstanding], ['Available for Issuance', SAMPLE_TOTALS.poolAvailable], ['Fully Diluted Shares', SAMPLE_TOTALS.fullyDiluted],
  ];
  const grants: Cell[][] = [
    ['Stakeholder', 'Email', 'Grant ID', 'Type', 'Options Granted', 'Exercise Price', 'Grant Date', 'Vesting Start Date', 'Vesting Schedule', 'Expiration Date', 'Exercised', 'Cancelled', 'Outstanding', 'Vested', 'Unvested', 'Board Approval Date'],
    ...GRANTS.map((g) => {
      const outstanding = g.qty - g.exercised - g.cancelled;
      const vested = vestedOn(g, SAMPLE_AS_OF);
      return [person(g.holder).name, person(g.holder).email, g.label, g.type, g.qty, g.strike, g.date, g.vestStart, g.schedule, addMonths(g.date, 120), g.exercised || null, g.cancelled || null,
        outstanding, vested, Math.max(0, outstanding - (vested - g.exercised)), g.date] as Cell[];
    }),
    [null], ['Authorized Shares', PLAN.authorized], ['Available for Issuance', SAMPLE_TOTALS.poolAvailable],
  ];
  // Who holds what, fully diluted, with the unallocated pool on a line of its own.
  const sum = (rows: { holder: string; qty: number }[]) => rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r.holder]: (m[r.holder] ?? 0) + r.qty }), {});
  const common = sum(COMMON), seed = sum(SEED);
  const options = sum(GRANTS.map((g) => ({ holder: g.holder, qty: g.qty - g.exercised - g.cancelled })));
  const issued = SAMPLE_TOTALS.commonOutstanding + SAMPLE_TOTALS.seedOutstanding;
  const share = (n: number, of: number): number => Number((n / of).toFixed(6));
  const ownership: Cell[][] = [
    ['Stakeholder', 'Stakeholder Type', 'Common', 'Series Seed Preferred', 'Issued and Outstanding', 'Issued and Outstanding % Ownership', PLAN.name, 'Fully Diluted', 'Fully Diluted % Ownership'],
    ...PEOPLE.filter((p) => common[p.key] || seed[p.key] || options[p.key]).map((p) => {
      const outstanding = (common[p.key] ?? 0) + (seed[p.key] ?? 0);
      const fd = outstanding + (options[p.key] ?? 0);
      return [p.name, label(p.type), common[p.key] ?? 0, seed[p.key] ?? 0, outstanding, share(outstanding, issued), options[p.key] ?? 0, fd, share(fd, SAMPLE_TOTALS.fullyDiluted)] as Cell[];
    }),
    ['Available for Issuance', null, null, null, null, null, SAMPLE_TOTALS.poolAvailable, SAMPLE_TOTALS.poolAvailable, share(SAMPLE_TOTALS.poolAvailable, SAMPLE_TOTALS.fullyDiluted)],
    ['Total', null, SAMPLE_TOTALS.commonOutstanding, SAMPLE_TOTALS.seedOutstanding, issued, 1, SAMPLE_TOTALS.optionsOutstanding + SAMPLE_TOTALS.poolAvailable, SAMPLE_TOTALS.fullyDiluted, 1],
  ];
  const safes: Cell[][] = [
    ['Stakeholder', 'Email', 'SAFE ID', 'Conversion Type', 'Principal', 'Issue Date', 'Valuation Cap', 'Discount', 'MFN', 'Pro Rata', 'Status'],
    ...SAFES.map((s) => [person(s.holder).name, person(s.holder).email, s.label, 'Post-Money', s.principal, s.date, s.cap, s.discount || null, s.mfn ? 'Yes' : 'No', s.proRata ? 'Yes' : 'No', label(s.status)] as Cell[]),
  ];
  return {
    stakeholderReport: xlsx([{ name: 'Stakeholders', rows: stakeholders }]),
    capTable: xlsx([{ name: 'Summary', rows: summary }, { name: 'Ownership', rows: ownership }, { name: 'Common', rows: certRows(COMMON) }, { name: 'Series Seed Preferred', rows: certRows(SEED) }, { name: PLAN.name, rows: grants }, { name: 'SAFEs', rows: safes }]),
  };
}

/**
 * The schedules a new company starts with (company.vestingSchedules), plus any the
 * sample's grants are written against that the settings leave out, so its records
 * hold together whatever the list says.
 */
function sampleSchedules(): typeof STANDARD_SCHEDULES {
  const schedules = vestingTemplates();
  for (const name of [STD, ADVISOR]) {
    if (!schedules.some((s) => s.name === name)) schedules.push(STANDARD_SCHEDULES.find((s) => s.name === name)!);
  }
  return schedules;
}

/**
 * Creates the sample company for a user; returns its id. Nothing else in the
 * database is touched. A new account is given the demo password, demo.password.
 */
export async function createSampleCompany(ownerEmail: string, ownerName = 'Avery Stone'): Promise<string> {
  const user = (await findUserByEmail(ownerEmail)) ?? (await createUser(ownerEmail, ownerName, config().demo.password));
  const companyId = id('co');
  const sh: Record<string, string> = {};
  await transaction(async () => {
    await insert('companies', {
      id: companyId, ...SAMPLE_COMPANY, currency: 'USD', brandColor: '#3d5afe', totalAssetsCents: $(6_400_000), createdAt: now(),
      portalSettings: null, exerciseRequestsEnabled: 1, isSample: 1,
    });
    // Schedules
    const schedules: Record<string, string> = {};
    for (const s of sampleSchedules()) {
      const sid = id('vs'); schedules[s.name] = sid;
      await insert('vesting_schedules', {
        id: sid, companyId, name: s.name, kind: s.kind, durationMonths: s.durationMonths, cliffMonths: s.cliffMonths, frequency: s.frequency, immediatePortion: s.immediatePortion,
        yearWeights: s.yearWeights, milestones: s.milestones, customTranches: s.customTranches, accelerationSingle: s.accelerationSingleTrigger, accelerationDouble: s.accelerationDoubleTrigger,
        accelerationMonths: s.accelerationMonths, createdAt: now(),
      });
    }
    // Classes
    const common = id('sc'); const seed = id('sc');
    const cls = (o: Record<string, unknown>) => insert('share_classes', {
      parValue: 100, seniority: 0, originalIssuePrice: 100, liquidationMultiple: 1, participation: 'NON_PARTICIPATING', participationCap: null, conversionRatio: 1,
      dividendType: 'NONE', dividendRate: 0, dividendCompounding: 0, dividendsParticipate: 0, votesPerShare: 1, antiDilution: 'NONE', payToPlay: 0, isConvertible: 0, legend: null, ...o,
    });
    await cls({ id: common, companyId, name: 'Common', kind: 'COMMON', authorized: 16_000_000, issueDate: '2022-03-08', sortOrder: 0 });
    await cls({ id: seed, companyId, name: 'Series Seed Preferred', kind: 'PREFERRED', authorized: 2_600_000, originalIssuePrice: pps(SEED_PRICE), seniority: 1,
      dividendType: 'NON_CUMULATIVE', dividendRate: 0.06, antiDilution: 'BROAD_WEIGHTED', isConvertible: 1, issueDate: '2023-05-03', sortOrder: 1,
      legend: 'THE SHARES ARE SUBJECT TO A RIGHT OF FIRST REFUSAL AND CO-SALE AGREEMENT DATED MAY 3, 2023.' });
    // People
    for (const p of PEOPLE) {
      const sid = id('stk'); sh[p.key] = sid;
      await insert('stakeholders', { id: sid, companyId, name: p.name, email: p.email, type: p.type, relation: p.relation, startDate: p.start, terminationDate: p.end,
        taxCountry: 'US', taxState: p.state, entityGroupId: null, title: p.title, department: p.department, address: p.type === 'INDIVIDUAL' && p.key === 'avery' ? '18 Alder Lane, Mill Valley, CA 94941' : null, phone: null, notes: null, createdAt: now() });
    }
    await insert('memberships', { id: id('mem'), userId: user.id, companyId, role: 'ADMIN', stakeholderId: sh.avery, createdAt: now() });
    // Certificates + ledger
    const tx = (o: Record<string, unknown>) => insert('transactions', { id: id('tx'), companyId, stakeholderId: null, counterpartyId: null, securityId: null, shareClassId: null, quantity: null, pricePerShare: null, amount: null, memo: null, createdAt: now(), createdBy: 'Avery Stone', ...o });
    const issuanceIds: Record<string, string> = {};
    for (const [classId, rows] of [[common, COMMON], [seed, SEED]] as [string, Certificate[]][]) {
      for (const c of rows) {
        const iid = id('iss'); issuanceIds[c.no] = iid;
        await insert('issuances', { id: iid, companyId, certificateNo: c.no, stakeholderId: sh[c.holder], shareClassId: classId, quantity: c.qty, pricePerShare: pps(c.price), issueDate: c.date, status: 'OUTSTANDING',
          vestingScheduleId: c.schedule ? schedules[c.schedule] : null, vestingStartDate: c.vestStart ?? null, earlyExercised: 0, election83bFiledOn: c.filed83b ?? null, sourceAwardId: null, boardApprovalDate: c.board, notes: c.source ? `Issued on exercise of ${c.source}` : null, createdAt: now() });
        if (!c.source) await tx({ type: 'ISSUANCE', date: c.date, stakeholderId: sh[c.holder], securityId: iid, shareClassId: classId, quantity: c.qty, pricePerShare: pps(c.price), amount: Math.round(c.qty * c.price * 100), memo: `Certificate ${c.no} issued` });
      }
    }
    // Plan and grants
    const pool = id('pol');
    await insert('pools', { id: pool, companyId, name: PLAN.name, shareClassId: common, authorized: PLAN.authorized, boardApprovalDate: PLAN.boardApprovalDate, shareholderApprovalDate: PLAN.shareholderApprovalDate, returnForfeitures: 1, evergreenPercent: null, planType: 'STOCK_PLAN', createdAt: now() });
    await tx({ type: 'POOL_INCREASE', date: PLAN.boardApprovalDate, memo: `${PLAN.name} adopted (${PLAN.authorized.toLocaleString('en-US')} shares)` });
    const awardIds: Record<string, string> = {};
    const fmvOn = (date: string): number => { let f = 0.02; for (const [eff, v] of VALUATIONS) if (eff <= date) f = v; return f; };
    for (const g of [...GRANTS, PENDING_GRANT]) {
      const aid = id('awa'); awardIds[g.label] = aid;
      await insert('awards', { id: aid, companyId, label: g.label, stakeholderId: sh[g.holder], poolId: pool, type: g.type, quantity: g.qty, strikePrice: pps(g.strike), grantDate: g.date, vestingStartDate: g.vestStart,
        vestingScheduleId: schedules[g.schedule], status: g.status, expirationDate: addMonths(g.date, 120), ptepMonths: 3, earlyExerciseAllowed: 0, exercisedQuantity: g.exercised, cancelledQuantity: g.cancelled,
        boardApprovalDate: g.date, acceptedDate: g.status === 'PENDING_SIGNATURE' ? null : g.date, fmvAtGrant: pps(fmvOn(g.date)), rsuLiquidityCondition: 0, notes: null, createdAt: now(),
        signingConfig: g.status === 'PENDING_SIGNATURE' ? JSON.stringify({ signerName: 'Avery Stone', signerTitle: 'Chief Executive Officer', templateId: null, message: 'Welcome to Marlowe.' }) : null });
      if (g.status !== 'PENDING_SIGNATURE') await tx({ type: 'GRANT', date: g.date, stakeholderId: sh[g.holder], securityId: aid, quantity: g.qty, pricePerShare: pps(g.strike), memo: `${g.label} granted` });
    }
    // Oscar's exercise and the cancellation of the rest on departure
    const ex = EXERCISE; const exGrant = GRANTS.find((g) => g.label === ex.grant)!;
    await insert('exercises', { id: id('exe'), companyId, awardId: awardIds[ex.grant], stakeholderId: sh[exGrant.holder], quantity: ex.quantity, exerciseDate: ex.date, method: 'CASH', strikePrice: pps(exGrant.strike), fmvAtExercise: pps(ex.fmv),
      totalCost: Math.round(ex.quantity * exGrant.strike * 100), spread: Math.round(ex.quantity * (ex.fmv - exGrant.strike) * 100), sharesIssued: ex.quantity, issuanceId: issuanceIds[ex.certificate], status: 'COMPLETED', notes: 'Vested options exercised after departure', createdAt: now() });
    await tx({ type: 'EXERCISE', date: ex.date, stakeholderId: sh[exGrant.holder], securityId: awardIds[ex.grant], shareClassId: common, quantity: ex.quantity, pricePerShare: pps(exGrant.strike), amount: Math.round(ex.quantity * exGrant.strike * 100), memo: `${ex.grant} exercised for cash` });
    await tx({ type: 'CANCELLATION', date: ex.cancelledOn, stakeholderId: sh[exGrant.holder], securityId: awardIds[ex.grant], quantity: exGrant.cancelled, memo: 'Unvested options cancelled after the post-termination exercise window' });
    // SAFEs
    for (const s of SAFES) {
      await insert('convertibles', { id: id('cnv'), companyId, label: s.label, stakeholderId: sh[s.holder], instrument: 'SAFE_POST', principal: $(s.principal), issueDate: s.date, valuationCap: s.cap ? $(s.cap) : null, discount: s.discount,
        interestRate: 0, compounding: 'SIMPLE', maturityDate: null, mfn: s.mfn ? 1 : 0, proRataRight: s.proRata ? 1 : 0, status: s.status, convertedIntoShareClassId: null, convertedOn: null, qualifiedFinancingMinimum: null,
        notes: s.status === 'CANCELLED' ? 'Investor withdrew before funding' : null, fundsReceivedOn: s.funded, fundsReference: s.funded ? `Wire ${s.label}` : null, boardApprovalDate: '2024-01-25', signingConfig: null, createdAt: now() });
    }
    // 409A history
    for (const [eff, fmv, exp, status] of VALUATIONS) {
      await insert('valuations', { id: id('val'), companyId, type: '409A', fairMarketValue: pps(fmv), effectiveDate: eff, expirationDate: exp, provider: 'Northgate Valuation Advisors', reportUrl: null, status, enterpriseValue: null, method: 'OPM backsolve', notes: null, createdAt: now() });
    }
    // Documents, the pending agreement and its signature blocks
    await insert('documents', { id: id('doc'), companyId, name: 'Series Seed Stock Purchase Agreement', category: 'FINANCING', folder: 'Series Seed', body: 'Executed stock purchase agreement for the Series Seed financing closed on May 3, 2023.', stakeholderId: null, securityId: null, requiresSignature: 0, status: 'EXECUTED', visibility: 'ADMIN', createdBy: 'Avery Stone', createdAt: now() });
    await insert('documents', { id: id('doc'), companyId, name: '409A Valuation Report — March 2026', category: 'VALUATION', folder: 'Valuations', body: 'Independent 409A valuation concluding a $0.22 common fair market value as of March 25, 2026.', stakeholderId: null, securityId: null, requiresSignature: 0, status: 'FINAL', visibility: 'ADMIN', createdBy: 'Avery Stone', createdAt: now() });
    const pg = PENDING_GRANT; const holder = person(pg.holder);
    const agreement = renderTemplate(BUILT_IN_TEMPLATES.OPTION_AGREEMENT.body, {
      company: { name: SAMPLE_COMPANY.name, legalName: SAMPLE_COMPANY.legalName, jurisdiction: 'Delaware', entityType: 'corporation', address: SAMPLE_COMPANY.address },
      holder: { name: holder.name, email: holder.email ?? '', address: '', title: holder.title ?? '' },
      grant: { label: pg.label, type: pg.type, typeName: 'Incentive Stock Option', isIso: 'yes', quantity: pg.qty.toLocaleString('en-US'), strikePrice: `$${pg.strike.toFixed(2)}`, totalPrice: usd(pg.qty * pg.strike), grantDate: pg.date,
        expirationDate: addMonths(pg.date, 120), vestingSchedule: pg.schedule, vestingStart: pg.vestStart, boardApprovalDate: pg.date, ptepMonths: '3', earlyExercise: '' },
      plan: { name: PLAN.name, shareClass: 'Common' }, shareClass: { name: 'Common', parValue: '$0.0001' }, signer: { name: 'Avery Stone', title: 'Chief Executive Officer' }, message: 'Welcome to Marlowe.', today: now().slice(0, 10),
    }).rendered;
    const docId = id('doc');
    const face = awardFace({
      legalName: SAMPLE_COMPANY.legalName, jurisdiction: 'Delaware', entityType: 'C_CORP', label: pg.label, type: pg.type, typeName: 'Incentive Stock Option',
      holderName: holder.name, quantity: pg.qty, strikePrice: pps(pg.strike), className: 'Common', planName: PLAN.name, grantDate: pg.date,
      vestingSchedule: pg.schedule, vestingStart: pg.vestStart, expirationDate: addMonths(pg.date, 120),
      signerName: 'Avery Stone', signerTitle: 'Chief Executive Officer', back: agreement,
    });
    await insert('documents', { id: docId, companyId, name: `Option agreement ${pg.label} — ${holder.name}`, category: 'GRANT_AGREEMENT', folder: 'Equity awards', body: agreement, face: JSON.stringify(face), stakeholderId: sh[pg.holder], securityId: awardIds[pg.label], requiresSignature: 1, status: 'AWAITING_SIGNATURE', visibility: 'HOLDER', createdBy: 'Avery Stone', createdAt: now() });
    await insert('signatures', { id: id('sig'), companyId, documentId: docId, stakeholderId: null, signerName: 'Avery Stone, Chief Executive Officer — for the Company', signerEmail: ownerEmail, status: 'SIGNED', typedSignature: 'Avery Stone', signedAt: now(), ipAddress: '127.0.0.1', token: randomUUID(), sentAt: now(), createdAt: now() });
    await insert('signatures', { id: id('sig'), companyId, documentId: docId, stakeholderId: sh[pg.holder], signerName: holder.name, signerEmail: holder.email, status: 'PENDING', token: randomUUID(), sentAt: now(), createdAt: now() });
    // Approvals: an approved consent behind the pending grant, a pending board consent, a pending stockholder approval
    const approved = id('con');
    await insert('board_consents', { id: approved, companyId, title: `Approve Incentive Stock Option grant of 70,000 shares to ${holder.name}`, type: 'WRITTEN_CONSENT', kind: 'BOARD', body: 'RESOLVED, that the Company grant Tomás Rivera 70,000 Incentive Stock Options under the 2022 Stock Plan at $0.22 per share.', status: 'APPROVED', meetingDate: null, effectiveDate: pg.date, approvedAt: now(), linkedEntityType: 'awards', linkedEntityIds: JSON.stringify([awardIds[pg.label]]), createdBy: 'Avery Stone', createdAt: now() });
    for (const d of ['avery', 'mira', 'beatrix']) await insert('board_votes', { id: id('vot'), consentId: approved, stakeholderId: sh[d], vote: 'APPROVE', comment: null, votedAt: now(), createdAt: now() });
    const pending = id('con');
    await insert('board_consents', { id: pending, companyId, title: 'Increase the 2022 Stock Plan by 600,000 shares', type: 'WRITTEN_CONSENT', kind: 'BOARD', body: 'RESOLVED, that the number of shares reserved under the 2022 Stock Plan be increased by 600,000 shares of Common Stock, subject to stockholder approval.', status: 'PENDING', meetingDate: null, effectiveDate: now().slice(0, 10), linkedEntityType: null, linkedEntityIds: '[]', createdBy: 'Avery Stone', createdAt: now() });
    for (const d of ['avery', 'mira', 'beatrix']) await insert('board_votes', { id: id('vot'), consentId: pending, stakeholderId: sh[d], vote: d === 'avery' ? 'APPROVE' : 'PENDING', comment: null, votedAt: d === 'avery' ? now() : null, createdAt: now() });
    const voting = [...COMMON, ...SEED].reduce<Record<string, number>>((m, c) => ({ ...m, [c.holder]: (m[c.holder] ?? 0) + c.qty }), {});
    const total = Object.values(voting).reduce((s, v) => s + v, 0);
    const stockholder = id('con');
    await insert('board_consents', { id: stockholder, companyId, title: 'Approve the amended and restated certificate of incorporation', type: 'STOCKHOLDER_CONSENT', kind: 'STOCKHOLDER', threshold: 0.5, totalWeight: total, body: 'RESOLVED, that the Amended and Restated Certificate of Incorporation increasing the authorized Common Stock to 20,000,000 shares be approved.', status: 'PENDING', meetingDate: null, effectiveDate: now().slice(0, 10), linkedEntityType: null, linkedEntityIds: '[]', createdBy: 'Avery Stone', createdAt: now() });
    for (const [key, weight] of Object.entries(voting)) await insert('board_votes', { id: id('vot'), consentId: stockholder, stakeholderId: sh[key], weight, vote: key === 'avery' ? 'APPROVE' : 'PENDING', comment: null, votedAt: key === 'avery' ? now() : null, createdAt: now() });
    // Investor update with recipients, some of whom have read it
    const upd = id('upd');
    await insert('investor_updates', { id: upd, companyId, title: 'H1 2026 investor update', period: 'H1 2026', body: 'ARR passed $3.1M with net revenue retention of 118%. We shipped the workflow builder to all customers and closed our first two enterprise logos. Runway stands at 19 months; we plan to open a Series A conversation in the autumn.',
      metrics: JSON.stringify([{ label: 'ARR', value: '$3.1M' }, { label: 'Net revenue retention', value: '118%' }, { label: 'Runway', value: '19 months' }, { label: 'Headcount', value: '14' }]),
      status: 'SENT', sentAt: '2026-07-08T09:00:00.000Z', audience: 'INVESTORS', recipientIds: '[]', sentBy: 'Avery Stone', createdBy: 'Avery Stone', createdAt: '2026-07-07T16:00:00.000Z' });
    let i = 0;
    for (const p of PEOPLE.filter((x) => x.relation === 'INVESTOR')) {
      await insert('update_recipients', { id: id('upr'), updateId: upd, stakeholderId: sh[p.key], email: p.email, emailed: p.email ? 1 : 0, sentAt: '2026-07-08T09:00:00.000Z', viewedAt: i++ % 3 === 0 ? '2026-07-09T12:00:00.000Z' : null });
    }
    // An offer letter out with a candidate
    await insert('offers', { id: id('off'), companyId, candidateName: 'Camille Okafor', candidateEmail: 'camille.okafor@mail.example', position: 'Senior Software Engineer', department: 'Engineering', startDate: '2026-10-26', salaryCents: $(170_000),
      poolId: pool, awardType: 'ISO', quantity: 60_000, strikePrice: pps(0.22), vestingScheduleId: schedules[STD], expiresOn: '2026-10-08', message: 'We loved your systems design round and think you will thrive on the platform team.', templateId: null,
      signerName: 'Avery Stone', signerTitle: 'Chief Executive Officer', body: 'Offer letter generated on send.', status: 'SENT', token: randomUUID().replace(/-/g, ''), sentAt: '2026-09-11T15:00:00.000Z', viewedAt: '2026-09-12T08:30:00.000Z', createdBy: 'Avery Stone', createdAt: '2026-09-11T14:30:00.000Z' });
    // Signatory and counsel; a saved report
    await insert('company_contacts', { id: id('cct'), companyId, kind: 'SIGNATORY', name: 'Avery Stone', title: 'Chief Executive Officer', email: ownerEmail, phone: null, stakeholderId: sh.avery, isDefault: 1, notes: null, createdAt: now() });
    await insert('company_contacts', { id: id('cct'), companyId, kind: 'CONTACT', name: 'Hartley & Voss LLP', title: 'Outside counsel', email: 'counsel@hartleyvoss.example', phone: null, stakeholderId: null, isDefault: 0, notes: 'Corporate and securities counsel since incorporation.', createdAt: now() });
    await insert('saved_reports', { id: id('rpt'), companyId, name: 'Option ledger', dataset: 'grants', config: JSON.stringify({ dataset: 'grants', columns: ['label', 'holder', 'type', 'quantity', 'strikePrice', 'grantDate', 'vested', 'unvested', 'status'], filters: [], sort: { column: 'grantDate', dir: 'asc' }, totals: true }), createdBy: 'Avery Stone', createdAt: now() });
    await insert('audit_log', { id: id('aud'), companyId, userId: user.id, userName: 'Avery Stone', action: 'SAMPLE', entityType: 'companies', entityId: companyId, detail: 'Sample company created', ipAddress: '127.0.0.1', createdAt: now() });
  });
  return companyId;
}


/**
 * With the demo card on (demo.enabled), the account it hands out has to open onto
 * the sample company, on a fresh or rebuilt database as much as on a laptop. The
 * server calls this at start: it creates the sample company when the demo account
 * has none and does nothing otherwise. An advisory lock keeps two servers starting
 * at once from creating two. Returns the new company's id, or null.
 */
export async function ensureDemoCompany(): Promise<string | null> {
  const { enabled, email } = config().demo;
  if (!enabled) return null;
  return transaction(async () => {
    await run("SELECT pg_advisory_xact_lock(hashtext('kosmitor:demo-company'))");
    const existing = await one<{ id: string }>(
      `SELECT c.id FROM companies c JOIN memberships m ON m.company_id = c.id JOIN users u ON u.id = m.user_id
       WHERE c.is_sample = 1 AND LOWER(u.email) = LOWER(?) LIMIT 1`, email);
    return existing ? null : createSampleCompany(email);
  });
}

/** Writes the two workbooks to a folder; returns their paths. */
export function writeSampleWorkbooks(dir: string): string[] {
  mkdirSync(dir, { recursive: true });
  const { stakeholderReport, capTable } = buildWorkbooks();
  const paths = [resolve(dir, 'marlowe-stakeholder-report.xlsx'), resolve(dir, 'marlowe-cap-table.xlsx')];
  writeFileSync(paths[0], stakeholderReport);
  writeFileSync(paths[1], capTable);
  return paths;
}

if (process.argv[1]?.endsWith('sample.ts')) {
  const args = process.argv.slice(2);
  const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : resolve(import.meta.dirname, '..', 'samples');
  const files = writeSampleWorkbooks(outDir);
  console.log('Sample workbooks written:', files.join(', '));
  if (!args.includes('--files-only')) {
    await migrate();
    const { email, password } = config().demo;
    const existing = await all<{ id: string }>(
      `SELECT c.id FROM companies c JOIN memberships m ON m.company_id = c.id JOIN users u ON u.id = m.user_id WHERE c.name = ? AND u.email = ?`, SAMPLE_COMPANY.name, email);
    if (existing.length && !args.includes('--replace')) {
      console.log(`Sample company already exists (${existing.map((e) => e.id).join(', ')}); pass --replace to rebuild it.`);
    } else {
      for (const e of existing) { await deleteCompany(e.id); console.log('Removed previous sample company', e.id); }
      const companyId = await createSampleCompany(email);
      console.log(`Sample company created: ${companyId} (${SAMPLE_COMPANY.legalName}) — sign in with ${email} / ${password}`);
    }
    await close();
  }
}
