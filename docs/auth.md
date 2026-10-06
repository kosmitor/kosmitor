# Signing in

## Sign in with Google

Password sign-in works out of the box. To offer "Continue with Google":

1. In [Google Cloud console → Credentials](https://console.cloud.google.com/apis/credentials),
   create an **OAuth client ID** of type **Web application**.
2. Add your origins under *Authorized JavaScript origins* — for development both
   `http://localhost` and `http://localhost:5173` (Google insists on the bare
   origin as well), plus your production origin. No redirect URI is needed: the
   browser posts the ID token straight to the API. New origins can take a few
   minutes to become active.
3. Copy `apps/server/.env.example` to `apps/server/.env` and set `GOOGLE_CLIENT_ID`
   (or `auth.google.clientId` in `kosmitor.config.local.json`). Optionally set
   `GOOGLE_ALLOWED_DOMAINS=yourcompany.com` to accept only your workspace's accounts.
4. Restart the API. The button appears on the sign-in page automatically.

`auth.passwordSignIn: false` then leaves Google as the only way in, and
`auth.selfSignup: false` stops strangers creating accounts: only invited people and
existing accounts get in, and Google sign-in no longer creates an account.

The server verifies each ID token itself — RS256 signature against Google's
published keys, issuer, audience, expiry, verified email, and a single-use nonce
issued per attempt — with no extra dependencies. Accounts link by Google-verified
email, so someone an administrator invited can claim their access by signing in
with Google without ever setting a password.

## Passwords and recovery

- **Welcome email** — someone who creates an account themselves, by signing up or by
  a first Google sign-in, is emailed once with the first steps; invited people get
  their invitation instead. `mail.welcomeEmail: false` turns it off, and
  `mail.welcomeEmailsPerHour` (50) caps it across the server, below the mail
  provider's hourly limit so resets and invitations still go out.
- **Invitations** — inviting someone on *Team & access* emails them. A new address,
  or an account nobody has signed in to yet, gets a single-use link that chooses
  their password and signs them in, valid for `auth.inviteLinkDays` (7 by default),
  with Google offered beside it when Google sign-in accepts the address; with
  `auth.passwordSignIn: false` the email says to sign in with Google as the address
  invited, and an address `auth.google.allowedDomains` turns away cannot be invited. Someone who already
  signs in is only told about the new company. The email names who sent it, the
  company and the role, and never carries a password. When it does not go out, the
  administrator gets the link to pass on, for an account that belongs to that
  company alone. Members who have not signed in yet show *Invited* and can be sent
  the invitation again, with a new link that retires the old one; one address gets
  at most `auth.inviteEmailsPerAddressPerDay` (five) invitation emails a day, from
  every company together, deleted ones included. The link stops working once its
  owner signs in by any way, or their address is changed, and a link handed to an
  administrator also stops once the person belongs to another company.
- **Forgot password** — the sign-in page sends a single-use link that expires after
  `auth.resetLinkMinutes` (an hour by default; at most `auth.resetEmailsPerHour`,
  three, per address per hour; the response is the same whether or not the address
  has an account). Using the link sets the password, signs the person in, and
  signs out every other session.
- **Change password** — open the menu on your name at the foot of the sidebar,
  choose *Preferences*, then *Signing in*. Other sessions are signed out; the
  current one stays.
- **Preferences** — the same menu holds *My equity*, *Preferences* and *Sign out*.
  Preferences covers your name and colour, your password, whether the explanation
  at the top of each page starts open, and the assistant's model and API key.
- **Assistant** — the round button at the bottom right of every page opens the
  chat, for roles that see the whole company. It needs a model and your own API
  key, set once in Preferences and used in every company you belong to. Each
  question sends a summary of the cap table to the provider chosen;
  `ai.enabled: false` removes the assistant, and `ai.providers.<id>.enabled: false`
  removes one provider.
- **Administrator reset** — on *Team & access*, the key icon on a member offers
  three options: email them a link, get a link to pass on yourself (single use,
  valid for `auth.adminResetLinkHours`, 24 by default), or set a temporary
  password they must replace at their next sign-in. Every option is written to the audit log. Accounts are global, so a
  link to pass on, a temporary password, and changes to a member's name or
  sign-in email are only offered for someone who belongs to no other company;
  anyone else can only be emailed a link, which goes to them.

Links are emailed through `SMTP_URL` in `apps/server/.env`
(`smtp://user:pass@host:587` uses STARTTLS, `smtps://…:465` implicit TLS), sent
from `MAIL_FROM` (`mail.from`). Every link points at `APP_URL` (`app.url`), never
at whatever address a request came from, so set it to the public address in
production. Without `SMTP_URL` the server prints messages to its log and —
outside production — the sign-in page and the administrator dialog show the link
directly, so the flow works on a laptop.
Only a hash of each reset token is stored.
