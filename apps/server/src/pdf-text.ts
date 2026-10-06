/**
 * The text of a PDF, page by page, read with nothing but Node's own zlib.
 *
 * It has one job: reading the values an appraisal report states (the fair market
 * value, the valuation date, the method) so that a person checks them rather than
 * types them. So it reads what a report written by software carries, text drawn
 * with fonts, and gives up plainly on the rest: an encrypted file, a stream packed
 * with a filter other than Flate, a scan with no text in it.
 *
 * The file comes from outside the company, through a link, so it is read as a
 * hostile one. Every stream is inflated with a ceiling on what it may grow to, the
 * bytes inflated and the objects found are counted against limits, nesting is
 * bounded, and whatever goes wrong inside comes back as a reason, never a crash.
 * The ceiling on the bytes inflated grows with the file, so a small file cannot
 * ask for as much as a large one.
 *
 * What a small file can make the reader do over and over is counted too. Content
 * counts each time a page or a form draws it, not once per stream, and so does
 * every object unpacked and every character map read; a table that a thousand
 * fonts share is built once, and every font's tables count against one budget
 * for the whole file; the forms drawn and the text that comes out have limits of
 * their own. Whatever a file shares, the work it can ask for grows with what it
 * holds, not with how often it points at it. The server also reads uploads in a
 * worker with its own time and memory limits (report-reader.ts), so a case these
 * limits did not foresee still cannot hold up anything else.
 *
 * It does not lay a page out. Text comes in the order the page draws it, which
 * for a report is the order it reads in, with a line break wherever the drawing
 * moves to another line and a space wherever it skips across one.
 */
import { inflateSync, constants } from 'node:zlib';

export interface PdfTextLimits {
  /** The most one stream may inflate to, in bytes. */
  streamBytes?: number;
  /**
   * The most every stream read may inflate to together, in bytes. By default
   * eight times the file's own size, at least 4 MB and at most 64 MB: a report's
   * text inflates to a few times what it takes in the file, and a file that
   * inflates far beyond that was built to.
   */
  totalBytes?: number;
  /** The most objects a file may hold, counting the ones packed in object streams. */
  objects?: number;
  /**
   * The most bytes the reader may go through once they are inflated, as many as
   * totalBytes by default. Content counts each time a page or a form draws it,
   * since each time it is read again, and so does each object unpacked from an
   * object stream and each character map. Each page, each part of a page and each
   * form drawn counts a little besides, so that a list of a million references to
   * nothing is not free.
   */
  readBytes?: number;
  /** The most times the pages may draw a form, together. */
  forms?: number;
  /**
   * The most entries the fonts' tables may be given together: character codes,
   * widths and glyph names. A table that several fonts share counts once.
   */
  fontCodes?: number;
  /** The most characters of text the pages may come to together. */
  characters?: number;
  /** The most characters of text one page may come to. A page of a report has some thousands. */
  pageCharacters?: number;
}

export type PdfText =
  | { readable: true; pages: string[] }
  | { readable: false; reason: 'not-pdf' | 'encrypted' | 'unreadable' | 'too-large' };

const LIMITS: Omit<Required<PdfTextLimits>, 'totalBytes' | 'readBytes'> = {
  streamBytes: 20 * 1024 * 1024, objects: 250_000, forms: 50_000, fontCodes: 1_000_000, characters: 4_000_000,
  pageCharacters: 1_000_000,
};

/** What a file may inflate to, and be read through, unless the caller says otherwise: eight times its size, within these bounds. */
const BUDGET = { times: 8, least: 4 * 1024 * 1024, most: 64 * 1024 * 1024 };
const budgetFor = (size: number): number => Math.min(BUDGET.most, Math.max(BUDGET.least, size * BUDGET.times));

/** What a page, a part of a page or a form drawn costs against readBytes, beyond its own bytes. */
const STEP = 64;

/** How deep arrays, dictionaries, page trees and forms may nest. Real files stay far below it. */
const MAX_DEPTH = 64;

class TooLarge extends Error {}
class Encrypted extends Error {}

// --- The objects a PDF is made of ------------------------------------------------
// Plain classes with fields set in the constructor, since the server runs its
// TypeScript with the types stripped and parameter properties are not types.

class Name { name: string; constructor(name: string) { this.name = name; } }
class Ref { num: number; constructor(num: number) { this.num = num; } }
class Dict {
  map: Map<string, Value>;
  constructor(map = new Map<string, Value>()) { this.map = map; }
  get(key: string): Value | undefined { return this.map.get(key); }
}
class Stream { dict: Dict; raw: Buffer; constructor(dict: Dict, raw: Buffer) { this.dict = dict; this.raw = raw; } }
/** A keyword: an operator in a content stream, or obj, stream, R and the like in the file. */
class Op { op: string; constructor(op: string) { this.op = op; } }
type Value = null | boolean | number | Buffer | Name | Ref | Dict | Stream | Op | Value[];

// --- Reading tokens --------------------------------------------------------------

const SPACE = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) SPACE[c] = 1;
const DELIMITER = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIMITER[c.charCodeAt(0)] = 1;
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

type Token =
  | { k: 'eof' } | { k: 'num'; v: number; int: boolean } | { k: 'str'; v: Buffer } | { k: 'name'; v: string }
  | { k: 'kw'; v: string } | { k: '[' } | { k: ']' } | { k: '<<' } | { k: '>>' };

const EOF: Token = { k: 'eof' };
const OPEN_ARRAY: Token = { k: '[' };
const CLOSE_ARRAY: Token = { k: ']' };
const OPEN_DICT: Token = { k: '<<' };
const CLOSE_DICT: Token = { k: '>>' };

/** Bytes collected one at a time, in a buffer that doubles as it fills, so a long string costs bytes rather than an array of numbers. */
class Bytes {
  buf = Buffer.allocUnsafe(64);
  length = 0;
  push(b: number): void {
    if (this.length === this.buf.length) {
      const bigger = Buffer.allocUnsafe(this.buf.length * 2);
      this.buf.copy(bigger);
      this.buf = bigger;
    }
    this.buf[this.length++] = b;
  }
  done(): Buffer { return Buffer.from(this.buf.subarray(0, this.length)); }
}

const hexValue = (c: number): number =>
  c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1;

class Lexer {
  buf: Buffer;
  pos: number;
  end: number;
  constructor(buf: Buffer, start = 0, end = buf.length) { this.buf = buf; this.pos = start; this.end = end; }

  private skipSpace(): void {
    const b = this.buf;
    while (this.pos < this.end) {
      const c = b[this.pos];
      if (SPACE[c]) { this.pos++; continue; }
      if (c === 0x25) {   // % starts a comment that runs to the end of the line
        while (this.pos < this.end && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos++;
        continue;
      }
      return;
    }
  }

  next(): Token {
    const b = this.buf;
    for (;;) {
      this.skipSpace();
      if (this.pos >= this.end) return EOF;
      const c = b[this.pos];
      if (c === 0x28) return { k: 'str', v: this.literal() };
      if (c === 0x3c) {
        if (b[this.pos + 1] === 0x3c) { this.pos += 2; return OPEN_DICT; }
        return { k: 'str', v: this.hex() };
      }
      if (c === 0x3e) {
        this.pos++;
        if (b[this.pos] === 0x3e) { this.pos++; return CLOSE_DICT; }
        continue;   // a stray >
      }
      if (c === 0x5b) { this.pos++; return OPEN_ARRAY; }
      if (c === 0x5d) { this.pos++; return CLOSE_ARRAY; }
      if (c === 0x2f) return { k: 'name', v: this.name() };
      if (c === 0x29 || c === 0x7b || c === 0x7d) { this.pos++; continue; }   // a stray ), or the braces of a PostScript function
      const start = this.pos;
      while (this.pos < this.end && !SPACE[b[this.pos]] && !DELIMITER[b[this.pos]]) this.pos++;
      const word = b.toString('latin1', start, this.pos);
      if (NUMBER.test(word)) return { k: 'num', v: Number(word), int: !word.includes('.') };
      // A malformed number such as "--1" or "1.2.3" reads as a number, as readers take it.
      if (/^[-+.\d]+$/.test(word) && /\d/.test(word)) return { k: 'num', v: Number.parseFloat(word.replace(/^[+-]+/, (signs) => (signs.includes('-') ? '-' : ''))) || 0, int: false };
      return { k: 'kw', v: word };
    }
  }

  /**
   * Whether what follows is the rest of a reference, a generation number and R as
   * in "12 0 R", stepping past it when it is. Read from the bytes rather than as
   * two tokens, since every number in a file's objects asks it, and a file of
   * numbers would otherwise be read three times over.
   */
  reference(): boolean {
    const b = this.buf;
    const save = this.pos;
    this.skipSpace();
    let i = this.pos;
    if (b[i] === 0x2b) i++;
    const digits = i;
    while (i < this.end && b[i] >= 0x30 && b[i] <= 0x39) i++;
    if (i > digits && (i >= this.end || SPACE[b[i]] || DELIMITER[b[i]])) {
      this.pos = i;
      this.skipSpace();
      const r = this.pos;
      if (r < this.end && b[r] === 0x52 && (r + 1 >= this.end || SPACE[b[r + 1]] || DELIMITER[b[r + 1]])) {
        this.pos = r + 1;
        return true;
      }
    }
    this.pos = save;
    return false;
  }

  /** A literal string: escapes, octal codes, line continuations and balanced parentheses. */
  private literal(): Buffer {
    const b = this.buf;
    const out = new Bytes();
    let depth = 1;
    this.pos++;
    while (this.pos < this.end) {
      const c = b[this.pos++];
      if (c === 0x5c) {
        if (this.pos >= this.end) break;
        const e = b[this.pos++];
        if (e === 0x6e) out.push(0x0a);
        else if (e === 0x72) out.push(0x0d);
        else if (e === 0x74) out.push(0x09);
        else if (e === 0x62) out.push(0x08);
        else if (e === 0x66) out.push(0x0c);
        else if (e === 0x0d) { if (b[this.pos] === 0x0a) this.pos++; }   // a line continued
        else if (e === 0x0a) { /* a line continued */ }
        else if (e >= 0x30 && e <= 0x37) {
          let v = e - 0x30;
          for (let i = 0; i < 2 && this.pos < this.end && b[this.pos] >= 0x30 && b[this.pos] <= 0x37; i++) v = v * 8 + b[this.pos++] - 0x30;
          out.push(v & 0xff);
        } else out.push(e);   // \( \) \\ and anything else stand for themselves
        continue;
      }
      if (c === 0x28) depth++;
      else if (c === 0x29 && --depth === 0) break;
      if (c === 0x0d) { if (b[this.pos] === 0x0a) this.pos++; out.push(0x0a); continue; }
      out.push(c);
    }
    return out.done();
  }

  /** A hex string: white space ignored, and an odd last digit read as if followed by 0. */
  private hex(): Buffer {
    const b = this.buf;
    const out = new Bytes();
    let high = -1;
    this.pos++;
    while (this.pos < this.end) {
      const c = b[this.pos++];
      if (c === 0x3e) break;
      const v = hexValue(c);
      if (v < 0) continue;
      if (high < 0) high = v;
      else { out.push((high << 4) | v); high = -1; }
    }
    if (high >= 0) out.push(high << 4);
    return out.done();
  }

  /** A name, with its #xx escapes decoded. */
  private name(): string {
    const b = this.buf;
    this.pos++;
    const out = new Bytes();
    while (this.pos < this.end && !SPACE[b[this.pos]] && !DELIMITER[b[this.pos]]) {
      const c = b[this.pos++];
      if (c === 0x23 && this.pos + 1 < this.end) {
        const h = hexValue(b[this.pos]), l = hexValue(b[this.pos + 1]);
        if (h >= 0 && l >= 0) { out.push((h << 4) | l); this.pos += 2; continue; }
      }
      out.push(c);
    }
    return out.done().toString('latin1');
  }
}

/**
 * One value from the token just read. `refs` reads "12 0 R" as a reference, which
 * only the file's own objects use; a content stream never does, and reading ahead
 * after each of its many numbers would only slow it down.
 */
function parseValue(lx: Lexer, tok: Token, refs: boolean, depth = 0): Value {
  switch (tok.k) {
    case 'num': {
      if (refs && tok.int && tok.v >= 0 && lx.reference()) return new Ref(tok.v);
      return tok.v;
    }
    case 'str': return tok.v;
    case 'name': return new Name(tok.v);
    case '[': {
      if (depth > MAX_DEPTH) throw new Error('nested too deeply');
      const list: Value[] = [];
      for (;;) {
        const t = lx.next();
        if (t.k === ']' || t.k === 'eof') return list;
        list.push(parseValue(lx, t, refs, depth + 1));
      }
    }
    case '<<': {
      if (depth > MAX_DEPTH) throw new Error('nested too deeply');
      const dict = new Dict();
      for (;;) {
        const t = lx.next();
        if (t.k === '>>' || t.k === 'eof') return dict;
        if (t.k !== 'name') continue;   // a stray value where a key belongs
        const v = lx.next();
        if (v.k === '>>' || v.k === 'eof') { dict.map.set(t.v, null); return dict; }
        dict.map.set(t.v, parseValue(lx, v, refs, depth + 1));
      }
    }
    case 'kw':
      if (tok.v === 'true') return true;
      if (tok.v === 'false') return false;
      if (tok.v === 'null') return null;
      return new Op(tok.v);
    default:
      return null;
  }
}

// --- The file's objects ------------------------------------------------------------

interface Found { value: Value; at: number }

/** Where an object starts: its number, generation and "obj", not in the middle of a larger number. */
const OBJECT_HEADER = /(\d{1,10})[\0\t\n\f\r ]+(\d{1,5})[\0\t\n\f\r ]+obj(?![^\0\t\n\f\r ()<>[\]{}/%])/g;
const TRAILER = /trailer[\0\t\n\f\r ]*<</g;

class PdfFile {
  buf: Buffer;
  limits: Required<PdfTextLimits>;
  objects = new Map<number, Found>();
  /** The trailer dictionaries, and the dictionaries of cross-reference streams, in the order the file has them. */
  trailers: { dict: Dict; at: number }[] = [];
  private inflated = 0;
  private count = 0;
  private decoded = new WeakMap<Stream, Buffer | null>();
  /**
   * The tables fonts are built from, each built once however many fonts point at
   * the same stream or value: a file can give a thousand fonts one map, and
   * building it a thousand times is the attack.
   */
  readonly cmaps = new WeakMap<Stream, Map<number, string> | null>();
  readonly cidWidths = new WeakMap<Value[], Map<number, number>>();
  readonly widths = new WeakMap<Value[], number[]>();
  readonly differences = new WeakMap<Value[], Map<number, string>>();
  /** What the reading has used so far of its limits, as against the limits on the file. */
  private read = 0;
  private formsDrawn = 0;
  private codes = 0;
  private characters = 0;
  private pageCharacters = 0;

  constructor(buf: Buffer, limits: Required<PdfTextLimits>) {
    this.buf = buf;
    this.limits = limits;
  }

  private counted(): void {
    if (++this.count > this.limits.objects) throw new TooLarge();
  }

  /** Bytes about to be read: a page's content, a form's each time it is drawn, an object unpacked, a map. */
  reads(bytes: number): void {
    this.read += bytes;
    if (this.read > this.limits.readBytes) throw new TooLarge();
  }

  /** A form about to be drawn. */
  drawsForm(): void {
    if (++this.formsDrawn > this.limits.forms) throw new TooLarge();
  }

  /** One more entry in a font's tables: a character code, a width, a glyph name. */
  maps(): void {
    if (++this.codes > this.limits.fontCodes) throw new TooLarge();
  }

  /** A page about to be read: what it costs, and a fresh count of its text. */
  startsPage(): void {
    this.reads(STEP);
    this.pageCharacters = 0;
  }

  /** Text about to come out of the page. */
  writes(characters: number): void {
    this.characters += characters;
    this.pageCharacters += characters;
    if (this.characters > this.limits.characters || this.pageCharacters > this.limits.pageCharacters) throw new TooLarge();
  }

  /** How many more characters the page may come to. */
  charactersLeft(): number {
    return Math.min(this.limits.characters - this.characters, this.limits.pageCharacters - this.pageCharacters);
  }

  /** A ToUnicode map, read once however many fonts point at it. */
  toUnicode(s: Stream): Map<number, string> | null {
    return once(this.cmaps, s, () => {
      const data = this.decode(s);
      if (!data) return null;
      this.reads(data.length);
      return parseCMap(data, () => this.maps());
    });
  }

  /**
   * Finds every object by reading the file from the start rather than trusting its
   * cross-reference table, which is often wrong in files that have been edited, and
   * steps over each stream's data so nothing inside one is taken for an object.
   * A later definition of an object replaces an earlier one, as an update does.
   */
  scan(): void {
    const buf = this.buf;
    const src = buf.toString('latin1');
    OBJECT_HEADER.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = OBJECT_HEADER.exec(src))) {
      const before = m.index > 0 ? src.charCodeAt(m.index - 1) : 0x20;
      if (before >= 0x30 && before <= 0x39) continue;
      this.counted();
      const lx = new Lexer(buf, OBJECT_HEADER.lastIndex);
      let value: Value;
      try {
        value = parseValue(lx, lx.next(), true);
      } catch {
        // Nested past the limit, which no real file is. What it swallowed is not
        // read again for the objects inside it, or each would cost the whole of it.
        OBJECT_HEADER.lastIndex = Math.max(OBJECT_HEADER.lastIndex, lx.pos);
        continue;
      }
      const after = lx.pos;
      const next = lx.next();
      if (value instanceof Dict && next.k === 'kw' && next.v === 'stream') {
        let start = lx.pos;
        if (buf[start] === 0x0d) start++;
        if (buf[start] === 0x0a) start++;
        const declared = value.get('Length');
        let end = -1;
        if (typeof declared === 'number' && Number.isInteger(declared) && declared >= 0 && start + declared <= buf.length
          && /^[\0\t\n\f\r ]*endstream/.test(src.slice(start + declared, start + declared + 64))) {
          end = start + declared;
        }
        if (end < 0) {
          // The length is another object, or wrong: the data runs to "endstream",
          // less the line break written before it.
          const at = src.indexOf('endstream', start);
          end = at < 0 ? buf.length : at;
          if (end > start && buf[end - 1] === 0x0a) end--;
          if (end > start && buf[end - 1] === 0x0d) end--;
        }
        value = new Stream(value, buf.subarray(start, end));
        OBJECT_HEADER.lastIndex = end;
        if (nameOf(value.dict.get('Type')) === 'XRef') this.trailers.push({ dict: value.dict, at: m.index });
      } else {
        OBJECT_HEADER.lastIndex = after;
      }
      this.objects.set(Number(m[1]), { value, at: m.index });
    }

    TRAILER.lastIndex = 0;
    while ((m = TRAILER.exec(src))) {
      const lx = new Lexer(buf, m.index + m[0].length - 2);
      try {
        const dict = parseValue(lx, lx.next(), true);
        if (dict instanceof Dict) this.trailers.push({ dict, at: m.index });
      } catch { /* a damaged trailer: the objects may still be enough */ }
      // The next trailer is looked for after this one, not inside it: a trailer
      // left open runs to the end of the file, and so would each one after it.
      TRAILER.lastIndex = Math.max(TRAILER.lastIndex, lx.pos);
    }
    this.trailers.sort((a, b) => a.at - b.at);
    if (this.trailers.some((t) => t.dict.get('Encrypt') != null)) throw new Encrypted();
  }

  /** Unpacks object streams: the objects a compressed file keeps inside other objects. */
  unpack(): void {
    for (const [, found] of [...this.objects]) {
      const s = found.value;
      if (!(s instanceof Stream) || nameOf(s.dict.get('Type')) !== 'ObjStm') continue;
      const data = this.decode(s);
      if (!data) continue;
      const n = this.resolve(s.dict.get('N'));
      const first = this.resolve(s.dict.get('First'));
      if (typeof n !== 'number' || typeof first !== 'number' || n < 0 || first < 0 || first > data.length) continue;
      const header = new Lexer(data, 0, first);
      for (let i = 0; i < n; i++) {
        const num = header.next();
        const offset = header.next();
        if (num.k !== 'num' || offset.k !== 'num') break;
        this.counted();
        const known = this.objects.get(num.v);
        if (known && known.at > found.at) continue;   // replaced by a later update
        if (!offset.int || offset.v < 0) continue;
        const at = first + offset.v;
        const lx = new Lexer(data, at);
        try {
          this.objects.set(num.v, { value: parseValue(lx, lx.next(), true), at: found.at });
        } catch { /* one damaged object; the rest may still read */ }
        // Each object counts what it read, since a header can point every object at one large value.
        this.reads(Math.max(0, lx.pos - at));
      }
    }
  }

  /** Follows a reference, and a reference to a reference, to the value. */
  resolve(v: Value | undefined): Value {
    for (let hops = 0; v instanceof Ref && hops < 32; hops++) v = this.objects.get(v.num)?.value;
    return v instanceof Ref || v === undefined ? null : v;
  }

  dict(v: Value | undefined): Dict | null {
    const d = this.resolve(v);
    return d instanceof Dict ? d : d instanceof Stream ? d.dict : null;
  }

  /**
   * A stream's data, inflated when it is Flate-compressed, or null when it is
   * packed some other way. Each stream is inflated at most once and counted once.
   */
  decode(s: Stream): Buffer | null {
    if (this.decoded.has(s)) return this.decoded.get(s)!;
    const filters = asList(this.resolve(s.dict.get('Filter'))).map((f) => nameOf(this.resolve(f)));
    const params = asList(this.resolve(s.dict.get('DecodeParms'))).map((p) => this.dict(p));
    let data: Buffer | null = s.raw;
    if (filters.some((f) => f !== 'FlateDecode' && f !== 'Fl')) data = null;
    // A predictor is for images and cross-reference tables, never for text.
    else if (params.some((p) => { const v = this.resolve(p?.get('Predictor')); return typeof v === 'number' && v > 1; })) data = null;
    for (let i = 0; data && i < filters.length; i++) data = this.inflate(data);
    if (data && !filters.length) this.spend(data.length);
    this.decoded.set(s, data);
    return data;
  }

  private spend(bytes: number): void {
    this.inflated += bytes;
    if (this.inflated > this.limits.totalBytes) throw new TooLarge();
  }

  private inflate(data: Buffer): Buffer | null {
    const room = Math.min(this.limits.streamBytes, this.limits.totalBytes - this.inflated);
    if (room < 1) throw new TooLarge();
    let out: Buffer;
    try {
      // Sync flush rather than finish: a stream cut short still gives what it has.
      out = inflateSync(data, { maxOutputLength: room, finishFlush: constants.Z_SYNC_FLUSH });
    } catch (err) {
      if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) throw new TooLarge();
      return null;   // damaged data: this stream is lost, the rest may still read
    }
    this.spend(out.length);
    return out;
  }
}

const nameOf = (v: Value | undefined): string | null => (v instanceof Name ? v.name : null);
const asList = (v: Value): Value[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
const numberOf = (v: Value | undefined, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** What `make` builds from `key`, built the first time it is asked for and kept for the rest of the file. */
function once<K extends object, T>(cache: WeakMap<K, T>, key: K, make: () => T): T {
  if (cache.has(key)) return cache.get(key)!;
  const built = make();
  cache.set(key, built);
  return built;
}

// --- Fonts: from the codes a page draws to the characters they stand for --------

/** Latin-1 above 0x9f, with Windows code page 1252 in the range Latin-1 leaves for control codes. */
const CP1252: Record<number, string> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹',
  0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜', 0x99: '™',
  0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};
/** Where the Standard and Mac Roman encodings differ from Latin-1 in ways that matter to reading text. */
const STANDARD: Record<number, string> = { 0x27: '’', 0x60: '‘', 0xa9: "'", 0xaa: '“', 0xba: '”', 0xb1: '–', 0xd0: '—', 0xb7: '•', 0xae: 'fi', 0xaf: 'fl' };
const MAC_ROMAN: Record<number, string> = { 0xca: ' ', 0xd0: '–', 0xd1: '—', 0xd2: '“', 0xd3: '”', 0xd4: '‘', 0xd5: '’', 0xa5: '•', 0xc9: '…', 0xde: 'fi', 0xdf: 'fl' };

function baseEncoding(name: string | null): (code: number) => string {
  const table = name === 'StandardEncoding' ? STANDARD : name === 'MacRomanEncoding' ? MAC_ROMAN : CP1252;
  return (code) => table[code] ?? (code >= 0x20 && code !== 0x7f && (code < 0x80 || code >= 0xa0) ? String.fromCharCode(code) : '');
}

/** The glyph names a font's /Differences use for the characters a report's values are written in. */
const GLYPHS: Record<string, string> = {
  space: ' ', nbspace: ' ', nonbreakingspace: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%',
  ampersand: '&', quotesingle: "'", quoteright: '’', quoteleft: '‘', quotedblleft: '“', quotedblright: '”', quotesinglbase: '‚',
  quotedblbase: '„', parenleft: '(', parenright: ')', asterisk: '*', plus: '+', comma: ',', hyphen: '-', minus: '-', period: '.',
  slash: '/', colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[',
  backslash: '\\', bracketright: ']', underscore: '_', braceleft: '{', braceright: '}', bar: '|', asciitilde: '~', grave: '`',
  asciicircum: '^', endash: '–', emdash: '—', bullet: '•', ellipsis: '…', periodcentered: '·', sterling: '£', euro: '€', yen: '¥',
  section: '§', paragraph: '¶', degree: '°', registered: '®', copyright: '©', trademark: '™',
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl',
};

/** The character a glyph name stands for: a known name, a single letter, uniXXXX or uXXXX, ignoring a suffix such as ".sc". */
function glyph(name: string): string | null {
  const base = name.split('.')[0];
  if (GLYPHS[base]) return GLYPHS[base];
  if (/^[A-Za-z]$/.test(base)) return base;
  const uni = base.match(/^uni((?:[0-9A-Fa-f]{4})+)$/);
  if (uni) return uni[1].match(/.{4}/g)!.map((h) => String.fromCharCode(Number.parseInt(h, 16))).join('');
  const u = base.match(/^u([0-9A-Fa-f]{4,6})$/);
  if (u) { const cp = Number.parseInt(u[1], 16); return cp <= 0x10ffff ? String.fromCodePoint(cp) : null; }
  if (base.includes('_')) {
    const parts = base.split('_').map(glyph);
    return parts.every((p) => p) ? parts.join('') : null;
  }
  return null;
}

/** Text in UTF-16BE, as a ToUnicode CMap gives it. */
function utf16(bytes: Buffer): string {
  if (bytes.length === 1) return String.fromCharCode(bytes[0]);
  let s = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  return s;
}

const codeOf = (bytes: Buffer): number => { let v = 0; for (const b of bytes.subarray(0, 4)) v = v * 256 + b; return v; };

/** The most codes one CMap may map, so a crafted range cannot fill memory. */
const CMAP_ENTRIES = 200_000;

/**
 * A ToUnicode CMap: its bfchar and bfrange sections, including ranges given as
 * arrays. `count` is told of each code given, so the file's budget for every
 * font's tables together stops a crafted map while it is being built. A code
 * given again counts again, or a map that gives one wide range over and over
 * would cost its width each time and count it once.
 */
function parseCMap(data: Buffer, count: () => void): Map<number, string> {
  const map = new Map<number, string>();
  const lx = new Lexer(data);
  const set = (code: number, text: string) => {
    if (map.size >= CMAP_ENTRIES) return;
    count();
    map.set(code, text);
  };
  const target = (v: Value): string | null =>
    Buffer.isBuffer(v) ? utf16(v) : v instanceof Name ? glyph(v.name) : null;
  for (let t = lx.next(); t.k !== 'eof'; t = lx.next()) {
    if (t.k !== 'kw') continue;
    if (t.v === 'beginbfchar') {
      for (;;) {
        const src = lx.next();
        if (src.k === 'eof' || (src.k === 'kw' && src.v === 'endbfchar')) break;
        const dst = parseValue(lx, lx.next(), false);
        const text = target(dst);
        if (src.k === 'str' && text != null) set(codeOf(src.v), text);
      }
    } else if (t.v === 'beginbfrange') {
      for (;;) {
        const lo = lx.next();
        if (lo.k === 'eof' || (lo.k === 'kw' && lo.v === 'endbfrange')) break;
        const hi = lx.next();
        const dst = parseValue(lx, lx.next(), false);
        if (lo.k !== 'str' || hi.k !== 'str') continue;
        const from = codeOf(lo.v);
        const to = Math.min(codeOf(hi.v), from + 0xffff);
        if (Array.isArray(dst)) {
          for (let c = from, i = 0; c <= to && i < dst.length; c++, i++) { const text = target(dst[i]); if (text != null) set(c, text); }
        } else if (Buffer.isBuffer(dst) && dst.length) {
          // Each code past the first maps to the destination with its last character moved on by as much.
          const head = utf16(dst.subarray(0, dst.length >= 2 ? dst.length - 2 : 0));
          const last = dst.length >= 2 ? (dst[dst.length - 2] << 8) | dst[dst.length - 1] : dst[0];
          for (let c = from; c <= to && map.size < CMAP_ENTRIES; c++) set(c, head + String.fromCharCode((last + c - from) & 0xffff));
        }
      }
    }
  }
  return map;
}

interface Font {
  /** Bytes per character code: two for a composite (Type0) font, one for the rest. */
  bytes: 1 | 2;
  text(code: number): string;
  /** How far a code moves the pen, in thousandths of the font size. */
  width(code: number): number;
}

/** How wide a character is likely to be, in thousandths of the size, for a font that does not say. */
function guessWidth(ch: string): number {
  if (!ch) return 500;
  if (/[\s.,:;'’|!il()[\]ftj]/.test(ch)) return 280;
  if (/[mwMW]/.test(ch)) return 830;
  if (/[A-Z]/.test(ch)) return 670;
  return 540;
}

/** Text drawn with no font set, or with one that cannot be read: its bytes as Latin-1. */
const PLAIN: Font = { bytes: 1, text: baseEncoding(null), width: (code) => guessWidth(String.fromCharCode(code)) };

/**
 * A composite font's widths, from its /W array: a code followed by a list of
 * widths, or two codes and the one width of every code from the first to the
 * second. A width that is not a number is kept as NaN, for the font's default.
 * Each width given counts against the file's budget, since a range grows the
 * way a character map's does.
 */
function cidWidths(doc: PdfFile, given: Value[]): Map<number, number> {
  const widths = new Map<number, number>();
  const w = given.map((v) => doc.resolve(v));
  const set = (code: number, width: number) => { doc.maps(); widths.set(code, width); };
  for (let i = 0; i < w.length && widths.size < CMAP_ENTRIES;) {
    const first = w[i];
    const second = w[i + 1];
    if (typeof first !== 'number' || !Number.isFinite(first)) break;
    if (Array.isArray(second)) {
      for (let j = 0; j < second.length && widths.size < CMAP_ENTRIES; j++) set(first + j, numberOf(doc.resolve(second[j]), Number.NaN));
      i += 2;
    } else if (typeof second === 'number') {
      const width = numberOf(doc.resolve(w[i + 2]), Number.NaN);
      for (let c = first; c <= Math.min(second, first + 0xffff) && widths.size < CMAP_ENTRIES; c++) set(c, width);
      i += 3;
    } else break;
  }
  return widths;
}

/** The characters a simple font's /Differences gives its codes: a code, then the glyph names of it and the codes after it. */
function differencesOf(doc: PdfFile, list: Value[]): Map<number, string> {
  const differences = new Map<number, string>();
  let code = 0;
  for (const item of list) {
    if (typeof item === 'number') code = item;
    else if (item instanceof Name) {
      doc.maps();
      const ch = glyph(item.name);
      if (ch != null) differences.set(code, ch);
      code++;
    }
  }
  return differences;
}

function loadFont(doc: PdfFile, dict: Dict): Font {
  const toUnicodeStream = doc.resolve(dict.get('ToUnicode'));
  const toUnicode = toUnicodeStream instanceof Stream ? doc.toUnicode(toUnicodeStream) : null;
  const subtype = nameOf(doc.resolve(dict.get('Subtype')));

  if (subtype === 'Type0') {
    const encoding = nameOf(doc.resolve(dict.get('Encoding'))) ?? '';
    // Without a ToUnicode map, a code is a glyph number and says nothing about the
    // character, unless the encoding is Unicode itself.
    const unicode = /UCS2|UTF16/.test(encoding);
    const descendant = doc.dict(asList(doc.resolve(dict.get('DescendantFonts')))[0]);
    const fallback = numberOf(doc.resolve(descendant?.get('DW')), 1000);
    const w = doc.resolve(descendant?.get('W'));
    const widths = Array.isArray(w) ? once(doc.cidWidths, w, () => cidWidths(doc, w)) : null;
    return {
      bytes: 2,
      text: (code) => toUnicode?.get(code) ?? (unicode ? String.fromCharCode(code) : ''),
      width: (code) => { const width = widths?.get(code); return width === undefined || Number.isNaN(width) ? fallback : width; },
    };
  }

  const encoding = doc.resolve(dict.get('Encoding'));
  const encodingDict = encoding instanceof Dict ? encoding : null;
  const base = baseEncoding(nameOf(encodingDict ? doc.resolve(encodingDict.get('BaseEncoding')) : encoding));
  const list = doc.resolve(encodingDict?.get('Differences'));
  const differences = Array.isArray(list) ? once(doc.differences, list, () => differencesOf(doc, list)) : null;
  const text = (c: number): string => toUnicode?.get(c) ?? differences?.get(c) ?? base(c);

  const first = numberOf(doc.resolve(dict.get('FirstChar')), 0);
  const given = doc.resolve(dict.get('Widths'));
  const widths = Array.isArray(given) ? once(doc.widths, given, () => given.map((v) => { doc.maps(); return numberOf(doc.resolve(v), Number.NaN); })) : [];
  const missing = numberOf(doc.resolve(doc.dict(dict.get('FontDescriptor'))?.get('MissingWidth')), Number.NaN);
  // A Type 3 font measures its glyphs in its own units, which its matrix scales to the font size.
  const matrix = asList(doc.resolve(dict.get('FontMatrix')));
  const unit = subtype === 'Type3' && typeof matrix[0] === 'number' ? matrix[0] * 1000 : 1;
  return {
    bytes: 1,
    text,
    width: (c) => {
      const w = widths[c - first];
      if (Number.isFinite(w)) return w * unit;
      return Number.isFinite(missing) && missing > 0 ? missing * unit : guessWidth(text(c));
    },
  };
}

// --- Drawing a page's text ---------------------------------------------------------

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];
const asMatrix = (v: Value[]): Matrix | null =>
  v.length === 6 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? v as Matrix : null;

/** The lines of one page, as its text is drawn. */
class PageText {
  lines: string[] = [];
  private line = '';
  /**
   * Whether the line ends in a space. Kept rather than asked of the line, since
   * asking makes the engine copy a line built from many pieces into one, and a
   * page drawn all on one line would be copied again at every word.
   */
  private spaced = false;
  private y: number | null = null;
  private size = 0;
  /** Where the last text drawn on this line ended, across the page. */
  private end: number | null = null;

  /** Starts a line, or adds a space, before text drawn at x, y in characters of the given size. */
  at(x: number, y: number, size: number): void {
    const tolerance = Math.max(size, this.size, 1) * 0.5;
    if (this.y === null || Math.abs(y - this.y) > tolerance) {
      this.newLine();
      this.y = y;
      this.size = size;
      return;
    }
    if (this.end !== null) {
      const gap = x - this.end;
      // A skip forward of a fifth of a character or more is a space between words or
      // table cells; a jump far back on the same line is another column.
      if (gap > size * 0.2 || gap < -size * 3) this.space();
    }
  }

  add(text: string, end: number): void {
    this.line += text;
    if (text) this.spaced = text.endsWith(' ');
    this.end = end;
  }

  space(): void {
    if (this.line && !this.spaced) { this.line += ' '; this.spaced = true; }
  }

  newLine(): void {
    if (this.line) this.lines.push(this.line);
    this.line = '';
    this.spaced = false;
    this.end = null;
  }

  done(): string {
    this.newLine();
    return this.lines.join('\n');
  }
}

interface TextState { font: Font; size: number; charSpace: number; wordSpace: number; scale: number; leading: number }

/**
 * What reads a page: the document, the fonts already loaded, the fonts each
 * resources' font dictionary names, and where the page's text goes.
 */
interface Reader { doc: PdfFile; fonts: Map<Dict, Font>; fontSets: Map<Dict, Map<string, Font>>; out: PageText }

const NO_FONTS = new Map<string, Font>();

/**
 * The fonts a set of resources names, by the name the content uses. Worked out
 * once for each font dictionary, however many pages' resources share it and
 * however often a form using it is drawn.
 */
function fontsOf(r: Reader, resources: Dict | null): Map<string, Font> {
  const dict = resources ? r.doc.dict(resources.get('Font')) : null;
  if (!dict) return NO_FONTS;
  let fonts = r.fontSets.get(dict);
  if (!fonts) {
    fonts = loadFonts(r, dict);
    r.fontSets.set(dict, fonts);
  }
  return fonts;
}

function loadFonts(r: Reader, dict: Dict): Map<string, Font> {
  const fonts = new Map<string, Font>();
  for (const [key, ref] of dict.map) {
    const fontDict = r.doc.dict(ref);
    if (!fontDict) continue;
    let font = r.fonts.get(fontDict);
    if (!font) {
      try { font = loadFont(r.doc, fontDict); } catch (err) { if (err instanceof TooLarge) throw err; font = PLAIN; }
      r.fonts.set(fontDict, font);
    }
    fonts.set(key, font);
  }
  return fonts;
}

/**
 * Runs a content stream's text operators. Positions are followed through both
 * the text matrix and the transformation matrix, since some writers place each
 * line with one and some with the other, and a change of height is a new line.
 * Forms drawn with Do are read in place, with their own resources, and each read
 * counts against the file's limits, so drawing one form a thousand times costs
 * what reading it a thousand times does. The caller counts `data` before it is
 * read.
 */
function readContent(r: Reader, data: Buffer, resources: Dict | null, ctm: Matrix, depth: number, forms: Set<Stream>): void {
  const fonts = fontsOf(r, resources);
  const xobjects = r.doc.dict(resources?.get('XObject'));
  const lx = new Lexer(data);
  const stack: Matrix[] = [];
  let state: TextState = { font: PLAIN, size: 12, charSpace: 0, wordSpace: 0, scale: 1, leading: 0 };
  const states: TextState[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let operands: Value[] = [];

  const num = (i: number, fallback = 0): number => numberOf(operands[i], fallback);
  const moveTo = (tx: number, ty: number) => { tlm = multiply([1, 0, 0, 1, tx, ty], tlm); tm = tlm; };
  const draw = (str: Buffer) => {
    const font = state.font;
    const at = multiply(tm, ctm);
    const size = Math.abs(state.size) * (Math.hypot(at[2], at[3]) || 1);
    r.out.at(at[4], at[5], size);
    // A code can stand for a long run of text, so the limit is minded code by code.
    const room = r.doc.charactersLeft();
    let text = '';
    for (let i = 0; i + font.bytes <= str.length; i += font.bytes) {
      const code = font.bytes === 2 ? (str[i] << 8) | str[i + 1] : str[i];
      text += font.text(code);
      if (text.length > room) throw new TooLarge();
      const advance = (font.width(code) / 1000 * state.size + state.charSpace + (font.bytes === 1 && code === 32 ? state.wordSpace : 0)) * state.scale;
      tm = [tm[0], tm[1], tm[2], tm[3], tm[4] + advance * tm[0], tm[5] + advance * tm[1]];
    }
    r.doc.writes(text.length);
    r.out.add(text, multiply(tm, ctm)[4]);
  };

  for (let t = lx.next(); t.k !== 'eof'; t = lx.next()) {
    if (t.k !== 'kw') {
      operands.push(parseValue(lx, t, false));
      if (operands.length > 64) operands = operands.slice(-16);   // nothing takes this many; drop the junk
      continue;
    }
    switch (t.v) {
      case 'q': if (stack.length < 256) { stack.push(ctm); states.push({ ...state }); } break;
      case 'Q': if (stack.length) { ctm = stack.pop()!; state = states.pop()!; } break;
      case 'cm': { const m = asMatrix(operands); if (m) ctm = multiply(m, ctm); break; }
      case 'BT': tm = tlm = IDENTITY; break;
      case 'Tf': {
        const key = operands[0] instanceof Name ? operands[0].name : '';
        state.font = fonts.get(key) ?? PLAIN;
        state.size = num(1, state.size);
        break;
      }
      case 'Tc': state.charSpace = num(0); break;
      case 'Tw': state.wordSpace = num(0); break;
      case 'Tz': state.scale = num(0, 100) / 100; break;
      case 'TL': state.leading = num(0); break;
      case 'Td': moveTo(num(0), num(1)); break;
      case 'TD': state.leading = -num(1); moveTo(num(0), num(1)); break;
      case 'Tm': { const m = asMatrix(operands); if (m) tm = tlm = m; break; }
      case 'T*': moveTo(0, -state.leading); break;
      case 'Tj': if (Buffer.isBuffer(operands[0])) draw(operands[0]); break;
      case "'": moveTo(0, -state.leading); if (Buffer.isBuffer(operands[0])) draw(operands[0]); break;
      case '"':
        state.wordSpace = num(0);
        state.charSpace = num(1);
        moveTo(0, -state.leading);
        if (Buffer.isBuffer(operands[2])) draw(operands[2]);
        break;
      case 'TJ':
        for (const part of Array.isArray(operands[0]) ? operands[0] : []) {
          if (Buffer.isBuffer(part)) draw(part);
          else if (typeof part === 'number') {
            // A large negative adjustment is how many writers draw the space between words.
            if (part < -200) r.out.space();
            const shift = -part / 1000 * state.size * state.scale;
            tm = [tm[0], tm[1], tm[2], tm[3], tm[4] + shift * tm[0], tm[5] + shift * tm[1]];
          }
        }
        break;
      case 'Do': {
        const key = operands[0] instanceof Name ? operands[0].name : '';
        const form = r.doc.resolve(xobjects?.get(key));
        if (!(form instanceof Stream) || nameOf(form.dict.get('Subtype')) !== 'Form' || depth >= 8 || forms.has(form)) break;
        const content = r.doc.decode(form);
        if (!content) break;
        r.doc.drawsForm();
        r.doc.reads(content.length + STEP);
        // Only a matrix of six is read: a form can point at a list of millions, and be drawn thousands of times.
        const given = r.doc.resolve(form.dict.get('Matrix'));
        const m = Array.isArray(given) && given.length === 6 ? asMatrix(given.map((v) => r.doc.resolve(v))) : null;
        forms.add(form);
        readContent(r, content, r.doc.dict(form.dict.get('Resources')) ?? resources, m ? multiply(m, ctm) : ctm, depth + 1, forms);
        forms.delete(form);
        break;
      }
      case 'BI':
        // An inline image: its data runs from ID to EI and is not text.
        for (let u = lx.next(); u.k !== 'eof' && !(u.k === 'kw' && u.v === 'ID'); u = lx.next()) { /* its parameters */ }
        skipInlineImage(lx);
        break;
      default: break;
    }
    operands = [];
  }
}

/** Moves past an inline image's data, to just after the EI that ends it. */
function skipInlineImage(lx: Lexer): void {
  const b = lx.buf;
  let i = lx.pos + 1;
  for (; i + 1 < lx.end; i++) {
    if (b[i] === 0x45 && b[i + 1] === 0x49 && SPACE[b[i - 1]] && (i + 2 >= lx.end || SPACE[b[i + 2]] || DELIMITER[b[i + 2]])) {
      lx.pos = i + 2;
      return;
    }
  }
  lx.pos = lx.end;
}

interface Page { dict: Dict; resources: Dict | null }

const NEWLINE = Buffer.from('\n');

/** The pages in order, walking the page tree and passing each node's resources down to the pages that do not have their own. */
function pagesOf(doc: PdfFile): Page[] {
  const pages: Page[] = [];
  const seen = new Set<Dict>();
  // A list of kids is followed once, as a node is: a file can give a thousand nodes one list of a thousand.
  const followed = new Set<Value[]>();
  const walk = (node: Dict, resources: Dict | null, depth: number) => {
    if (seen.has(node) || depth > MAX_DEPTH) return;
    seen.add(node);
    const own = doc.dict(node.get('Resources')) ?? resources;
    const kids = doc.resolve(node.get('Kids'));
    const type = nameOf(doc.resolve(node.get('Type')));
    if (Array.isArray(kids) && type !== 'Page') {
      if (followed.has(kids)) return;
      followed.add(kids);
      for (const kid of kids) { const d = doc.dict(kid); if (d) walk(d, own, depth + 1); }
    } else if (type === 'Page' || node.get('Contents') !== undefined) {
      pages.push({ dict: node, resources: own });
    }
  };

  // The catalog the newest trailer names, or failing that any catalog in the file.
  let root: Dict | null = null;
  for (let i = doc.trailers.length - 1; i >= 0 && !root; i--) {
    const d = doc.dict(doc.trailers[i].dict.get('Root'));
    if (d && doc.dict(d.get('Pages'))) root = d;
  }
  if (!root) {
    for (const { value } of doc.objects.values()) {
      if (value instanceof Dict && nameOf(value.get('Type')) === 'Catalog' && doc.dict(value.get('Pages'))) { root = value; break; }
    }
  }
  const tree = root ? doc.dict(root.get('Pages')) : null;
  if (tree) walk(tree, null, 0);
  if (pages.length) return pages;

  // No page tree to follow: every page in the file, in the order of their numbers.
  return [...doc.objects.entries()].sort(([a], [b]) => a - b)
    .map(([, { value }]) => value)
    .filter((v): v is Dict => v instanceof Dict && nameOf(v.get('Type')) === 'Page')
    .map((dict) => ({ dict, resources: doc.dict(dict.get('Resources')) }));
}

/** A page's text with its white space made plain: one space between words, no empty lines, ligatures spelt out. */
function tidy(text: string): string {
  return text.normalize('NFKC')
    .replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f­​-‍﻿]/g, '')
    .replace(/[\t\f  -   　]/g, ' ')
    .split(/\r?\n|\r/)
    .map((line) => line.replace(/ {2,}/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * The text of each page of a PDF, in order, or why there is none to read: not a
 * PDF at all, encrypted, too damaged to follow, or asking for more than the limits.
 */
export function pdfText(bytes: Buffer, limits: PdfTextLimits = {}): PdfText {
  if (bytes.length < 5 || bytes.toString('latin1', 0, 5) !== '%PDF-') return { readable: false, reason: 'not-pdf' };
  const budget = budgetFor(bytes.length);
  const doc = new PdfFile(bytes, { ...LIMITS, totalBytes: budget, readBytes: budget, ...limits });
  try {
    doc.scan();
    doc.unpack();
    const pages = pagesOf(doc);
    if (!pages.length) return { readable: false, reason: 'unreadable' };
    const fonts = new Map<Dict, Font>();
    const fontSets = new Map<Dict, Map<string, Font>>();
    return {
      readable: true,
      pages: pages.map((page) => {
        const out = new PageText();
        doc.startsPage();
        // A page's content streams read as one, since a writer may split them anywhere
        // between two tokens. Each part counts as it is gathered, so a page that lists
        // one stream a thousand times stops before the thousand copies are made.
        const parts: Buffer[] = [];
        for (const part of asList(doc.resolve(page.dict.get('Contents')))) {
          const stream = doc.resolve(part);
          const data = stream instanceof Stream ? doc.decode(stream) : null;
          doc.reads((data?.length ?? 0) + STEP);
          if (data) parts.push(data, NEWLINE);
        }
        try {
          readContent({ doc, fonts, fontSets, out }, Buffer.concat(parts), page.resources, IDENTITY, 0, new Set());
        } catch (err) {
          if (err instanceof TooLarge) throw err;
          // A damaged page loses the text after the damage, not the rest of the report.
        }
        return tidy(out.done());
      }),
    };
  } catch (err) {
    if (err instanceof TooLarge) return { readable: false, reason: 'too-large' };
    if (err instanceof Encrypted) return { readable: false, reason: 'encrypted' };
    return { readable: false, reason: 'unreadable' };
  }
}
