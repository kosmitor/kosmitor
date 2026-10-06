/**
 * The signed-in person's own preferences.
 *
 * Everything here belongs to the person, not to a company, so it follows them
 * into every company they are a member of. Company settings live on the Company
 * page. Each control does something real; a preference the app would ignore is
 * not offered.
 */
import { useEffect, useRef, useState } from 'react';
import { useSession } from '../session.tsx';
import { api, ApiError } from '../api.ts';
import { ChangePasswordModal } from '../account.tsx';
import { forgetPageChoices, pageChoiceCount } from '../ConceptNote.tsx';
import { AssistantPreferences } from '../assistant/AssistantSettings.tsx';
import {
  PageHeader, Card, CardHeader, Field, Input, Button, Avatar, SegmentedControl, useToast, cx,
} from '../ui.tsx';
import { Icon } from '../icons.tsx';
import { config, PRODUCT } from '../config.ts';

/**
 * The colours a new account is given, with names a screen reader can say:
 * brand.colors.avatarChoices. Lower case, the way the server stores a colour, so
 * the saved one is recognised among them.
 */
const COLOURS: { hex: string; name: string }[] = config.brand.colors.avatarChoices.map((c) => ({ hex: c.value.toLowerCase(), name: c.label }));

/** The way the server stores a name, so the page knows when nothing has really changed. */
const tidy = (s: string) => s.trim().replace(/\s+/g, ' ');

/** The server's rules for a name, checked here too so the problem shows at the field before saving. */
function nameProblem(value: string): string | null {
  const name = tidy(value);
  if (!name) return 'Enter your name.';
  if (/[\p{Cc}\p{Cf}]/u.test(name)) return 'Your name contains a character that cannot be shown.';
  if (/[<>"]/.test(name)) return 'Your name cannot contain <, > or ".';
  if (!/[\p{L}\p{N}]/u.test(name)) return 'Your name needs at least one letter or number.';
  return null;
}

export default function Preferences() {
  const { user, refresh, canViewAll } = useSession();
  const toast = useToast();

  const [name, setName] = useState(user?.name ?? '');
  // Null means no colour was ever chosen, and the app draws one from the name.
  // It stays null until a swatch is picked, so saving a name never assigns one.
  const [colour, setColour] = useState<string | null>(user?.avatarColor ?? null);
  const [savingProfile, setSavingProfile] = useState(false);
  // A refusal the server gave for the name, shown at the field until the name is edited.
  const [refusedName, setRefusedName] = useState<string | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);
  const [explanations, setExplanations] = useState<'open' | 'closed'>(user?.explanationsOpen ? 'open' : 'closed');
  const [savingExplanations, setSavingExplanations] = useState(false);
  const [choices, setChoices] = useState(() => pageChoiceCount(user?.id));
  const choiceStatus = useRef<HTMLParagraphElement>(null);
  const swatchRow = useRef<HTMLDivElement>(null);

  // The form follows the person when they change underneath it, for instance after a save.
  useEffect(() => { setName(user?.name ?? ''); setColour(user?.avatarColor ?? null); }, [user?.name, user?.avatarColor]);
  useEffect(() => { setExplanations(user?.explanationsOpen ? 'open' : 'closed'); }, [user?.explanationsOpen]);

  if (!user) return null;

  const nameError = nameProblem(name) ?? refusedName;
  const nameChanged = tidy(name) !== user.name;
  const colourChanged = colour != null && colour !== user.avatarColor;
  const canSave = (nameChanged || colourChanged) && !nameError && !savingProfile;

  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    const body: Record<string, unknown> = {};
    if (nameChanged) body.name = tidy(name);
    if (colourChanged) body.avatarColor = colour;
    setSavingProfile(true);
    try {
      await api('/auth/me', { method: 'PATCH', body });
      await refresh();
      toast('Profile saved');
    } catch (err) {
      // A name the server refused is explained where it was typed.
      if (body.name && err instanceof ApiError && err.status === 400 && /^Name\b/.test(err.message)) setRefusedName(err.message);
      else toast((err as Error).message, 'error');
    } finally {
      setSavingProfile(false);
    }
  };

  // Changed on the spot, and put back if the server refuses, so the control never
  // lags behind the click or shows a choice that did not save.
  const chooseExplanations = async (v: 'open' | 'closed') => {
    if (v === explanations || savingExplanations) return;
    const before = explanations;
    setExplanations(v);
    setSavingExplanations(true);
    try {
      await api('/auth/me', { method: 'PATCH', body: { explanationsOpen: v === 'open' } });
      await refresh();
      toast(v === 'open' ? 'Explanations will start open' : 'Explanations will start closed');
    } catch (err) {
      setExplanations(before);
      toast((err as Error).message, 'error');
    } finally {
      setSavingExplanations(false);
    }
  };

  const forgetChoices = () => {
    forgetPageChoices(user.id);
    setChoices(0);
    // The button that had focus is gone, so focus goes to the line that replaced it.
    requestAnimationFrame(() => choiceStatus.current?.focus());
  };

  // The saved colour stays in the row even when it is not one of the choices, so it can be picked again.
  const saved = user.avatarColor;
  const swatches = saved && !COLOURS.some((c) => c.hex === saved) ? [{ hex: saved, name: 'Your current colour' }, ...COLOURS] : COLOURS;
  const checkedIndex = swatches.findIndex((c) => c.hex === colour);

  /** A radio group moves with the arrow keys and is one stop for Tab. */
  const onSwatchKey = (e: React.KeyboardEvent, index: number) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? swatches.length - 1 : step ? (index + step + swatches.length) % swatches.length : -1;
    if (to < 0) return;
    e.preventDefault();
    setColour(swatches[to].hex);
    swatchRow.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[to]?.focus();
  };

  const googleOnly = user.authProvider === 'GOOGLE';

  return (
    <>
      <PageHeader title="Preferences" subtitle="These are yours, and follow you into every company you belong to." />

      <div className="grid max-w-3xl gap-5">
        <Card>
          <CardHeader title="Profile" subtitle={`How you appear to the people you work with in ${PRODUCT}`} />
          <form onSubmit={(e) => void saveProfile(e)} className="flex items-start gap-5">
            <Avatar name={tidy(name) || user.name} size={56} color={colour ?? undefined} src={user.avatarUrl} />
            <div className="min-w-0 flex-1 space-y-4">
              <Field label="Name" required error={nameError}>
                <Input value={name} onChange={(e) => { setName(e.target.value); setRefusedName(null); }} maxLength={120} required
                  aria-invalid={nameError ? true : undefined} />
              </Field>
              <div>
                <p id="colour-label" className="mb-1.5 text-[13px] font-medium text-ink-800">Colour</p>
                <div ref={swatchRow} role="radiogroup" aria-labelledby="colour-label" className="flex flex-wrap gap-2">
                  {swatches.map((c, i) => {
                    const checked = c.hex === colour;
                    // One tab stop for the group: the chosen swatch, or the first when none is chosen.
                    const tabbable = checked || (checkedIndex < 0 && i === 0);
                    return (
                      <button key={c.hex} type="button" role="radio" aria-checked={checked} aria-label={c.name} title={c.name}
                        tabIndex={tabbable ? 0 : -1} onClick={() => setColour(c.hex)} onKeyDown={(e) => onSwatchKey(e, i)}
                        className={cx('grid size-8 place-items-center rounded-full text-white transition-shadow',
                          'focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-500',
                          checked ? 'ring-2 ring-ink-900 ring-offset-2' : 'ring-1 ring-ink-200 hover:ring-ink-400')}
                        style={{ background: c.hex }}>
                        {/* A tick as well as the ring, so the choice does not rest on colour and outline alone. */}
                        {checked && <Icon name="check" className="size-4" />}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-1.5 text-[12px] text-ink-500">
                  {user.avatarUrl
                    ? 'Your Google photo is shown where it can be. The colour is used where it cannot.'
                    : colour == null ? 'None chosen yet, so one is drawn from your name. Pick one to keep it.' : 'Shown behind your initials.'}
                </p>
              </div>
              <div className="flex justify-end">
                {/* aria-disabled rather than disabled: a disabled button drops the focus it
                    had, and a keyboard user saving would be sent back to the top of the page. */}
                <Button type="submit" variant="primary" aria-disabled={!canSave}
                  className={cx(!canSave && 'cursor-not-allowed opacity-60')}>
                  {savingProfile ? 'Saving' : 'Save profile'}
                </Button>
              </div>
            </div>
          </form>
        </Card>

        <Card>
          <CardHeader title="Signing in" />
          <dl className="grid gap-4 text-[13px] sm:grid-cols-2">
            <div>
              <dt className="text-ink-500">Email</dt>
              <dd className="mt-0.5 font-medium text-ink-900">{user.email}</dd>
              <dd className="mt-0.5 text-[12px] text-ink-500">You sign in with this address. It cannot be changed here.</dd>
            </div>
            <div>
              <dt className="text-ink-500">Password</dt>
              {!config.auth.passwordSignIn ? (
                <dd className="mt-0.5 text-ink-700">This server signs everyone in with Google, so there is no {PRODUCT} password to change.</dd>
              ) : googleOnly ? (
                <dd className="mt-0.5 text-ink-700">You sign in with Google, so there is no {PRODUCT} password to change.</dd>
              ) : (
                <>
                  <dd className="mt-1"><Button size="sm" onClick={() => setChangingPassword(true)}>Change password</Button></dd>
                  {user.googleLinked && (
                    // An invited account claimed through Google keeps a password nobody chose.
                    <dd className="mt-1.5 text-[12px] text-ink-500">
                      You can also sign in with Google. If you never set a password, use Forgot password on the sign-in page to create one.
                    </dd>
                  )}
                </>
              )}
            </div>
          </dl>
        </Card>

        <Card>
          <CardHeader title="Page explanations"
            subtitle="The panel at the top of each page that says what the page is for and why it matters" />
          <div role="group" aria-label="How page explanations start">
            <SegmentedControl<'closed' | 'open'> value={explanations} onChange={(v) => void chooseExplanations(v)} options={[
              { value: 'closed', label: 'Start closed' },
              { value: 'open', label: 'Start open' },
            ]} />
          </div>
          <p className="mt-3 text-[12px] text-ink-500">
            Closed shows the one-line summary. A page you open or close yourself keeps your choice in this browser.
          </p>
          <p ref={choiceStatus} tabIndex={-1}
            className="mt-2 rounded text-[12px] text-ink-600 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500">
            {choices === 0 ? 'Every page follows this preference.'
              : choices === 1 ? 'One page has a choice of its own.' : `${choices} pages have a choice of their own.`}
            {choices > 0 && (
              <button type="button" className="ml-1 font-medium text-brand-600 hover:text-brand-700" onClick={forgetChoices}>
                Forget them
              </button>
            )}
          </p>
        </Card>

        {config.ai.enabled && <AssistantPreferences canAsk={canViewAll} />}
      </div>

      <ChangePasswordModal open={changingPassword} onClose={() => setChangingPassword(false)} />
    </>
  );
}
