import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSession } from '../session.tsx';
import { api } from '../api.ts';
import { Card, Button, Input, Field, Select, ErrorNote, useToast } from '../ui.tsx';
import { Logo } from '../icons.tsx';
import { today, parseShares, fieldNumber } from '../format.ts';
import { config, PRODUCT } from '../config.ts';

/** The form starts from the new-company defaults under company in kosmitor.config.json. */
export default function Onboarding() {
  const { refresh, selectCompany } = useSession();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const toast = useToast();
  const defaults = config.company;
  const [form, setForm] = useState({
    name: '', legalName: '', jurisdiction: defaults.jurisdiction, entityType: defaults.entityType as string,
    incorporationDate: today(), authorizedCommon: fieldNumber(defaults.commonClass.authorized),
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const company = await api('/companies', {
        body: {
          name: form.name, legalName: form.legalName || `${form.name}${defaults.legalNameSuffix}`,
          jurisdiction: form.jurisdiction, entityType: form.entityType,
          incorporationDate: form.incorporationDate,
          authorizedCommon: parseShares(form.authorizedCommon),
        },
      });
      await refresh();
      selectCompany(company.id);
      toast('Company created');
      // Without a company every page opens here first, so a link that led here (the welcome
      // email's first steps, say) carries on to the page it was for.
      navigate(pathname === '/onboarding' ? '/' : `${pathname}${search}`);
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="mx-auto max-w-lg px-4 py-14">
      <div className="mb-7 text-center">
        {/* The only brand on this page, with no name beside it, so it is labelled. */}
        <Logo title={PRODUCT} className="mx-auto mb-4 size-12 text-brand-600" />
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Set up your company</h1>
        <p className="mt-1.5 text-sm text-ink-500">
          We will create a common share class and a set of standard vesting schedules so you can start
          issuing equity right away.
        </p>
      </div>

      <Card>
        <form onSubmit={create} className="space-y-4">
          {error && <ErrorNote error={error} />}
          <Field label="Company name" required>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Northstar Robotics" autoFocus required />
          </Field>
          <Field label="Legal name" hint={defaults.legalNameSuffix ? 'Leave empty to use your company name with a suffix.' : 'Leave empty to use your company name.'}>
            <Input value={form.legalName} onChange={(e) => setForm({ ...form, legalName: e.target.value })}
              placeholder={`Northstar Robotics${defaults.legalNameSuffix}`} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Entity type">
              <Select value={form.entityType} onChange={(e) => setForm({ ...form, entityType: e.target.value })}>
                <option value="C_CORP">C corporation</option>
                <option value="S_CORP">S corporation</option>
                <option value="LLC">Limited liability company</option>
                <option value="LTD">Limited company</option>
              </Select>
            </Field>
            <Field label="Jurisdiction">
              <Input value={form.jurisdiction} onChange={(e) => setForm({ ...form, jurisdiction: e.target.value })} />
            </Field>
            <Field label="Incorporation date">
              <Input type="date" value={form.incorporationDate}
                onChange={(e) => setForm({ ...form, incorporationDate: e.target.value })} />
            </Field>
            <Field label="Authorized common shares">
              <Input value={form.authorizedCommon}
                onChange={(e) => setForm({ ...form, authorizedCommon: e.target.value })} />
            </Field>
          </div>
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
            Create company
          </Button>
        </form>
      </Card>
    </div>
  );
}
