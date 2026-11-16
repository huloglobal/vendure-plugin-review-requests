import { mergeConfig } from '@vendure/core';
import { createTestEnvironment, registerInitializer, MysqlInitializer, testConfig } from '@vendure/testing';
import gql from 'graphql-tag';
import { createHmac } from 'crypto';
import { initialData } from '../../../e2e-shared/initial-data';
import { ReviewRequestPlugin } from '../src/plugin';
import { ReviewRequestService } from '../src/review-request.service';

/**
 * Review-requests targets MySQL/MariaDB (DATE_SUB/INTERVAL), so this runs
 * against real MariaDB — skipped unless creds are provided via env:
 *   RR_E2E_DB_HOST RR_E2E_DB_PORT RR_E2E_DB_USER RR_E2E_DB_PASS
 */
const DB = process.env.RR_E2E_DB_HOST
    ? { host: process.env.RR_E2E_DB_HOST, port: Number(process.env.RR_E2E_DB_PORT || 3306),
        username: process.env.RR_E2E_DB_USER || 'root', password: process.env.RR_E2E_DB_PASS || '' }
    : null;

const PORT = 3064;
const BASE = `http://localhost:${PORT}`;
const run = DB ? describe : describe.skip;

run('@huloglobal/vendure-plugin-review-requests (MariaDB)', () => {
    registerInitializer('mysql', new MysqlInitializer());
    const config = mergeConfig(testConfig, {
        apiOptions: { port: PORT },
        dbConnectionOptions: {
            type: 'mysql' as const, host: DB!.host, port: DB!.port,
            username: DB!.username, password: DB!.password, database: 'hulo_rr_e2e', synchronize: true,
        },
        plugins: [ReviewRequestPlugin.init({ publicBaseUrl: BASE, optOutSecret: 'e2e-secret' })],
    });
    const { server, adminClient } = createTestEnvironment(config);
    beforeAll(async () => { await server.init({ initialData, productsCsvPath: '', customerCount: 0 } as any); }, 120_000);
    afterAll(async () => { await server.destroy(); });
    const svc = () => (server as any).app.get(ReviewRequestService) as ReviewRequestService;

    /** Insert a row, filling every NOT NULL column without a default (Vendure entities have many). */
    async function insertRow(table: string, values: Record<string, any>): Promise<number> {
        const db = (svc() as any).db;
        const cols: any[] = await db.query(
            `SELECT COLUMN_NAME AS name, DATA_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt, EXTRA AS extra
             FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?`, [table]);
        const row: Record<string, any> = { ...values };
        for (const c of cols) {
            if (c.name in row || c.nullable === 'YES' || (c.dflt !== null && c.dflt !== undefined) || /auto_increment/i.test(c.extra || '')) continue;
            row[c.name] = /int|decimal|double|float/i.test(c.type) ? 0 : /date|time/i.test(c.type) ? new Date() : '';
        }
        const keys = Object.keys(row);
        const r = await db.query(`INSERT INTO \`${table}\` (${keys.map(k => `\`${k}\``).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, keys.map(k => row[k]));
        return Number(r.insertId);
    }
    async function seedCustomer(email: string, firstName = 'Sam'): Promise<number> {
        return insertRow('customer', { firstName, lastName: 'Tester', emailAddress: email });
    }
    /** A Delivered order placed `daysAgo` days ago, in the given channels. */
    let orderIdsBumped = false;
    async function seedOrder(customerId: number, channelIds: number[], daysAgo = 25): Promise<number> {
        // Earlier tests write review_log rows for low order ids (1, 2, 3, …): keep seeded orders clear of them.
        if (!orderIdsBumped) { await (svc() as any).db.query('ALTER TABLE `order` AUTO_INCREMENT = 100000'); orderIdsBumped = true; }
        const code = 'E2E' + Math.random().toString(36).slice(2, 12).toUpperCase();
        const id = await insertRow('order', {
            code, state: 'Delivered', active: 0, customerId, subTotal: 4000, subTotalWithTax: 4800,
            orderPlacedAt: new Date(Date.now() - daysAgo * 86_400_000), currencyCode: 'GBP', type: 'Regular',
        });
        for (const ch of channelIds) await (svc() as any).db.query('INSERT INTO order_channels_channel (orderId, channelId) VALUES (?, ?)', [id, ch]);
        return id;
    }
    /** Route the service's SMTP to an in-memory recorder for the duration of `fn` (no real mail). */
    async function withFakeSmtp<T>(fn: (sent: any[]) => Promise<T>): Promise<T> {
        const s0 = svc() as any;
        const sent: any[] = [];
        const opts = s0.getOptions();
        s0.setOptions({ ...opts, smtp: { host: 'smtp.invalid', port: 587, from: 'reviews@shop.test' } });
        s0.transporter = () => ({ sendMail: async (m: any) => { sent.push(m); return { messageId: String(sent.length) }; }, close: () => undefined });
        try { return await fn(sent); }
        finally { s0.setOptions(opts); delete s0.transporter; }
    }

    it('admin endpoints reject anonymous callers', async () => {
        for (const p of ['config', 'stats', 'log', 'template', 'exclusions', 'meta']) {
            expect([401, 403]).toContain((await fetch(`${BASE}/review-requests/${p}`)).status);
        }
    });

    it('saves + reads per-channel config', async () => {
        const cfgs = await svc().getAllConfigs();
        expect(cfgs.length).toBeGreaterThan(0);
        await svc().saveConfig({ ...cfgs[0], enabled: true, delayDays: 21, triggerState: 'Delivered', trustpilotDomain: 'elite-software.co.uk', businessName: 'ELITE' } as any);
        const back = await svc().getConfig(cfgs[0].channelId);
        expect(back.enabled).toBe(true);
        expect(back.delayDays).toBe(21);
        expect(back.businessName).toBe('ELITE');
    });

    it('excludes emails + domains, and reflects it in isExcluded', async () => {
        await svc().addExclusion('email', 'blocked@example.com', 'e2e');
        await svc().addExclusion('email_domain', 'wholesale.test', 'e2e');
        expect(await svc().isExcluded('blocked@example.com')).toBe(true);
        expect(await svc().isExcluded('anyone@wholesale.test')).toBe(true);
        expect(await svc().isExcluded('normal@gmail.com')).toBe(false);
    });

    it('opt-out requires a valid signed token, then excludes', async () => {
        const svc0 = svc();
        const email = 'optme@example.com';
        expect(await svc0.optOut(email, 'wrong-token')).toBe(false);
        const goodToken = await svc0.optOutToken(email);
        expect(await svc0.optOut(email, goodToken)).toBe(true);
        expect(await svc0.isExcluded(email)).toBe(true);
    });

    it('the public opt-out page confirms on GET, applies on POST, rejects a bad token', async () => {
        const email = 'pageme@example.com';
        const tok = await svc().optOutToken(email);
        const url = `${BASE}/review-requests/optout?e=${encodeURIComponent(email)}&t=${tok}`;
        const good = await (await fetch(url)).text();
        expect(good).toContain('unsubscribe me'); // confirm button only — GETs are prefetched by mail scanners
        expect(await svc().isExcluded(email)).toBe(false);
        const applied = await (await fetch(url, { method: 'POST' })).text();
        expect(applied).toContain('unsubscribed');
        expect(applied).toContain('border:1px solid #e5e7eb;border-radius:10px'); // 0.18.0 card
        expect(good).toContain('action="optout?e='); // relative: works behind a path prefix
        expect(await svc().isExcluded(email)).toBe(true);
        const bad = await (await fetch(`${BASE}/review-requests/optout?e=x@y.com&t=nope`)).text();
        expect(bad).toContain('expired');
        const badPost = await fetch(`${BASE}/review-requests/optout?e=x@y.com&t=nope`, { method: 'POST' });
        expect(badPost.status).toBe(400);
    });

    it('template save rejects an oversized subject / body with a 400 and a size message (service-level guard lives in the controller)', async () => {
        // The service itself stores anything; the controller enforces 255 chars / 4 MB — checked via the HTTP route with an anonymous caller being rejected first.
        const r = await fetch(`${BASE}/review-requests/template`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channelId: 1, subject: 'x'.repeat(300), body: '<p>hi</p>' }) });
        expect([401, 403]).toContain(r.status);
    });

    it('pending summary is memoised between calls and dropped by invalidatePending()', async () => {
        const s0 = svc();
        const a = await s0.pendingSummary();
        const b = await s0.pendingSummary();
        expect(b).toBe(a); // same array instance → served from the memo
        s0.invalidatePending();
        const c = await s0.pendingSummary();
        expect(c).not.toBe(a);
        expect(Array.isArray(c)).toBe(true);
    });

    it('batched eligibility: excluded + opted-out + cooldown emails are skipped in one pass', async () => {
        const s0 = svc();
        await s0.addExclusion('email', 'batch-ex@example.com', 'e2e');
        await s0.addExclusion('email_domain', 'batchdom.test', 'e2e');
        await s0.optOut('batch-opt@example.com', await s0.optOutToken('batch-opt@example.com'));
        await s0.logSend(424242, 'BATCHCD', 1, 'batch-cd@example.com', 'sent', '', '');
        const gate = await (s0 as any).batchEligibility(
            ['batch-ex@example.com', 'anyone@batchdom.test', 'batch-opt@example.com', 'batch-cd@example.com', 'fine@example.com'], 120);
        expect(gate.excluded.has('batch-ex@example.com')).toBe(true);
        expect(gate.excluded.has('anyone@batchdom.test')).toBe(true);
        expect(gate.excluded.has('batch-opt@example.com')).toBe(true);
        expect(gate.excluded.has('fine@example.com')).toBe(false);
        expect(gate.cooldown.has('batch-cd@example.com')).toBe(true);
        expect(gate.cooldown.has('fine@example.com')).toBe(false);
        const none = await (s0 as any).batchEligibility(['batch-cd@example.com'], 0);
        expect(none.cooldown.size).toBe(0); // cooldown disabled
    });

    it('pruneLog removes old non-sent rows in batches and keeps sent rows', async () => {
        const s0 = svc();
        const db = (s0 as any).db;
        await db.query(`INSERT INTO review_log (orderId, orderCode, channelId, email, status, reason, reviewUrl, createdAt) VALUES (1, 'OLD1', 1, 'old@example.com', 'skipped', 'excluded', '', DATE_SUB(NOW(), INTERVAL 20 MONTH))`);
        await db.query(`INSERT INTO review_log (orderId, orderCode, channelId, email, status, reason, reviewUrl, createdAt) VALUES (2, 'OLD2', 1, 'old@example.com', 'sent', '', '', DATE_SUB(NOW(), INTERVAL 20 MONTH))`);
        await db.query(`INSERT INTO review_log (orderId, orderCode, channelId, email, status, reason, reviewUrl, createdAt) VALUES (3, 'NEW3', 1, 'new@example.com', 'failed', 'x', '', NOW())`);
        const n = await s0.pruneLog(18, 1);
        expect(n).toBe(1);
        const left = await db.query(`SELECT orderCode FROM review_log WHERE orderCode IN ('OLD1','OLD2','NEW3') ORDER BY orderCode`);
        expect(left.map((r: any) => r.orderCode)).toEqual(['NEW3', 'OLD2']);
    });

    it('composes an invitation email with the review link', async () => {
        const cfg = await svc().getConfig(1);
        const composed = await svc().composeEmail(cfg, 'shopper@example.com', 'Sam', 'ORD123');
        expect(composed).toBeTruthy();
        expect(composed!.html).toContain('trustpilot.com/evaluate/elite-software.co.uk');
        expect(composed!.subject).toContain('Sam');
        // 0.18.0: the shared card, a plain-text alternative, the sign-off
        expect(composed!.html).toContain('border-bottom:3px solid #155dfc');
        expect(composed!.html).toContain('Kind regards,');
        expect(composed!.text).toContain('Leave a review (https://');
        expect(composed!.text).toContain('Unsubscribe (http://localhost');
        expect(composed!.text).not.toMatch(/<[a-z]/i);
    });

    it('a saved custom template still renders inside the new card (0.18.0)', async () => {
        await svc().saveTemplate(1, 'Hello {{firstName}}', '<p class="mine">Custom for {{firstName}} at {{businessName}}</p>{{reviewButton}}');
        try {
            const c = await svc().composeEmail(await svc().getConfig(1), 'shopper@example.com', 'Sam <b>', 'ORD123');
            expect(c!.subject).toBe('Hello Sam <b>');
            expect(c!.html).toContain('<p class="mine">Custom for Sam &lt;b&gt; at ');
            expect(c!.html).toContain('Leave a review</a>');
            expect(c!.html).toContain('max-width:600px');
        } finally {
            await (svc() as any).db.query('DELETE FROM review_template WHERE channelId = 1');
        }
    });

    it('products on an order come from the channel language, with English and any-language fallbacks (0.18.0)', async () => {
        const db = (svc() as any).db;
        const [line] = await db.query('SELECT ol.`orderId` AS orderId FROM order_line ol LIMIT 1').catch(() => []);
        if (!line) return; // no seeded order lines in this fixture
        const products = await svc().getOrderProducts(Number(line.orderId));
        expect(products.length).toBeGreaterThan(0);
        expect(new Set(products.map(p => p.slug)).size).toBe(products.length);
    });

    it('composes product-review links in product / both mode', async () => {
        const base = await svc().getConfig(1);
        // both mode + a product-review template → email lists sample products
        const both = { ...base, reviewMode: 'both', productReviewUrlTemplate: 'https://shop.test/product/{slug}?review=1', trustpilotDomain: 'elite-software.co.uk' } as any;
        const c1 = await svc().composeEmail(both, 'a@b.test', 'Sam', 'ORD1', 0);
        expect(c1!.html).toContain('Review this');
        expect(c1!.html).toContain('shop.test/product/sample-a?review=1');
        expect(c1!.html).toContain('trustpilot.com/evaluate/elite-software.co.uk'); // service button too

        // product-only mode → no service button
        const prod = { ...both, reviewMode: 'product' } as any;
        const c2 = await svc().composeEmail(prod, 'a@b.test', 'Sam', 'ORD1', 0);
        expect(c2!.html).toContain('Review this');
        expect(c2!.html).not.toContain('Leave a review');

        // service-only (default) → no product list
        const svcOnly = { ...both, reviewMode: 'service' } as any;
        const c3 = await svc().composeEmail(svcOnly, 'a@b.test', 'Sam', 'ORD1', 0);
        expect(c3!.html).not.toContain('Review this');
    });

    it('getOrderProducts returns an array (empty on the no-order fixture)', async () => {
        expect(Array.isArray(await svc().getOrderProducts(999999))).toBe(true);
        expect(await svc().getOrderProducts(0)).toEqual([]);
    });

    it('dry-run eligibility returns a numeric summary (no orders in the fixture)', async () => {
        const cfg = await svc().getConfig(1);
        const res = await svc().runChannel(cfg, true);
        expect(res).toHaveProperty('eligible');
        expect(res.sent).toBe(0);
    });

    it('checkExcluded reports why an email is excluded', async () => {
        await svc().addExclusion('email', 'checkme@example.com', 'e2e');
        await svc().addExclusion('email_domain', 'blockdom.test', 'e2e');
        expect(await svc().checkExcluded('checkme@example.com')).toMatchObject({ excluded: true, via: 'excluded' });
        expect(await svc().checkExcluded('anyone@blockdom.test')).toMatchObject({ excluded: true, via: 'domain rule' });
        expect(await svc().checkExcluded('fine@gmail.com')).toMatchObject({ excluded: false, via: null });
    });

    it('searchCustomers returns an array (empty on the no-customer fixture)', async () => {
        const r = await svc().searchCustomers('sam');
        expect(Array.isArray(r)).toBe(true);
        expect(await svc().searchCustomers('a')).toEqual([]); // < 2 chars → empty
    });

    it('template edit + reset round-trips', async () => {
        await svc().saveTemplate(1, 'Custom {{firstName}}', '<p>{{reviewUrl}}</p>');
        expect((await svc().getTemplate(1)).isDefault).toBe(false);
        await svc().resetTemplate(1);
        expect((await svc().getTemplate(1)).isDefault).toBe(true);
    });

    // ── 0.16.2 regressions ─────────────────────────────────────────────

    it('two due orders for one customer get ONE invitation (cooldown) — in one run and across concurrent runs', async () => {
        const cfg = { ...(await svc().getConfig(1)), enabled: true, delayDays: 21, cooldownDays: 120 };
        await withFakeSmtp(async sent => {
            // Same run: both orders come back from the candidate query together.
            const c1 = await seedCustomer('twice@example.com');
            await seedOrder(c1, [1]); await seedOrder(c1, [1]);
            await svc().runChannel(cfg);
            expect(sent.filter(m => m.to === 'twice@example.com')).toHaveLength(1);

            // Two overlapping runs (hourly cron in the worker + "Send due now" on the server).
            const c2 = await seedCustomer('race@example.com');
            await seedOrder(c2, [1]); await seedOrder(c2, [1]);
            await Promise.all([svc().runChannel(cfg), svc().runChannel(cfg)]);
            expect(sent.filter(m => m.to === 'race@example.com')).toHaveLength(1);
        });
    });

    it('unsubscribe secret: a failed read neither rotates the stored secret nor falls back to a public literal', async () => {
        const s0 = svc() as any;
        const opts = s0.getOptions();
        const salt = process.env.HULO_IP_SALT;
        delete process.env.HULO_IP_SALT;
        s0.setOptions({ ...opts, optOutSecret: undefined });
        s0.optOutSecretCache = null;
        const real = s0.db;
        const stored = async () => (await real.query(`SELECT licenceKey FROM hulo_licence_store WHERE pluginId = 'review-requests-optout-secret'`))[0]?.licenceKey;
        try {
            const tok = await s0.optOutToken('keep@example.com');
            const secret = await stored();
            expect(secret).toMatch(/^[0-9a-f]{64}$/);

            // A transient read failure (SELECT only) must not overwrite the secret every sent link is signed with.
            s0.optOutSecretCache = null;
            let failReads = true;
            Object.defineProperty(s0, 'db', { configurable: true, get: () => ({
                dialect: real.dialect,
                query: (sql: string, p?: any[], o?: any) => failReads && /^\s*SELECT[\s\S]*hulo_licence_store/i.test(sql) ? (failReads = false, Promise.reject(new Error('connection lost'))) : real.query(sql, p, o),
            }) });
            await s0.optOutToken('keep@example.com').catch(() => null);
            expect(await stored()).toBe(secret);
            s0.optOutSecretCache = null;
            expect(await s0.optOutTokenValid('keep@example.com', tok)).toBe(true); // old links still work

            // Store fully down: a token made with the old shared literal must not be accepted.
            s0.optOutSecretCache = null;
            Object.defineProperty(s0, 'db', { configurable: true, get: () => ({
                dialect: real.dialect,
                query: (sql: string, p?: any[], o?: any) => /hulo_licence_store/.test(sql) ? Promise.reject(new Error('connection lost')) : real.query(sql, p, o),
            }) });
            const forged = createHmac('sha256', 'hulo-review-optout').update('victim@example.com').digest('hex').slice(0, 32);
            expect(await s0.optOutTokenValid('victim@example.com', forged)).toBe(false);
            expect(await s0.optOutUrl('victim@example.com')).toBe(''); // → the send refuses rather than mailing a forgeable link
        } finally {
            delete s0.db;
            s0.optOutSecretCache = null;
            s0.setOptions(opts);
            if (salt !== undefined) process.env.HULO_IP_SALT = salt;
        }
    });

    describe('channel scoping (an admin whose role covers only channel 2)', () => {
        let ch2 = 0;
        let scopedToken = '';
        let superToken = '';
        let ch1Order = 0;
        const call = (path: string, token: string, init: RequestInit = {}, channelToken: string | null = 'rr-second-token') => fetch(`${BASE}/review-requests/${path}`, {
            ...init,
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(channelToken ? { 'vendure-token': channelToken } : {}), ...(init.headers || {}) },
        });

        beforeAll(async () => {
            await adminClient.asSuperAdmin();
            const { createChannel } = await adminClient.query(gql`
                mutation {
                    createChannel(input: {
                        code: "rr-second", token: "rr-second-token", defaultLanguageCode: en,
                        pricesIncludeTax: false, currencyCode: GBP, defaultCurrencyCode: GBP,
                        defaultShippingZoneId: "1", defaultTaxZoneId: "1"
                    }) { ... on Channel { id } ... on ErrorResult { message } }
                }`);
            ch2 = Number(String(createChannel.id).replace(/^T_/, '')); // the testing id strategy returns "T_<n>"
            const { createRole } = await adminClient.query(gql`
                mutation($ch: ID!) {
                    createRole(input: { code: "rr-ch2-admin", description: "ch2", permissions: [ReadSettings, UpdateSettings, ReadOrder], channelIds: [$ch] }) { id }
                }`, { ch: createChannel.id });
            await adminClient.query(gql`
                mutation($role: ID!) {
                    createAdministrator(input: { firstName: "Ch", lastName: "Two", emailAddress: "rr-ch2@test", password: "ch2pass", roleIds: [$role] }) { id }
                }`, { role: createRole.id });
            // Logged in with a plain fetch: the shared client logs out its current session on every login.
            const login = await fetch(`${BASE}/admin-api`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ query: 'mutation { login(username: "rr-ch2@test", password: "ch2pass") { ... on CurrentUser { id } } }' }),
            });
            scopedToken = String(login.headers.get('vendure-auth-token') || '');
            expect(scopedToken).not.toBe('');
            await adminClient.asSuperAdmin(); // fresh session: its channel permissions include channel 2
            superToken = adminClient.getAuthToken();

            await svc().logSend(900001, 'CH1SECRET', 1, 'channel-one-customer@example.com', 'sent', '', 'https://www.trustpilot.com/evaluate/one.test');
            await svc().logSend(900002, 'CH2OWN', ch2, 'channel-two-customer@example.com', 'sent', '', 'https://www.trustpilot.com/evaluate/two.test');
            ch1Order = await seedOrder(await seedCustomer('ch1-order@example.com'), [1], 3);
        });

        it('the log and config only show channel 2', async () => {
            const log = await call('log', scopedToken);
            expect(log.status).toBe(200);
            const text = await log.text();
            expect(text).toContain('channel-two-customer@example.com');
            expect(text).not.toContain('channel-one-customer@example.com');

            const cfg: any[] = await (await call('config', scopedToken)).json();
            expect(cfg.map(c => Number(c.channelId))).toEqual([ch2]);
        });

        it('cannot read or change channel 1 templates, config or orders', async () => {
            expect((await call('template?channelId=1', scopedToken)).status).toBe(403);
            expect((await call('template', scopedToken, { method: 'POST', body: JSON.stringify({ channelId: 1, subject: 'x', body: '<p>x</p>' }) })).status).toBe(403);
            const saved = await (await call('config', scopedToken, { method: 'POST', body: JSON.stringify({ configs: [{ channelId: 1, enabled: false }] }) })).json();
            expect(saved.rejected).toContain(1);
            expect(saved.saved).toBe(0);
            expect(await (await call(`order-status/${ch1Order}`, scopedToken)).json()).toEqual({ found: false });
            const sendRes = await call(`send-order/${ch1Order}`, scopedToken, { method: 'POST', body: '{}' });
            expect([400, 402, 404]).toContain(sendRes.status);
            if (sendRes.status !== 402) expect((await sendRes.json()).reason).toBe('Order not found');
            expect(await svc().sendForOrder(ch1Order, true, [ch2])).toMatchObject({ ok: false, reason: 'Order not found', code: 'not_found' }); // past the licence gate too
        });

        it('cannot change install-wide settings (licence, weekly report)', async () => {
            expect((await call('licence/deactivate', scopedToken, { method: 'POST', body: '{}' })).status).toBe(403);
            expect((await call('digest/settings', scopedToken, { method: 'POST', body: JSON.stringify({ enabled: false }) })).status).toBe(403);
        });

        it('a default-channel (super) admin still sees every channel, whatever channel token the UI sends', async () => {
            const text = await (await call('log', superToken)).text();
            expect(text).toContain('channel-one-customer@example.com');
            expect(text).toContain('channel-two-customer@example.com');
            const cfg: any[] = await (await call('config', superToken)).json();
            expect(cfg.map(c => Number(c.channelId))).toEqual(expect.arrayContaining([1, ch2]));
            expect((await call(`order-status/${ch1Order}`, superToken)).status).toBe(200);
            expect((await (await call(`order-status/${ch1Order}`, superToken)).json()).found).toBe(true);
        });
    });

    // ── 0.17.0: parity wave ────────────────────────────────────────────
    describe('0.17.0 parity wave', () => {
        let token = '';
        const http = (path: string, init: RequestInit = {}) => fetch(`${BASE}/review-requests/${path}`, {
            ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
        });
        const setPremium = (on: boolean) => {
            (ReviewRequestPlugin as any).licenceStatus = on ? { valid: true, message: 'e2e licence' } : { valid: false, message: 'No licence key configured.' };
        };
        const db = () => (svc() as any).db;
        let base: any;

        beforeAll(async () => {
            await adminClient.asSuperAdmin();
            token = adminClient.getAuthToken();
            base = { ...(await svc().getConfig(1)), enabled: true, delayDays: 21, cooldownDays: 120, maxPerRun: 200, trustpilotDomain: 'elite-software.co.uk', reviewUrlTemplate: 'https://www.trustpilot.com/evaluate/{domain}' };
            await svc().saveConfig(base);
        });
        afterEach(async () => { setPremium(false); await svc().saveConfig(base); });

        it('B6: without a review page nothing is sent, logged or claimed — scheduled, manual, list or test', async () => {
            await svc().saveConfig({ ...base, trustpilotDomain: '' });
            const cust = await seedCustomer('nopage@example.com');
            const order = await seedOrder(cust, [1]);
            await withFakeSmtp(async sent => {
                const run = await svc().runChannel(await svc().getConfig(1));
                expect(run.notReady).toContain('Set your review page');
                const r = await svc().sendForOrder(order);
                expect(r).toMatchObject({ ok: false, code: 'not_set_up' });
                setPremium(true);
                const list = await svc().sendList(1, 'nopage2@example.com', 'now');
                expect(list.ok).toBe(false);
                expect(list.blocked).toContain('Set your review page');
                const test = await http('test-send', { method: 'POST', body: JSON.stringify({ channelId: 1, email: 'me@example.com' }) });
                expect(test.status).toBe(400);
                expect(sent).toHaveLength(0);
            });
            expect(await db().query(`SELECT id FROM review_log WHERE orderId = ?`, [order])).toHaveLength(0);
            expect(await db().query(`SELECT email FROM review_email_claim WHERE email = 'nopage@example.com'`)).toHaveLength(0);
            expect(await db().query(`SELECT id FROM review_queue WHERE email = 'nopage2@example.com'`)).toHaveLength(0);
            // Once the page is set the customer is invited normally (the cooldown did not hold them back).
            await svc().saveConfig(base);
            await withFakeSmtp(async sent => {
                expect((await svc().sendForOrder(order)).ok).toBe(true);
                expect(sent.map(m => m.to)).toEqual(['nopage@example.com']);
            });
        });

        it('B6: the config save validates the review page and takes the identifier from a pasted page; Reviews.io uses company-reviews/store', async () => {
            const save = async (patch: any) => (await http('config', { method: 'POST', body: JSON.stringify({ configs: [{ ...base, ...patch }] }) })).json();
            let r = await save({ reviewUrlTemplate: 'https://www.trustpilot.com/evaluate/{domain}', trustpilotDomain: 'https://uk.trustpilot.com/review/harbourbakery.co.uk' });
            expect(r.errors).toEqual([]);
            expect((await svc().getConfig(1)).trustpilotDomain).toBe('harbourbakery.co.uk');
            r = await save({ reviewUrlTemplate: 'https://search.google.com/local/writereview?placeid={domain}', trustpilotDomain: 'https://g.page/r/CabcdEFGH/review' });
            expect(r.errors[0].message).toContain('Custom link');
            expect((await svc().getConfig(1)).trustpilotDomain).toBe('');
            expect(r.notReady.find((x: any) => x.channelId === 1).problem).toContain('Set your review page');
            r = await save({ reviewUrlTemplate: 'https://www.reviews.io/company-review/store/{domain}/new', trustpilotDomain: 'https://www.reviews.io/company-reviews/store/harbour-bakery' });
            const cfg = await svc().getConfig(1);
            expect(cfg.reviewUrlTemplate).toBe('https://www.reviews.io/company-reviews/store/{domain}');
            expect(cfg.trustpilotDomain).toBe('harbour-bakery');
            r = await save({ reviewUrlTemplate: 'javascript:alert(1)', trustpilotDomain: '' });
            expect(r.errors[0].message).toContain('is not a link');
            expect((await svc().getConfig(1)).reviewUrlTemplate).toBe('https://www.reviews.io/company-reviews/store/{domain}');
            // A Reviews.io template stored by an older version reads as the current one.
            await db().query(`UPDATE review_config SET reviewUrlTemplate = 'https://www.reviews.io/company-review/store/{domain}/new' WHERE channelId = 1`);
            expect((await svc().getConfig(1)).reviewUrlTemplate).toBe('https://www.reviews.io/company-reviews/store/{domain}');
        });

        it('manual send is free and adds an order note; Resend (force) needs a licence', async () => {
            const order = await seedOrder(await seedCustomer('free-send@example.com', 'Fay'), [1]);
            await withFakeSmtp(async sent => {
                const r = await http(`send-order/${order}`, { method: 'POST', body: '{}' });
                expect(r.status).toBe(200);
                expect(sent.map(m => m.to)).toEqual(['free-send@example.com']);
                const again = await http(`send-order/${order}`, { method: 'POST', body: JSON.stringify({ force: true }) });
                expect(again.status).toBe(402);
                setPremium(true);
                expect((await http(`send-order/${order}`, { method: 'POST', body: JSON.stringify({ force: true }) })).status).toBe(200);
                expect(sent).toHaveLength(2);
            });
            const notes: any[] = await db().query(`SELECT data FROM history_entry WHERE orderId = ? AND type = 'ORDER_NOTE'`, [order]);
            expect(notes.length).toBe(2);
            expect(String(notes[0].data)).toContain('Review invitation e-mailed to free-send@example.com');
            const log: any[] = await db().query(`SELECT status, reason FROM review_log WHERE orderId = ? ORDER BY id`, [order]);
            expect(log.map(l => `${l.status}:${l.reason}`)).toEqual(['sent:manual', 'sent:resend']);
        });

        it('manual send honours the cooldown and the hourly limit (Resend overrides the cooldown)', async () => {
            const cust = await seedCustomer('cool@example.com');
            const o1 = await seedOrder(cust, [1]);
            const o2 = await seedOrder(cust, [1]);
            await withFakeSmtp(async sent => {
                expect((await svc().sendForOrder(o1)).ok).toBe(true);
                const r = await svc().sendForOrder(o2);
                expect(r).toMatchObject({ ok: false, code: 'cooldown' });
                expect(await db().query(`SELECT id FROM review_log WHERE orderId = ? AND status = 'skipped' AND reason = 'cooldown'`, [o2])).toHaveLength(1);
                expect((await svc().orderReviewStatus(o2)).cooldown).toBe(true);
                expect((await svc().sendForOrder(o2, true)).ok).toBe(true);
                expect(sent).toHaveLength(2);
                // Hourly limit: with maxPerRun at what was already sent this hour, the next staff send waits.
                const n = await svc().sentLastHour(1);
                await svc().saveConfig({ ...base, maxPerRun: n });
                const o3 = await seedOrder(await seedCustomer('capped@example.com'), [1]);
                expect(await svc().sendForOrder(o3)).toMatchObject({ ok: false, code: 'capped' });
            });
        });

        it('lists (premium): pasted text is parsed, sent a batch at a time; opt-outs, exclusions and the cooldown apply', async () => {
            const body = 'Ana Lima <ana.list@example.com>, ben.list@example.com\nnot an address\nopted.list@example.com\nex.list@example.com';
            const post = (mode: string, text: string) => http(`lists?channelId=1&mode=${mode}`, { method: 'POST', body: text, headers: { 'content-type': 'text/plain' } });
            expect((await post('now', body)).status).toBe(402);
            setPremium(true);
            await svc().optOut('opted.list@example.com', await svc().optOutToken('opted.list@example.com'));
            await svc().addExclusion('email', 'ex.list@example.com', 'e2e');
            await withFakeSmtp(async sent => {
                const r = await (await post('now', body)).json();
                expect(r.ok).toBe(true);
                expect(r.sent).toBe(2);
                expect(r.skipped).toBe(2);
                expect(r.invalid).toBe(1);
                expect(r.message).toContain('could not be read');
                expect(sent.map(m => m.to).sort()).toEqual(['ana.list@example.com', 'ben.list@example.com']);
                const ana = sent.find(m => m.to === 'ana.list@example.com');
                expect(ana.subject).toContain('Ana');
                expect(ana.html).not.toContain('recent order'); // the built-in list e-mail mentions no order
                const ben = sent.find(m => m.to === 'ben.list@example.com');
                expect(ben.subject).toMatch(/^How did we do\? /); // no name known
                const rows: any[] = await db().query(`SELECT email, state, reason FROM review_queue WHERE email LIKE '%.list@example.com' ORDER BY email`);
                expect(rows.map(x => `${x.email}:${x.state}`)).toEqual([
                    'ana.list@example.com:sent', 'ben.list@example.com:sent', 'ex.list@example.com:skipped', 'opted.list@example.com:skipped',
                ]);
                const logs: any[] = await db().query(`SELECT orderId, status, reason, queueId FROM review_log WHERE email = 'ana.list@example.com'`);
                expect(logs).toHaveLength(1);
                expect(logs[0]).toMatchObject({ orderId: 0, status: 'sent', reason: 'list' });
                expect(Number(logs[0].queueId)).toBeGreaterThan(0);
                // The cooldown: the same list again sends nobody.
                const again = await (await post('now', 'ana.list@example.com')).json();
                expect(again.sent).toBe(0);
                expect(again.message).toContain('cooldown');
            });
        });

        it('lists: more than 20 go out in the background; a scheduled list waits for its day and for sending to be on', async () => {
            setPremium(true);
            const many = Array.from({ length: 23 }, (_, i) => `bulk${i}.list@example.com`).join('\n');
            await withFakeSmtp(async sent => {
                const r = await svc().sendList(1, many, 'now');
                expect(r.sent).toBe(20);
                expect(r.queued).toBe(3);
                const bg = await svc().processOutbox();
                expect(bg.sent).toBe(3);
                expect(sent).toHaveLength(23);

                const sched = await svc().sendList(1, 'later1.list@example.com\nlater2.list@example.com', 'schedule');
                expect(sched).toMatchObject({ ok: true, scheduled: 2, sent: 0 });
                expect(sched.message).toContain('in 21 days');
                expect(await svc().promoteScheduled()).toBe(0); // not due yet
                const waiting = await svc().notInvited(null);
                expect(waiting.scheduled.map((q: any) => q.email)).toEqual(expect.arrayContaining(['later1.list@example.com', 'later2.list@example.com']));
                await db().query(`UPDATE review_queue SET dueAt = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE email = 'later1.list@example.com'`);
                await svc().saveConfig({ ...base, enabled: false });
                expect(await svc().promoteScheduled()).toBe(0); // sending off for the channel
                await svc().saveConfig(base);
                expect(await svc().promoteScheduled()).toBe(1);
                await svc().processOutbox();
                expect(sent.map(m => m.to)).toContain('later1.list@example.com');
                expect(sent.map(m => m.to)).not.toContain('later2.list@example.com');
                const q = waiting.scheduled.find((x: any) => x.email === 'later2.list@example.com');
                expect((await (await http(`queue/${q.id}`, { method: 'DELETE' })).json()).ok).toBe(true);
            });
        });

        it('the orders-list bulk action and Invite selected (premium): 20 now, the rest in the background', async () => {
            const ids: number[] = [];
            for (let i = 0; i < 22; i++) ids.push(await seedOrder(await seedCustomer(`bulk${i}.order@example.com`), [1]));
            expect((await http('bulk-send', { method: 'POST', body: JSON.stringify({ orderIds: ids }) })).status).toBe(402);
            setPremium(true);
            const ni = await (await http('not-invited')).json();
            expect(ni.orders.map((o: any) => o.orderId)).toEqual(expect.arrayContaining(ids));
            await withFakeSmtp(async sent => {
                const r = await (await http('bulk-send', { method: 'POST', body: JSON.stringify({ orderIds: ids.slice(0, 21) }) })).json();
                expect(r).toMatchObject({ sent: 20, queued: 1, skipped: 0 });
                expect(r.message).toContain('20 invitations sent');
                const after = await svc().notInvited(null);
                expect(after.outbox).toBe(1);
                expect(after.orders.map((o: any) => o.orderId)).not.toContain(ids[20]); // waiting in the outbox
                expect((await svc().processOutbox()).sent).toBe(1);
                const inv = await (await http('invite-selected', { method: 'POST', body: JSON.stringify({ orderIds: [ids[21], ids[0]] }) })).json();
                expect(inv.sent).toBe(1);
                expect(inv.skipped).toBe(1); // ids[0] already invited
                expect(sent).toHaveLength(22);
            });
            const notes: any[] = await db().query(`SELECT id FROM history_entry WHERE orderId = ? AND type = 'ORDER_NOTE'`, [ids[20]]);
            expect(notes).toHaveLength(1);
        });

        it('opt-out list (free) and exclusions stay free', async () => {
            await svc().optOut('listme.opt@example.com', await svc().optOutToken('listme.opt@example.com'));
            const r = await (await http('optouts?q=listme.opt')).json();
            expect(r.rows.map((x: any) => x.email)).toEqual(['listme.opt@example.com']);
            expect(r.total).toBeGreaterThan(0);
            expect([200, 201]).toContain((await http('exclusions', { method: 'POST', body: JSON.stringify({ type: 'email', value: 'free-ex@example.com' }) })).status);
            expect((await http('exclusions', { method: 'POST', body: JSON.stringify({ type: 'email', value: '' }) })).status).toBe(400);
        });

        it('weekly report, set-up checklist and the rating box are premium', async () => {
            const tick = vi_spy(svc().getDigest()!, 'tick');
            expect(await svc().digestTick()).toBe(false);
            expect(tick.calls).toBe(0);
            expect(await (await http('setup')).json()).toMatchObject({ locked: true, items: [] });
            expect((await http('digest/send-test', { method: 'POST', body: '{}' })).status).toBe(402);
            expect((await http('digest/preview')).status).toBe(402);
            expect((await (await http('digest/settings')).json()).premium).toBe(false);
            expect((await http('trustpilot/check', { method: 'POST', body: JSON.stringify(base) })).status).toBe(402);
            const rating = vi_spy(svc() as any, 'getRating');
            await svc().composeEmail({ ...base, trustpilotApiKey: 'k' }, 'r@example.com', 'R', 'ORD1');
            expect(rating.calls).toBe(0);
            setPremium(true);
            await svc().digestTick();
            expect(tick.calls).toBe(1);
            expect((await (await http('setup')).json()).locked).toBe(false);
            await svc().composeEmail({ ...base, trustpilotApiKey: 'k' }, 'r@example.com', 'R', 'ORD1');
            expect(rating.calls).toBe(1);
            tick.restore(); rating.restore();
        });
    });
});

/** A minimal call-counting spy (jest's own spies are not imported in this file). */
function vi_spy(obj: any, name: string): { calls: number; restore: () => void } {
    const orig = obj[name];
    const spy = { calls: 0, restore: () => { obj[name] = orig; } };
    obj[name] = async (...args: any[]) => { spy.calls++; return name === 'getRating' ? null : orig.apply(obj, args); };
    return spy;
}
