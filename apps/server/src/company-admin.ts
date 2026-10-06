/**
 * Removing a company: every table keyed by company_id, plus the rows that hang
 * off those (votes, update recipients). Nothing outside the company is touched.
 */
import { all, run, transaction } from './db.ts';
import { invalidate } from './store.ts';

export async function deleteCompany(companyId: string): Promise<void> {
  await transaction(async () => {
    await run('DELETE FROM board_votes WHERE consent_id IN (SELECT id FROM board_consents WHERE company_id = ?)', companyId);
    await run('DELETE FROM update_recipients WHERE update_id IN (SELECT id FROM investor_updates WHERE company_id = ?)', companyId);
    const tables = await all<{ table_name: string }>(
      "SELECT table_name FROM information_schema.columns WHERE column_name = 'company_id' AND table_schema = 'public' AND table_name <> 'companies'");
    for (const t of tables) await run(`DELETE FROM ${t.table_name} WHERE company_id = ?`, companyId);
    await run('DELETE FROM companies WHERE id = ?', companyId);
  });
  invalidate(companyId);
}
