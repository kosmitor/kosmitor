/**
 * The explanations that open each page.
 *
 * Equity has its own vocabulary and most of it is load-bearing: a 409A valuation
 * is not paperwork, it is what makes a strike price defensible. Every page names
 * a concept here so that someone meeting the term for the first time gets the
 * answer on the page rather than in a browser tab. The panel that renders this is
 * ConceptNote.tsx.
 *
 * Nothing here is advice, and the panel says so. Keep it that way: describe how
 * the thing works and what the settled rules are, never what a particular company
 * should do. Leave a figure out rather than guess it.
 *
 * Figures that are policy rather than law come from kosmitor.config.json, so the
 * words stay true when an operator changes them.
 */
import { config } from './config.ts';

export interface Concept {
  /** The question a newcomer would ask, ending in a question mark. */
  title: string;
  /** One or two sentences answering it. Always on screen, so it has to stand alone. */
  summary: string;
  /** Why it matters, usually the cost of getting it wrong. */
  why: string;
  /** Three to five single-sentence facts: thresholds, deadlines, common mistakes. */
  points: string[];
  /** Where to go next inside the app. */
  seeAlso: { to: string; label: string }[];
}

export const CONCEPT_IDS = [
  'cap-table', 'stakeholders', 'stakeholder-position', 'share-classes', 'certificates',
  'certificate-record',
  'equity-awards', 'award-record', 'equity-plans', 'offer-letters', 'my-equity', 'stock-comp',
  'convertibles', 'convertible-record', 'warrants', 'warrant-record', 'round-modeling', 'exit-waterfall',
  'compliance', '409a', 'valuation-record', 'iso-100k', 'rule-701', '83b', 'form-3921', 'boi',
  'documents', 'templates', 'investor-updates', 'board-consents', 'transactions', 'audit-log',
  'reports', 'report-builder', 'import', 'company-settings', 'team-access', 'calculator',
  'ai-assistant',
] as const;

export type ConceptId = (typeof CONCEPT_IDS)[number];

/** Partial on purpose: a page whose explanation is not written yet simply shows no panel. */
export const CONCEPTS: Partial<Record<ConceptId, Concept>> = {
  'cap-table': {
    title: 'What is a capitalization table?',
    summary: 'A capitalization table, shortened to cap table, is the record of every share, option and convertible instrument a company has issued. It names each holder and how much each one owns.',
    why: 'A financing, an exit payout and a diligence request all run from this record, so an error in it surfaces at the worst possible moment. Investors and acquirers read the fully diluted view, because it counts shares that are promised but not yet issued.',
    points: [
      'Outstanding counts only shares actually issued and held today, and it leaves out options and unissued pool shares.',
      'Fully diluted adds options, restricted stock units, warrants, convertible instruments and the unallocated pool to the outstanding count.',
      'As converted restates preferred stock as the common shares it would become on conversion.',
      'A simple agreement for future equity, shortened to SAFE, has no fixed share count until it converts, so its as converted figure rests on assumptions.',
      'Voting weights each share by its votes per share, so a class carrying extra votes changes that column alone.',
    ],
    seeAlso: [
      { to: '/share-classes', label: 'Share classes' },
      { to: '/certificates', label: 'Share & certificates' },
      { to: '/model/exit', label: 'Exit waterfall' },
    ],
  },
  stakeholders: {
    title: 'Who counts as a stakeholder?',
    summary: 'A stakeholder is any person or entity holding equity or a right to equity in the company. Founders, employees, advisors, investors and warrant holders all appear on the register.',
    why: 'Payments, tax forms and signature requests all route from these records, so a missing address or a wrong legal name stalls a closing.',
    points: [
      'An individual is recorded under a legal name, while an entity is recorded under its registered name with a named signing officer.',
      'A fund investing through several entities appears as several stakeholders, each holding its own shares.',
      'Withholding and reporting follow the holder\'s own tax status, which is why the record carries a tax residence and a tax form.',
      'A former employee stays on the register while they still hold shares or an option that has not expired.',
      'Accredited investor is a status defined by United States securities rules, and private placements under Regulation D depend on who qualifies.',
      'A seat on the board is recorded apart from the relationship, with the dates it ran and the investor who designated the director, so an angel who holds shares and sits on the board is both an investor and a director.',
    ],
    seeAlso: [
      { to: '/cap-table', label: 'Cap table' },
      { to: '/grants', label: 'Equity grants' },
      { to: '/portal', label: 'My equity' },
    ],
  },
  'stakeholder-position': {
    title: 'How do I read one holder\'s position?',
    summary: 'A position gathers everything one holder owns into a single view, split into shares, options, restricted stock units, warrants and convertible instruments. Every line is expressed in shares.',
    why: 'Holders read this to learn how much of the company they own, and a figure taken from the wrong line overstates or understates that stake.',
    points: [
      'Shares outstanding counts stock already issued to the holder, whether those shares are vested or not.',
      'As converted restates preferred stock and convertible instruments as the common shares they would become.',
      'Options outstanding counts granted options that have not been exercised, cancelled or expired, both vested and unvested.',
      'Fully diluted percentage divides this holder\'s fully diluted shares by the company total, and that total includes the unallocated pool.',
      'Current value multiplies fully diluted shares by the fair market value from the latest valuation, and it does not subtract the cost of exercising options.',
    ],
    seeAlso: [
      { to: '/stakeholders', label: 'Stakeholders' },
      { to: '/grants', label: 'Equity grants' },
      { to: '/cap-table', label: 'Cap table' },
    ],
  },
  'share-classes': {
    title: 'What is a share class, and why do terms differ?',
    summary: 'A share class is a group of shares that carry identical rights. Common stock normally goes to founders and employees, and preferred stock is created for investors in a priced round.',
    why: 'Class terms decide who is paid first and how much in an exit, so two holders with identical share counts can receive very different amounts.',
    points: [
      'A liquidation preference is the amount a preferred holder receives before common holders get anything, most often one times the original issue price.',
      'Participating preferred takes its preference and then shares the remainder with common, while non-participating takes whichever of the two is larger.',
      'Seniority sets the order in which classes are paid, and later rounds either rank ahead of earlier ones or rank equally with them.',
      'Anti-dilution adjusts the preferred conversion price if the company later sells shares at a lower price, and broad based weighted average is the common form.',
      'Preferred stock converts into common at a stated ratio, and that conversion is typically automatic in a qualifying initial public offering.',
    ],
    seeAlso: [
      { to: '/certificates', label: 'Share & certificates' },
      { to: '/model/exit', label: 'Exit waterfall' },
      { to: '/cap-table', label: 'Cap table' },
    ],
  },
  certificates: {
    title: 'What does a stock certificate record?',
    summary: 'A certificate records one issuance of shares to one holder. It states the share class, the number of shares, the price paid, the issue date and any restrictions attached.',
    why: 'The certificate is the evidence that shares were issued, and a ledger that disagrees with the signed paperwork leaves ownership open to challenge in diligence.',
    points: [
      'Shares are issued when the board approves the issuance and the holder pays the agreed price, and the certificate records that issuance.',
      'Restricted stock vests over time, and the purchase agreement usually lets the company buy back shares that are still unvested when the holder leaves.',
      'An 83(b) election taxes restricted stock at purchase rather than as it vests, and the filing deadline is 30 days after the stock is transferred, moved to the next business day when the thirtieth falls on a weekend or a legal holiday.',
      'Early exercised shares are bought before the option vests, and the company can repurchase them at the price the holder paid until they vest.',
      'A transfer or a repurchase cancels the old certificate and issues a new one, which keeps every share traceable to a document.',
    ],
    seeAlso: [
      { to: '/compliance/83b', label: '83(b) elections' },
      { to: '/share-classes', label: 'Share classes' },
      { to: '/ledger', label: 'Transactions' },
    ],
  },
  'certificate-record': {
    title: 'What does one certificate record hold?',
    summary: 'This page gathers a single issuance of shares: what was paid for them, the terms they were sold under, how far they have vested, their 83(b) position and everything that has happened to them since.',
    why: 'Diligence is done one certificate at a time, and a term that lives only in the signed paperwork is a term nobody can check against the ledger.',
    points: [
      'Capital contribution is the number of shares multiplied by the price per share, which is what the holder actually paid.',
      'Par value is the nominal amount per share set in the charter, and shares are normally sold at or above it.',
      'The federal exemption names the rule the sale relied on instead of registering the shares with the Securities and Exchange Commission.',
      'The legend is the restrictive text carried on the certificate, and it states that the shares may not be resold freely.',
      'Rule 144 sets how long restricted shares must be held before they can be resold, and that clock starts on the holding start date recorded here.',
    ],
    seeAlso: [
      { to: '/certificates', label: 'Share & certificates' },
      { to: '/compliance/83b', label: '83(b) elections' },
      { to: '/ledger', label: 'Transactions' },
    ],
  },
  'equity-awards': {
    title: 'What are stock options and RSUs?',
    summary: 'A stock option is the right to buy company shares later at a price fixed on the grant date. A restricted stock unit, or RSU, is a promise to deliver shares once it vests.',
    why: 'Options and RSUs are taxed under different rules, and an option that is not exercised before its deadline is lost for good.',
    points: [
      'An incentive stock option, or ISO, can be granted only to employees, and it can qualify for favorable tax treatment.',
      'A non-qualified stock option, or NSO, can go to contractors, advisors and directors, and the gain at exercise is ordinary income.',
      'An RSU has no purchase price, and its value is ordinary income for the holder when the shares are delivered.',
      'The exercise price is fixed at grant and is normally at least the fair market value of a share on that date.',
      'Incentive stock option treatment generally requires exercise within three months after employment ends, with different periods for disability and death.',
    ],
    seeAlso: [
      { to: '/plans', label: 'Plans and vesting' },
      { to: '/compliance/iso-100k', label: 'ISO $100K limit' },
      { to: '/compliance/409a', label: '409A valuations' },
    ],
  },
  'award-record': {
    title: 'What does one grant record hold?',
    summary: 'This page gathers a single equity award: how much of it is still live, what exercising it would cost and what that would be worth, how far it has vested, and the deadlines that end it.',
    why: 'An option is a right with an expiry date on it, and the two dates that end it, the grant expiry and the window that opens when someone leaves, arrive without a reminder.',
    points: [
      'Outstanding is what is left of the grant once the shares already exercised and the shares cancelled are taken off it.',
      'The spread is the fair market value of a share today less the strike price, and it is what the grant is worth before tax.',
      'A grant is underwater when its strike price is above the current fair market value, so exercising it would cost more than the shares are worth.',
      'Leaving the company starts the post-termination exercise period, commonly three months, after which unexercised options are gone for good.',
      'The $100,000 incentive stock option limit is measured per person per calendar year, so the test covers every incentive stock option the holder has rather than this grant alone.',
    ],
    seeAlso: [
      { to: '/grants', label: 'Equity grants' },
      { to: '/plans', label: 'Plans and vesting' },
      { to: '/compliance/iso-100k', label: 'ISO $100K limit' },
    ],
  },
  'equity-plans': {
    title: 'What is an option pool and how does vesting work?',
    summary: 'An option pool is a block of shares reserved under an equity incentive plan for grants to employees and others. Vesting sets the pace at which an award is earned.',
    why: 'Grants made without enough reserved shares or without the right approvals can be invalid, and fixing a broken plan later is slow and expensive.',
    points: [
      'The board adopts the plan and sets the number of shares reserved for grants under it.',
      'Shareholders must approve the plan within twelve months before or after board adoption for incentive stock options to be granted under it.',
      'Four year vesting with a one year cliff is the common pattern, so nothing vests until the first anniversary.',
      'An evergreen provision increases the reserve automatically each year, usually by a percentage of the shares outstanding.',
      'Shares from cancelled or forfeited awards return to the pool only if the plan allows it.',
    ],
    seeAlso: [
      { to: '/grants', label: 'Equity grants' },
      { to: '/cap-table', label: 'Cap table' },
      { to: '/model/round', label: 'Model a round' },
    ],
  },
  'offer-letters': {
    title: 'Why is an equity offer not the same as a grant?',
    summary: 'An equity offer states what a candidate is being offered, including the number of shares, the award type and the vesting schedule. It becomes a grant only once the board approves it.',
    why: 'A candidate who reads an offer as a grant can expect a share count or a price that the board never approved.',
    points: [
      'The grant date and the exercise price are set when the board or a committee of the board approves the award.',
      'The exercise price must be at least the fair market value of a share on the grant date, so a newer valuation can raise it.',
      'A percentage of ownership means little without the total number of shares it is measured against.',
      'A grant can be made only if the plan reserve holds enough unissued shares on the approval date.',
      'Candidates commonly ask for the exercise price, the vesting schedule, the shares outstanding and the exercise window after leaving.',
    ],
    seeAlso: [
      { to: '/grants', label: 'Equity grants' },
      { to: '/plans', label: 'Plans and vesting' },
      { to: '/compliance/409a', label: '409A valuations' },
    ],
  },
  'my-equity': {
    title: 'What does this page show about my equity?',
    summary: 'This page shows the shares, options and other awards held by one person, with the vested portion separated from the unvested portion.',
    why: 'The deadlines attached to equity are short and unforgiving, and a missed exercise window or filing usually cannot be undone.',
    points: [
      'Vested means earned, and unvested awards are normally forfeited when someone stops working for the company.',
      'The window to exercise vested options after leaving is set by the award, and ninety days is a common length.',
      'Exercising an option costs cash, the exercise price multiplied by the number of shares, and tax can fall due the same year.',
      'An 83(b) election must be filed with the Internal Revenue Service within thirty days of the date the restricted stock is transferred. When the thirtieth day falls on a weekend or a legal holiday, the deadline moves to the next business day.',
      'A value shown for private shares is an estimate from the latest valuation, and private shares are usually hard to sell.',
    ],
    seeAlso: [
      { to: '/grants', label: 'Equity grants' },
      { to: '/compliance/83b', label: '83(b) elections' },
      { to: '/documents', label: 'Documents' },
    ],
  },
  'stock-comp': {
    title: 'Why do equity awards create an accounting expense?',
    summary: 'ASC 718, the US accounting standard for share-based payment, records equity awards as compensation expense. The amount is the fair value of the award measured on its grant date.',
    why: 'Investors, lenders and auditors expect this expense in the accounts, and valuation assumptions without support are a common audit finding.',
    points: [
      'Grant-date fair value is spread over the service period, which is normally the vesting period of the award.',
      'Options are valued with a model such as Black-Scholes, which needs share value, strike price, expected term, volatility, risk-free rate and dividend yield.',
      'A restricted stock unit needs no option model, because its grant-date value is the fair value of a share.',
      'Private companies often estimate volatility from comparable public companies, since they have no share price history of their own.',
      'The expense uses no cash, but it lowers reported profit, and the offsetting entry increases equity.',
    ],
    seeAlso: [
      { to: '/grants', label: 'Equity grants' },
      { to: '/compliance/409a', label: '409A valuations' },
      { to: '/reports', label: 'Reports' },
    ],
  },
  convertibles: {
    title: 'What is a SAFE or a convertible note?',
    summary: 'A SAFE or a convertible note is money invested now in exchange for shares issued later, usually at the next priced round. SAFE stands for simple agreement for future equity, and it is not a loan.',
    why: 'No price per share is set when the money arrives, so the shares an investor will end up holding stay unknown until conversion. Several instruments stacked together can convert into far more of the company than the amounts raised suggest.',
    points: [
      'A valuation cap sets the highest company valuation that can be used to price the investor\'s shares when the instrument converts.',
      'A discount gives the investor a fixed percentage off the price per share paid by new investors in the round.',
      'When an instrument carries both a cap and a discount, the investor normally receives whichever of the two produces more shares.',
      'A post-money SAFE fixes the investor\'s percentage measured after all SAFEs convert, so later SAFEs dilute founders rather than earlier investors.',
      'A convertible note is debt that accrues interest and comes due at its maturity date, while a SAFE has neither.',
    ],
    seeAlso: [
      { to: '/model/round', label: 'Model a round' },
      { to: '/cap-table', label: 'Cap table' },
      { to: '/share-classes', label: 'Share classes' },
    ],
  },
  'convertible-record': {
    title: 'What does one SAFE or note record hold?',
    summary: 'This page gathers a single convertible instrument: the money that came in, the cap and discount that will price it, any interest it accrues, when it matures, and what it would convert into on today\'s numbers.',
    why: 'A convertible has no share count until a priced round gives it one, so the dilution it carries is easy to leave out of the picture until the round where it is too late to renegotiate.',
    points: [
      'A valuation cap sets the highest company value the money converts at, and a discount takes a percentage off the round price.',
      'Where a cap and a discount both apply, the holder normally converts on whichever of the two gives them more shares.',
      'A convertible note accrues interest and comes due on its maturity date, while a SAFE has neither.',
      'A post-money SAFE with a cap fixes the holder\'s percentage measured after all SAFEs convert, so later SAFEs dilute the founders rather than that holder.',
      'A note left outstanding past its maturity date is repayable on demand unless the holder agrees in writing to extend it or to convert.',
    ],
    seeAlso: [
      { to: '/convertibles', label: 'SAFEs and notes' },
      { to: '/model/round', label: 'Model a round' },
      { to: '/cap-table', label: 'Cap table' },
    ],
  },
  warrants: {
    title: 'What is a warrant and who receives one?',
    summary: 'A warrant is a contract that lets its holder buy a set number of shares at a fixed price before a stated expiry date. Warrants usually go to lenders, investors and partners rather than to employees.',
    why: 'Warrants live outside the equity plan and are easy to leave off the cap table, which understates dilution in a financing and at an exit.',
    points: [
      'A warrant is issued under its own standalone agreement, while an employee option is issued from an equity incentive plan.',
      'Incentive stock option rules apply only to employees, so a warrant held by an outside party cannot be an incentive stock option.',
      'Venture debt lenders often ask for warrant coverage, meaning a warrant amount set as a percentage of the loan principal.',
      'Warrants belong in the fully diluted share count, the total number of shares that would exist if every right to buy shares were used.',
      'A warrant that is never exercised before its expiry date delivers nothing to the holder.',
    ],
    seeAlso: [
      { to: '/grants', label: 'Equity grants' },
      { to: '/cap-table', label: 'Cap table' },
      { to: '/model/exit', label: 'Exit waterfall' },
    ],
  },
  'warrant-record': {
    title: 'What does one warrant record hold?',
    summary: 'This page gathers a single warrant: how many shares it still covers, the price those shares would be bought at, the class they come from, and the date after which none of it is worth anything.',
    why: 'A warrant sits outside the equity plan and outside payroll, which makes it the security most often missed in a fully diluted count and in an exit waterfall.',
    points: [
      'Outstanding is the shares under the warrant less the shares already bought under it.',
      'A net exercise, also called a cashless exercise, keeps back part of the shares in place of paying the strike price in cash.',
      'Warrants belong in the fully diluted share count, the total number of shares that would exist if every right to buy shares were used.',
      'A warrant that reaches its expiry date unexercised delivers nothing, and those shares leave the fully diluted count.',
      'Warrant coverage on venture debt is a warrant amount set as a percentage of the loan principal.',
    ],
    seeAlso: [
      { to: '/warrants', label: 'Warrants' },
      { to: '/cap-table', label: 'Cap table' },
      { to: '/model/exit', label: 'Exit waterfall' },
    ],
  },
  'round-modeling': {
    title: 'How does a priced round change ownership?',
    summary: 'A priced round sells newly issued stock at an agreed price per share. Existing holders keep the same number of shares afterwards but own a smaller percentage of a larger company.',
    why: 'The order in which new shares and a larger option pool enter the cap table decides who absorbs the dilution. Placing the pool before the money shifts that dilution onto founders and other existing holders instead of sharing it with the new investors.',
    points: [
      'Pre-money valuation is the agreed value of the company before the new money arrives, and post-money valuation adds the investment to it.',
      'Price per share is usually the pre-money valuation divided by the pre-money fully diluted share count.',
      'The option pool shuffle places a new or enlarged option pool in the pre-money cap table, so existing holders carry that dilution alone.',
      'SAFEs and convertible notes normally convert in the same round, which adds shares on top of the new investment.',
      'A pro rata right lets an existing investor buy enough of the new round to hold its percentage steady.',
    ],
    seeAlso: [
      { to: '/convertibles', label: 'SAFEs and notes' },
      { to: '/share-classes', label: 'Share classes' },
      { to: '/cap-table', label: 'Cap table' },
    ],
  },
  'exit-waterfall': {
    title: 'Who gets paid first when the company sells?',
    summary: 'A waterfall is the order in which sale proceeds are paid out. Debt is repaid first, then preferred stock takes its liquidation preference, and common stock shares whatever remains.',
    why: 'In a modest sale the preference stack can absorb most of the proceeds, leaving common shareholders and employees with little or nothing.',
    points: [
      'A liquidation preference is the amount a preferred holder receives before common stock, most commonly one times the original investment.',
      'Participating preferred takes its preference and then shares the remaining proceeds with common stock as well.',
      'A non-participating preferred holder takes the greater of the preference and the value of converting into common stock.',
      'Under a seniority stack later rounds are paid before earlier ones, while pari passu pays all preferred at the same level.',
      'Option and warrant holders receive proceeds only above their exercise price, so awards priced above the sale price pay nothing.',
    ],
    seeAlso: [
      { to: '/share-classes', label: 'Share classes' },
      { to: '/convertibles', label: 'SAFEs and notes' },
      { to: '/grants', label: 'Equity grants' },
    ],
  },
  compliance: {
    title: 'What does equity compliance actually cover?',
    summary: 'Issuing equity in a private United States company sits inside federal tax law and securities law. Compliance is the set of valuations, filings and deadlines those rules attach to each grant.',
    why: 'Errors here usually land on employees as unexpected tax, and on the company as findings in an audit, an acquisition or a funding diligence review.',
    points: [
      'A 409A valuation is an appraisal of common stock, and it sets the fair market value that option strike prices are measured against.',
      'Rule 701 is a federal exemption that lets a private company issue equity to employees and other service providers without registering the securities.',
      'The 100,000 dollar limit caps the value of incentive stock options that can first become exercisable in one calendar year, measured at grant.',
      'A section 83(b) election has a 30 day filing window set by statute, and a late election is not accepted.',
      'Most obligations here are triggered by a dated event, so grant dates and exercise dates drive the whole calendar.',
      `This page lists what must be fixed, what to review, and every area found in good order, and the score starts at ${config.compliance.scoring.start} and loses points for each finding by how serious it is.`,
    ],
    seeAlso: [
      { to: '/compliance/409a', label: '409A valuations' },
      { to: '/compliance/83b', label: '83(b) elections' },
      { to: '/grants', label: 'Equity grants' },
    ],
  },
  '409a': {
    title: 'What is a 409A valuation and why do we need one?',
    summary: 'A 409A valuation is an appraisal that sets the fair market value of a private company\'s common stock. Companies price stock options at or above that value on the date of grant.',
    why: 'Section 409A of the Internal Revenue Code treats an option priced below fair market value as deferred compensation. The holder then owes income tax as the option vests, plus an extra 20 percent federal tax.',
    points: [
      'An appraisal by a qualified independent appraiser creates a safe harbor, and the Internal Revenue Service must then show the price was grossly unreasonable.',
      'The safe harbor covers grants made within twelve months of the valuation date, so most companies refresh the valuation each year.',
      'A priced financing round, an acquisition offer or a large change in the business is a material event that ends reliance early.',
      'An incentive stock option must also carry a strike price of at least fair market value on the date of grant.',
      'The tax and the extra 20 percent fall on the option holder, while the company carries the reporting and withholding duties.',
    ],
    seeAlso: [
      { to: '/grants', label: 'Equity grants' },
      { to: '/compliance/iso-100k', label: 'ISO $100K limit' },
      { to: '/compliance', label: 'Compliance & tax' },
    ],
  },
  'valuation-record': {
    title: 'What does one 409A valuation record hold?',
    summary: 'This page gathers a single appraisal: the fair market value it set, the dates it covers, whether anything later has replaced it, and every option grant that was priced off it.',
    why: 'The valuation is what makes a strike price defensible. A grant priced below the fair market value on its grant date puts the tax on the holder, and the company cannot undo that later.',
    points: [
      'A grant takes its price from the most recent valuation in force on its grant date, which is why the grants listed here are the ones made while this one stood.',
      'The safe harbor covers grants made within twelve months of the valuation date, and a priced round or another material event ends reliance on it early.',
      'An option priced below fair market value is deferred compensation under section 409A, taxed as it vests and carrying an extra 20 percent federal tax.',
      'An incentive stock option must carry a strike price of at least fair market value on its grant date, or it is treated as a nonqualified option.',
      'The implied company value here is the common stock price multiplied by the fully diluted count, which is lower than what an investor paid for preferred stock.',
    ],
    seeAlso: [
      { to: '/compliance/409a', label: '409A valuations' },
      { to: '/grants', label: 'Equity grants' },
      { to: '/compliance/iso-100k', label: 'ISO $100K limit' },
    ],
  },
  'iso-100k': {
    title: 'What is the 100,000 dollar incentive stock option limit?',
    summary: 'Incentive stock options, known as ISOs, carry favorable tax treatment. Options covering at most 100,000 dollars of stock, valued at grant, can first become exercisable for one person in a calendar year.',
    why: 'Anything above the limit is treated as a nonqualified stock option instead. Tax at exercise, payroll withholding and year end reporting all change as a result.',
    points: [
      'The rule comes from Section 422(d) of the Internal Revenue Code and applies to each person for each calendar year.',
      'Value is measured by the fair market value at grant, which for an incentive stock option is normally the strike price.',
      'The test looks at when options first become exercisable, usually the vesting date, and not at when they are exercised.',
      'Options count in the order they were granted, so later grants are the ones that spill past the limit.',
      'Early exercise rights and accelerated vesting can make a large amount first exercisable in one year and often carry a holder past the limit.',
    ],
    seeAlso: [
      { to: '/grants', label: 'Equity grants' },
      { to: '/compliance/409a', label: '409A valuations' },
      { to: '/compliance/form-3921', label: 'Form 3921' },
    ],
  },
  'rule-701': {
    title: 'What is Rule 701 and when does it apply?',
    summary: 'Rule 701 is a federal exemption that lets a private company issue stock and options to its own people without registering them with the Securities and Exchange Commission.',
    why: 'Every grant is a sale of securities and needs an exemption. Without a valid one, recipients can gain a right to unwind the purchase, and the gap surfaces during diligence.',
    points: [
      'Rule 701 sits under the Securities Act of 1933 and covers securities issued under a written compensatory plan or agreement.',
      'It reaches employees, officers, directors and consultants who are natural persons providing bona fide services, and not raising capital.',
      'Over any twelve consecutive months a company may sell the greatest of 1,000,000 dollars, 15 percent of total assets, or 15 percent of the outstanding shares of that class.',
      'Above 10 million dollars of sales in a twelve month period, recipients must receive risk factors, plan terms and recent financial statements a reasonable time before the sale.',
      'Rule 701 is a federal exemption only, so state securities rules still apply to the same grants.',
    ],
    seeAlso: [
      { to: '/grants', label: 'Equity grants' },
      { to: '/plans', label: 'Plans and vesting' },
      { to: '/compliance', label: 'Compliance & tax' },
    ],
  },
  '83b': {
    title: 'What is an 83(b) election and why 30 days?',
    summary: 'A section 83(b) election is a filing that taxes restricted shares when they are received rather than as they vest. It fixes the taxable amount at the early value, which is usually low.',
    why: 'The election must be filed with the Internal Revenue Service no later than 30 days after the shares are transferred, and a missed window cannot be repaired. Without it, ordinary income is measured again at every vesting date.',
    points: [
      'The 30 day window runs from the date the shares are transferred, and a postmark inside those 30 days counts as timely filing.',
      'The election covers restricted stock and shares bought by exercising an option before that option has vested.',
      'Restricted stock units are a promise to deliver shares later, so an 83(b) election is not available for them.',
      'A filed election starts the capital gains holding period at the transfer date instead of at each vesting date.',
      'The election is irrevocable without Internal Revenue Service consent, and tax already paid is not recovered if the shares are forfeited.',
    ],
    seeAlso: [
      { to: '/grants', label: 'Equity grants' },
      { to: '/plans', label: 'Plans and vesting' },
      { to: '/compliance', label: 'Compliance & tax' },
    ],
  },
  'form-3921': {
    title: 'What is Form 3921 and who receives one?',
    summary: 'Form 3921 is an Internal Revenue Service information return that a company files after an employee exercises an incentive stock option. A copy also goes to the person who exercised.',
    why: 'That copy carries the numbers the employee needs for alternative minimum tax and for cost basis on a later sale. Late or missing returns carry a penalty for each return.',
    points: [
      'One form covers one exercise, so several exercises by the same person in a year produce several forms.',
      'The employee copy is due by January 31 of the year following the exercise.',
      'The Internal Revenue Service copy is due by February 28 on paper and by March 31 when it is filed electronically.',
      'A company that files 10 or more information returns of all types in a year has to file them electronically.',
      'An employee exercise of a nonqualified stock option is not reported here, because the spread runs through payroll and appears on Form W-2.',
    ],
    seeAlso: [
      { to: '/grants', label: 'Equity grants' },
      { to: '/compliance/iso-100k', label: 'ISO $100K limit' },
      { to: '/compliance', label: 'Compliance & tax' },
    ],
  },
  boi: {
    title: 'What is beneficial ownership reporting?',
    summary: 'The Corporate Transparency Act created a federal register of the real people behind companies. Reports go to the Financial Crimes Enforcement Network, a bureau of the Treasury Department.',
    why: 'The scope of this requirement narrowed sharply in 2025. Guidance and checklists written before that change describe a filing that companies formed in the United States no longer owe.',
    points: [
      'The Financial Crimes Enforcement Network administers this register, not the Internal Revenue Service and not the Securities and Exchange Commission.',
      'In March 2025 that bureau issued an interim final rule removing companies formed in the United States from the reporting requirement.',
      'As narrowed, the requirement reaches companies formed under foreign law that register to do business in a United States state.',
      'The rule defines a beneficial owner as an individual who exercises substantial control over a company or owns or controls at least 25 percent of it.',
      'The register is not public, and access is limited to authorized government users and to financial institutions in narrow circumstances.',
    ],
    seeAlso: [
      { to: '/stakeholders', label: 'Stakeholders' },
      { to: '/cap-table', label: 'Cap table' },
      { to: '/compliance', label: 'Compliance & tax' },
    ],
  },
  documents: {
    title: 'Why keep every signed equity document?',
    summary: 'This page holds the executed paperwork behind every share, option and financing on the cap table. Executed means signed by all parties.',
    why: 'Buyers, auditors and lawyers verify ownership from signed documents rather than from a spreadsheet. Paperwork that cannot be produced slows a deal or changes its price.',
    points: [
      'Each certificate, option grant, board consent and financing agreement has a signed document behind it.',
      'Due diligence is the review an investor or buyer runs before closing, and it asks for these documents by name.',
      'A document tied to a stakeholder can be shared with that holder or kept visible to administrators only.',
      'Delaware corporate law gives stockholders a right to inspect certain books and records for a proper purpose.',
      'An unsigned draft is not evidence of what was agreed, so the signed copy is the record.',
    ],
    seeAlso: [
      { to: '/certificates', label: 'Share & certificates' },
      { to: '/templates', label: 'Templates' },
      { to: '/consents', label: 'Board consents' },
    ],
  },
  templates: {
    title: 'What is a document template and a merge field?',
    summary: 'A template is the standard wording for a recurring document. A merge field is a placeholder that fills with data from the record, such as a holder name or a share count.',
    why: 'Redrafting each agreement by hand produces inconsistent terms and wrong names, quantities and dates, which are slow and costly to correct later.',
    points: [
      'Templates cover the repeating paperwork, such as stock purchase agreements, grant notices and exercise forms.',
      'Merge fields pull the holder name, quantity, price, dates and vesting schedule straight from the underlying record.',
      'A template reviewed by counsel once gives every document generated from it the same reviewed wording.',
      'A merge field with no matching data renders blank, and the preview lists the tokens it could not fill.',
      'Editing a template does not change documents already signed, because a signed document keeps the wording it had at signature.',
    ],
    seeAlso: [
      { to: '/documents', label: 'Documents' },
      { to: '/grants', label: 'Equity grants' },
      { to: '/offers', label: 'Offer letters' },
    ],
  },
  'investor-updates': {
    title: 'Why send investors a regular update?',
    summary: 'An investor update is a short written report on the business, sent on a fixed rhythm to shareholders and other investors.',
    why: 'Investors who follow the business move faster on introductions, hiring help and follow on money. A long silence tends to be read as bad news.',
    points: [
      'Updates commonly go out monthly or quarterly, and most run to about a page.',
      'A common update covers cash on hand, months of cash remaining, revenue or usage, hiring, wins, losses and specific asks.',
      'Information rights are contract terms that require the company to give certain investors financial statements and reports.',
      'Those rights usually sit in the investors rights agreement and apply to investors holding at least a set minimum.',
      'Updates tend to stop during a weak quarter, which is when investors have the least information about the business.',
    ],
    seeAlso: [
      { to: '/stakeholders', label: 'Stakeholders' },
      { to: '/reports', label: 'Reports' },
      { to: '/cap-table', label: 'Cap table' },
    ],
  },
  'board-consents': {
    title: 'What is a written consent, and what needs one?',
    summary: 'A written consent is a decision by the board or the stockholders recorded in a signed document instead of taken at a meeting. It has the same legal effect as a vote.',
    why: 'Equity issued without the approval it required can be void or need a formal fix later. The gap usually surfaces in diligence, when a financing is already underway.',
    points: [
      'Boards approve share issuances, option grants and the fair market value used to set option strike prices.',
      'Under Delaware law, board action by written consent requires every director to consent rather than a majority.',
      'The directors are the stakeholders with a board seat on the consent\'s effective date, so a founder who is not on the board does not vote, and a director who has left keeps a record of the seat but no vote.',
      'Stockholder action by written consent, where the charter allows it, needs the votes that would carry the matter with every voting share present.',
      'Increasing the option pool usually needs stockholder approval too, and an incentive stock option plan must be approved by stockholders within 12 months of adoption.',
      'A grant dates from board approval unless the approval names a later date, so equity described in an offer letter is not granted until then.',
    ],
    seeAlso: [
      { to: '/grants', label: 'Equity grants' },
      { to: '/compliance/409a', label: '409A valuations' },
      { to: '/documents', label: 'Documents' },
    ],
  },
  transactions: {
    title: 'Why is every cap table change a recorded event?',
    summary: 'The transaction ledger records each event that changed ownership, such as an issuance, exercise, transfer, cancellation or conversion, in date order.',
    why: 'A cap table is only as trustworthy as the history behind it. Without the underlying events, a number cannot be traced or defended.',
    points: [
      'Each event carries a date, a holder, a quantity and a price, so the table can be rebuilt as of any past date.',
      'Errors are corrected by recording a new event rather than by editing or deleting the original one.',
      'Common event types include issuance, grant, exercise, transfer, repurchase, cancellation, conversion and stock split.',
      'Delaware corporations are required to keep a stock ledger showing holders of record and the shares each one holds.',
      'Reports, exit waterfalls and stock compensation figures are all computed from these recorded events.',
    ],
    seeAlso: [
      { to: '/cap-table', label: 'Cap table' },
      { to: '/certificates', label: 'Share & certificates' },
      { to: '/audit', label: 'Audit log' },
    ],
  },
  'audit-log': {
    title: 'What does the audit log record, and who reads it?',
    summary: 'The audit log is an append only record of actions taken in the system, showing the person, the time, the action and the record affected. Append only means entries are added and never altered.',
    why: 'In diligence or a dispute, the question is who approved a change and when it happened. A written trail answers that, and recollection does not.',
    points: [
      'Each entry captures who acted, what they did, when, the record affected and the network address of the request.',
      'Logged actions include sign ins, password changes, edits, signatures, votes, invitations, exports and imports.',
      'The ledger records ownership events, while the audit log records system actions, including ones that changed no numbers.',
      'Financial statement auditors test access and change controls, and this trail is part of that evidence.',
      'Shared administrator logins break accountability, because every action then traces back to a single account.',
    ],
    seeAlso: [
      { to: '/ledger', label: 'Transactions' },
      { to: '/team', label: 'Team and access' },
      { to: '/documents', label: 'Documents' },
    ],
  },
  reports: {
    title: 'What do cap table reports cover?',
    summary: 'A report exports the cap table and its supporting schedules as a CSV file, computed as of one chosen date. The standard set covers holders, share classes, equity awards, vesting, convertible instruments and transactions.',
    why: 'Investors, auditors, the board and tax preparers each want a different view of the same data. A figure that cannot be reproduced months later stalls a financing or an audit.',
    points: [
      'Every report is computed as of a date, so a position from a past quarter can be produced again later.',
      'Audit requests commonly cover the share register, the equity award register and the vesting detail behind stock compensation expense.',
      'Diligence in a financing usually starts with a fully diluted cap table and a list of outstanding convertible instruments.',
      'A CSV file freezes the numbers at the moment of export, so later edits never change a copy already sent.',
      'Each export is written to the audit log with the report name, the person who ran it and the time.',
    ],
    seeAlso: [
      { to: '/cap-table', label: 'Cap table' },
      { to: '/ledger', label: 'Transactions' },
      { to: '/stock-comp', label: 'Stock compensation' },
    ],
  },
  'report-builder': {
    title: 'What does the report builder do?',
    summary: 'The report builder assembles a table from one dataset, with chosen columns, filters and sort order. The result is previewed on screen and exported as CSV or Excel.',
    why: 'The standard reports answer standard questions. A board question, a bank request or an audit sample often needs a narrow slice that no fixed report contains.',
    points: [
      'A custom report starts from one dataset such as the cap table, stakeholders, certificates, equity awards, SAFEs and notes, warrants or transactions.',
      'Filters narrow the rows by value, for example awards above a given strike price or holders of one share class.',
      'A saved report keeps its dataset, columns and filters, so the same slice can be run again after the data changes.',
      'One as of date applies to the whole report, so every row reflects the cap table on the same day.',
      'The preview shows a limited number of rows and says when it is truncated, while the export contains every matching row.',
    ],
    seeAlso: [
      { to: '/reports', label: 'Reports' },
      { to: '/cap-table', label: 'Cap table' },
      { to: '/ledger', label: 'Transactions' },
    ],
  },
  import: {
    title: 'How does importing a cap table work?',
    summary: 'An import reads a spreadsheet or an export from another provider, works out what each tab holds and which column is which, and checks every row before anything is saved.',
    why: 'An import sets the opening balances for every later calculation. An error carried in at the start reappears in ownership percentages, compliance checks and every report.',
    points: [
      'Order matters during an import, because people are created first, then certificates, then equity awards, then convertible instruments.',
      'The check shows what happens to each row, with what needs an answer or a fix, and nothing is saved until Import is pressed.',
      'Reconciliation means comparing the imported totals for each share class against the signed certificates and the board consents behind them.',
      'Outstanding shares, the size of the option pool and the fully diluted total are the figures usually reconciled first.',
      'Original grant dates and vesting start dates carry over from the source file, because vesting math and tax treatment depend on them.',
    ],
    seeAlso: [
      { to: '/cap-table', label: 'Cap table' },
      { to: '/stakeholders', label: 'Stakeholders' },
      { to: '/share-classes', label: 'Share classes' },
    ],
  },
  'company-settings': {
    title: 'Why does the company record matter?',
    summary: 'The company record holds the legal identity of the business. It covers legal name, entity type, state of incorporation, incorporation date, fiscal year end and tax identification number.',
    why: 'Certificates, grant paperwork, board consents and generated documents all read from this record, so a wrong legal name or date reaches papers that people then sign.',
    points: [
      'The legal name is the one on the certificate of incorporation, punctuation and the Inc or Corp suffix included.',
      'Most venture backed startups incorporate in Delaware, and the state of incorporation decides which body of corporate law applies.',
      'The Employer Identification Number, or EIN, is the federal tax identification number the IRS issues to a company.',
      'Fiscal year end sets the reporting periods for financial statements and for the stock compensation expense reported in them.',
      'Documents generated here print the legal name, entity type, state of incorporation and address from this record rather than the display name.',
    ],
    seeAlso: [
      { to: '/documents', label: 'Documents' },
      { to: '/compliance/boi', label: 'Beneficial ownership' },
      { to: '/team', label: 'Team and access' },
    ],
  },
  'team-access': {
    title: 'What can each role see on the cap table?',
    summary: 'Access is granted per person by role. Administrators manage everything, legal and finance edit records, board members and viewers read the full table, and employees and investors see only their own holdings.',
    why: 'A cap table carries compensation information, personal details and financing terms that are not yet public. One over broad invitation exposes every holder\'s position.',
    points: [
      'Least privilege is the practice of granting each person the narrowest role that still covers their work.',
      'Only administrators can invite people, change roles or edit the company record.',
      'The employee and investor roles open a personal portal limited to the holdings of the stakeholder they are linked to.',
      'Auditors and diligence readers usually need reading rights alone, which the viewer role gives without any edit access.',
      'A person holds one role at a time, and removing the role removes access to the company\'s data.',
    ],
    seeAlso: [
      { to: '/company', label: 'Company' },
      { to: '/audit', label: 'Audit log' },
      { to: '/portal', label: 'My equity' },
    ],
  },
  calculator: {
    title: 'What is a holding worth at today\'s numbers?',
    summary: 'The calculator converts between a share count, an ownership percentage and a dollar value. It uses the current cap table and the fair market value from the active 409A valuation.',
    why: 'Equity questions get answered quickly in offers and hallway conversations. An ownership figure quoted against the wrong share count can be off by a wide margin.',
    points: [
      'Ownership depends on the denominator, so a holding is a smaller percentage fully diluted than it is of outstanding shares.',
      'Fully diluted adds outstanding options, restricted stock units, warrants and the unissued option pool to the issued shares.',
      'The cash cost of exercising an option is the strike price multiplied by the number of shares being exercised.',
      'The spread at exercise, fair market value minus strike price, is ordinary income on a nonqualified stock option and an alternative minimum tax adjustment on an incentive stock option.',
      'These figures ignore liquidation preferences and conversion terms, which decide what a holding actually pays at an exit.',
    ],
    seeAlso: [
      { to: '/grants', label: 'Equity grants' },
      { to: '/compliance/409a', label: '409A valuations' },
      { to: '/model/exit', label: 'Exit waterfall' },
    ],
  },
  'ai-assistant': {
    title: 'Where do the assistant\'s answers come from?',
    summary: 'The assistant sends your question, together with a snapshot of this company\'s cap table, to a language model you set up with your own key. The answer is written by that model rather than calculated by this app.',
    why: 'A language model writes confident sentences whether or not it has the arithmetic right, so an answer here can be wrong and still read well. The figures on every other page are read straight from the records, and those pages are the record.',
    points: [
      'The snapshot carries real stakeholder names, share counts and the terms recorded against them to the provider you chose, so asking a question means sharing that information with that company.',
      'The whole snapshot can be read before anything is sent, from the link under the question box or from these settings.',
      'Nothing asked here changes a record, because the assistant only reads the snapshot and writes text back.',
      'Any figure worth acting on should be confirmed on the page that owns it, such as the cap table, equity grants or the exit waterfall.',
      'The key is stored for you rather than for the company, so it works across every company you can open, and it can be replaced or deleted here in Preferences.',
    ],
    seeAlso: [
      { to: '/cap-table', label: 'Cap table' },
      { to: '/grants', label: 'Equity grants' },
      { to: '/model/exit', label: 'Exit waterfall' },
    ],
  },
};
