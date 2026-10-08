import type { IconName } from './icons.tsx';

export type Requirement = 'edit' | 'viewAll' | 'admin';
export interface NavChild { to: string; label: string; requires?: Requirement }
export interface NavItem {
  /** Absent for a section that only folds its sub-items open and closed. */
  to?: string;
  label: string;
  icon: IconName;
  requires?: Requirement;
  /** Sub-pages shown under the item when its section is expanded. */
  children?: NavChild[];
}
export interface NavGroup { label: string; items: NavItem[] }

/** The sidebar, and the "Pages" section of the search palette. */
export const NAV: NavGroup[] = [
  { label: '', items: [
    { to: '/', label: 'Overview', icon: 'home', requires: 'viewAll' },
    { to: '/cap-table', label: 'Cap table', icon: 'table', requires: 'viewAll', children: [
      { to: '/share-classes', label: 'Share classes' },
      { to: '/plans', label: 'Plans & vesting' },
      { to: '/certificates', label: 'Share & certificates' },
      { to: '/convertibles', label: 'SAFEs & notes' },
      { to: '/grants', label: 'Equity grants' },
      { to: '/warrants', label: 'Warrants' },
      { to: '/offers', label: 'Offer letters' },
    ] },
    { to: '/compliance', label: 'Compliance & tax', icon: 'shield', requires: 'viewAll', children: [
      { to: '/compliance/409a', label: '409A valuations' },
      { to: '/compliance/iso-100k', label: 'ISO $100K limit' },
      { to: '/compliance/rule-701', label: 'Rule 701' },
      { to: '/compliance/83b', label: '83(b) elections' },
      { to: '/compliance/form-3921', label: 'Form 3921' },
      { to: '/compliance/boi', label: 'BOI reporting' },
    ] },
    { label: 'Governance', icon: 'bank', children: [
      { to: '/documents', label: 'Documents' },
      { to: '/templates', label: 'Templates', requires: 'viewAll' },
      { to: '/updates', label: 'Investor updates', requires: 'viewAll' },
      { to: '/consents', label: 'Board consents', requires: 'viewAll' },
      { to: '/ledger', label: 'Transactions', requires: 'viewAll' },
      { to: '/reports', label: 'Reports', requires: 'viewAll' },
      { to: '/stock-comp', label: 'Stock comp (ASC 718)', requires: 'viewAll' },
      { to: '/audit', label: 'Audit log', requires: 'viewAll' },
    ] },
    { to: '/stakeholders', label: 'Stakeholders', icon: 'users', requires: 'viewAll' },
  ] },
  { label: 'Modeling', items: [
    { to: '/model/round', label: 'Round modeling', icon: 'trending', requires: 'viewAll' },
    { to: '/model/exit', label: 'Exit waterfall', icon: 'waterfall', requires: 'viewAll' },
    { to: '/tools/calculator', label: 'Share calculator', icon: 'calculator', requires: 'viewAll' },
  ] },
  { label: 'Workspace', items: [
    { to: '/company', label: 'Company', icon: 'settings', requires: 'admin' },
    { to: '/import', label: 'Import data', icon: 'inbox', requires: 'edit' },
    { to: '/team', label: 'Team & access', icon: 'badge', requires: 'admin' },
  ] },
];
