/** A small hand-drawn stroke icon set so the app carries no external icon dependency. */
import { config } from './config.ts';

const PATHS: Record<string, string> = {
  // The built-in mark at icon size: the shield and its three lines. <Logo> draws it at its own proportions.
  logo: 'M4.13 6.33A2.58 2.58 0 0 1 6.7 3.75h10.6a2.58 2.58 0 0 1 2.58 2.58v5.74C19.88 16.88 14.86 19.92 12 21 9.14 19.92 4.13 16.88 4.13 12.07ZM7.88 7.88h8.25M7.88 11.25h8.25M7.88 14.63h8.25',
  home: 'M3.5 10.5 12 3.5l8.5 7M5.5 9.5V20h13V9.5M10 20v-6h4v6',
  table: 'M3.5 5.5h17v13h-17zM3.5 10h17M9 10v8.5M15 10v8.5',
  users: 'M8 11a3.2 3.2 0 1 0 0-6.5A3.2 3.2 0 0 0 8 11ZM2.5 19.5c0-3 2.5-5 5.5-5s5.5 2 5.5 5M16 5.2a3 3 0 0 1 0 5.8M17.5 14.8c2 .7 4 2.3 4 4.7',
  layers: 'm12 3.5 8.5 4.5L12 12.5 3.5 8zM3.5 12.5 12 17l8.5-4.5M3.5 16.5 12 21l8.5-4.5',
  certificate: 'M6 3.5h9l4 4V16H6zM15 3.5V8h4M8.5 19.5 12 17l3.5 2.5V14h-7z',
  award: 'M12 13.5a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM8.5 12.5 7 21l5-2.5L17 21l-1.5-8.5',
  convert: 'M4 8h13l-3-3M20 16H7l3 3',
  ticket: 'M3.5 8.5V6.5h17v2a2 2 0 0 0 0 7v2h-17v-2a2 2 0 0 0 0-7ZM10 7v10',
  calendar: 'M4 6.5h16v14H4zM4 11h16M8.5 3.5v5M15.5 3.5v5',
  phone: 'M6.5 3.5h3l1.5 4-2 1.5a11 11 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2 2A16.5 16.5 0 0 1 4.5 5.5a2 2 0 0 1 2-2Z',
  chart: 'M4 20V4M4 20h16M8 17V11M12.5 17V7M17 17v-4',
  trending: 'M3.5 16.5 9 11l3.5 3.5L20.5 6M20.5 6h-5M20.5 6v5',
  waterfall: 'M3.5 5.5h4v5h-4zM10 10.5h4v5h-4zM16.5 15.5h4v4h-4zM7.5 8h2.5M14 13h2.5',
  shield: 'M12 3.5 5 6v6c0 4 3 7 7 8.5 4-1.5 7-4.5 7-8.5V6zM9 12l2 2 4-4',
  document: 'M6 3.5h8l4.5 4.5v12H6zM14 3.5V8h4.5M9 12.5h6M9 16h6',
  folder: 'M3.5 6.5A1.5 1.5 0 0 1 5 5h4.2l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5Z',
  folderPlus: 'M3.5 6.5A1.5 1.5 0 0 1 5 5h4.2l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5ZM12 10.5v5.5M9.25 13.25h5.5',
  gavel: 'm5 19 6-6M8 8l5 5M11 5l8 8M9.5 3.5l3.5 3.5M17 11l3.5 3.5M3.5 20.5h7',
  ledger: 'M5 3.5h14v17H5zM9 8h6M9 12h6M9 16h3',
  download: 'M12 3.5v11M8 11l4 4 4-4M4.5 19.5h15',
  history: 'M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3.5 5v4h4M12 7.5V12l3 2',
  wallet: 'M3.5 7.5h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-14zM3.5 7.5V6a1.5 1.5 0 0 1 1.5-1.5h11M16 12.5h2',
  key: 'M14.5 9.5a4 4 0 1 1-4-4M14.5 9.5 21 3M18 6l2 2M16 8l1.5 1.5',
  lock: 'M8 11V8a4 4 0 0 1 8 0v3M6.5 11h11a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 18.5v-6A1.5 1.5 0 0 1 6.5 11ZM12 14.5v2',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2l-.3-2.5h-4l-.3 2.5a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.3 2.5h4l.3-2.5a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.07-.4.1-.8.1-1.2Z',
  plus: 'M12 5v14M5 12h14',
  chevron: 'm7 10 5 5 5-5',
  menu: 'M4 7h16M4 12h16M4 17h16',
  signout: 'M9 4.5H5.5v15H9M14 8.5l3.5 3.5L14 15.5M17.5 12H9',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM15.5 15.5 20 20',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  alert: 'M12 8v5M12 16.5v.5M10.3 4.2 2.8 17.5a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14.5 5.5l4 4',
  trash: 'M4.5 6.5h15M9 6.5V4h6v2.5M6.5 6.5 7.5 20h9l1-13.5M10 10v6M14 10v6',
  external: 'M14 4.5h5.5V10M19 5l-8 8M17 14v5.5H4.5V7H10',
  sparkle: 'M12 3.5 13.8 9l5.7 1.8-5.7 1.8L12 18.5l-1.8-5.9L4.5 10.8 10.2 9zM18.5 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z',
  filter: 'M3.5 5.5h17l-6.5 7.5v6l-4 2v-8z',
  copy: 'M8 8V5.5h11v11H16M5 8h11v11H5z',
  link: 'M10 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1.5 1.5M14 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1.5-1.5',
  clock: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17ZM12 7v5.2l3.2 2',
  bank: 'M3.5 9.5 12 4l8.5 5.5M5.5 10v8M10 10v8M14 10v8M18.5 10v8M3 20.5h18',
  badge: 'M7 4.5h10a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2ZM9.5 4.5v2h5v-2M12 12.5a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5ZM8.5 17c.5-1.7 1.9-2.5 3.5-2.5s3 .8 3.5 2.5',
  scale: 'M12 4v16M7 20h10M5 8h14M5 8 2.5 14h5zM19 8l-2.5 6h5z',
  target: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17ZM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 13.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z',
  inbox: 'M3.5 13.5h4l1.5 3h6l1.5-3h4M3.5 13.5 6 5h12l2.5 8.5v5h-17z',
  megaphone: 'M4 10v4a1 1 0 0 0 1 1h2l3 4.5V4.5L7 9H5a1 1 0 0 0-1 1ZM10 9l9-4v14l-9-4M16 10.5v3',
  chat: 'M4 5.5h16v10.5h-8.5L7 20v-4H4zM8 9.5h8M8 13h5',
  calculator: 'M6 3.5h12v17H6zM8.5 6.5h7v3h-7zM8.5 12.5h1M11.5 12.5h1M14.5 12.5h1M8.5 15.5h1M11.5 15.5h1M14.5 15.5v2.5',
  help: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17ZM9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.8-.9 1.4v.8M12 16.8v.2',
  more: 'M5.6 12h.8M11.6 12h.8M17.6 12h.8',
  send: 'M20.5 3.5 10 14M20.5 3.5l-6.7 17-3.8-6.5-6.5-3.8 17-6.7Z',
  eye: 'M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12ZM12 14.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2Z',
  // A clipboard with a tick: the header's "My pending actions".
  tasks: 'M9 3.75h6v3H9zM9 5.25H6.5A1.5 1.5 0 0 0 5 6.75V19.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V6.75a1.5 1.5 0 0 0-1.5-1.5H15M8.75 13.5l2.25 2.25 4.25-4.5',
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = 'size-4' }: { name: IconName; className?: string }) {
  const d = PATHS[name] ?? PATHS.alert;
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

/**
 * The product's mark. With brand.logoUrl set in kosmitor.config.json it is that
 * image, in the same box. Otherwise it is the built-in shield with three lines,
 * in the brand colour unless the class says otherwise: the same drawing as
 * public/logo.svg and the favicon, kept at its own stroke weight so it reads
 * the same at every size.
 */
export function Logo({ className = 'size-9 text-brand-600', title }: { className?: string; title?: string }) {
  const src = config.brand.logoUrl;
  // Without a title the name is written beside it, so the image is decoration.
  if (src) return <img src={src} alt={title ?? ''} className={`${className} object-contain`} />;
  return (
    <svg viewBox="0 0 1024 1024" className={className} fill="none" stroke="currentColor" strokeWidth="60"
      strokeLinecap="round" strokeLinejoin="round" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true}>
      {title && <title>{title}</title>}
      <path d="M176 270A110 110 0 0 1 286 160H738A110 110 0 0 1 848 270V515C848 720 634 850 512 896C390 850 176 720 176 515Z" />
      <path d="M336 336H688M336 480H688M336 624H688" />
    </svg>
  );
}
