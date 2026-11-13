import { describe, expect, it } from 'vitest';
import { firstNameOf, isEmail, isHeader, MAX_LIST_LINES, normaliseList, parseList, readList } from './list-parser';

// Cases ported from the WordPress edition's tests (hulo-review-requests/tests/run-tests.php, Manual::parse).
const names = (p: { rows: Array<{ name: string; email: string }> }) => Object.fromEntries(p.rows.map(r => [r.email, r.name]));
const prep = (t: string) => readList(t);
const firsts = (p: { rows: Array<{ name: string; email: string }> }) => Object.fromEntries(p.rows.map(r => [r.email, firstNameOf(r.name)]));

describe('parseList', () => {
    it('paste formats parsed, de-duplicated', () => {
        const p = parseList('Jo Bloggs, Jo@Example.com\nsam@example.com\n"Lee, Ann" <ann@example.com>\nnot an email\njo@example.com\nsam@example.com; Sam Two');
        expect(p.rows).toHaveLength(3);
        expect(p.invalid).toBe(1);
        expect(p.rows[0]).toEqual({ name: 'Jo Bloggs', email: 'jo@example.com' });
        expect(p.rows[2].name).toBe('Lee, Ann');
    });
    it('CSV with a header row', () => {
        const p = parseList('First name,Last,E-mail address\nAnn,Lee,ann@example.com\nBo,Ray,bo@example.com');
        expect(p.rows).toHaveLength(2);
        expect(p.rows[1].email).toBe('bo@example.com');
        expect(p.rows[0].name).toBe('Ann');
    });
    it('"Name <e-mail>" lines', () => {
        const p = prep('Jo Bloggs <jo@example.com>\n"Lee, Ann" <Ann@Example.com>\nsam@example.com');
        expect(p.rows).toHaveLength(3);
        expect(p.rows[0]).toEqual({ name: 'Jo Bloggs', email: 'jo@example.com' });
        expect(p.rows[1]).toEqual({ name: 'Lee, Ann', email: 'ann@example.com' });
    });
    it('a first line without an e-mail is only a header when it names an e-mail column', () => {
        const p = parseList('Jo Bloggs\nsam@example.com');
        expect(p.rows).toHaveLength(1);
        expect(p.invalid).toBe(1);
        expect(isHeader('My mailing list')).toBe(false);
        expect(isHeader('Name;E-mail')).toBe(true);
        expect(isHeader('Ana, ana@example.com')).toBe(false);
    });
    it('lines past the per-list maximum are reported', () => {
        const p = parseList('x@example.com\n'.repeat(MAX_LIST_LINES + 3));
        expect(p.unread).toBe(3);
        expect(p.rows).toHaveLength(1);
    });
    it('a byte-order mark no longer costs the first customer', () => {
        const p = parseList('﻿jo@example.com,Jo\nsam@example.com,Sam');
        expect(p.rows).toHaveLength(2);
        expect(p.invalid).toBe(0);
        expect(p.rows[0]).toEqual({ name: 'Jo', email: 'jo@example.com' });
    });
    it('several addresses on one line: one customer each, none named after another', () => {
        expect(names(prep('ana@example.com, ben@example.com, cara@example.com'))).toEqual({ 'ana@example.com': '', 'ben@example.com': '', 'cara@example.com': '' });
        expect(names(prep('Ana Lima <ana@example.com>, Ben Ode <ben@example.com>, cara@example.com'))).toEqual({ 'ana@example.com': 'Ana Lima', 'ben@example.com': 'Ben Ode', 'cara@example.com': '' });
        expect(names(prep('ana@example.com, Ben Ode <ben@example.com>'))).toEqual({ 'ana@example.com': '', 'ben@example.com': 'Ben Ode' });
        expect(names(prep('Ana Lima <ana@example.com>; Ben Ode <ben@example.com>;'))).toEqual({ 'ana@example.com': 'Ana Lima', 'ben@example.com': 'Ben Ode' });
        expect(names(prep('Lima, Ana <ana@example.com>; Ode, Ben <ben@example.com>'))).toEqual({ 'ana@example.com': 'Lima, Ana', 'ben@example.com': 'Ode, Ben' });
        expect(firstNameOf('Ode, Ben')).toBe('Ben');
    });
    it('names on a line of several addresses only where their order is certain', () => {
        const p = parseList('Ana, ana@example.com, Ben, ben@example.com\nana2@example.com, Ana, ben2@example.com, Ben\nana3@example.com, Ana, ben3@example.com\nAnn,Lee,ann@example.com,London,bob@example.com');
        expect(names(p)).toEqual({
            'ana@example.com': 'Ana', 'ben@example.com': 'Ben', 'ana2@example.com': 'Ana', 'ben2@example.com': 'Ben',
            'ana3@example.com': '', 'ben3@example.com': '', 'ann@example.com': '', 'bob@example.com': '',
        });
    });
    it('an "@" piece that is not an address is counted, never sent elsewhere', () => {
        const p = parseList('ana@example.com, ben@, cara@example.com\nJo, jo@example.com, jo@@x');
        expect(p.rows).toHaveLength(3);
        expect(p.invalid).toBe(2);
        const q = prep('jo bloggs@example.com, Ana <ana@example.com>');
        expect(names(q)).toEqual({ 'ana@example.com': 'Ana' });
        expect(q.invalid).toBe(1);
        expect(q.bad).toBe('jo bloggs@example.com');
        const r = parseList('sam@example.com\nzoë@example.com, Zoë\njo bloggs@example.com\nJo Bloggs (jo@example.com)\nana@example.com cara@example.com');
        expect(r.rows.map(x => x.email)).toEqual(['sam@example.com', 'jo@example.com', 'ana@example.com', 'cara@example.com']);
        expect(r.invalid).toBe(2);
    });
    it('a name is never a piece holding an "@"', () => {
        const p = prep('x@example.com, y@example.com\nJo jo@example.com\njo2@example.com <Jo>\nName,E-mail');
        expect(p.rows.some(r => r.name.includes('@'))).toBe(false);
    });
    it('semicolon CSV with a header row; two addresses in the e-mail cell are two customers', () => {
        const p = parseList('Name;Email\n"Martin, Chloe";chloe@example.com\nBo;bo@example.com, bo2@example.com');
        expect(names(p)).toEqual({ 'chloe@example.com': 'Martin, Chloe', 'bo@example.com': '', 'bo2@example.com': '' });
        expect(p.invalid).toBe(0);
    });
    it('Outlook "Last, First <e-mail>" one per line (also ";" or a "Cc:" label): greeted by the first name', () => {
        const outlook = 'Lima, Olga <olga.lima@example.com>\nOde, Otto <otto.ode@example.com>;\nCc: Ray, Gail <gail.ray@example.com>';
        expect(firsts(prep(outlook))).toEqual({ 'olga.lima@example.com': 'Olga', 'otto.ode@example.com': 'Otto', 'gail.ray@example.com': 'Gail' });
        expect(prep(outlook).invalid).toBe(0);
    });
    it('every listed format greets each customer by their own first name', () => {
        const formats = 'Jo Bloggs, jo@example.com\nsam@example.com, Sam Hill\nAnn Lee <ann@example.com>\nbare@example.com\n"Martin, Chloe" <chloe@example.com>\n\'Pat Doe\' <pat@example.com>\nLima, Olga <olga@example.com>\n'
            + 'a1@example.com, a2@example.com; a3@example.com\nTo: Gail Ray <gail@example.com>, Bo Li <bo@example.com>, cara@example.com\nLima, Ana <ana@example.com>; Ode, Ben <ben@example.com>\n"Fox, Ida" <ida@example.com>, Ken Wu <ken@example.com>';
        const p = prep(formats);
        expect(firsts(p)).toEqual({
            'jo@example.com': 'Jo', 'sam@example.com': 'Sam', 'ann@example.com': 'Ann', 'bare@example.com': '', 'chloe@example.com': 'Chloe', 'pat@example.com': 'Pat', 'olga@example.com': 'Olga',
            'a1@example.com': '', 'a2@example.com': '', 'a3@example.com': '', 'gail@example.com': 'Gail', 'bo@example.com': 'Bo', 'cara@example.com': '', 'ana@example.com': 'Ana', 'ben@example.com': 'Ben', 'ida@example.com': 'Ida', 'ken@example.com': 'Ken',
        });
        expect(p.invalid).toBe(0);
    });
    it('CSV header: the first-name column, else the name column; never company, account, surname, username or a date', () => {
        const hdr = (csv: string) => firsts(prep(csv));
        expect(hdr('*ContactName,AccountNumber,EmailAddress,FirstName,LastName\nAcme Ltd,ACME01,olga@example.com,Olga,Lima')).toEqual({ 'olga@example.com': 'Olga' });
        expect(hdr('Account Name,First Name,Last Name,Email\nAcme Ltd,Olga,Lima,olga@example.com')).toEqual({ 'olga@example.com': 'Olga' });
        expect(hdr('Last Name,First Name,Email\nLima,Olga,olga@example.com')).toEqual({ 'olga@example.com': 'Olga' });
        expect(hdr('Username,Email,First name\njbloggs,jo@example.com,Jo')).toEqual({ 'jo@example.com': 'Jo' });
        expect(hdr('LNAME,FNAME,EMAIL\nLima,Olga,olga@example.com')).toEqual({ 'olga@example.com': 'Olga' });
        expect(hdr('First Order Date,Name,Email\n2024-01-05,Jo Bloggs,jo@example.com')).toEqual({ 'jo@example.com': 'Jo' });
        expect(hdr('Full Name,Company,Email\nJo Bloggs,Acme Ltd,jo@example.com')).toEqual({ 'jo@example.com': 'Jo' });
    });
    it('CSV header: the address column wins over labels, types and marketing flags', () => {
        expect(names(prep('Name,Mailing address,Email\nJo Bloggs,1 High St,jo@example.com'))).toEqual({ 'jo@example.com': 'Jo Bloggs' });
        expect(names(prep('First Name,Middle Name,Last Name,E-mail 1 - Label,E-mail 1 - Value\nOlga,,Lima,* Home,olga@example.com'))).toEqual({ 'olga@example.com': 'Olga' });
        expect(names(prep('First Name,Last Name,E-mail Address,E-mail Type,E-mail Display Name\nOlga,Lima,olga@example.com,SMTP,Olga Lima (olga@example.com)'))).toEqual({ 'olga@example.com': 'Olga' });
        expect(names(prep('Customer ID,First Name,Last Name,Email,Accepts Email Marketing\n123,Olga,Lima,olga@example.com,yes'))).toEqual({ 'olga@example.com': 'Olga' });
    });
    it('what could not be read is counted and the first entry kept as written', () => {
        const p = parseList('Jo Bloggs jo.bloggs@example.com\nok@example.com\nJo Bloggs - jo2@example.com');
        expect(p.invalid).toBe(2);
        expect(p.bad).toBe('Jo Bloggs jo.bloggs@example.com');
        expect(parseList('ana@example.com, ben@, cara@example.com').bad).toBe('ben@');
        expect(parseList('ok@example.com').bad).toBe('');
        const q = prep('My mailing list\nJo Bloggs, jo@example.com');
        expect(names(q)).toEqual({ 'jo@example.com': 'Jo Bloggs' });
        expect(q.bad).toBe('My mailing list');
        expect(names(prep('Email\njo2@example.com\nJo Two <jo3@example.com>'))).toEqual({ 'jo2@example.com': '', 'jo3@example.com': 'Jo Two' });
    });
    it('names are plain text', () => {
        expect(parseList('<b>Jo</b> Bloggs, jo@example.com').rows[0].name).toBe('Jo Bloggs');
        expect(normaliseList('To: Ana <ana@example.com>')).toBe('"Ana", ana@example.com');
    });
});

describe('isEmail', () => {
    it('accepts a plain mailbox and refuses junk', () => {
        expect(isEmail('jo@example.com')).toBe(true);
        expect(isEmail('jo.b+x@sub.example.co.uk')).toBe(true);
        for (const bad of ['jo@', '@x.com', 'jo@x', 'jo..b@x.com', 'zoë@example.com', 'jo@-x.com', 'a b@x.com']) expect(isEmail(bad)).toBe(false);
    });
});
