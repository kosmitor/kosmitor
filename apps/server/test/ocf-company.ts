/**
 * Brightwater Kinetics, an invented company with a bit of everything, built through
 * the routes the way a person would: founders' restricted stock, a preferred round
 * with capped participation and a legend, a SAFE that converts, an MFN election, a
 * note repaid and a KISS cancelled, options exercised, cancelled and expired, an RSU,
 * a SAR, a phantom unit, a growth share, a restricted stock award, warrants exercised,
 * cancelled and expired, partial and full transfers (one onward from a transferee),
 * repurchases and cancellations, a 2:1 split between them, a plan increase, 409A and
 * other valuations, every vesting kind, board seats, every stakeholder type and
 * relation, and a grant awaiting signature. Since the reviews: a leaver whose options
 * lapse with no ledger entry, a restricted stock award with its certificate, a grant
 * that never expires, a cashless exercise after the split, a warrant whose count was
 * lowered after its issue, a preferred transfer at a premium with cumulative
 * dividends, notes, an unnumbered certificate, an email OCF refuses and a signatory
 * with no email. Every name and number is invented.
 *
 * The OCF export and import tests both build it (ocf-export.test.ts, ocf-import.test.ts).
 * A test file calls freshDatabase() before this, as before anything from src/.
 */

type Call = (method: string, path: string, body?: unknown, token?: string | null) => Promise<{ status: number; json: any; token?: string }>;

export async function buildBrightwater(call: Call, admin: string, email = 'ines@example.com') {
  void email;
  const { insert, one } = await import('../src/db.ts');
  const cid = (await call('POST', '/api/companies', {
    name: 'Brightwater Kinetics', legalName: 'Brightwater Kinetics, Inc.', jurisdiction: 'Delaware', incorporationDate: '2021-01-04',
    ein: '00-0000001', address: '12 Example Quay, Springfield',
  }, admin)).json.id as string;
  const post = async (path: string, body: Record<string, unknown>) => (await call('POST', `/api/c/${cid}/${path}`, body, admin)).json;
  const common = (await one<{ id: string }>('SELECT id FROM share_classes WHERE company_id = ?', cid))!.id;
  const schedules = (await call('GET', `/api/c/${cid}/vesting-schedules`, undefined, admin)).json as { id: string; name: string }[];
  const vs = (name: string) => schedules.find((s) => s.name === name)!.id;
  const STD = vs('4 years, 1 year cliff, monthly');
  const customVs = (await post('vesting-schedules', { name: 'Three dated tranches', kind: 'CUSTOM', durationMonths: 0, cliffMonths: 0, frequency: 'MONTHLY', immediatePortion: 0,
    customTranches: [{ date: '2022-06-01', portion: 0.25 }, { date: '2023-06-01', portion: 0.25 }, { date: '2024-06-01', portion: 0.5 }] })).id;
  const milestoneVs = (await post('vesting-schedules', { name: 'Launch milestones', kind: 'MILESTONE', durationMonths: 0, cliffMonths: 0, frequency: 'MONTHLY', immediatePortion: 0,
    milestones: [{ id: 'proto', name: 'Prototype flies', portion: 0.4, targetDate: '2022-09-01', achievedDate: '2022-08-15' }, { id: 'cert', name: 'Certification', portion: 0.6, targetDate: '2025-12-01', achievedDate: null }] })).id;
  const weeklyVs = (await post('vesting-schedules', { name: '2 years weekly, 6-month cliff', kind: 'TIME', durationMonths: 24, cliffMonths: 6, frequency: 'WEEKLY', immediatePortion: 0, accelerationDouble: 1 })).id;

  const person = async (name: string, extra: Record<string, unknown>) => (await post('stakeholders', { name, ...extra })).id as string;
  const fenwick = await person('Fenwick Capital Fund I, L.P.', { type: 'FUND', relation: 'INVESTOR', email: 'ir@fenwick.example', signatoryName: 'Petra Lindqvist-Rowe', signatoryEmail: 'petra@fenwick.example', country: 'US', address: '400 Harbor Row', city: 'Springfield', region: 'IL', postalCode: '62701' });
  const ada = await person('Ada Fernsby', { relation: 'FOUNDER', email: 'ada@brightwater.example', phone: '+1 415 555 0100', title: 'CEO', department: 'Leadership', startDate: '2021-01-04', taxCountry: 'US', taxState: 'CA', address: '7 Lantern Lane', city: 'Oakview', region: 'CA', postalCode: '94000', country: 'US', boardSeat: true, boardSeatStart: '2021-01-04' });
  const bram = await person('Bram Holloway', { relation: 'FOUNDER', email: 'bram@brightwater.example', phone: '(415) 555-0199', legalName: 'Bramwell Holloway' });
  const cleo = await person('Cleo Marchetti', { relation: 'EMPLOYEE', email: 'cleo@brightwater.example', secondaryEmail: 'cleo.m@mail.example', employeeId: 'E-1001', startDate: '2021-05-17' });
  const dario = await person('Dario Vance', { relation: 'EMPLOYEE', email: 'dario@brightwater.example' });
  const elin = await person('Elin Sorvik', { relation: 'EMPLOYEE', email: 'elin@brightwater.example' });
  const gale = await person('Gale Street Trust', { type: 'TRUST', relation: 'INVESTOR', address: '3 Gale Street, Port Ellery', notes: 'The other Gale trust', signatoryName: 'Rhea Gale' });
  const harrow = await person('Harrow Angels', { type: 'ENTITY', relation: 'INVESTOR', legalName: 'Harrow Angels LLC', email: 'deals@harrow.example', country: 'GB', city: 'London', region: 'Greater London', address: '9 Example Mews' });
  const iris = await person('Iris Calder', { relation: 'ADVISOR', email: 'iris@calder.example' });
  const jonah = await person('Jonah Pell', { relation: 'CONTRACTOR', email: 'jonah@pell.example', secondaryEmail: 'jonah@péll.example' });
  const kira = await person('Kira Moss', { relation: 'FORMER_EMPLOYEE', email: 'kira@mail.example', startDate: '2021-08-02', terminationDate: '2023-01-31' });
  const lark = await person('Lark Ostrander', { relation: 'BOARD_MEMBER', email: 'lark@fenwick.example', boardSeatStart: '2022-03-01', boardDesignatedBy: fenwick });
  const mina = await person('Mina Osei', { relation: 'OTHER', email: 'mina@osei.example' });
  const nadia = await person('Nadia Quist', { relation: 'BOARD_MEMBER', boardSeat: false });
  const tamsin = await person('Tamsin Reyes', { relation: 'EMPLOYEE', email: 'tamsin@brightwater.example', startDate: '2021-03-01' });
  const odile = await person('Odile Brandt', { relation: 'EMPLOYEE', email: 'odile@brightwater.example', startDate: '2021-09-15' });

  const seriesA = (await post('share-classes', {
    name: 'Series A Preferred', kind: 'PREFERRED', authorized: 5_000_000, parValue: 100, seniority: 1, originalIssuePrice: 1_250_000, liquidationMultiple: 1,
    participation: 'CAPPED_PARTICIPATING', participationCap: 3, conversionRatio: 1, dividendType: 'CUMULATIVE', dividendRate: 0.06, votesPerShare: 1,
    antiDilution: 'BROAD_WEIGHTED', isConvertible: 1, issueDate: '2022-03-01', legend: 'SUBJECT TO A RIGHT OF FIRST REFUSAL UNDER THE INVESTORS\' RIGHTS AGREEMENT.',
  })).id as string;
  const plan = (await post('pools', { name: '2021 Equity Incentive Plan', shareClassId: common, authorized: 2_000_000, boardApprovalDate: '2021-02-01', shareholderApprovalDate: '2021-02-05', returnForfeitures: 1 })).id as string;

  const certificate = async (no: string, holder: string, cls: string, quantity: number, price: number, issueDate: string, extra: Record<string, unknown> = {}) =>
    (await post('issuances', { certificateNo: no, stakeholderId: holder, shareClassId: cls, quantity, pricePerShare: price, issueDate, ...extra })).id as string;
  const cs1 = await certificate('CS-1', ada, common, 4_000_000, 100, '2021-01-15', { vestingScheduleId: STD, vestingStartDate: '2021-01-04', federalExemption: 'SECTION_4A2', election83bFiledOn: '2021-02-01', boardApprovalDate: '2021-01-10' });
  const cs2 = await certificate('CS-2', bram, common, 3_000_000, 100, '2021-01-15', { stateExemption: 'California 25102(f)' });
  const cs3 = await certificate('CS-3', iris, common, 100_000, 50_000, '2022-02-01', { notes: 'Advisor shares for the 2022 roadmap' });
  const ps1 = await certificate('PS-1', fenwick, seriesA, 2_000_000, 1_250_000, '2022-03-01');
  const ps2 = await certificate('PS-2', harrow, seriesA, 400_000, 1_250_000, '2022-03-01');

  const grant = async (label: string, holder: string, type: string, quantity: number, strike: number, grantDate: string, schedule: string, extra: Record<string, unknown> = {}) =>
    (await post('awards', { label, stakeholderId: holder, poolId: plan, type, quantity, strikePrice: strike, grantDate, vestingStartDate: grantDate, vestingScheduleId: schedule, expirationDate: `${Number(grantDate.slice(0, 4)) + 10}${grantDate.slice(4)}`, ptepMonths: 3, ...extra })).id as string;
  const opt1 = await grant('OPT-1', cleo, 'ISO', 200_000, 100_000, '2021-06-01', STD, { acceptedDate: '2021-06-03', boardApprovalDate: '2021-05-28', fmvAtGrant: 50_000 });
  const opt2 = await grant('OPT-2', dario, 'NSO', 100_000, 100_000, '2021-07-01', vs('4 years, no cliff, monthly'));
  await grant('OPT-3', cleo, 'ISO', 40_000, 250_000, '2022-04-15', customVs, { earlyExerciseAllowed: 1 });
  await grant('OPT-4', dario, 'NSO', 30_000, 250_000, '2022-04-15', milestoneVs);
  await grant('OPT-5', elin, 'NSO', 24_000, 250_000, '2022-04-15', weeklyVs);
  await grant('OPT-6', elin, 'ISO', 48_000, 250_000, '2022-04-15', vs('4 years back-loaded (10/20/30/40)'));
  await grant('RSU-1', elin, 'RSU', 50_000, 0, '2022-01-10', vs('1 year, monthly'), { rsuLiquidityCondition: 1 });
  await grant('SAR-1', jonah, 'SAR', 30_000, 200_000, '2022-02-01', vs('Fully vested at grant'));
  await grant('PH-1', iris, 'PHANTOM', 10_000, 0, '2022-02-01', vs('2 years, monthly (advisor)'));
  await grant('GS-1', mina, 'GROWTH_SHARE', 20_000, 150_000, '2022-02-01', vs('4 years, 1 year cliff, quarterly'));
  const rsa1 = await grant('RSA-1', kira, 'RSA', 60_000, 50_000, '2021-09-01', STD);
  // A leaver's grants (she leaves on 2023-06-30, below), one of them never expiring.
  const opt8 = await grant('OPT-8', tamsin, 'NSO', 48_000, 250_000, '2022-01-01', STD, { expirationDate: null });
  const rsu2 = await grant('RSU-2', tamsin, 'RSU', 12_000, 0, '2022-07-01', vs('1 year, monthly'));
  // A restricted stock award with the certificate of its shares.
  const rsa2 = await grant('RSA-2', odile, 'RSA', 30_000, 50_000, '2021-10-01', STD);
  const cs4 = await certificate('CS-4', odile, common, 30_000, 50_000, '2021-10-01', { vestingScheduleId: STD, vestingStartDate: '2021-10-01', sourceAwardId: rsa2 });
  // A certificate with no number.
  const unnumbered = (await post('issuances', { stakeholderId: nadia, shareClassId: common, quantity: 10_000, pricePerShare: 50_000, issueDate: '2022-05-01' })).id as string;
  // Awaiting the holder's signature: not issued, so not in the package.
  await insert('awards', { id: `awa_pending_${cid.slice(-6)}`, companyId: cid, label: 'OPT-9', stakeholderId: cleo, poolId: plan, type: 'ISO', quantity: 5_000, strikePrice: 300_000, grantDate: '2024-09-01',
    vestingStartDate: '2024-09-01', vestingScheduleId: STD, status: 'PENDING_SIGNATURE', ptepMonths: 3, earlyExerciseAllowed: 0, exercisedQuantity: 0, cancelledQuantity: 0, fmvAtGrant: 0, rsuLiquidityCondition: 0, createdAt: new Date().toISOString() });

  const warrant = async (holder: string, cls: string, quantity: number, strike: number, issueDate: string, expirationDate: string) =>
    (await post('warrants', { stakeholderId: holder, shareClassId: cls, quantity, strikePrice: strike, issueDate, expirationDate, netExercise: 1 })).id as string;
  const w1 = await warrant(fenwick, seriesA, 100_000, 1_250_000, '2022-03-01', '2032-03-01');
  const w2 = await warrant(harrow, common, 50_000, 250_000, '2022-06-01', '2032-06-01');
  const w3 = await warrant(gale, common, 25_000, 300_000, '2022-07-01', '2027-07-01');
  const w4 = await warrant(mina, common, 30_000, 300_000, '2022-08-01', '2032-08-01');

  const convertible = async (label: string, holder: string, instrument: string, principal: number, issueDate: string, extra: Record<string, unknown> = {}) =>
    (await post('convertibles', { label, stakeholderId: holder, instrument, principal, issueDate, ...extra })).id as string;
  const safe1 = await convertible('SAFE-1', fenwick, 'SAFE_POST', 50_000_000, '2021-06-15', { valuationCap: 800_000_000 });
  const safe2 = await convertible('SAFE-2', mina, 'SAFE_PRE', 10_000_000, '2021-09-01', { valuationCap: 500_000_000, discount: 0.2, mfn: 1 });
  const safe3 = await convertible('SAFE-3', harrow, 'SAFE_POST', 20_000_000, '2022-05-01', { valuationCap: 1_200_000_000, proRataRight: 1, qualifiedFinancingMinimum: 100_000_000,
    boardApprovalDate: '2022-04-20', fundsReceivedOn: '2022-05-03', fundsReference: 'WIRE-2207', notes: 'Signed at the Harbor Row offsite' });
  const note1 = await convertible('NOTE-1', bram, 'NOTE', 25_000_000, '2021-06-15', { interestRate: 0.06, compounding: 'ANNUAL', maturityDate: '2023-06-15', valuationCap: 600_000_000 });
  const kiss1 = await convertible('KISS-1', iris, 'KISS', 5_000_000, '2021-10-01', { discount: 0.15 });

  await post('valuations', { type: '409A', fairMarketValue: 50_000, effectiveDate: '2021-03-01', status: 'SUPERSEDED', provider: 'Northbeam Valuation Group', method: 'OPM backsolve' });
  await post('valuations', { type: '409A', fairMarketValue: 250_000, effectiveDate: '2022-04-01', expirationDate: '2023-04-01', status: 'ACTIVE', provider: 'Northbeam Valuation Group', method: 'OPM backsolve', enterpriseValue: 1_500_000_000 });
  await post('valuations', { type: 'PREFERRED_PRICE', fairMarketValue: 1_250_000, effectiveDate: '2022-03-01', status: 'ACTIVE' });
  await post('valuations', { type: '409A', fairMarketValue: 400_000, effectiveDate: '2024-09-01', status: 'DRAFT' });
  // The count on Iris's certificate was entered wrong and corrected from its issue date.
  await call('PATCH', `/api/c/${cid}/issuances/${cs3}`, { quantity: 120_000, effectiveDate: '2022-02-01' }, admin);

  // Events before the split.
  const ev = (path: string, body: Record<string, unknown>) => post(path, body);
  const tr1 = await ev(`issuances/${cs2}/transfer`, { toStakeholderId: gale, quantity: 500_000, date: '2021-12-01', pricePerShare: 100_000 });
  await ev(`convertibles/${safe1}/convert`, { shareClassId: seriesA, shares: 500_000, date: '2022-03-01', pricePerShare: 1_000_000 });
  await ev(`awards/${opt1}/exercise`, { quantity: 50_000, exerciseDate: '2022-06-01' });
  await ev(`issuances/${cs1}/repurchase`, { quantity: 100_000, date: '2022-09-01', pricePerShare: 100 });
  await ev(`awards/${opt2}/cancel`, { quantity: 30_000, date: '2022-10-01', reason: 'Forfeited on a change of role' });
  // Part of Harrow's preferred sold on at a premium: the buyer's shares were paid in at the original price.
  await ev(`issuances/${ps2}/transfer`, { toStakeholderId: mina, quantity: 100_000, date: '2022-09-15', pricePerShare: 1_500_000 });
  // Odile's unvested restricted shares bought back, and the award cancelled for them.
  await ev(`issuances/${cs4}/repurchase`, { quantity: 5_000, date: '2022-12-15', pricePerShare: 50_000 });
  await ev(`awards/${rsa2}/cancel`, { quantity: 5_000, date: '2022-12-15', reason: 'Unvested shares repurchased' });
  await ev(`awards/${rsa1}/cancel`, { quantity: 15_000, date: '2022-11-01', reason: 'Unvested shares forfeited' });
  await post('pool-adjustments', { poolId: plan, date: '2022-12-01', amount: 500_000, reason: 'Board increased the plan' });
  await ev(`warrants/${w1}/exercise`, { quantity: 40_000, exerciseDate: '2023-01-15' });
  await ev(`convertibles/${safe2}/mfn-election`, { adoptedId: safe3, date: '2023-02-01' });
  await ev(`convertibles/${note1}/repay`, { date: '2023-03-01', amount: 26_000_000 });
  await ev(`convertibles/${kiss1}/cancel`, { date: '2023-04-01', reason: 'Withdrawn by agreement' });
  await ev(`warrants/${w2}/cancel`, { date: '2023-05-01', reason: 'Surrendered' });
  await ev(`warrants/${w3}/cancel`, { date: '2023-05-02', reason: 'EXPIRED' });
  await post('transactions', { type: 'SECONDARY_SALE', date: '2023-05-10', memo: 'Tender offer recorded for reference', quantity: 1, securityId: null });
  // Mina gave up a third of her warrant: its count corrected from that date.
  await call('PATCH', `/api/c/${cid}/warrants/${w4}`, { quantity: 20_000, effectiveDate: '2023-02-01' }, admin);
  // Tamsin leaves: her unvested options lapse that day, and the vested ones when her window closes.
  await call('PATCH', `/api/c/${cid}/stakeholders/${tamsin}`, { terminationDate: '2023-06-30', relation: 'FORMER_EMPLOYEE' }, admin);
  // A 2:1 split, then more.
  await post('stock-splits', { date: '2023-06-01', ratio: 2 });
  await ev(`issuances/${cs2}/transfer`, { toStakeholderId: harrow, date: '2023-09-01' });
  await ev(`issuances/${cs1}/cancel`, { quantity: 200_000, date: '2023-10-01', reason: 'Returned to treasury' });
  await ev(`awards/${opt1}/exercise`, { quantity: 20_000, exerciseDate: '2024-01-15', method: 'CASHLESS' });
  await ev(`awards/${opt1}/cancel`, { quantity: 10_000, date: '2024-02-01' });
  await grant('OPT-7', cleo, 'NSO', 10_000, 150_000, '2024-02-15', STD);
  await ev(`warrants/${w1}/exercise`, { quantity: 10_000, exerciseDate: '2024-03-01' });
  await ev(`issuances/${ps2}/cancel`, { date: '2024-04-01', reason: 'Rescinded' });
  await ev(`issuances/${tr1.id}/transfer`, { toStakeholderId: mina, quantity: 100_000, date: '2024-05-01', pricePerShare: 300_000 });
  await ev(`issuances/${cs1}/repurchase`, { quantity: 50_000, date: '2024-06-01', pricePerShare: 100 });
  await ev(`awards/${rsa1}/cancel`, { date: '2024-07-01', reason: 'Remaining shares forfeited' });
  await post('transactions', { type: 'VESTING_ACCELERATION', date: '2024-08-01', securityId: cs1, quantity: 1_000, memo: 'Board accelerated a tranche' });
  await ev(`awards/${opt2}/cancel`, { date: '2025-01-01', reason: 'EXPIRED' });

  return {
    cid, common, seriesA, plan, STD, customVs, milestoneVs, weeklyVs,
    fenwick, ada, bram, cleo, dario, elin, gale, harrow, iris, jonah, kira, lark, mina, nadia, tamsin, odile,
    cs1, cs2, cs3, cs4, ps1, ps2, opt1, opt2, opt8, rsu2, rsa1, rsa2, unnumbered, w1, w2, w3, w4, safe1, safe2, safe3, note1, kiss1, tr1,
  };
}
