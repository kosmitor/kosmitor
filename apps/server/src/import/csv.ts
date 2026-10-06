/**
 * RFC 4180 CSV parsing: quoted fields, doubled quotes, newlines inside quotes,
 * CRLF and bare CR line endings, a UTF-8 BOM, and delimiter detection between
 * comma, semicolon and tab (European exports often use semicolons).
 */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') { quoted = true; continue; }
    if (ch === delimiter) { row.push(field); field = ''; continue; }
    if (ch === '\r') {
      if (text[i + 1] === '\n') continue;          // CRLF: the LF ends the row
      row.push(field); rows.push(row); row = []; field = '';   // bare CR
      continue;
    }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }

  return rows
    .map((r) => r.map((c) => c.trim()))
    .filter((r) => r.some((c) => c !== ''));
}

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const outsideQuotes = firstLine.replace(/"[^"]*"/g, '');
  const counts: [string, number][] = [
    [',', (outsideQuotes.match(/,/g) ?? []).length],
    [';', (outsideQuotes.match(/;/g) ?? []).length],
    ['\t', (outsideQuotes.match(/\t/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

/** Serialises rows back to CSV, quoting whatever needs it. */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((r) => r.map((cell) => {
    const s = cell == null ? '' : String(cell);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n');
}
