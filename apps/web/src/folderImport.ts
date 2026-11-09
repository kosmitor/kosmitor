/**
 * Files picked or dropped together with the folders they sit in.
 *
 * `dir` is the folder the file was in on the computer, relative to what was
 * picked and keeping the picked folder's own name: dropping "Series A" holding
 * "Term sheet/ts.pdf" gives dir "Series A/Term sheet". Loose files have none.
 * The upload adds it under the folder chosen in the dialog, so the structure
 * on the computer is the structure on the page.
 */
export interface Picked { file: File; dir: string }

/** Files the operating system leaves in folders that nobody means to store. */
const JUNK = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
const isJunk = (name: string) => JUNK.has(name.toLowerCase()) || name.startsWith('._');

/**
 * The folder each file was picked in, remembered by the file itself. Files travel
 * through the import page as plain File objects, and the ones kept as documents
 * need to go back into the folder they came from.
 */
const homes = new WeakMap<File, string>();
export const rememberDir = (file: File, dir: string): File => { if (dir) homes.set(file, dir); return file; };
export const dirOf = (file: File): string => homes.get(file) ?? '';
/** A file's own name, without the folder a duplicate may have been given. */
export const baseName = (file: File): string => file.name.slice(file.name.lastIndexOf('/') + 1);

export const plain = (files: Iterable<File>): Picked[] => Array.from(files, (file) => ({ file, dir: '' }));

/** From a file input, where the browser reports each file's path (folder pickers only). */
export function fromInput(files: FileList): Picked[] {
  return Array.from(files).filter((f) => !isJunk(f.name)).map((file) => {
    const rel = file.webkitRelativePath;
    const cut = rel.lastIndexOf('/');
    return { file, dir: cut > 0 ? rel.slice(0, cut) : '' };
  });
}

type Entry = FileSystemEntry;

const readFile = (e: FileSystemFileEntry) => new Promise<File>((res, rej) => e.file(res, rej));
const readBatch = (r: FileSystemDirectoryReader) => new Promise<Entry[]>((res, rej) => r.readEntries(res, rej));

async function walk(entry: Entry, dir: string, out: Picked[]): Promise<void> {
  if (entry.isFile) {
    if (isJunk(entry.name)) return;
    out.push({ file: await readFile(entry as FileSystemFileEntry), dir });
    return;
  }
  if (!entry.isDirectory) return;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const inside = dir ? `${dir}/${entry.name}` : entry.name;
  // A reader hands back its entries in batches (100 at a time in Chrome) until it returns none.
  for (let batch = await readBatch(reader); batch.length > 0; batch = await readBatch(reader)) {
    for (const child of batch) await walk(child, inside, out);
  }
}

/**
 * Everything in a drop, folders opened down to the last file. The entries are
 * taken before anything is awaited, because the browser empties the drop once
 * the event handler returns.
 */
export async function fromDrop(data: DataTransfer): Promise<Picked[]> {
  const entries: Entry[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) return plain(Array.from(data.files).filter((f) => !isJunk(f.name)));
  const out: Picked[] = [];
  for (const entry of entries) await walk(entry, '', out);
  return out;
}

/** The folder a picked file goes to: the one chosen, with its own folders under it. */
export const targetFolder = (base: string, dir: string): string => [base, dir].filter((s) => s !== '').join('/');
