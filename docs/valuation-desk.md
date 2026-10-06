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
  the request closes. The team's inbox is `valuationDesk.email` (or
  `VALUATION_DESK_EMAIL`); with none set, requests are saved but nobody is told.
  `valuationDesk.name` is what the team is called in the app and in emails.
- **Your own appraiser** — the data workbook stays downloadable from the 409A
  page, and *Record valuation* takes the result.
- **Reports** — a valuation's page has a *Report* field: upload the appraisal,
  choose a document already in the vault, or paste a link. The valuations table
  opens it directly.
