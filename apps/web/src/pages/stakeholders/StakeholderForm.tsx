/**
 * Everything the register knows about a stakeholder, as one form shared by
 * the list page and the detail page. Sections appear as they apply: employment
 * details for people, formation and signatory details for entities, accredited
 * status for investors.
 */
import type { Dispatch, SetStateAction } from 'react';
import { FormGrid } from '../../crud.tsx';
import { Field, Input, Select, Textarea } from '../../ui.tsx';
import { RELATION_LABELS } from '../../format.ts';

export const STAKEHOLDER_TYPES: [string, string][] = [['INDIVIDUAL', 'Individual'], ['ENTITY', 'Entity'], ['FUND', 'Fund'], ['TRUST', 'Trust']];
export const STAKEHOLDER_RELATIONS = ['FOUNDER', 'EMPLOYEE', 'FORMER_EMPLOYEE', 'ADVISOR', 'CONTRACTOR', 'INVESTOR', 'BOARD_MEMBER', 'OTHER'];
export const EMPLOYMENT_TYPES: [string, string][] = [['', 'Not specified'], ['FULL_TIME', 'Full-time'], ['PART_TIME', 'Part-time'], ['CONTRACTOR', 'Contractor'], ['ADVISOR', 'Advisor'], ['INTERN', 'Intern'], ['OTHER', 'Other']];
export const TERMINATION_REASONS: [string, string][] = [['', 'Not specified'], ['VOLUNTARY', 'Voluntary'], ['INVOLUNTARY', 'Involuntary'], ['RETIREMENT', 'Retirement'], ['DEATH', 'Death'], ['DISABILITY', 'Disability'], ['OTHER', 'Other']];
export const TAX_FORMS: [string, string][] = [['', 'None on file'], ['W9', 'W-9'], ['W8BEN', 'W-8BEN'], ['W8BENE', 'W-8BEN-E'], ['OTHER', 'Other']];
export const ACCREDITED: [string, string][] = [['', 'Unknown'], ['YES', 'Accredited'], ['NO', 'Not accredited']];

export const STAKEHOLDER_BLANK = {
  name: '', legalName: '', type: 'INDIVIDUAL', relation: 'EMPLOYEE',
  title: '', department: '', employeeId: '', employmentType: '',
  email: '', secondaryEmail: '', phone: '', address: '', city: '', region: '', postalCode: '', country: '',
  startDate: '', terminationDate: '', terminationReason: '',
  taxCountry: 'US', taxState: '', taxForm: '', accreditedInvestor: '',
  jurisdiction: '', signatoryName: '', signatoryTitle: '', signatoryEmail: '',
  tags: '', notes: '',
};
export type StakeholderForm = typeof STAKEHOLDER_BLANK;

/** Form state for an existing record: every known field, with blanks for nulls. */
export function stakeholderFormFrom(record: Record<string, unknown> | null | undefined): StakeholderForm {
  const out = { ...STAKEHOLDER_BLANK } as Record<string, string>;
  for (const key of Object.keys(STAKEHOLDER_BLANK)) {
    const v = record?.[key];
    if (v != null) out[key] = String(v);
    else if (record) out[key] = '';
  }
  return out as StakeholderForm;
}

/** What the API receives: blanks become nulls, so a cleared field is cleared on the server as well. */
export function stakeholderPayload(form: StakeholderForm): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(form)) {
    const v = value.trim();
    out[key] = key === 'name' || key === 'type' || key === 'relation' ? v : v === '' ? null : v;
  }
  return out;
}

export const labelOf = (list: [string, string][], value: string | null | undefined): string | undefined =>
  list.find(([k]) => k === (value ?? ''))?.[1];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink-400">{title}</h3>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

export function StakeholderFields({ form, setForm }: { form: StakeholderForm; setForm: Dispatch<SetStateAction<StakeholderForm>> }) {
  const set = (key: keyof StakeholderForm) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const individual = form.type === 'INDIVIDUAL';
  const options = (list: [string, string][]) => list.map(([v, l]) => <option key={v} value={v}>{l}</option>);

  return (
    <div className="space-y-6">
      <Section title="Identity">
        <FormGrid>
          <Field label={individual ? 'Full name' : 'Name'} required>
            <Input value={form.name} onChange={set('name')} placeholder={individual ? 'Jordan Ellis' : 'Larkspur Ventures Fund II'} required />
          </Field>
          <Field label="Legal name" hint={individual ? 'As it appears on tax forms, if different.' : 'The registered name, with L.P., LLC or Inc.'}>
            <Input value={form.legalName} onChange={set('legalName')} />
          </Field>
          <Field label="Type">
            <Select value={form.type} onChange={set('type')}>{options(STAKEHOLDER_TYPES)}</Select>
          </Field>
          <Field label="Relationship">
            <Select value={form.relation} onChange={set('relation')}>
              {STAKEHOLDER_RELATIONS.map((r) => <option key={r} value={r}>{RELATION_LABELS[r] ?? r}</option>)}
            </Select>
          </Field>
          {individual && (
            <>
              <Field label="Title"><Input value={form.title} onChange={set('title')} placeholder="VP Engineering" /></Field>
              <Field label="Department" hint="Cost centre for stock-compensation expense.">
                <Input value={form.department} onChange={set('department')} placeholder="Engineering" />
              </Field>
              <Field label="Employee ID" hint="From your HR or payroll system."><Input value={form.employeeId} onChange={set('employeeId')} /></Field>
              <Field label="Employment type">
                <Select value={form.employmentType} onChange={set('employmentType')}>{options(EMPLOYMENT_TYPES)}</Select>
              </Field>
            </>
          )}
        </FormGrid>
      </Section>

      <Section title="Contact">
        <FormGrid>
          <Field label="Email" hint="Used to invite them to the holder portal.">
            <Input type="email" value={form.email} onChange={set('email')} placeholder="jordan@company.com" />
          </Field>
          <Field label="Secondary email"><Input type="email" value={form.secondaryEmail} onChange={set('secondaryEmail')} /></Field>
          <Field label="Phone"><Input type="tel" value={form.phone} onChange={set('phone')} placeholder="+1 415 555 0134" /></Field>
          <Field label="Country"><Input value={form.country} onChange={set('country')} placeholder="United States" /></Field>
        </FormGrid>
        <Field label="Street address"><Textarea value={form.address} onChange={set('address')} rows={2} /></Field>
        <FormGrid columns={3}>
          <Field label="City"><Input value={form.city} onChange={set('city')} /></Field>
          <Field label="State / region"><Input value={form.region} onChange={set('region')} /></Field>
          <Field label="Postal code"><Input value={form.postalCode} onChange={set('postalCode')} /></Field>
        </FormGrid>
      </Section>

      <Section title="Dates">
        <FormGrid>
          <Field label="Start date" hint={individual ? 'Employment or engagement start; drives Rule 701 and ISO tests.' : 'First investment or relationship start.'}>
            <Input type="date" value={form.startDate} onChange={set('startDate')} />
          </Field>
          <Field label="Termination date" hint="Stops vesting and starts the exercise window.">
            <Input type="date" value={form.terminationDate} onChange={set('terminationDate')} />
          </Field>
          {form.terminationDate && (
            <Field label="Termination reason" hint="Some plans extend the exercise window for death, disability or retirement.">
              <Select value={form.terminationReason} onChange={set('terminationReason')}>{options(TERMINATION_REASONS)}</Select>
            </Field>
          )}
        </FormGrid>
      </Section>

      <Section title="Tax & compliance">
        <FormGrid>
          <Field label="Tax residence" hint="Country and state or province.">
            <div className="flex gap-2">
              <Input value={form.taxCountry} onChange={set('taxCountry')} placeholder="US" className="w-20" />
              <Input value={form.taxState} onChange={set('taxState')} placeholder="CA" />
            </div>
          </Field>
          <Field label="Tax form on file">
            <Select value={form.taxForm} onChange={set('taxForm')}>{options(TAX_FORMS)}</Select>
          </Field>
          {form.relation === 'INVESTOR' && (
            <Field label="Accredited investor" hint="Under Regulation D.">
              <Select value={form.accreditedInvestor} onChange={set('accreditedInvestor')}>{options(ACCREDITED)}</Select>
            </Field>
          )}
        </FormGrid>
      </Section>

      {!individual && (
        <Section title="Entity details">
          <FormGrid>
            <Field label="Jurisdiction" hint="Where the entity is formed, e.g. Delaware or Cayman Islands.">
              <Input value={form.jurisdiction} onChange={set('jurisdiction')} />
            </Field>
            <Field label="Signatory name" hint="Who signs for the entity."><Input value={form.signatoryName} onChange={set('signatoryName')} /></Field>
            <Field label="Signatory title"><Input value={form.signatoryTitle} onChange={set('signatoryTitle')} placeholder="Managing Partner" /></Field>
            <Field label="Signatory email"><Input type="email" value={form.signatoryEmail} onChange={set('signatoryEmail')} /></Field>
          </FormGrid>
        </Section>
      )}

      <Section title="Notes & tags">
        <Field label="Tags" hint="Comma-separated labels, e.g. seed-round, board-observer.">
          <Input value={form.tags} onChange={set('tags')} />
        </Field>
        <Field label="Notes"><Textarea value={form.notes} onChange={set('notes')} rows={3} /></Field>
      </Section>
    </div>
  );
}
