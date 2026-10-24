/**
 * Writes what an OCF package was checked into (plan.ts), inside the transaction
 * runWorkbook holds, so the package lands whole or not at all. Records go in the
 * order they name each other: the company's empty fields, people, classes,
 * schedules, plans and their adjustments, valuations, splits, then the securities
 * in their final state, their exercises, and every ledger entry that dates how
 * they got there. The deferred ledger trigger (db.ts) checks at COMMIT that each
 * security and split has its entry; nothing here works around it.
 */
import { randomUUID } from 'node:crypto';
import { insert, insertMany, update } from '../db.ts';
import type { ImportCounts } from '../import/engine.ts';

type Obj = Record<string, unknown>;

export interface OcfWritePlan {
  /** The company's empty fields the issuer fills in, by column. */
  companyFill: Obj;
  stakeholders: Obj[];
  stakeholderUpdates: { id: string; updates: Obj }[];
  /** Board seats designated by another stakeholder, set once both are written. */
  designations: { id: string; designatedBy: string }[];
  classes: Obj[];
  classUpdates: { id: string; updates: Obj }[];
  schedules: Obj[];
  pools: Obj[];
  poolAdjustments: Obj[];
  valuations: Obj[];
  splits: Obj[];
  /** The company STOCK_SPLIT entry of each split. */
  splitEntries: Obj[];
  issuances: Obj[];
  awards: Obj[];
  warrants: Obj[];
  convertibles: Obj[];
  exercises: Obj[];
  transactions: Obj[];
}

export async function writeOcfPlan(companyId: string, plan: OcfWritePlan, about: {
  fileName: string; createdBy: string | null; counts: ImportCounts; sections: Record<string, ImportCounts>;
  creates: { stakeholders: string[]; shareClasses: string[]; vestingSchedules: string[]; pools: string[] };
}): Promise<string> {
  if (Object.keys(plan.companyFill).length) await update('companies', companyId, plan.companyFill);
  await insertMany('stakeholders', plan.stakeholders);
  for (const u of plan.stakeholderUpdates) await update('stakeholders', u.id, u.updates);
  for (const d of plan.designations) await update('stakeholders', d.id, { boardDesignatedBy: d.designatedBy });
  await insertMany('share_classes', plan.classes);
  for (const u of plan.classUpdates) await update('share_classes', u.id, u.updates);
  await insertMany('vesting_schedules', plan.schedules);
  await insertMany('pools', plan.pools);
  await insertMany('pool_adjustments', plan.poolAdjustments);
  await insertMany('valuations', plan.valuations);
  await insertMany('stock_splits', plan.splits);
  await insertMany('transactions', plan.splitEntries);
  await insertMany('issuances', plan.issuances);
  await insertMany('awards', plan.awards);
  await insertMany('warrants', plan.warrants);
  await insertMany('convertibles', plan.convertibles);
  await insertMany('exercises', plan.exercises);
  await insertMany('transactions', plan.transactions);
  const importId = `imp_${randomUUID().slice(0, 12)}`;
  await insert('imports', {
    id: importId, companyId, kind: 'ocf', fileName: about.fileName,
    rowCount: about.counts.total, importedCount: about.counts.willImport, skippedCount: about.counts.errors + about.counts.skipped,
    summary: JSON.stringify({ creates: about.creates, counts: about.counts, sections: about.sections }),
    createdBy: about.createdBy, createdAt: new Date().toISOString(),
  });
  return importId;
}
