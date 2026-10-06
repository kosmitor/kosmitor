import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useSession, type AuthConfig } from '../session.tsx';
import { api, useQuery } from '../api.ts';
import { Button, Input, Field, ErrorNote, Loading } from '../ui.tsx';
import { Logo } from '../icons.tsx';
import { passwordProblem } from '../account.tsx';
import { config, PRODUCT } from '../config.ts';
import { GoogleSignIn } from './SignIn.tsx';

/** What GET /auth/reset/:token says about a link. An invitation also names its company and who sent it. */
interface LinkCheck {
  valid: boolean; email?: string; name?: string; purpose?: 'RESET' | 'INVITE';
  company?: string | null; companyId?: string | null; invitedBy?: string | null;
}
type Ready = { status: 'ready'; email: string; name: string; invite: boolean; company: string | null; companyId: string | null; invitedBy: string | null };

/** Whether Google sign-in would let this address in: any domain, or one of auth.google.allowedDomains. */
const googleTakes = (email: string, domains: string[]): boolean =>
  !domains.length || domains.includes(email.toLowerCase().split('@')[1] ?? '');

/**
 * Lands from the link in a reset email (or one an administrator passed on), and
 * from an invitation, where someone new chooses their first password. An
 * invitation names the company and, when Google sign-in is on, offers it as the
 * address invited instead.
 */
export default function ResetPassword() {
  const { refresh, selectCompany } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<{ status: 'checking' } | { status: 'invalid' } | Ready>({ status: 'checking' });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: auth } = useQuery<AuthConfig>('/auth/config');

  useEffect(() => {
    if (!token) { setState({ status: 'invalid' }); return; }
    let cancelled = false;
    api<LinkCheck>(`/auth/reset/${encodeURIComponent(token)}`)
      .then((r) => {
        if (cancelled) return;
        setState(r.valid
          ? { status: 'ready', email: r.email!, name: r.name!, invite: r.purpose === 'INVITE', company: r.company ?? null, companyId: r.companyId ?? null, invitedBy: r.invitedBy ?? null }
          : { status: 'invalid' });
      })
      .catch(() => { if (!cancelled) setState({ status: 'invalid' }); });
    return () => { cancelled = true; };
  }, [token]);

  // Someone who accepted an invitation lands in the company that invited them.
  const companyId = state.status === 'ready' ? state.companyId : null;
  const enter = useCallback(() => {
    if (companyId) selectCompany(companyId);
    navigate('/', { replace: true });
  }, [companyId, selectCompany, navigate]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = passwordProblem(password, confirm);
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      await api('/auth/reset', { body: { token, password } });
      await refresh();
      enter();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  const google = state.status === 'ready' && state.invite && !!auth?.googleClientId && googleTakes(state.email, auth.googleAllowedDomains);
  const passwords = config.auth.passwordSignIn;

  return (
    <div className="grid min-h-screen place-items-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2.5">
          <Logo className="size-9 text-brand-600" />
          <span className="text-lg font-semibold tracking-tight">{PRODUCT}</span>
        </div>

        {state.status === 'checking' && <Loading label="Checking your link" />}

        {state.status === 'invalid' && (
          <>
            <h1 className="text-2xl font-semibold tracking-tight text-ink-900">This link has expired</h1>
            <p className="mt-1.5 text-sm text-ink-500">
              Links to choose a password work once and for a limited time. Ask for a new one and use it straight away.
              If you were invited, the person who invited you can also send the invitation again.
            </p>
            <div className="mt-7 flex flex-col gap-2">
              {passwords && <Link to="/?forgot=1"><Button variant="primary" size="lg" className="w-full">Request a new link</Button></Link>}
              <Link to="/"><Button size="lg" className="w-full">Back to sign in</Button></Link>
            </div>
          </>
        )}

        {state.status === 'ready' && (
          <>
            <h1 className="text-2xl font-semibold tracking-tight text-ink-900">
              {state.invite ? (state.company ? `Join ${state.company} on ${PRODUCT}` : `Join ${PRODUCT}`) : 'Choose a new password'}
            </h1>
            <p className="mt-1.5 text-sm text-ink-500">
              {state.invite ? (
                <>
                  {state.invitedBy && <>{state.invitedBy} invited you. </>}
                  {(passwords || google) && <>{passwords ? 'Choose a password' : 'Sign in with Google'} for <span className="font-medium text-ink-700">{state.email}</span> to sign in.</>}
                </>
              ) : (
                <>For <span className="font-medium text-ink-700">{state.email}</span>. You will be signed in here and out everywhere else.</>
              )}
            </p>
            {error && <div className="mt-6"><ErrorNote error={error} /></div>}
            {passwords && (
              <form onSubmit={submit} className="mt-7 space-y-4">
                <Field label={state.invite ? 'Password' : 'New password'} required hint={`At least ${config.auth.passwordMinLength} characters.`}>
                  <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required
                    minLength={config.auth.passwordMinLength} maxLength={config.auth.passwordMaxLength} autoFocus />
                </Field>
                <Field label={state.invite ? 'Repeat password' : 'Repeat new password'} required>
                  <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
                </Field>
                <Button type="submit" variant="primary" size="lg" loading={busy} className="w-full">
                  {state.invite ? 'Set password and join' : 'Set password and sign in'}
                </Button>
              </form>
            )}
            {google && auth && (
              <div className="mt-6">
                {passwords && (
                  <div className="mb-6 flex items-center gap-3 text-[12px] uppercase tracking-wide text-ink-400">
                    <span className="h-px flex-1 bg-ink-200" />or<span className="h-px flex-1 bg-ink-200" />
                  </div>
                )}
                <p className="mb-3 text-center text-[13px] text-ink-600">
                  Sign in with Google as <span className="font-medium text-ink-800">{state.email}</span>. Another Google account will not find the invitation.
                </p>
                <GoogleSignIn config={auth} onError={setError} onSignedIn={enter} loginHint={state.email} />
              </div>
            )}
            {!state.invite && !passwords && (
              <div className="mt-7 space-y-4">
                <p className="text-sm text-ink-600">Signing in with a password is turned off on this server, so this link cannot set one.</p>
                <Link to="/"><Button size="lg" className="w-full">Back to sign in</Button></Link>
              </div>
            )}
            {state.invite && !passwords && auth && !google && (
              <p className="mt-7 text-sm text-ink-600">
                {auth.googleClientId
                  ? <>Signing in with a password is turned off on this server, and its Google sign-in only accepts {auth.googleAllowedDomains.map((d) => `@${d}`).join(' or ')} accounts, so {state.email} cannot sign in here. Ask {state.invitedBy ?? 'whoever invited you'} to invite an address it accepts.</>
                  : 'Signing in with a password is turned off on this server, and Google sign-in is not set up yet. Ask whoever runs it to turn one of them on.'}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
