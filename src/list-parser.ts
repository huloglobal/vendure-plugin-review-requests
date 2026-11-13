/**
 * The "invite these customers" list: pasted lines or a CSV file of name and
 * e-mail (a port of the WordPress edition's Manual.php, same rules).
 *
 * Accepts "Name, email", "email, Name", "Name <email>" (also Outlook's
 * "Last, First <email>"), a bare e-mail, a CSV with a header row naming an
 * e-mail column, and several addresses on one line (separated by commas or
 * semicolons, or copied from an e-mail's To: field, with or without its "To:"
 * label): one customer per address.
 *
 * A name is only ever taken from the customer's own entry, never from a piece
 * holding an "@", so no customer is greeted with someone else's name or
 * address. Anything that could not be read is counted in `invalid`, and the
 * first such entry is kept in `bad`, so the result can say so.
 */

export const MAX_LIST_LINES = 5000;
export const MAX_LIST_BYTES = 1_048_576;

export interface ListRow { name: string; email: string }
export interface ParsedList { rows: ListRow[]; invalid: number; unread: number; bad: string }

/** One address-like piece: anything with an "@", up to the next space, separator, quote or bracket. */
const TOKEN = /[^\s,;<>()"[\]]*@[^\s,;<>()"[\]]*/g;
/** "<e-mail>", as mail apps write it after a name. */
const BRACKETED = /\s*<\s*([^<>\s,;]+@[^<>\s,;]+)\s*>/;
/** The label of a copied address line ("To: Ana <ana@…>", "Cc:"). */
const LABEL = /^[ \t]*(?:to|cc|bcc)[ \t]*:[ \t]*/i;
/** What separates the entries of an address list. */
const EDGE = ',;\t<>()[]"';

const EMAIL_HEADERS = ['email', 'emails', 'emailaddress', 'emailaddresses', 'mail', 'mailaddress'];
const EMAIL_HEADER = /^e?mail|e?mail(?:address)?$|emailaddress/;
const NOT_ADDRESS = /mailing|type|label|display|name|status|optin|optout|opted|consent|subscri|market|permission|verif|format|prefer|bounce|list|accept|date|sent|valid|domain|voice/;
const NOT_FIRST_NAME = /mail|last|surname|family|^lname$|middle|additional|company|account|business|organi|user|nick|prefix|suffix|title|product|item|store|shop|site|domain|file|yomi|phonetic|event/;

/** A plausible single mailbox (the shape WordPress's is_email() accepts), lower-case. */
export function isEmail(e: string): boolean {
    if (!e || e.length > 254 || e.length < 6) return false;
    const m = e.match(/^([a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64})@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i);
    if (!m) return false;
    const [, local, domain] = m;
    if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
    if (domain.split('.').some(p => !p || p.startsWith('-') || p.endsWith('-'))) return false;
    return true;
}

/** Plain text for a name: no tags, no control characters, single spaces, at most 190 characters. */
export function cleanName(s: string): string {
    return String(s || '').replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 190);
}

function key(cell: string): string { return String(cell || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

/** 0 for "Email"/"E-mail address", 1 for another address column ("Primary e-mail"), null when none. */
export function emailHeader(cell: string): number | null {
    const k = key(cell);
    if (EMAIL_HEADERS.includes(k)) return 0;
    return EMAIL_HEADER.test(k) && !NOT_ADDRESS.test(k) ? 1 : null;
}

/** 0 for the first name, 1 for the whole name, null for any other column. */
export function nameHeader(cell: string): number | null {
    const k = key(cell);
    if (!k || NOT_FIRST_NAME.test(k)) return null;
    if (/firstname|givenname|forename|^fname$|^first$|^given$/.test(k)) return 0;
    return k.includes('name') || ['customer', 'contact', 'client', 'recipient'].includes(k) ? 1 : null;
}

function pieces(line: string): string[] {
    return line.split(/[,;\t]/).map(c => c.trim().replace(/^["']+|["']+$/g, '').trim()).filter(Boolean);
}

/** A first line with no address and a cell naming an e-mail column is a CSV header row. */
export function isHeader(line: string): boolean {
    if (line.includes('@')) return false;
    return pieces(line).some(c => emailHeader(c) !== null);
}

function columns(cells: string[]): [number, number | null] | null {
    if (cells.filter(Boolean).length < 2) return null;
    const best = (rank: (c: string) => number | null): number | null => {
        let col: number | null = null; let top: number | null = null;
        cells.forEach((cell, i) => { const r = rank(String(cell)); if (r !== null && (top === null || r < top)) { col = i; top = r; } });
        return col;
    };
    const email = best(emailHeader);
    return email === null ? null : [email, best(nameHeader)];
}

/** One CSV line split on `delim`, honouring double quotes (doubled quotes inside). */
function csvCells(line: string, delim: string): string[] {
    const out: string[] = [];
    let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (q) {
            if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
            else cur += ch;
        } else if (ch === '"' && cur.trim() === '') { q = true; cur = ''; }
        else if (ch === delim) { out.push(cur.trim()); cur = ''; }
        else cur += ch;
    }
    out.push(cur.trim());
    return out;
}

function named(line: string): string {
    const m = BRACKETED.exec(line)!;
    const name = line.slice(0, m.index).replace(/^[\s,;"']+|[\s,;"']+$/g, '');
    const rest = line.slice(m.index + m[0].length);
    return (name ? `"${name.replace(/"/g, '""')}", ` : '') + m[1] + rest;
}

function recipients(line: string): string[] {
    const out: string[] = [];
    let rest = line;
    const re = /^([\s\S]*?)(<\s*[^<>\s,;]+@[^<>\s,;]+\s*>|[^\s,;<>()"[\]]*@[^\s,;<>()"[\]]*)/;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rest))) {
        const name = m[1].replace(/^[\s,;"']+|[\s,;"']+$/g, '');
        const address = m[2].replace(/^[\s<>]+|[\s<>]+$/g, '');
        if (m[2][0] !== '<' && name) out.push((m[1] + m[2]).replace(/^[\s,;]+|[\s,;]+$/g, ''));
        else out.push(name ? `"${name.replace(/"/g, '""')}", ${address}` : address);
        rest = rest.slice(m[0].length);
    }
    rest = rest.replace(/^[\s,;"']+|[\s,;"']+$/g, '');
    if (rest) out.push(rest);
    return out;
}

/**
 * Ready raw text for parse(): an address list copied from a To: field becomes
 * one line per recipient, "Name <e-mail>" becomes '"Name", e-mail', a To:/Cc:
 * label is dropped; in a CSV with a header row "Name <e-mail>" becomes
 * "Name (e-mail)" so the columns stay where they are.
 */
export function normaliseList(text: string): string {
    const lines = String(text || '').replace(/﻿/g, '').replace(/\r\n?/g, '\n').split('\n');
    let header: boolean | null = null;
    const out: string[] = [];
    for (let line of lines) {
        line = line.replace(LABEL, '');
        if (header === null && line.trim() !== '') header = isHeader(line) && pieces(line).length > 1;
        if (!BRACKETED.test(line)) out.push(line);
        else if (header) out.push(line.replace(new RegExp(BRACKETED.source, 'g'), ' ($1)'));
        else if ((line.match(TOKEN) || []).length > 1) out.push(...recipients(line));
        else out.push(named(line));
    }
    return out.join('\n');
}

interface Tok { email: string; at: number; len: number }

function tokens(line: string): Tok[] {
    const spans: Array<{ raw: string; at: number; len: number }> = [];
    for (const m of line.matchAll(TOKEN)) if (m[0].includes('@')) spans.push({ raw: m[0], at: m.index!, len: m[0].length });
    return spans.map((t, i) => {
        const before = line.slice(0, t.at).replace(/ +$/, '');
        const after = line.slice(t.at + t.len).replace(/^ +/, '');
        const prev = spans[i - 1]; const next = spans[i + 1];
        const alone = (before === '' || EDGE.includes(before.slice(-1)) || (!!prev && prev.at + prev.len === before.length))
            && (after === '' || EDGE.includes(after[0]) || (!!next && next.at === line.length - after.length));
        const email = t.raw.replace(/^['.]+|['.]+$/g, '').toLowerCase();
        return { email: alone && isEmail(email) ? email : '', at: t.at, len: t.len };
    });
}

function entry(line: string, t: Tok): string {
    let from = t.at;
    while (from > 0 && !EDGE.includes(line[from - 1])) from--;
    let to = t.at + t.len;
    while (to < line.length && !EDGE.includes(line[to])) to++;
    return line.slice(from, to).trim();
}

function pairNames(line: string, toks: Tok[]): string[] {
    const none = toks.map(() => '');
    const gaps: string[] = [];
    let pos = 0;
    for (const t of toks) { gaps.push(line.slice(pos, t.at)); pos = t.at + t.len; }
    gaps.push(line.slice(pos));
    const texts: string[] = [];
    for (const gap of gaps) {
        const bits = gap.split(/[,;\t]/).map(b => b.replace(/^[\s"'<>()[\]]+|[\s"'<>()[\]]+$/g, '')).filter(Boolean);
        if (bits.length > 1) return none;
        texts.push(bits[0] || '');
    }
    const lead = texts[0]; const trail = texts[texts.length - 1];
    if (lead && !trail) return texts.slice(0, toks.length);
    if (!lead && trail) return texts.slice(1);
    return none;
}

/** Parse a (normalised) list: one row per distinct address, first entry kept. */
export function parseList(text: string): ParsedList {
    const all = String(text || '').replace(/﻿/g, '').replace(/\r\n?/g, '\n').split('\n')
        .map(l => l.replace(LABEL, '').trim()).filter(Boolean);
    const unread = Math.max(0, all.length - MAX_LIST_LINES);
    const lines = all.slice(0, MAX_LIST_LINES);
    const rows = new Map<string, ListRow>();
    let invalid = 0; let bad: string | null = null;
    let emailCol: number | null = null; let nameCol: number | null = null; let headerDelim: string | null = null;
    const put = (email: string, name: string) => { if (!rows.has(email)) rows.set(email, { name: cleanName(name), email }); };
    const skip = (e: string) => { invalid++; if (bad === null) bad = e; };
    lines.forEach((line, n) => {
        const delim = headerDelim ?? ((line.split(';').length > line.split(',').length) ? ';' : line.includes('\t') ? '\t' : ',');
        const cells = csvCells(line, delim);
        if (n === 0 && isHeader(line)) {
            const cols = columns(cells);
            if (cols) { [emailCol, nameCol] = cols; headerDelim = delim; }
            return;
        }
        if (emailCol !== null) {
            const cell = cells[emailCol] ?? '';
            const toks = tokens(cell);
            const valid = toks.map(t => t.email).filter(Boolean);
            if (!valid.length) { skip(cell || line); return; }
            for (const t of toks) if (!t.email) skip(entry(cell, t));
            const name = nameCol !== null ? (cells[nameCol] ?? '') : '';
            for (const e of valid) put(e, valid.length === 1 && !name.includes('@') ? name : '');
            return;
        }
        const toks = tokens(line);
        if (toks.length > 1) {
            const names = pairNames(line, toks);
            toks.forEach((t, i) => (t.email ? put(t.email, names[i]) : skip(entry(line, t))));
            return;
        }
        if (!toks.length || !toks[0].email) { skip(line); return; }
        const email = toks[0].email;
        let name = '';
        const m = line.match(/^(.*)<\s*[^>]+\s*>\s*$/);
        if (m && !m[1].includes('@')) name = m[1].replace(/^[\s"',;]+|[\s"',;]+$/g, '');
        else {
            name = cells.find(c => c !== '' && !c.includes('@')) || '';
            if (!name) {
                name = (line.slice(0, toks[0].at) + ' ' + line.slice(toks[0].at + toks[0].len)).replace(/^[\s,;"'<>()[\]]+|[\s,;"'<>()[\]]+$/g, '');
            }
        }
        put(email, name);
    });
    return { rows: [...rows.values()], invalid, unread, bad: bad ?? '' };
}

/** normaliseList + parseList, after the size check. */
export function readList(text: string): ParsedList {
    return parseList(normaliseList(String(text || '').slice(0, MAX_LIST_BYTES)));
}

/** The first name to greet with ("Lima, Olga" → "Olga"; "Jo Bloggs" → "Jo"; "Ode, Ben" → "Ben"). */
export function firstNameOf(name: string): string {
    let n = String(name || '').trim();
    const parts = n.split(/\s*[,;]\s*/);
    if (parts.length >= 2) {
        const rest = n.slice(n.search(/[,;]/) + 1).trim();
        n = (!parts[0].includes(' ') && rest !== '') ? rest : parts[0];
    }
    const w = n.trim().split(/\s+/)[0] || '';
    return w.replace(/^[\s,;:"'()]+|[\s,;:"'()]+$/g, '');
}

/** What a list send says about entries it could not read. */
export function unreadableMessage(p: ParsedList, none: boolean): string {
    const bad = p.bad.length > 80 ? p.bad.slice(0, 80) + '…' : p.bad;
    let msg: string;
    if (none) msg = bad ? `No customer could be read from the list. The first entry was "${bad}".` : 'No customer could be read from the list.';
    else msg = bad
        ? (p.invalid === 1 ? `1 entry could not be read and was left out: "${bad}".` : `${p.invalid} entries could not be read and were left out, the first: "${bad}".`)
        : `${p.invalid} entr${p.invalid === 1 ? 'y' : 'ies'} could not be read and ${p.invalid === 1 ? 'was' : 'were'} left out.`;
    return msg + ' Write each customer as "Name, e-mail" or just the e-mail address.';
}
