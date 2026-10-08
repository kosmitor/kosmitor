/**
 * Company people and roles beyond the cap table: who signs for the Company,
 * who to contact (counsel, accountants), and who sits on the board (the
 * stakeholders with a board seat today, as the consent flows read it).
 */
import { today } from '@kosmitor/core';
import { route, newId, nowISO, audit, badRequest, notFound, str, type Ctx } from '../http.ts';
import { all, one, run, insert, update, toCamel, toCamelAll } from '../db.ts';
import { directorsOn } from '../board.ts';

const KINDS = ['SIGNATORY', 'CONTACT'];

interface ContactRow { id: string; company_id: string; kind: string; name: string; title: string | null; email: string | null; phone: string | null; stakeholder_id: string | null; is_default: number; notes: string | null; created_at: string }

async function contactRow(ctx: Ctx, id: string): Promise<ContactRow> {
  const row = await one<ContactRow>('SELECT * FROM company_contacts WHERE id = ? AND company_id = ?', id, ctx.companyId);
  if (!row) throw notFound('Contact not found.');
  return row;
}

function readContact(b: Record<string, unknown>, existing?: ContactRow) {
  const kind = String(b.kind ?? existing?.kind ?? 'CONTACT');
  if (!KINDS.includes(kind)) throw badRequest('A contact is a signatory or a contact.');
  const email = b.email != null ? String(b.email).trim().toLowerCase() : existing?.email ?? null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('That email address does not look right.');
  return {
    kind, name: str(b.name ?? existing?.name, 'Name', { max: 120 }),
    title: b.title != null ? String(b.title).slice(0, 120) || null : existing?.title ?? null,
    email: email || null, phone: b.phone != null ? String(b.phone).slice(0, 60) || null : existing?.phone ?? null,
    stakeholderId: b.stakeholderId != null ? String(b.stakeholderId) || null : existing?.stakeholder_id ?? null,
    notes: b.notes != null ? String(b.notes).slice(0, 2000) || null : existing?.notes ?? null,
    isDefault: b.isDefault != null ? (b.isDefault ? 1 : 0) : existing?.is_default ?? 0,
  };
}

/** The signatory the issuing flows default to. */
export async function defaultSignatory(companyId: string): Promise<{ name: string; title: string | null } | null> {
  const row = await one<ContactRow>("SELECT * FROM company_contacts WHERE company_id = ? AND kind = 'SIGNATORY' ORDER BY is_default DESC, created_at LIMIT 1", companyId);
  return row ? { name: row.name, title: row.title } : null;
}

route.get('/api/c/:cid/contacts', 'read', async (ctx) => {
  const rows = toCamelAll<Record<string, unknown>>(await all('SELECT * FROM company_contacts WHERE company_id = ? ORDER BY is_default DESC, created_at', ctx.companyId));
  return {
    signatories: rows.filter((r) => r.kind === 'SIGNATORY'), contacts: rows.filter((r) => r.kind === 'CONTACT'),
    boardMembers: await directorsOn(ctx.companyId!, today()), defaultSignatory: await defaultSignatory(ctx.companyId!),
  };
});

route.post('/api/c/:cid/contacts', 'admin', async (ctx) => {
  const values = readContact(ctx.body);
  const id = newId('cct');
  if (values.isDefault && values.kind === 'SIGNATORY') await run("UPDATE company_contacts SET is_default = 0 WHERE company_id = ? AND kind = 'SIGNATORY'", ctx.companyId);
  await insert('company_contacts', { id, companyId: ctx.companyId, ...values, createdAt: nowISO() });
  await audit(ctx, 'CREATE', 'company_contacts', id, `${values.kind === 'SIGNATORY' ? 'Signatory' : 'Contact'} ${values.name} added`);
  return toCamel(await one('SELECT * FROM company_contacts WHERE id = ?', id));
});

route.patch('/api/c/:cid/contacts/:id', 'admin', async (ctx) => {
  const existing = await contactRow(ctx, ctx.params.id);
  const values = readContact(ctx.body, existing);
  if (values.isDefault && values.kind === 'SIGNATORY') await run("UPDATE company_contacts SET is_default = 0 WHERE company_id = ? AND kind = 'SIGNATORY'", ctx.companyId);
  await update('company_contacts', existing.id, values);
  await audit(ctx, 'UPDATE', 'company_contacts', existing.id, `${values.name} updated`);
  return toCamel(await one('SELECT * FROM company_contacts WHERE id = ?', existing.id));
});

route.del('/api/c/:cid/contacts/:id', 'admin', async (ctx) => {
  const existing = await contactRow(ctx, ctx.params.id);
  await run('DELETE FROM company_contacts WHERE id = ?', existing.id);
  await audit(ctx, 'DELETE', 'company_contacts', existing.id, `${existing.name} removed`);
  return { ok: true };
});
