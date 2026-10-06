import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useSession } from '../session.tsx';
import { api } from '../api.ts';
import { Button, Loading } from '../ui.tsx';
import { Logo } from '../icons.tsx';
import { PRODUCT } from '../config.ts';

/** Lands from the link in the welcome email: opening it confirms the address and signs the person in. */
export default function VerifyEmail() {
  const { refresh } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [error, setError] = useState<string | null>(token ? null : 'This link is missing its token.');

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api('/auth/verify', { body: { token } })
      .then(async () => { await refresh(); if (!cancelled) navigate('/', { replace: true }); })
      .catch((err: Error) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [token, refresh, navigate]);

  return (
    <div className="grid min-h-screen place-items-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2.5">
          <Logo className="size-9 text-brand-600" />
          <span className="text-lg font-semibold tracking-tight">{PRODUCT}</span>
        </div>
        {error ? (
          <>
            <h1 className="text-2xl font-semibold tracking-tight text-ink-900">This link has expired</h1>
            <p className="mt-1.5 text-sm text-ink-500">{error} Sign in with your password and a new link is sent to you.</p>
            <Link to="/"><Button variant="primary" size="lg" className="mt-7 w-full">Back to sign in</Button></Link>
          </>
        ) : <Loading label="Confirming your email" />}
      </div>
    </div>
  );
}
