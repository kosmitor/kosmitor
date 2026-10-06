/**
 * Builds a realistic demo company: two founders, a seeded option pool, an
 * angel SAFE round, a priced Series A with participating preferred, employee
 * grants at three different 409A prices, a departed employee, a convertible
 * note, warrants, documents awaiting signature and an open board consent.
 */
import './env.ts';
import { insert, run, migrate, close, transaction } from './db.ts';
import { createUser, findUserByEmail } from './auth.ts';
import { STANDARD_SCHEDULES, dollarsToCents as $, dollarsToPPS as pps, addMonths } from '@kosmitor/core';
import { randomUUID } from 'node:crypto';
import { config, vestingTemplates } from './config.ts';

const id = (p: string) => `${p}_${randomUUID().slice(0, 12)}`;
const now = () => new Date().toISOString();
const D = (s: string) => s;

async function wipe(): Promise<void> {
  const tables = ['board_votes', 'board_consents', 'signatures', 'file_blobs', 'documents', 'exercises',
    'transactions', 'stock_splits', 'valuations', 'vesting_schedules', 'convertibles', 'warrants',
    'pool_adjustments', 'pools', 'awards', 'issuances', 'stakeholders', 'share_classes',
    'scenarios', 'audit_log', 'investor_updates', 'tasks', 'imports', 'memberships', 'companies'];
  for (const t of tables) await run(`DELETE FROM ${t}`);
  await run('DELETE FROM sessions');
  await run('DELETE FROM login_nonces');
  await run("DELETE FROM users WHERE email LIKE '%@northstar.demo' OR email = ?", config().demo.email);
}

/** Schedules the demo grants below are written against, kept even when company.vestingSchedules leaves them out. */
const SEED_SCHEDULES = ['4 years, 1 year cliff, monthly', '2 years, monthly (advisor)', '4 years, double-trigger 100%'];

export async function seed(): Promise<{ companyId: string; email: string; password: string }> {
  await wipe();

  // The demo account, demo.email and demo.password.
  const { email, password } = config().demo;
  const user = (await findUserByEmail(email)) ?? (await createUser(email, 'Avery Stone', password));

  const companyId = id('co');
  await insert('companies', {
    id: companyId, name: 'Northstar Robotics', legalName: 'Northstar Robotics, Inc.',
    entityType: 'C_CORP', jurisdiction: 'Delaware', incorporationDate: '2021-02-01',
    fiscalYearEnd: '12-31', ein: '87-4410293', address: '1200 Harrison St, San Francisco, CA',
    website: 'northstar.demo', currency: 'USD', brandColor: '#3d5afe',
    totalAssetsCents: $(14_800_000), createdAt: now(),
  });
  await insert('memberships', {
    id: id('mem'), userId: user.id, companyId, role: 'ADMIN', stakeholderId: null, createdAt: now(),
  });

  // --- Vesting schedules --------------------------------------------------
  const scheduleIds: Record<string, string> = {};
  const schedules = vestingTemplates();
  for (const name of SEED_SCHEDULES) {
    if (!schedules.some((s) => s.name === name)) schedules.push(STANDARD_SCHEDULES.find((s) => s.name === name)!);
  }
  for (const s of schedules) {
    const sid = id('vs');
    scheduleIds[s.name] = sid;
    await insert('vesting_schedules', {
      id: sid, companyId, name: s.name, kind: s.kind, durationMonths: s.durationMonths,
      cliffMonths: s.cliffMonths, frequency: s.frequency, immediatePortion: s.immediatePortion,
      yearWeights: s.yearWeights, milestones: s.milestones, customTranches: s.customTranches,
      accelerationSingle: s.accelerationSingleTrigger, accelerationDouble: s.accelerationDoubleTrigger,
      accelerationMonths: s.accelerationMonths, createdAt: now(),
    });
  }
  const [STD, ADVISOR, DOUBLE] = SEED_SCHEDULES.map((name) => scheduleIds[name]);

  // --- Share classes ------------------------------------------------------
  const commonId = id('sc');
  await insert('share_classes', {
    id: commonId, companyId, name: 'Common', kind: 'COMMON', authorized: 22_000_000,
    parValue: 100, seniority: 0, originalIssuePrice: 100, liquidationMultiple: 1,
    participation: 'NON_PARTICIPATING', participationCap: null, conversionRatio: 1,
    dividendType: 'NONE', dividendRate: 0, dividendCompounding: 0, dividendsParticipate: 0,
    votesPerShare: 1, antiDilution: 'NONE', payToPlay: 0, issueDate: '2021-02-01',
    isConvertible: 0, sortOrder: 0,
  });

  const seriesSeedId = id('sc');
  await insert('share_classes', {
    id: seriesSeedId, companyId, name: 'Series Seed Preferred', kind: 'PREFERRED',
    authorized: 3_500_000, parValue: 100, seniority: 1, originalIssuePrice: pps(0.8734),
    liquidationMultiple: 1, participation: 'NON_PARTICIPATING', participationCap: null,
    conversionRatio: 1, dividendType: 'NON_CUMULATIVE', dividendRate: 0.06, dividendCompounding: 0,
    dividendsParticipate: 0, votesPerShare: 1, antiDilution: 'BROAD_WEIGHTED', payToPlay: 0,
    issueDate: '2022-09-15', isConvertible: 1, sortOrder: 1,
  });

  const seriesAId = id('sc');
  await insert('share_classes', {
    id: seriesAId, companyId, name: 'Series A Preferred', kind: 'PREFERRED',
    authorized: 5_200_000, parValue: 100, seniority: 2, originalIssuePrice: pps(3.2145),
    liquidationMultiple: 1, participation: 'CAPPED_PARTICIPATING', participationCap: 2,
    conversionRatio: 1, dividendType: 'CUMULATIVE', dividendRate: 0.08, dividendCompounding: 0,
    dividendsParticipate: 0, votesPerShare: 1, antiDilution: 'BROAD_WEIGHTED', payToPlay: 1,
    issueDate: '2024-04-10', isConvertible: 1, sortOrder: 2,
  });

  // --- Stakeholders -------------------------------------------------------
  const people: [string, string, string, string, string | null, string | null, string | null][] = [
    ['Avery Stone', 'founder@example.com', 'INDIVIDUAL', 'FOUNDER', '2021-02-01', null, 'Co-founder & CEO'],
    ['Bao Nguyen', 'bao@northstar.demo', 'INDIVIDUAL', 'FOUNDER', '2021-02-01', null, 'Co-founder & CTO'],
    ['Priya Raman', 'priya@northstar.demo', 'INDIVIDUAL', 'EMPLOYEE', '2021-11-08', null, 'VP Engineering'],
    ['Marcus Webb', 'marcus@northstar.demo', 'INDIVIDUAL', 'EMPLOYEE', '2022-03-14', null, 'Head of Design'],
    ['Lena Fischer', 'lena@northstar.demo', 'INDIVIDUAL', 'EMPLOYEE', '2023-01-09', null, 'Staff Engineer'],
    ['Tomas Silva', 'tomas@northstar.demo', 'INDIVIDUAL', 'EMPLOYEE', '2023-06-01', null, 'Account Executive'],
    ['Ingrid Olsen', 'ingrid@northstar.demo', 'INDIVIDUAL', 'FORMER_EMPLOYEE', '2021-05-03', '2024-02-29', 'Engineer'],
    ['Dr. Hana Kim', 'hana@northstar.demo', 'INDIVIDUAL', 'ADVISOR', '2021-06-01', null, 'Technical advisor'],
    ['Wendell Grant', 'wendell@northstar.demo', 'INDIVIDUAL', 'BOARD_MEMBER', '2024-04-10', null, 'Independent director'],
    ['Foundry Seed Fund I, L.P.', 'ir@foundry.demo', 'FUND', 'INVESTOR', null, null, null],
    ['Meridian Capital Partners III', 'ir@meridian.demo', 'FUND', 'INVESTOR', null, null, null],
    ['Juniper Angels SPV', 'spv@juniper.demo', 'ENTITY', 'INVESTOR', null, null, null],
    ['Cormac Doyle', 'cormac@angels.demo', 'INDIVIDUAL', 'INVESTOR', null, null, 'Angel'],
    ['Bridgepoint Venture Debt', 'debt@bridgepoint.demo', 'ENTITY', 'INVESTOR', null, null, null],
  ];
  const sh: Record<string, string> = {};
  for (const [name, mail, type, relation, start, term, title] of people) {
    const sid = id('stk');
    sh[name] = sid;
    await insert('stakeholders', {
      id: sid, companyId, name, email: mail, type, relation, startDate: start,
      terminationDate: term, taxCountry: 'US', taxState: 'CA', entityGroupId: null,
      title, address: null, phone: null, notes: null, createdAt: now(),
    });
  }

  // --- Founder stock ------------------------------------------------------
  const issue = async (o: Record<string, unknown>) => {
    const iid = id('iss');
    await insert('issuances', {
      id: iid, companyId, status: 'OUTSTANDING', earlyExercised: 0, election83bFiledOn: null,
      sourceAwardId: null, boardApprovalDate: null, notes: null, vestingScheduleId: null,
      vestingStartDate: null, createdAt: now(), ...o,
    });
    return iid;
  };
  await issue({ certificateNo: 'CS-1', stakeholderId: sh['Avery Stone'], shareClassId: commonId,
    quantity: 4_200_000, pricePerShare: 100, issueDate: '2021-02-01',
    vestingScheduleId: STD, vestingStartDate: '2021-02-01', election83bFiledOn: '2021-02-12',
    boardApprovalDate: '2021-02-01' });
  await issue({ certificateNo: 'CS-2', stakeholderId: sh['Bao Nguyen'], shareClassId: commonId,
    quantity: 3_800_000, pricePerShare: 100, issueDate: '2021-02-01',
    vestingScheduleId: STD, vestingStartDate: '2021-02-01', election83bFiledOn: '2021-02-12',
    boardApprovalDate: '2021-02-01' });
  await issue({ certificateNo: 'CS-3', stakeholderId: sh['Dr. Hana Kim'], shareClassId: commonId,
    quantity: 60_000, pricePerShare: 100, issueDate: '2021-06-01',
    vestingScheduleId: ADVISOR, vestingStartDate: '2021-06-01', election83bFiledOn: '2021-06-20',
    boardApprovalDate: '2021-06-01' });

  // --- Option pools -------------------------------------------------------
  const pool2021 = id('pol');
  await insert('pools', {
    id: pool2021, companyId, name: '2021 Equity Incentive Plan', shareClassId: commonId,
    authorized: 1_500_000, boardApprovalDate: '2021-02-15', shareholderApprovalDate: '2021-02-15',
    returnForfeitures: 1, evergreenPercent: null, planType: 'STOCK_PLAN', createdAt: now(),
  });
  await insert('pool_adjustments', {
    id: id('poo'), companyId, poolId: pool2021, date: '2022-09-15', amount: 800_000,
    reason: 'Series Seed pool top-up', createdAt: now(),
  });
  await insert('pool_adjustments', {
    id: id('poo'), companyId, poolId: pool2021, date: '2024-04-10', amount: 1_650_000,
    reason: 'Series A pool refresh to 12% post-close', createdAt: now(),
  });

  // --- 409A history -------------------------------------------------------
  const valuations: [string, number, string, string][] = [
    ['2021-03-01', pps(0.0100), '2022-02-28', 'SUPERSEDED'],
    ['2022-10-01', pps(0.1900), '2023-09-30', 'SUPERSEDED'],
    ['2023-10-15', pps(0.3400), '2024-10-14', 'SUPERSEDED'],
    ['2024-05-20', pps(0.9600), addMonths('2024-05-20', 12), 'ACTIVE'],
  ];
  for (const [eff, fmv, exp, status] of valuations) {
    await insert('valuations', {
      id: id('val'), companyId, type: '409A', fairMarketValue: fmv, effectiveDate: eff,
      expirationDate: exp, provider: 'Meridian Valuation Group', reportUrl: null, status,
      enterpriseValue: null, method: 'OPM backsolve', notes: null, createdAt: now(),
    });
  }

  // --- Convertibles (pre-seed SAFEs, one converted, plus a live note) -----
  const conv = (o: Record<string, unknown>) => insert('convertibles', {
    id: id('cnv'), companyId, discount: 0, interestRate: 0, compounding: 'SIMPLE',
    maturityDate: null, mfn: 0, proRataRight: 1, status: 'OUTSTANDING',
    convertedIntoShareClassId: null, convertedOn: null, qualifiedFinancingMinimum: null,
    notes: null, createdAt: now(), ...o,
  });
  await conv({ stakeholderId: sh['Cormac Doyle'], instrument: 'SAFE_POST', principal: $(250_000),
    issueDate: '2021-08-12', valuationCap: $(8_000_000), discount: 0.1,
    status: 'CONVERTED', convertedIntoShareClassId: seriesSeedId, convertedOn: '2022-09-15' });
  await conv({ stakeholderId: sh['Juniper Angels SPV'], instrument: 'SAFE_POST', principal: $(400_000),
    issueDate: '2023-11-02', valuationCap: $(24_000_000), discount: 0.15, proRataRight: 1 });
  await conv({ stakeholderId: sh['Cormac Doyle'], instrument: 'SAFE_POST', principal: $(150_000),
    issueDate: '2024-01-20', valuationCap: $(30_000_000), discount: 0, mfn: 1 });
  await conv({ stakeholderId: sh['Bridgepoint Venture Debt'], instrument: 'NOTE', principal: $(1_000_000),
    issueDate: '2024-11-01', valuationCap: $(45_000_000), discount: 0.2, interestRate: 0.08,
    compounding: 'ANNUAL', maturityDate: '2026-11-01', qualifiedFinancingMinimum: $(5_000_000) });

  // --- Preferred rounds ---------------------------------------------------
  await issue({ certificateNo: 'PS-1', stakeholderId: sh['Foundry Seed Fund I, L.P.'],
    shareClassId: seriesSeedId, quantity: 2_290_000, pricePerShare: pps(0.8734),
    issueDate: '2022-09-15', boardApprovalDate: '2022-09-10' });
  await issue({ certificateNo: 'PS-2', stakeholderId: sh['Cormac Doyle'], shareClassId: seriesSeedId,
    quantity: 318_000, pricePerShare: pps(0.8734), issueDate: '2022-09-15',
    boardApprovalDate: '2022-09-10' });
  await issue({ certificateNo: 'PA-1', stakeholderId: sh['Meridian Capital Partners III'],
    shareClassId: seriesAId, quantity: 3_733_000, pricePerShare: pps(3.2145),
    issueDate: '2024-04-10', boardApprovalDate: '2024-04-05' });
  await issue({ certificateNo: 'PA-2', stakeholderId: sh['Foundry Seed Fund I, L.P.'],
    shareClassId: seriesAId, quantity: 622_000, pricePerShare: pps(3.2145),
    issueDate: '2024-04-10', boardApprovalDate: '2024-04-05' });

  // --- Warrants -----------------------------------------------------------
  await insert('warrants', {
    id: id('wrt'), companyId, stakeholderId: sh['Bridgepoint Venture Debt'],
    shareClassId: seriesAId, quantity: 46_700, strikePrice: pps(3.2145),
    issueDate: '2024-11-01', expirationDate: '2034-11-01', status: 'OUTSTANDING',
    exercisedQuantity: 0, netExercise: 1, notes: 'Coverage on the venture debt facility',
    createdAt: now(),
  });

  // --- Employee grants ----------------------------------------------------
  let grantNo = 1;
  const grant = async (holder: string, type: string, qty: number, strike: number, grantDate: string,
                       scheduleId: string, extra: Record<string, unknown> = {}) => {
    const aid = id('awa');
    await insert('awards', {
      id: aid, companyId, label: `${type}-${String(grantNo++).padStart(4, '0')}`,
      stakeholderId: sh[holder], poolId: pool2021, type, quantity: qty, strikePrice: strike,
      grantDate, vestingStartDate: grantDate, vestingScheduleId: scheduleId, status: 'OUTSTANDING',
      expirationDate: addMonths(grantDate, 120), ptepMonths: 3, earlyExerciseAllowed: 0,
      exercisedQuantity: 0, cancelledQuantity: 0, boardApprovalDate: grantDate,
      acceptedDate: grantDate, fmvAtGrant: strike, rsuLiquidityCondition: 0, notes: null,
      createdAt: now(), ...extra,
    });
    return aid;
  };

  await grant('Priya Raman', 'ISO', 420_000, pps(0.01), '2021-11-08', STD);
  await grant('Ingrid Olsen', 'ISO', 180_000, pps(0.01), '2021-05-03', STD);
  await grant('Marcus Webb', 'ISO', 240_000, pps(0.19), '2022-03-14', STD);
  await grant('Lena Fischer', 'ISO', 310_000, pps(0.34), '2023-01-09', STD);
  await grant('Tomas Silva', 'NSO', 95_000, pps(0.34), '2023-06-01', STD);
  await grant('Dr. Hana Kim', 'NSO', 40_000, pps(0.34), '2023-10-20', ADVISOR);
  await grant('Wendell Grant', 'NSO', 120_000, pps(0.96), '2024-04-10', DOUBLE);
  await grant('Priya Raman', 'ISO', 260_000, pps(0.96), '2024-06-01', DOUBLE);
  await grant('Lena Fischer', 'RSU', 55_000, 0, '2024-09-01', STD, { rsuLiquidityCondition: 1 });

  // A large ISO grant that trips the $100,000 first-exercisable limit.
  await grant('Marcus Webb', 'ISO', 600_000, pps(0.96), '2024-07-15', STD);

  // --- Ledger -------------------------------------------------------------
  const tx = (type: string, date: string, memo: string, o: Record<string, unknown> = {}) =>
    insert('transactions', {
      id: id('tx'), companyId, type, date, stakeholderId: null, counterpartyId: null,
      securityId: null, shareClassId: null, quantity: null, pricePerShare: null, amount: null,
      memo, createdAt: now(), createdBy: 'Avery Stone', ...o,
    });
  await tx('ISSUANCE', '2021-02-01', 'Founder common stock issued', { quantity: 8_000_000, shareClassId: commonId });
  await tx('POOL_INCREASE', '2021-02-15', '2021 Equity Incentive Plan adopted (1,500,000 shares)');
  await tx('ISSUANCE', '2022-09-15', 'Series Seed closed at $0.8734 per share', { amount: $(2_280_000), shareClassId: seriesSeedId });
  await tx('CONVERSION', '2022-09-15', 'Pre-seed SAFE converted into Series Seed', { amount: $(250_000) });
  await tx('POOL_INCREASE', '2022-09-15', 'Pool increased by 800,000 shares');
  await tx('ISSUANCE', '2024-04-10', 'Series A closed at $3.2145 per share', { amount: $(14_000_000), shareClassId: seriesAId });
  await tx('POOL_INCREASE', '2024-04-10', 'Pool refreshed by 1,650,000 shares to 12% post-close');
  await tx('ISSUANCE', '2024-11-01', 'Venture debt facility drawn with warrant coverage', { amount: $(1_000_000) });

  // --- Documents and signatures ------------------------------------------
  const docId = id('doc');
  await insert('documents', {
    id: docId, companyId, name: 'Series A Stock Purchase Agreement', category: 'FINANCING',
    folder: 'Series A', body: 'Executed stock purchase agreement for the Series A financing.',
    stakeholderId: null, securityId: null, requiresSignature: 0, status: 'EXECUTED',
    visibility: 'ADMIN', createdBy: 'Avery Stone', createdAt: now(),
  });
  const grantDocId = id('doc');
  await insert('documents', {
    id: grantDocId, companyId, name: 'Stock Option Grant Notice — Wendell Grant',
    category: 'GRANT', folder: 'Grants',
    body: 'Notice of stock option grant and option agreement under the 2021 Equity Incentive Plan.',
    stakeholderId: sh['Wendell Grant'], securityId: null, requiresSignature: 1,
    status: 'AWAITING_SIGNATURE', visibility: 'ALL', createdBy: 'Avery Stone', createdAt: now(),
  });
  await insert('signatures', {
    id: id('sig'), companyId, documentId: grantDocId, stakeholderId: sh['Wendell Grant'],
    signerName: 'Wendell Grant', signerEmail: 'wendell@northstar.demo', status: 'PENDING',
    token: randomUUID(), sentAt: now(), createdAt: now(),
  });
  await insert('documents', {
    id: id('doc'), companyId, name: '409A Valuation Report — May 2024', category: 'VALUATION',
    folder: 'Valuations', body: 'Independent 409A valuation concluding a $0.96 common fair market value.',
    stakeholderId: null, securityId: null, requiresSignature: 0, status: 'FINAL',
    visibility: 'ADMIN', createdBy: 'Avery Stone', createdAt: now(),
  });

  // --- Board consent awaiting votes --------------------------------------
  const consentId = id('con');
  await insert('board_consents', {
    id: consentId, companyId, title: 'Approval of Q3 employee option grants',
    type: 'WRITTEN_CONSENT',
    body: 'Resolved, that the grants set out in the attached schedule are approved at an exercise price of $0.96 per share, the fair market value determined by the board on 20 May 2024.',
    status: 'PENDING', meetingDate: null, effectiveDate: '2024-09-01',
    linkedEntityType: 'awards', linkedEntityIds: JSON.stringify([]),
    createdBy: 'Avery Stone', createdAt: now(),
  });
  for (const director of ['Avery Stone', 'Bao Nguyen', 'Wendell Grant']) {
    await insert('board_votes', {
      id: id('vot'), consentId, stakeholderId: sh[director],
      vote: director === 'Avery Stone' ? 'APPROVE' : 'PENDING',
      comment: null, votedAt: director === 'Avery Stone' ? now() : null, createdAt: now(),
    });
  }

  // --- Tasks --------------------------------------------------------------
  await insert('tasks', {
    id: id('tas'), companyId, title: 'Refresh the 409A valuation before it expires',
    detail: 'The current report expires in May. Engage the valuation provider six weeks ahead.',
    kind: 'COMPLIANCE', entityType: 'valuations', entityId: null, dueDate: '2025-04-01',
    status: 'OPEN', assignee: 'Avery Stone', createdAt: now(), completedAt: null,
  });
  await insert('tasks', {
    id: id('tas'), companyId, title: 'Collect the outstanding grant signature',
    detail: 'Wendell Grant has not countersigned his option grant notice.',
    kind: 'DOCUMENT', entityType: 'documents', entityId: grantDocId, dueDate: null,
    status: 'OPEN', assignee: 'Avery Stone', createdAt: now(), completedAt: null,
  });

  await insert('investor_updates', {
    id: id('upd'), companyId, title: 'Q3 2024 investor update', period: 'Q3 2024',
    body: 'Revenue grew 41% quarter over quarter and the pilot programme converted three enterprise accounts.',
    metrics: JSON.stringify({ arr: 4_200_000, headcount: 34, runwayMonths: 22, netRetention: 1.18 }),
    status: 'SENT', sentAt: now(), createdAt: now(),
  });

  await insert('audit_log', {
    id: id('aud'), companyId, userId: user.id, userName: 'Avery Stone', action: 'SEED',
    entityType: 'companies', entityId: companyId, detail: 'Demo company created',
    ipAddress: '127.0.0.1', createdAt: now(),
  });

  return { companyId, email, password };
}

if (process.argv[1]?.endsWith('seed.ts')) {
  if (!process.argv.includes('--yes')) {
    console.error('npm run seed deletes every company and session in the database before building the demo.');
    console.error('Run it only on a throwaway database, as: npm run seed -- --yes');
    process.exit(1);
  }
  await migrate();
  const result = await transaction(() => seed());
  console.log('Seeded demo company:', result.companyId);
  console.log(`Sign in with ${result.email} / ${result.password}`);
  await close();
}
void D;
