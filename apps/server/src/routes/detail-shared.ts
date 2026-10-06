/**
 * The parts every record page needs.
 *
 * A certificate, an option grant, a SAFE and a warrant are different things, but
 * the page each one gets asks the same three questions at the bottom: who holds
 * it, what paperwork is filed against it, and what has happened to it. Those
 * answers are assembled here once so the four routes differ only where the
 * instruments genuinely differ.
 */
import type { Ctx } from '../http.ts';
import { all, toCamelAll } from '../db.ts';
import type { CompanyData } from '@ct/core';

/** The roles that read the whole vault; everyone else sees what is published or theirs. */
const WIDE = ['ADMIN', 'LEGAL', 'BOARD'];

export interface TimelineEvent {
  id: string;
  at: string;
  kind: 'TRANSACTION' | 'SIGNATURE' | 'CHANGE';
  title: string;
  detail: string | null;
  quantity: number | null;
  by: string | null;
}

/**
 * The documents filed against one instrument, each with its signature blocks,
 * under the same visibility rule the documents page applies. A record page must
 * not become a way around the vault.
 */
export async function documentsFor(ctx: Ctx, securityId: string): Promise<Record<string, any>[]> {
  const mine = ctx.membership!.stakeholderId;
  const rows = toCamelAll<Record<string, any>>(WIDE.includes(ctx.membership!.role)
    ? await all('SELECT * FROM documents WHERE company_id = ? AND security_id = ? ORDER BY created_at DESC', ctx.companyId, securityId)
    : await all(`SELECT * FROM documents WHERE company_id = ? AND security_id = ?
                 AND (visibility = 'ALL' OR stakeholder_id = ?) ORDER BY created_at DESC`, ctx.companyId, securityId, mine));
  const signatures = toCamelAll<Record<string, any>>(
    await all('SELECT * FROM signatures WHERE company_id = ?', ctx.companyId));
  return rows.map((d) => ({ ...d, signatures: signatures.filter((s) => s.documentId === d.id) }));
}

/**
 * What has happened to an instrument, newest first: the ledger entries that moved
 * it, the signatures that executed its paperwork, and the edits recorded against
 * it. Three sources, one list, because a person reading the page does not care
 * which table an event came from.
 */
export async function timelineFor(ctx: Ctx, securityId: string, documents: Record<string, any>[]): Promise<TimelineEvent[]> {
  const ledger = toCamelAll<Record<string, any>>(
    await all('SELECT * FROM transactions WHERE company_id = ? AND security_id = ? ORDER BY date, created_at', ctx.companyId, securityId));
  const audit = toCamelAll<Record<string, any>>(
    await all('SELECT * FROM audit_log WHERE company_id = ? AND entity_id = ? ORDER BY created_at', ctx.companyId, securityId));

  const events: TimelineEvent[] = [
    ...ledger.map((t) => ({
      id: String(t.id), at: String(t.date), kind: 'TRANSACTION' as const,
      title: String(t.type).replace(/_/g, ' ').toLowerCase(),
      detail: (t.memo as string) ?? null, quantity: t.quantity == null ? null : Number(t.quantity),
      by: (t.createdBy as string) ?? null,
    })),
    ...documents.flatMap((d) => ((d.signatures ?? []) as Record<string, any>[])
      .filter((s) => s.status === 'SIGNED' && s.signedAt)
      .map((s) => ({
        id: String(s.id), at: String(s.signedAt).slice(0, 10), kind: 'SIGNATURE' as const,
        title: `signed by ${s.signerName ?? 'a signatory'}`, detail: String(d.name), quantity: null,
        by: (s.signerName as string) ?? null,
      }))),
    ...audit.map((a) => ({
      id: String(a.id), at: String(a.createdAt).slice(0, 10), kind: 'CHANGE' as const,
      title: String(a.action).replace(/_/g, ' ').toLowerCase(),
      detail: (a.detail as string) ?? null, quantity: null, by: (a.userName as string) ?? null,
    })),
  ];
  return events.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? 1 : -1));
}

/** The holder, trimmed to what a record page shows about them. */
export function holderOf(data: CompanyData, stakeholderId: string) {
  const s = data.stakeholders.find((x) => x.id === stakeholderId);
  return s ? { id: s.id, name: s.name, email: s.email, type: s.type, relation: s.relation } : null;
}

/**
 * A holder may open their own records and no others; the wider roles open any.
 * Returns true when the caller must be refused.
 */
export function hiddenFrom(ctx: Ctx, stakeholderId: string): boolean {
  if (['ADMIN', 'LEGAL', 'BOARD', 'VIEWER'].includes(ctx.membership!.role)) return false;
  return ctx.membership!.stakeholderId !== stakeholderId;
}
