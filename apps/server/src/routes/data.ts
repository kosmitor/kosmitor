/**
 * Where the data lives. Administrators can see that the company's records —
 * cap table, documents and their files, audit trail — are all in the one
 * PostgreSQL database, how large it is, and how to back it up.
 */
import { route } from '../http.ts';
import { one, concurrently, DATABASE_URL } from '../db.ts';

const count = async (sql: string, ...params: unknown[]): Promise<number> =>
  Number((await one<{ n: number }>(sql, ...params))?.n ?? 0);

route.get('/api/c/:cid/data', 'admin', async (ctx) => {
  const cid = ctx.companyId!;
  const [server, files, ...counts] = await concurrently([
    () => one<{ version: string; database: string; size: number }>(
      'SELECT version() AS version, current_database() AS database, pg_database_size(current_database()) AS size'),
    () => one<{ n: number; bytes: number | null }>('SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS bytes FROM file_blobs WHERE company_id = ?', cid),
    () => count('SELECT COUNT(*) AS n FROM stakeholders WHERE company_id = ?', cid),
    () => count('SELECT COUNT(*) AS n FROM share_classes WHERE company_id = ?', cid),
    () => count('SELECT COUNT(*) AS n FROM issuances WHERE company_id = ?', cid),
    () => count('SELECT COUNT(*) AS n FROM awards WHERE company_id = ?', cid),
    () => count('SELECT COUNT(*) AS n FROM convertibles WHERE company_id = ?', cid),
    () => count('SELECT COUNT(*) AS n FROM transactions WHERE company_id = ?', cid),
    () => count('SELECT COUNT(*) AS n FROM documents WHERE company_id = ?', cid),
    () => count('SELECT COUNT(*) AS n FROM scenarios WHERE company_id = ?', cid),
    () => count('SELECT COUNT(*) AS n FROM imports WHERE company_id = ?', cid),
    () => count('SELECT COUNT(*) AS n FROM audit_log WHERE company_id = ?', cid),
  ]);
  const [stakeholders, shareClasses, certificates, awards, convertibles, transactions, documents, scenarios, imports, auditEntries] = counts;
  const url = new URL(DATABASE_URL);
  return {
    engine: 'PostgreSQL',
    version: (server?.version ?? '').split(' on ')[0],
    database: server?.database ?? url.pathname.slice(1),
    host: `${url.hostname}${url.port ? `:${url.port}` : ''}`,
    sizeBytes: Number(server?.size ?? 0),
    counts: {
      stakeholders, shareClasses, certificates, awards, convertibles, transactions, documents,
      files: Number(files?.n ?? 0), fileBytes: Number(files?.bytes ?? 0), scenarios, imports, auditEntries,
    },
  };
});
