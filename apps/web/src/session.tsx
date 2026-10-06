import React, { createContext, useContext, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api.ts';
import { config } from './config.ts';

export interface User {
  id: string; email: string; name: string; avatarColor: string | null;
  avatarUrl: string | null; authProvider: 'PASSWORD' | 'GOOGLE';
  /** True after an administrator set a temporary password — the app asks for a new one first. */
  mustChangePassword?: boolean;
  /** Whether the explanation at the top of each page starts open for this person. */
  explanationsOpen?: boolean;
  /**
   * True when a Google account is linked. An invited account claimed through
   * Google has a password nobody chose, so a password account may not have one
   * its owner knows.
   */
  googleLinked?: boolean;
}
export interface AuthConfig { googleClientId: string | null; googleAllowedDomains: string[]; passwordSignIn: boolean; mailConfigured?: boolean }
export interface CompanyRef {
  id: string; name: string; legalName: string | null; role: Role;
  stakeholderId: string | null; brandColor: string | null; jurisdiction: string | null;
  entityType: string | null; incorporationDate: string | null; ein: string | null;
  website: string | null; address: string | null; totalAssetsCents: number | null;
  fiscalYearEnd: string | null;
  isSample?: number | boolean;
}
export type Role = 'ADMIN' | 'LEGAL' | 'BOARD' | 'EMPLOYEE' | 'INVESTOR' | 'VIEWER';

interface SessionValue {
  user: User | null;
  companies: CompanyRef[];
  company: CompanyRef | null;
  companyId: string | null;
  role: Role;
  loading: boolean;
  /** True for roles that may change cap table data. */
  canEdit: boolean;
  /** True for roles that may see the whole company rather than only their own holdings. */
  canViewAll: boolean;
  isAdmin: boolean;
  /** The selected company is the read-only sample. */
  isSample: boolean;
  selectCompany: (id: string) => void;
  refresh: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  /** Resolves signed in, or with `verifyEmail` when a link to open was sent to the address first. */
  signUp: (name: string, email: string, password: string) => Promise<{ verifyEmail: boolean }>;
  /** Completes a Google Identity Services sign-in with the credential it returned. */
  signInWithGoogle: (credential: string, nonce: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}

const LAST_COMPANY = 'kosmitor_company';

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [companies, setCompanies] = useState<CompanyRef[]>([]);
  const [companyId, setCompanyId] = useState<string | null>(localStorage.getItem(LAST_COMPANY));
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const me = await api<{ user: User; companies: CompanyRef[] }>('/auth/me');
      setUser(me.user);
      setCompanies(me.companies);
      setCompanyId((current) => {
        // The demo account everyone shares always opens onto the sample company, whatever
        // else it may hold or was last open in this browser.
        const demo = config.demo.enabled && me.user.email.trim().toLowerCase() === config.demo.email.trim().toLowerCase();
        const sample = demo ? me.companies.find((c) => !!c.isSample) : undefined;
        if (sample) return sample.id;
        if (current && me.companies.some((c) => c.id === current)) return current;
        return me.companies[0]?.id ?? null;
      });
    } catch {
      setUser(null);
      setCompanies([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (companyId) localStorage.setItem(LAST_COMPANY, companyId);
  }, [companyId]);

  const signIn = useCallback(async (email: string, password: string) => {
    await api<{ user: User }>('/auth/login', { body: { email, password } });
    await refresh();
  }, [refresh]);

  const signUp = useCallback(async (name: string, email: string, password: string) => {
    const res = await api<{ user?: User; verifyEmail?: boolean }>('/auth/register', { body: { name, email, password } });
    if (res.verifyEmail) return { verifyEmail: true };
    await refresh();
    return { verifyEmail: false };
  }, [refresh]);

  const signInWithGoogle = useCallback(async (credential: string, nonce: string) => {
    await api<{ user: User }>('/auth/google', { body: { credential, nonce } });
    await refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    try { await api('/auth/logout', { body: {} }); } catch { /* the local session is cleared regardless */ }
    localStorage.removeItem(LAST_COMPANY);
    setUser(null);
    setCompanies([]);
    setCompanyId(null);
  }, []);

  const value = useMemo<SessionValue>(() => {
    const company = companies.find((c) => c.id === companyId) ?? null;
    const role = (company?.role ?? 'VIEWER') as Role;
    const isSample = Number(company?.isSample ?? 0) === 1;
    return {
      user, companies, company, companyId: company?.id ?? null, role, loading, isSample,
      canEdit: role === 'ADMIN' || role === 'LEGAL',
      canViewAll: ['ADMIN', 'LEGAL', 'BOARD', 'VIEWER'].includes(role),
      isAdmin: role === 'ADMIN',
      selectCompany: setCompanyId,
      refresh, signIn, signUp, signInWithGoogle, signOut,
    };
  }, [user, companies, companyId, loading, refresh, signIn, signUp, signInWithGoogle, signOut]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
