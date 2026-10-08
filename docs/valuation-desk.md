# 409A requests and reports

Requesting a 409A from inside the app is an optional service for an operator who
runs, or works with, a valuation team. It is off until `valuationDesk.enabled` is
true; while it is off nothing offers it and new requests are refused, and requests
made earlier keep their history and their status links.

- **Request a new 409A** — on *Compliance & tax → 409A valuations*, the appraiser's
  information request, in five steps, every question required:
  - **The valuation:** the valuation date (or the most recent date), company size
    and stage, plans to grant options or close a round, a ballpark of options to
    grant in the next 6 to 12 months, and the last 409A.
  - **Documents:** historical and year-to-date financial statements, the pitch
    deck, earlier valuation reports, the certificate of incorporation, SAFE and
    note agreements, and projections (or revenue and EBITDA guidance instead).
    Documents are uploaded or chosen from the vault; the charter, earlier 409A
    reports and outstanding SAFE agreements are attached for you. The founder also
    confirms the cap table and option ledger are up to date, since the team gets
    them from the app.
  - **People:** the management team, and anyone on a below-market salary.
  - **Transactions:** secondary sales of the company's stock, and expenses
    recorded below market rates.
  - **Software and contact.**

  The server refuses a request missing any required answer or document, not only
  the form. The answer lists are in `valuationDesk.intake`. Sending it emails the
  valuation team the answers, the capital structure (no holder names) and the
  documents' names, and emails a recap to the account of the person who asked. The
  documents themselves never travel by email: the team downloads them from its
  page while the request is open.
- **Status** — the team works the request from a private link in its email: it
  marks the request started, adds notes, delivers the report (naming the
  appraisal firm and the valuation date) or closes it. The company sees each step
  on its 409A page, and recording the 409A from the report closes the request.
  The person who asked is emailed at each step, at their account address: when
  the team starts, delivers, puts the report back in progress or closes the
  request, and when someone else at the company completes or cancels it. Notes
  are not emailed. `valuationDesk.statusEmailsPerRequestPerDay` (10) caps these
  emails per request, and 0 turns them off.
- **The report, uploaded** — on its page the team can upload the appraisal report
  as a PDF before it marks the request delivered. The file goes into the
  company's vault (category *Valuation*, folder *Valuations*, administrators
  only), and the app reads the fair market value per common share, the valuation
  date and the method from its text, with no service outside the server. The
  delivery form fills in from what was read, each value with the sentence it came
  from and a warning when the reading is unsure; the team corrects anything and
  delivers. A scanned or encrypted PDF is still stored, and the team types the
  values instead. On the company's 409A page the delivered report shows those
  values, and *Review and record* opens *Record valuation* filled in from them:
  nothing is recorded until someone at the company has checked them against the
  report and saved the form, which records the 409A with the report attached and
  closes the request. Uploading again replaces the earlier file, and putting the
  report back in progress removes it, unless something in the company already
  uses it. `valuationDesk.reportUploadsPerRequestPerDay` (10) caps uploads per
  request, and 0 turns uploading off; delivering by email works either way.
- **The team's link** — only a hash of its token is stored, each new notice
  replaces it, and it stops working `valuationDesk.linkClosedDays` (30) days after
  the request closes. `valuationDesk.name` is what the team is called in the app
  and in emails.
- **The evaluators** — `valuationDesk.email` is one address or a list of up to
  10; `VALUATION_DESK_EMAIL` wins over it, comma separated (Terraform sets it
  from `valuation_desk_emails`). With none set, requests are saved but nobody is
  told. Each address gets an email of its own, so no evaluator sees another's
  address, and every one carries the same link; the closing notice and *Send to
  the team again, with a new link* go to all of them. Replies to the recap and
  the status emails reach the first address only, so the company learns no more
  of the list than it did of one inbox. When some addresses are reached and
  others are not, the company is told that some of the team did not get it,
  never which addresses or how many there are, the link moves to the new one,
  and the server log names the addresses that failed; a resend reaches everyone
  again. A notice counts once against the per-request, per-company and
  per-person `valuationDesk.noticesPer…` limits however many addresses it goes
  to, so each evaluator gets at most that many and a longer list does not use up
  a company's allowance faster; the audit log holds one entry per notice and no
  address. `valuationDesk.noticesPerHour` (30) is the exception: it guards the
  mail the server sends, so it counts emails, one per address, and a list of
  three lets ten notices out an hour. Keep it well below the mail provider's
  hourly limit (a new Azure Communication Services custom domain allows 100);
  the server refuses to start with fewer than the addresses on the list.
  Closing notices are not held back by it: one goes to each address on the list
  when a request the team was told about closes, so a list of three sends three.
- **Changing the list** — it takes a restart (with Terraform, an apply). Every
  evaluator shares the request's one link, so removing an address does not take
  back a link it was already sent: on each request it was told about, the link
  works until a new notice replaces it, which only someone at the company can
  send (*Send to the team again, with a new link*), or until it expires
  (`valuationDesk.linkOpenDays`, 180 days from when it was sent, or
  `valuationDesk.linkClosedDays` after the request closes). Remove
  only someone you would still trust with the requests already sent to them. The
  closing notice goes to the list as it is when the request closes: an address
  added since gets it too, and one removed does not.
- **Your own appraiser** — the data workbook stays downloadable from the 409A
  page, and *Record valuation* takes the result.
- **Importing a report** — *Import a report* on the 409A page, or *Fill from a
  report* in *Record valuation*, takes the appraiser's PDF from your computer or
  from the vault. The server reads it as it reads the team's uploads, in a worker
  with limits on its time and memory and with no service outside the server, and
  the form fills in: the price per common share, the valuation date, the method,
  the appraiser (the firm that prepared the report, never the company it values)
  and the enterprise value, or the equity value, flagged, when that is what the
  report states most surely; recording an equity value there adds a line to the
  notes saying so. A figure from a table "in thousands" is scaled and flagged.
  Each value is marked with the page and the words it was read from, and the
  ones read less surely are flagged for checking. A value already typed in the
  form stays, with the reading offered beside it. A report with no valuation
  date leaves the date empty to be entered. A scanned PDF has nothing to read
  and says so; the values are typed in by hand. Reading stores nothing: a PDF
  from your computer reaches the vault (category *Valuation*, folder
  *Valuations*, administrators only) only when the valuation is saved, together
  with the link to it, and a document from the vault stays where it is, its
  reading logged as a download is. Cancelling leaves nothing behind. Only
  administrators and legal can import a report, as only they can record a
  valuation; on the sample company a report can be read but not filed. One
  report is read at a time for a company and for a person, and the imports
  leave a place in the server's line for the team's uploads.
- **Reports** — a valuation's page has a *Report* field: upload the appraisal,
  choose a document already in the vault, or paste a link. The valuations table
  opens it directly.
