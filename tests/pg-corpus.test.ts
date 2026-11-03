/**
 * SQL corpus test — PostgreSQL and MySQL/MariaDB.
 *
 * Every SQL template literal in `src/**` is extracted, its `${…}` interpolations
 * are replaced with representative fragments and the statement is checked against
 * a scratch database holding the plugin DDL plus quoted-camelCase stand-ins for the
 * Vendure tables the plugin reads:
 *   - PostgreSQL: translated by the licence-sdk dialect adapter, PREPAREd and
 *     EXECUTEd (unquoted camelCase column, MySQL-only function, SUM(boolean) … fail);
 *   - MySQL/MariaDB: server-side PREPARE (syntax + column resolution).
 *
 * Skipped unless at least one of these is set:
 *   HULO_PG_URL=postgres://hulo_pg:hulo_pg_local@127.0.0.1:5432/hulo_rr_pg
 *   HULO_MYSQL_URL=mysql://hulo_e2e:hulo_e2e_local@127.0.0.1:3306/hulo_rr_corpus
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createDbAdapter, translateSql } from '@huloglobal/vendure-licence-sdk';

const PLUGIN = 'review-requests';
const SRC = path.resolve(__dirname, '..', 'src');

/** Representative replacements for `${expr}` interpolations found in the corpus. */
const SUBS = (dialect: 'postgres' | 'mysql'): Record<string, string | string[]> => ({
    'scope': dialect === 'postgres' ? 'table_catalog = current_database() AND table_schema = current_schema()' : 'table_schema = DATABASE()',
    'table': 'review_config',
    'column': ['reviewMode', 'productReviewUrlTemplate'],
    'ddl': `VARCHAR(400) NOT NULL DEFAULT ''`,
    'where': ['WHERE 1 = 1', 'WHERE status = ?'],
    // Channel-scope fragments (0.16.2): unscoped, and scoped to one channel.
    'chScope': ['', ' AND id IN (?)'],
    'occScope': ['', ' AND `channelId` IN (?)'],
    'logScope': ['', ' AND channelId IN (?)'],
    'custScope': ['', ' AND EXISTS (SELECT 1 FROM customer_channels_channel ccc WHERE ccc.`customerId` = customer.id AND ccc.`channelId` IN (?))'],
    'Math.min(take, 500)': '100',
});

/** Statements the plugin guards with a dialect check at runtime. */
const SKIP: Array<{ dialect: 'postgres' | 'mysql'; re: RegExp; why: string }> = [
    { dialect: 'postgres', re: /MODIFY\s+body\s+MEDIUMTEXT/i, why: 'MySQL-only column widening (dialect-guarded in widenTemplateBody)' },
    { dialect: 'postgres', re: /table_schema = DATABASE\(\)/i, why: 'MySQL information_schema scope (dialect-guarded)' },
];

/** Conflict targets for ON DUPLICATE KEY UPDATE statements, by table (Postgres only). */
const CONFLICT: Record<string, string[]> = {
    review_config: ['channelId'],
    review_template: ['channelId'],
};

/** Vendure tables the plugin queries — camelCase columns quoted exactly as TypeORM creates them
 *  (written for Postgres; `mysqlDdl` derives the MySQL form). */
const STAND_IN_DDL = [
    `CREATE TABLE "order" (id SERIAL PRIMARY KEY, code VARCHAR, state VARCHAR, "subTotalWithTax" INT, "orderPlacedAt" TIMESTAMP, "customerId" INT)`,
    `CREATE TABLE customer (id SERIAL PRIMARY KEY, "firstName" VARCHAR, "lastName" VARCHAR, "emailAddress" VARCHAR, "phoneNumber" VARCHAR, "deletedAt" TIMESTAMP, "userId" INT)`,
    `CREATE TABLE order_channels_channel ("orderId" INT, "channelId" INT, PRIMARY KEY ("orderId", "channelId"))`,
    // licence-sdk's shared store (the unsubscribe-link secret is read/created in it directly).
    `CREATE TABLE hulo_licence_store (pluginId VARCHAR(128) PRIMARY KEY, licenceKey TEXT NOT NULL, updatedAt TIMESTAMP NOT NULL DEFAULT NOW())`,
    `CREATE TABLE customer_channels_channel ("customerId" INT, "channelId" INT, PRIMARY KEY ("customerId", "channelId"))`,
    `CREATE TABLE channel (id SERIAL PRIMARY KEY, code VARCHAR, token VARCHAR)`,
    `CREATE TABLE order_line (id SERIAL PRIMARY KEY, "orderId" INT, "productVariantId" INT)`,
    `CREATE TABLE product_variant (id SERIAL PRIMARY KEY, "productId" INT, "deletedAt" TIMESTAMP)`,
    `CREATE TABLE product (id SERIAL PRIMARY KEY, "deletedAt" TIMESTAMP)`,
    `CREATE TABLE product_translation (id SERIAL PRIMARY KEY, "baseId" INT, "languageCode" VARCHAR, name VARCHAR, slug VARCHAR)`,
];

// ── template-literal extraction ─────────────────────────────────────────────

interface Literal { file: string; line: number; raw: string; parts: Array<{ text: string } | { expr: string }> }

/** Walk a TS source and return every template literal, with `${}` expressions kept separate. */
function extractTemplateLiterals(src: string, file: string): Literal[] {
    const out: Literal[] = [];
    let i = 0;
    const n = src.length;
    const lineAt = (pos: number) => src.slice(0, pos).split('\n').length;
    const skipString = (quote: string) => { // i at opening quote
        i++;
        while (i < n && src[i] !== quote) { if (src[i] === '\\') i++; i++; }
        i++;
    };
    const skipComment = () => {
        if (src.startsWith('//', i)) { while (i < n && src[i] !== '\n') i++; return true; }
        if (src.startsWith('/*', i)) { i = src.indexOf('*/', i + 2); i = i < 0 ? n : i + 2; return true; }
        return false;
    };
    // A `/` that starts a regex literal (after an operator or opening bracket)
    // must be skipped whole: a quote inside `/[,"\n]/` would otherwise open a string.
    const skipRegex = () => {
        i++;
        let inClass = false;
        while (i < n) {
            const c = src[i];
            if (c === '\\') { i += 2; continue; }
            if (c === '[') inClass = true;
            else if (c === ']') inClass = false;
            else if (c === '/' && !inClass) { i++; return; }
            else if (c === '\n') return;
            i++;
        }
    };
    const readTemplate = (): Literal['parts'] => { // i at opening backtick
        const parts: Literal['parts'] = [];
        let text = '';
        i++;
        while (i < n) {
            const ch = src[i];
            if (ch === '\\') { text += src[i + 1] === '`' ? '`' : src.slice(i, i + 2); i += 2; continue; }
            if (ch === '`') { i++; break; }
            if (ch === '$' && src[i + 1] === '{') {
                if (text) parts.push({ text }); text = '';
                i += 2;
                const start = i;
                let depth = 1;
                while (i < n && depth > 0) {
                    const c = src[i];
                    if (c === '\'' || c === '"') { skipString(c); continue; }
                    if (c === '`') { readTemplate(); continue; }
                    if (c === '{') depth++;
                    if (c === '}') { depth--; if (depth === 0) break; }
                    i++;
                }
                parts.push({ expr: src.slice(start, i).trim() });
                i++; // closing }
                continue;
            }
            text += ch; i++;
        }
        if (text) parts.push({ text });
        return parts;
    };
    let lastSig = '';
    while (i < n) {
        const ch = src[i];
        if (ch === '/' && src[i + 1] !== '/' && src[i + 1] !== '*' && (lastSig === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSig))) { skipRegex(); lastSig = '/'; continue; }
        if (skipComment()) continue;
        if (!/\s/.test(ch)) lastSig = ch;
        if (ch === '\'' || ch === '"') { skipString(ch); continue; }
        if (ch === '`') {
            const line = lineAt(i);
            const parts = readTemplate();
            const raw = parts.map(p => 'text' in p ? p.text : '${' + p.expr + '}').join('');
            out.push({ file, line, raw, parts });
            continue;
        }
        i++;
    }
    return out;
}

function listTsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...listTsFiles(p));
        else if (/\.ts$/.test(e.name) && !/\.(test|spec|d)\.ts$/.test(e.name)) out.push(p);
    }
    return out.sort();
}

const SQL_RE = /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i;

function substitute(subs: Record<string, string | string[]>, expr: string): string | string[] {
    if (expr in subs) return subs[expr];
    if (/\.map\(\(\)\s*=>\s*'\?'\)\.join\(','\)$/.test(expr)) return '?';
    if (/Ph$/.test(expr)) return '?';
    throw new Error(`no substitution for \${${expr}} — add it to SUBS in pg-corpus.test.ts`);
}

/** Expand a literal into one or more concrete SQL strings. */
function concrete(subs: Record<string, string | string[]>, lit: Literal): string[] {
    let variants: string[] = [''];
    for (const p of lit.parts) {
        const piece = 'text' in p ? [p.text] : ([] as string[]).concat(substitute(subs, p.expr));
        variants = variants.flatMap(v => piece.map(x => v + x));
    }
    return variants;
}

function dummyFor(pgType: string): string {
    const t = pgType.toLowerCase();
    if (/int|numeric|double|real|serial/.test(t)) return '1';
    if (/timestamp|date/.test(t)) return `'2026-01-01 00:00:00'`;
    if (/bool/.test(t)) return 'true';
    return `'x@example.com'`;
}

/** The stand-in DDL is written for Postgres; MySQL/MariaDB gets the same tables natively typed. */
function mysqlDdl(pg: string): string {
    return pg.replace(/"/g, '`')
        .replace(/SERIAL PRIMARY KEY/g, 'INT AUTO_INCREMENT PRIMARY KEY')
        .replace(/TIMESTAMP\(3\) NOT NULL DEFAULT NOW\(\)/g, 'DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)')
        .replace(/TIMESTAMP NOT NULL DEFAULT NOW\(\)/g, 'DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP')
        .replace(/(?<!CURRENT_)TIMESTAMP\(3\)/g, 'DATETIME(3)')
        .replace(/(?<!CURRENT_)\bTIMESTAMP\b/g, 'DATETIME')
        .replace(/\bBOOLEAN\b/g, 'TINYINT(1)')
        .replace(/\bVARCHAR\b(?!\()/g, 'VARCHAR(255)');
}

type Dialect = 'postgres' | 'mysql';
interface Target { dialect: Dialect; url: string }
const TARGETS: Target[] = [
    { dialect: 'postgres' as const, url: process.env.HULO_PG_URL || '' },
    { dialect: 'mysql' as const, url: process.env.HULO_MYSQL_URL || '' },
].filter(t => t.url);

/** One connection per dialect: `exec` runs a statement; `check` validates (and on Postgres executes) a DML statement. */
async function openTarget(t: Target): Promise<{ exec(sql: string): Promise<any>; check(sql: string, conflictColumns?: string[]): Promise<void>; close(): Promise<void>; adapter: { query(sql: string): Promise<any> } }> {
    if (t.dialect === 'postgres') {
        const { Pool } = await import('pg');
        const pool = new Pool({ connectionString: t.url, max: 2 });
        const raw = { options: { type: 'postgres' }, query: (sql: string, params?: any[]) => pool.query(sql, params).then(r => r.rows) };
        const adapter = createDbAdapter(raw as any);
        await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
        let seq = 0;
        return {
            adapter,
            exec: sql => pool.query(sql),
            async check(sql, conflictColumns) {
                // PREPARE (parse + analyse: unknown columns, bad casts, alias misuse) then
                // EXECUTE with type-inferred dummies against the empty tables.
                const translated = translateSql(sql, 'postgres', { conflictColumns });
                const name = `corpus_${seq++}`;
                await pool.query(`PREPARE ${name} AS ${translated}`);
                const { rows } = await pool.query(`SELECT parameter_types::text[] AS t FROM pg_prepared_statements WHERE name = $1`, [name]);
                const types: string[] = rows[0]?.t || [];
                await pool.query(`EXECUTE ${name}${types.length ? `(${types.map(dummyFor).join(', ')})` : ''}`);
                await pool.query(`DEALLOCATE ${name}`);
            },
            close: () => pool.end(),
        };
    }
    const mysql = await import('mysql2/promise');
    const u = new URL(t.url);
    const dbName = u.pathname.replace(/^\//, '') || 'hulo_corpus';
    const conn = await mysql.createConnection({ host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) });
    await conn.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await conn.query(`CREATE DATABASE \`${dbName}\``);
    await conn.query(`USE \`${dbName}\``);
    const adapter = createDbAdapter({ options: { type: 'mysql' }, query: (sql: string, params?: any[]) => conn.query(sql, params).then(r => r[0]) } as any);
    return {
        adapter,
        exec: sql => conn.query(sql),
        async check(sql) {
            // Server-side PREPARE: syntax + column resolution without executing.
            await conn.query('PREPARE corpus_stmt FROM ?', [sql]);
            await conn.query('DEALLOCATE PREPARE corpus_stmt');
        },
        close: () => conn.end(),
    };
}

describe.skipIf(!TARGETS.length)(`SQL corpus (${PLUGIN})`, () => {
    for (const target of TARGETS) {
        it(`every SQL statement in src/ is valid on ${target.dialect}`, async () => {
            const db = await openTarget(target);
            const subs = SUBS(target.dialect);
            const failures: string[] = [];
            let executed = 0;
            let literals: Literal[] = [];
            let statements: Array<Literal & { sql: string }> = [];
            try {
                for (const ddl of STAND_IN_DDL) await db.exec(target.dialect === 'postgres' ? ddl : mysqlDdl(ddl));

                literals = listTsFiles(SRC)
                    .flatMap(f => extractTemplateLiterals(fs.readFileSync(f, 'utf8'), path.relative(SRC, f)))
                    .filter(l => SQL_RE.test(l.raw));
                expect(literals.length).toBeGreaterThan(20);

                statements = literals.flatMap(l => concrete(subs, l).map(sql => ({ ...l, sql })));
                const isDdl = (s: string) => /^\s*(CREATE|ALTER|DROP)\b/i.test(s);
                const ordered = [...statements.filter(s => isDdl(s.sql)), ...statements.filter(s => !isDdl(s.sql))];

                for (const st of ordered) {
                    const label = `${st.file}:${st.line}`;
                    if (SKIP.find(k => k.dialect === target.dialect && k.re.test(st.sql))) continue;
                    try {
                        if (isDdl(st.sql)) { await db.adapter.query(st.sql); executed++; continue; }
                        const table = (st.sql.match(/INSERT\s+(?:IGNORE\s+)?INTO\s+`?([A-Za-z0-9_]+)`?/i) || [])[1] || '';
                        await db.check(st.sql, CONFLICT[table]);
                        executed++;
                    } catch (e: any) {
                        failures.push(`${label}: ${e.message}\n    ${st.sql.replace(/\s+/g, ' ').trim().slice(0, 300)}`);
                    }
                }
            } finally {
                await db.close();
            }
            console.log(`sql-corpus ${target.dialect}: ${literals.length} literals, ${statements.length} statements, ${executed} checked, ${failures.length} failed`);
            if (failures.length) console.error(failures.join('\n\n'));
            expect(failures, failures.join('\n')).toEqual([]);
            expect(executed).toBeGreaterThan(20);
        }, 60_000);
    }
});
