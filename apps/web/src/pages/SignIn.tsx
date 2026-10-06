import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSession, type AuthConfig } from '../session.tsx';
import { api, useQuery } from '../api.ts';
import { Button, Input, Field, Card, ErrorNote, Spinner } from '../ui.tsx';
import { Icon, Logo } from '../icons.tsx';
import { duration } from '../format.ts';
import { config, PRODUCT } from '../config.ts';

const GIS_SRC = 'https://accounts.google.com/gsi/client';

/** Loads Google Identity Services once and resolves when `window.google` is ready. */
function loadGoogleIdentity(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    const script = existing ?? document.createElement('script');
    const done = () => (window.google?.accounts?.id ? resolve() : reject(new Error('Google sign-in did not initialise.')));
    script.addEventListener('load', done, { once: true });
    script.addEventListener('error', () => reject(new Error('Could not load Google sign-in.')), { once: true });
    if (!existing) {
      script.src = GIS_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    } else if (window.google?.accounts?.id) {
      resolve();
    }
  });
}

/**
 * Renders Google's own button. Each render fetches a fresh single-use nonce
 * from the API, hands it to Google so it is embedded in the ID token, and
 * posts the credential back with the same nonce for the server to check.
 * `loginHint` suggests the account to Google, as the page for an invitation
 * does with the address invited; `onSignedIn` runs once the session is set.
 */
export function GoogleSignIn({ config, onError, onSignedIn, loginHint }: {
  config: AuthConfig; onError: (message: string | null) => void; onSignedIn?: () => void; loginHint?: string;
}) {
  const { signInWithGoogle } = useSession();
  const host = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState(false);
  // Held in a ref, so a caller passing an inline arrow does not make a new button each render.
  const signedIn = useRef(onSignedIn);
  useEffect(() => { signedIn.current = onSignedIn; });

  useEffect(() => {
    if (!config.googleClientId || !host.current) return;
    let cancelled = false;
    setReady(false);
    (async () => {
      const { nonce } = await api<{ nonce: string }>('/auth/google/start', { body: {} });
      await loadGoogleIdentity();
      if (cancelled || !host.current) return;
      window.google!.accounts.id.initialize({
        client_id: config.googleClientId,
        nonce,
        ux_mode: 'popup',
        auto_select: false,
        itp_support: true,
        ...(loginHint ? { login_hint: loginHint } : {}),
        callback: async (response: GoogleCredentialResponse) => {
          onError(null);
          try {
            await signInWithGoogle(response.credential, nonce);
            signedIn.current?.();
          } catch (err) {
            onError((err as Error).message);
            // The nonce is single-use, so a failed attempt needs a fresh button.
            setAttempt((n) => n + 1);
          }
        },
      });
      host.current.innerHTML = '';
      // As wide as the column, up to 384px, so it fits a phone without scrolling sideways.
      const width = Math.max(200, Math.min(384, Math.floor(host.current.clientWidth || 384)));
      window.google!.accounts.id.renderButton(host.current, {
        theme: 'outline', size: 'large', width, text: 'continue_with',
        shape: 'rectangular', logo_alignment: 'left',
      });
      setReady(true);
    })().catch((err: Error) => { if (!cancelled) onError(err.message); });
    return () => { cancelled = true; };
  }, [config.googleClientId, attempt, signInWithGoogle, onError, loginHint]);

  return (
    <div>
      <div ref={host} className="flex min-h-11 justify-center" />
      {!ready && <div className="flex h-11 items-center justify-center text-ink-400"><Spinner className="size-4" /></div>}
      {config.googleAllowedDomains.length > 0 && (
        <p className="mt-2 text-center text-[12px] text-ink-500">
          Use your {config.googleAllowedDomains.map((d) => `@${d}`).join(' or ')} Google account.
        </p>
      )}
    </div>
  );
}

interface ForgotResponse { ok: boolean; mailConfigured: boolean; resetUrl?: string; expiresAt?: string }

/** "Forgot password": asks for the address and reports the same thing whether or not it has an account. */
function ForgotPassword({ initialEmail, onBack }: { initialEmail: string; onBack: () => void }) {
  const [email, setEmail] = useState(initialEmail);
  const [sent, setSent] = useState<ForgotResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      setSent(await api<ForgotResponse>('/auth/forgot', { body: { email } }));
    } catch (err) { setError((err as Error).message); } finally { setLoading(false); }
  };

  if (sent) {
    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Check your email</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-ink-500">
          If <span className="font-medium text-ink-700">{email}</span> has an account, a link to choose a new password is on its way.
          It works once and expires in {duration(config.auth.resetLinkMinutes)}. Nothing changes until you use it.
        </p>
        {sent.resetUrl && (
          <Card className="mt-6 border-amber-200 bg-amber-50/60" padded>
            <p className="text-[12px] font-medium text-amber-900">Email is not set up on this server</p>
            <p className="mt-1 text-[12px] leading-relaxed text-amber-800">
              The link is shown here instead (this only happens outside production). Set <span className="font-mono">SMTP_URL</span> in{' '}
              <span className="font-mono">apps/server/.env</span> to send real email.
            </p>
            <a href={sent.resetUrl} className="mt-2 block break-all font-mono text-[12px] text-brand-700 hover:text-brand-800">{sent.resetUrl}</a>
          </Card>
        )}
        <p className="mt-6 text-center text-[13px] text-ink-500">
          <button onClick={onBack} className="font-medium text-brand-600 hover:text-brand-700">Back to sign in</button>
        </p>
      </>
    );
  }

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Reset your password</h1>
      <p className="mt-1.5 text-sm text-ink-500">Enter your work email and we will send you a link to choose a new one.</p>
      {error && <div className="mt-6"><ErrorNote error={error} /></div>}
      <form onSubmit={submit} className="mt-7 space-y-4">
        <Field label="Work email" required>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="email" required autoFocus />
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={loading} className="w-full">Send reset link</Button>
      </form>
      <p className="mt-6 text-center text-[13px] text-ink-500">
        Remembered it? <button onClick={onBack} className="font-medium text-brand-600 hover:text-brand-700">Sign in</button>
      </p>
    </>
  );
}

/**
 * Signing in and creating an account. Which ways in are offered follows
 * kosmitor.config.json: auth.passwordSignIn for the email and password form,
 * auth.selfSignup for creating an account here, and demo for the card that hands
 * out a demo login and fills the form with it. Google appears once the server
 * has a client id.
 */
export default function SignIn() {
  const { signIn, signUp } = useSession();
  const { data: auth } = useQuery<AuthConfig>('/auth/config');
  const { passwordSignIn, selfSignup } = config.auth;
  const demo = config.demo.enabled ? config.demo : null;
  const [params, setParams] = useSearchParams();
  const [mode, setMode] = useState<'in' | 'up' | 'forgot' | 'check'>(passwordSignIn && params.get('forgot') ? 'forgot' : 'in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState(demo?.email ?? '');
  const [password, setPassword] = useState(demo?.password ?? '');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      if (mode === 'in') await signIn(email, password);
      else if ((await signUp(name, email, password)).verifyEmail) setMode('check');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const googleConfigured = !!auth?.googleClientId;
  const { signIn: words } = config.brand;
  const backToSignIn = () => { setMode('in'); setError(null); if (params.get('forgot')) setParams({}, { replace: true }); };

  // Signing up sent a link to the address; the account opens from it.
  if (mode === 'check') {
    return (
      <div className="grid min-h-screen lg:grid-cols-2">
        <div className="flex items-center justify-center px-6 py-12">
          <div className="w-full max-w-sm">
            <div className="mb-8 flex items-center gap-2.5">
              <Logo className="size-9 text-brand-600" />
              <span className="text-lg font-semibold tracking-tight">{PRODUCT}</span>
            </div>
            <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Check your email</h1>
            <p className="mt-1.5 text-sm text-ink-500">
              We sent a link to <span className="font-medium text-ink-700">{email}</span>. Open it to confirm the address and sign in.
              It works once and expires in 24 hours. Signing in with your password sends a new one.
            </p>
            <Button size="lg" className="mt-7 w-full" onClick={backToSignIn}>Back to sign in</Button>
          </div>
        </div>
        <Showcase />
      </div>
    );
  }

  if (mode === 'forgot') {
    return (
      <div className="grid min-h-screen lg:grid-cols-2">
        <div className="flex items-center justify-center px-6 py-12">
          <div className="w-full max-w-sm">
            <div className="mb-8 flex items-center gap-2.5">
              <Logo className="size-9 text-brand-600" />
              <span className="text-lg font-semibold tracking-tight">{PRODUCT}</span>
            </div>
            <ForgotPassword initialEmail={email} onBack={backToSignIn} />
          </div>
        </div>
        <Showcase />
      </div>
    );
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5">
            <Logo className="size-9 text-brand-600" />
            <span className="text-lg font-semibold tracking-tight">{PRODUCT}</span>
          </div>

          <h1 className="text-2xl font-semibold tracking-tight text-ink-900">
            {mode === 'in' ? words.signInTitle : words.signUpTitle}
          </h1>
          <p className="mt-1.5 text-sm text-ink-500">
            {mode === 'in' ? words.signInSubtitle : words.signUpSubtitle}
          </p>

          {error && <div className="mt-6"><ErrorNote error={error} /></div>}

          {googleConfigured && auth && (
            <div className="mt-7">
              <GoogleSignIn config={auth} onError={setError} />
              {passwordSignIn && (
                <div className="my-6 flex items-center gap-3 text-[12px] uppercase tracking-wide text-ink-400">
                  <span className="h-px flex-1 bg-ink-200" />or with email<span className="h-px flex-1 bg-ink-200" />
                </div>
              )}
            </div>
          )}

          {/* With passwords turned off there is only Google, and without it no way in at all, which is said rather than left blank. */}
          {!passwordSignIn && auth && !googleConfigured && (
            <p className="mt-7 text-sm text-ink-600">
              Signing in with a password is turned off on this server, and Google sign-in is not set up yet.
            </p>
          )}

          {passwordSignIn && (
            <>
              <form onSubmit={submit} className={googleConfigured ? 'space-y-4' : 'mt-7 space-y-4'}>
                {mode === 'up' && (
                  <Field label="Your name" required>
                    <Input value={name} onChange={(e) => setName(e.target.value)}
                      placeholder="Jordan Ellis" autoComplete="name" required />
                  </Field>
                )}
                <Field label="Work email" required>
                  <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@company.com" autoComplete="email" required />
                </Field>
                <Field label="Password" required
                  hint={mode === 'up' ? `At least ${config.auth.passwordMinLength} characters.` : undefined}>
                  <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                    autoComplete={mode === 'in' ? 'current-password' : 'new-password'} required />
                </Field>
                {mode === 'in' && (
                  <p className="-mt-2 text-right text-[12px]">
                    <button type="button" onClick={() => { setMode('forgot'); setError(null); }}
                      className="font-medium text-brand-600 hover:text-brand-700">Forgot your password?</button>
                  </p>
                )}
                <Button type="submit" variant="primary" size="lg" loading={loading} className="w-full">
                  {mode === 'in' ? 'Sign in' : 'Create workspace'}
                </Button>
              </form>

              {/* Without self sign-up an account comes from an invitation, so there is nothing to create here. */}
              {selfSignup && (
                <p className="mt-6 text-center text-[13px] text-ink-500">
                  {mode === 'in' ? 'Need an account?' : 'Already have one?'}{' '}
                  <button onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setError(null); }}
                    className="font-medium text-brand-600 hover:text-brand-700">
                    {mode === 'in' ? 'Create one' : 'Sign in'}
                  </button>
                </p>
              )}

              {mode === 'in' && demo && (
                <Card className="mt-6 bg-ink-50/70" padded>
                  <p className="text-[12px] font-medium text-ink-700">Demo workspace</p>
                  <p className="mt-1 text-[12px] leading-relaxed text-ink-500">
                    Sign in with <span className="font-mono text-ink-700">{demo.email}</span> and{' '}
                    <span className="font-mono text-ink-700">{demo.password}</span> {demo.description}
                  </p>
                </Card>
              )}
            </>
          )}

          {import.meta.env.DEV && auth && !googleConfigured && (
            <p className="mt-4 text-center text-[11px] text-ink-400">
              Google sign-in is off — set <span className="font-mono">GOOGLE_CLIENT_ID</span> in{' '}
              <span className="font-mono">apps/server/.env</span> to enable it.
            </p>
          )}
        </div>
      </div>

      <Showcase />
    </div>
  );
}

/** The right-hand panel of the sign-in screens, in the words and colours of brand in kosmitor.config.json. */
function Showcase() {
  const { signIn: words, colors } = config.brand;
  return (
      <div className="relative hidden overflow-hidden bg-ink-900 lg:block">
        <div className="absolute inset-0 opacity-30"
          style={{ backgroundImage: `radial-gradient(circle at 25% 20%, ${colors.primary[500]} 0, transparent 45%), radial-gradient(circle at 75% 70%, ${colors.accent[500]} 0, transparent 45%)` }} />
        <div className="relative flex h-full flex-col justify-center px-14 text-white">
          <h2 className="text-3xl font-semibold leading-tight tracking-tight">
            {words.headline}
          </h2>
          <p className="mt-4 max-w-md text-[15px] leading-relaxed text-white/70">
            {words.subheadline}
          </p>
          {/* Each line leads with what it is, so the two a founder is most often
              told to worry about, the 409A valuation and the compliance filings,
              are read first rather than found at the end of a sentence. */}
          <ul className="mt-9 space-y-3.5 text-[14px] text-white/85">
            {words.features.map(({ title: lead, detail: rest }) => (
              <li key={lead} className="flex items-start gap-2.5">
                <span className="mt-0.5 grid size-4.5 shrink-0 place-items-center rounded-full bg-secondary-500/20">
                  <Icon name="check" className="size-3 text-secondary-400" />
                </span>
                <span><span className="font-semibold text-white">{lead}</span>{` — ${rest}`}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
  );
}
