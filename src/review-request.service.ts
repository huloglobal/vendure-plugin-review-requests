import {
    LicenceStore, adapterFor, PurchaseClaimClient, PluginPrefs, WeeklyDigest, composeDigest,
    DigestInput, DigestMail, DigestStat, DigestTip, LicenceSummary, EvaluationState,
} from '@huloglobal/vendure-licence-sdk';
import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { HistoryService, Logger, RequestContextService, TransactionalConnection } from '@vendure/core';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import * as nodemailer from 'nodemailer';

import { DEFAULT_CONFIG, ReviewChannelConfig, ReviewPluginOptions, TriggerState } from './types';
import {
    DEFAULT_LIST_BODY, DEFAULT_SUBJECT_NO_NAME, DEFAULT_TEMPLATE, Template, renderTemplate, wrapEmail, escapeHtml,
    resolveDesign, reviewButtonHtml, productListHtml, ratingBlockHtml, signOffHtml, htmlToText,
} from './templates';
import { buildReviewUrl, fetchRating, findBusinessUnitId, formatScore, renderStars, TrustpilotRating } from './trustpilot';
import { fetchGoogleRating } from './google';
import { parseClickToken, signClickToken } from './click-token';
import { currentTemplate, reviewPageProblem, validateReviewPage } from './review-page';
import { firstNameOf, isEmail, readList, unreadableMessage, ParsedList } from './list-parser';

const loggerCtx = 'ReviewRequests';

/** Days beyond `delayDays` an order stays a candidate (slow carriers, worker downtime). */
const LOOKBACK_DAYS = 45;

/** One name + slug per product, in first-seen order (max 20): `lang` first, then English, then any. */
export function pickProductTranslations(rows: Array<{ productId: any; languageCode: string; name: string; slug: string }>, lang: string): Array<{ name: string; slug: string }> {
    const rank = (l: string) => (lang && l === lang ? 0 : l === 'en' ? 1 : 2);
    const best = new Map<string, { r: number; name: string; slug: string }>();
    for (const row of rows) {
        const id = String(row.productId);
        const r = rank(String(row.languageCode || ''));
        const cur = best.get(id);
        if (!cur || r < cur.r) best.set(id, { r, name: String(row.name || ''), slug: String(row.slug || '') });
    }
    return [...best.values()].filter(p => p.name).slice(0, 20).map(({ name, slug }) => ({ name, slug }));
}

/** Package short id — pref namespace, buy URL, digest id. */
export const PLUGIN_SHORT_ID = 'vendure-plugin-review-requests';
export const PLUGIN_DISPLAY_NAME = 'Review Requests';
/**
 * What the free tier does not have — shown in the admin banners, the weekly report and the
 * licence server's e-mails. Free (0.17.0): sending the invitation for one order from the order
 * page (opt-outs, exclusions, the cooldown and the hourly limit apply), exclusions, the
 * unsubscribe list, the e-mail editor with preview and test send, click tracking, the order note
 * and the dashboard widget. When the licence lapses nothing is deleted: the premium features
 * below pause and the free ones carry on.
 */
export const PREMIUM_FEATURES = [
    'Automatic sending a set number of days after each order (hourly), with Send due now',
    'Invite customers from a pasted or CSV list, now or scheduled',
    '"Not invited yet" list with Invite selected',
    'Bulk "Send review invitation" on the orders list',
    'Resend, overriding exclusions, the cooldown or a previous invitation',
    'Trustpilot and Google star-rating box in the e-mail',
    'Weekly e-mail report and set-up checklist',
];

/** Invitations sent straight away by one bulk request; the rest go out in the background, this many a minute. */
export const SEND_BATCH = 20;

/** The outcome of one staff send. `code` says why it did not happen. */
export interface SendResult {
    ok: boolean;
    reason?: string;
    code?: 'sent' | 'not_set_up' | 'not_found' | 'invalid' | 'unsubscribed' | 'already' | 'excluded' | 'cooldown' | 'capped' | 'claimed' | 'failed' | 'licence';
}

/** Summary of a bulk send (orders list, Invite selected, a list sent now). */
export interface BulkResult { sent: number; skipped: number; queued: number; reasons: Record<string, number>; blocked?: string }

/** Usage-stat keys reported to the licence server (eval + heartbeat) and
 *  rendered in the weekly report. Numbers only, never personal data. */
export type UsageStatKey = 'invitesSent' | 'reviewLinkClicks' | 'invitesSkipped' | 'invitesFailed' | 'optOuts';
export const USAGE_STAT_LABELS: Record<UsageStatKey, string> = {
    invitesSent: 'review invitations sent',
    reviewLinkClicks: 'review links clicked',
    invitesSkipped: 'orders skipped (excluded, cooldown)',
    invitesFailed: 'invitations failed',
    optOuts: 'customers opted out',
};
const USAGE_STAT_ORDER: UsageStatKey[] = ['invitesSent', 'reviewLinkClicks', 'invitesSkipped', 'invitesFailed', 'optOuts'];

export interface SetupItem { key: string; label: string; done: boolean; hint: string; tab?: string; url?: string }

/** Hooks the plugin class supplies so this file never imports it. */
export interface EngagementHooks {
    tier: () => 'paid' | 'trial' | 'free';
    licence: () => LicenceSummary | null;
    evalState: () => EvaluationState | null;
    /** Re-load an admin-activated key in the worker before building a report. */
    refresh?: () => Promise<void>;
    /** Licence or evaluation active (premium features: the rating box, the weekly report …). */
    premium?: () => boolean;
}

const DAY_MS = 86_400_000;

/** Channels an admin request may touch: `null` = every channel, else these ids only. */
export type ChannelScope = number[] | null;

/** ` AND <col> IN (?, …)` + params for a scope; empty for every channel. */
function scopeFilter(scope: ChannelScope, col: string): { sql: string; params: number[] } {
    if (!scope) return { sql: '', params: [] };
    const ids = scope.length ? scope : [-1];
    return { sql: ` AND ${col} IN (${ids.map(() => '?').join(',')})`, params: ids };
}

/** One line summing up a bulk send. */
export function bulkSummary(r: BulkResult): string {
    if (r.blocked && !r.sent) return r.blocked;
    let msg = `${r.sent} invitation${r.sent === 1 ? '' : 's'} sent, ${r.skipped} skipped.`;
    for (const [reason, n] of Object.entries(r.reasons || {}).slice(0, 3)) msg += ` ${n} × ${reason}`;
    if (r.queued) msg += ` ${r.queued} more go${r.queued === 1 ? 'es' : ''} out in the background, ${SEND_BATCH} at a time, within your hourly limit.`;
    return msg;
}

/** `hulo_licence_store` row holding the per-install HMAC secret for unsubscribe + click links. */
const OPTOUT_SECRET_ID = 'review-requests-optout-secret';

@Injectable()
export class ReviewRequestService implements OnModuleInit {
    private options: ReviewPluginOptions = {};
    setOptions(o: ReviewPluginOptions) { this.options = o; }
    getOptions() { return this.options; }

    constructor(
        private connection: TransactionalConnection,
        @Optional() private history?: HistoryService,
        @Optional() private requestContextService?: RequestContextService,
    ) {}

    /** Licence or evaluation active. */
    hasPremium(): boolean { return !!this.hooks?.premium?.(); }

    private get db() { return adapterFor(this.connection.rawConnection); }

    private licenceStore = new LicenceStore((sql, params, opts) => this.db.query(sql, params, opts));

    // Buy-from-admin auto-install (hooks are supplied by the controller so
    // this file never imports the plugin class).
    private purchaseClaim: PurchaseClaimClient | null = null;
    initPurchaseClaim(hooks: { packageName: string; instanceId: () => string | null; onLicence: (key: string) => Promise<boolean> }): PurchaseClaimClient {
        if (!this.purchaseClaim) {
            this.purchaseClaim = new PurchaseClaimClient({ ...hooks, query: (sql, params, opts) => this.db.query(sql, params, opts) });
        }
        return this.purchaseClaim;
    }

    async loadStoredLicenceKey(): Promise<string | null> {
        await this.licenceStore.ensureTable();
        return this.licenceStore.load('vendure-plugin-review-requests');
    }

    async saveStoredLicenceKey(key: string): Promise<void> {
        await this.licenceStore.ensureTable();
        await this.licenceStore.save('vendure-plugin-review-requests', key);
    }

    async clearStoredLicenceKey(): Promise<void> {
        await this.licenceStore.clear('vendure-plugin-review-requests');
    }

    // ── Merchant engagement: prefs, usage stats, weekly report ──────────
    private prefs = new PluginPrefs((sql, params, opts) => this.db.query(sql, params, opts), PLUGIN_SHORT_ID);
    getPrefs(): PluginPrefs { return this.prefs; }

    private hooks: EngagementHooks | null = null;
    private digest: WeeklyDigest | null = null;

    /** Wire the tier/licence hooks and build the weekly report scheduler.
     *  Called once from the plugin constructor; `startDigest()` is the
     *  worker-only step. */
    initEngagement(hooks: EngagementHooks): WeeklyDigest {
        this.hooks = hooks;
        if (!this.digest) {
            this.digest = new WeeklyDigest({
                pluginId: PLUGIN_SHORT_ID,
                pluginName: PLUGIN_DISPLAY_NAME,
                prefs: this.prefs,
                collect: (from, to) => this.collectDigest(from, to),
                send: (to, mail) => this.sendDigest(to, mail),
                defaultRecipient: () => this.defaultDigestRecipient(),
            });
        }
        return this.digest;
    }

    getDigest(): WeeklyDigest | null { return this.digest; }

    private digestTimer: NodeJS.Timeout | null = null;

    /** Worker only (the plugin checks ProcessContext + disableCron). The weekly report is premium
     *  (0.17.0): each hourly tick re-reads the licence and only then lets the SDK scheduler decide
     *  whether this week's report is due, so a lapsed licence stops the report (settings and
     *  history are kept) and a renewed one resumes it. */
    startDigest(): void {
        if (this.digestTimer || !this.digest) return;
        const first = setTimeout(() => { void this.digestTick(); }, 90_000);
        if (typeof first.unref === 'function') first.unref();
        this.digestTimer = setInterval(() => { void this.digestTick(); }, 60 * 60_000);
        if (typeof this.digestTimer.unref === 'function') this.digestTimer.unref();
    }

    /** One scheduler tick: true when this process sent the weekly report. */
    async digestTick(now: Date = new Date()): Promise<boolean> {
        if (!this.digest) return false;
        await this.hooks?.refresh?.().catch(() => undefined);
        if (!this.hasPremium()) return false;
        return this.digest.tick(now);
    }

    /** Anonymous usage aggregates for the last 30 days (evaluation drip +
     *  heartbeat). Numbers only, never personal data. */
    async evalStats(): Promise<Record<string, number>> {
        const to = new Date();
        return this.usageStats(new Date(to.getTime() - 30 * DAY_MS), to);
    }

    /** Counts for the window `[from, to)`: invitations by outcome (by the row's
     *  createdAt), review-link clicks (by clickedAt) and opt-outs (by createdAt). */
    async usageStats(from: Date, to: Date): Promise<Record<UsageStatKey, number>> {
        const out: Record<UsageStatKey, number> = { invitesSent: 0, reviewLinkClicks: 0, invitesSkipped: 0, invitesFailed: 0, optOuts: 0 };
        try {
            const [r] = await this.db.query(
                `SELECT SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent,
                        SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) AS skipped,
                        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
                 FROM review_log WHERE createdAt >= ? AND createdAt < ?`, [from, to]);
            out.invitesSent = Number(r?.sent || 0); out.invitesSkipped = Number(r?.skipped || 0); out.invitesFailed = Number(r?.failed || 0);
            const [c] = await this.db.query(`SELECT COUNT(*) AS n FROM review_log WHERE clickedAt >= ? AND clickedAt < ?`, [from, to]);
            out.reviewLinkClicks = Number(c?.n || 0);
            const [o] = await this.db.query(`SELECT COUNT(*) AS n FROM review_optout WHERE createdAt >= ? AND createdAt < ?`, [from, to]);
            out.optOuts = Number(o?.n || 0);
        } catch (e: any) {
            Logger.warn(`usage stats unavailable: ${e?.message}`, loggerCtx);
        }
        return out;
    }

    /** The 30-day stats as labelled digest rows, non-zero first-N in key order. */
    async recentStats(limit = 3): Promise<DigestStat[]> {
        const s = await this.evalStats();
        return USAGE_STAT_ORDER
            .filter(k => Number(s[k] || 0) > 0)
            .slice(0, limit)
            .map(k => ({ key: k, label: USAGE_STAT_LABELS[k], value: Number(s[k] || 0), format: 'count' as const }));
    }

    /** Everything the weekly report needs for `[from, to)` plus the previous week. */
    async collectDigest(from: Date, to: Date): Promise<Omit<DigestInput, 'periodStart' | 'periodEnd' | 'pluginName' | 'shortId'>> {
        await this.hooks?.refresh?.().catch(() => undefined);
        const span = to.getTime() - from.getTime();
        const [cur, prev, setup, configs] = await Promise.all([
            this.usageStats(from, to),
            this.usageStats(new Date(from.getTime() - span), from),
            this.setupChecklist(),
            this.getAllConfigs().catch(() => [] as ReviewChannelConfig[]),
        ]);
        const stats: DigestStat[] = USAGE_STAT_ORDER.map(k => ({ key: k, label: USAGE_STAT_LABELS[k], value: cur[k], previous: prev[k], format: 'count' as const }));
        const adminUrl = this.adminUrl();
        const tips: DigestTip[] = setup.items.filter(i => !i.done).slice(0, 3)
            .map(i => ({ title: i.label, body: i.hint, url: i.url || adminUrl || undefined, linkLabel: i.url ? 'Read the docs' : undefined }));
        const dflt = configs.find(c => c.channelCode === '__default_channel__') || configs[0];
        const storeName = (dflt?.businessName || '').trim() || null;
        return {
            stats, tips, adminUrl, storeName,
            tier: this.hooks?.tier() ?? 'free',
            licence: this.hooks?.licence() ?? null,
            evalState: this.hooks?.evalState() ?? null,
            premiumFeatures: PREMIUM_FEATURES,
        };
    }

    /** This week's report, rendered (the admin "Preview" button). */
    async digestPreview(): Promise<DigestMail> {
        const to = new Date();
        const from = new Date(to.getTime() - 7 * DAY_MS);
        const partial = await this.collectDigest(from, to);
        return composeDigest({ ...partial, pluginName: PLUGIN_DISPLAY_NAME, shortId: PLUGIN_SHORT_ID, periodStart: from, periodEnd: to });
    }

    adminUrl(): string | null {
        const base = (this.options.publicBaseUrl || '').replace(/\/$/, '');
        return base ? `${base}/admin/extensions/review-requests` : null;
    }

    /** Through the plugin's own SMTP (the `smtp` option or the SMTP_* env). */
    private async sendDigest(to: string, mail: DigestMail): Promise<void> {
        const smtp = this.smtp();
        if (!smtp) throw new Error('SMTP not configured — set SMTP_SERVER/SMTP_USER or pass smtp to init()');
        await this.transporter(smtp).sendMail({ from: smtp.from, to, subject: mail.subject, text: mail.text, html: mail.html });
    }

    /** Merchant address, in order: a channel's reply-to, the licence customer,
     *  the trial-reminder address the admin gave us. */
    private async defaultDigestRecipient(): Promise<string | null> {
        try {
            const configs = await this.getAllConfigs();
            const ordered = configs.slice().sort((a, b) => Number(b.enabled) - Number(a.enabled));
            const replyTo = ordered.map(c => (c.replyTo || '').trim()).find(Boolean);
            if (replyTo) return replyTo;
        } catch { /* fall through */ }
        const customer = this.hooks?.licence()?.customer;
        if (customer) return customer;
        return this.prefs.get('eval.leadEmail');
    }

    /** What still needs doing before the plugin earns its keep. Real checks
     *  against config, templates and the log — no guesses. */
    async setupChecklist(): Promise<{ items: SetupItem[]; complete: boolean }> {
        const configs = await this.getAllConfigs().catch(() => [] as ReviewChannelConfig[]);
        const templates: any[] = await this.db.query(`SELECT channelId FROM review_template`).catch(() => []);
        const sentRows: any[] = await this.db.query(`SELECT id FROM review_log WHERE status = 'sent' LIMIT 1`).catch(() => []);
        const items: SetupItem[] = [
            {
                key: 'smtp', label: 'Connect your SMTP', done: !!this.smtp(),
                hint: 'Set SMTP_SERVER, SMTP_USER, SMTP_PASSWORD and SMTP_FROM in the host environment, or pass smtp to ReviewRequestPlugin.init(). Nothing can be sent until this is in place.',
                url: 'https://huloglobal.com/vendure-plugins/review-requests/#install',
            },
            {
                key: 'template', label: 'Save your invitation email', done: templates.length > 0,
                hint: 'Email tab: put the invitation in your own words and save it. The default works, but a personal note gets more reviews.',
                tab: 'email',
            },
            {
                key: 'platform', label: 'Set your business name and review page', done: configs.some(c => !!(c.businessName || '').trim() && !!(c.trustpilotDomain || '').trim()),
                hint: 'Settings tab: enter the business name shown in the email and your Trustpilot domain or Google Place ID, then press Connect to build the review link.',
                tab: 'settings',
            },
            {
                key: 'timing', label: 'Choose when to ask and switch sending on', done: configs.some(c => c.enabled),
                hint: 'Settings tab: pick the delay after the order and the trigger state, then flip the channel switch to "Sending on". The hourly scan only runs for enabled channels.',
                tab: 'settings',
            },
            {
                key: 'firstSend', label: 'Send your first invitation', done: sentRows.length > 0,
                hint: 'Overview tab: press "Send due now", or open any delivered order in the admin and use the Review invitation panel.',
                tab: 'overview',
            },
        ];
        return { items, complete: items.every(i => i.done) };
    }

    async onModuleInit() {
        try { await this.ensureSchema(); }
        catch (e: any) { Logger.error(`Schema init failed: ${e.message}`, loggerCtx); }
        await this.prefs.ensureTable();
    }

    // ── Schema ──────────────────────────────────────────────────────────
    async ensureSchema() {
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS review_config (
                channelId INT PRIMARY KEY,
                enabled TINYINT NOT NULL DEFAULT 0,
                triggerState VARCHAR(24) NOT NULL DEFAULT 'Delivered',
                delayDays INT NOT NULL DEFAULT 14,
                minOrderValuePence INT NOT NULL DEFAULT 0,
                cooldownDays INT NOT NULL DEFAULT 120,
                trustpilotDomain VARCHAR(190) NOT NULL DEFAULT '',
                reviewUrlTemplate VARCHAR(400) NOT NULL DEFAULT 'https://www.trustpilot.com/evaluate/{domain}',
                trustpilotApiKey VARCHAR(190) NOT NULL DEFAULT '',
                trustpilotBusinessUnitId VARCHAR(64) NOT NULL DEFAULT '',
                businessName VARCHAR(190) NOT NULL DEFAULT '',
                replyTo VARCHAR(190) NOT NULL DEFAULT '',
                maxPerRun INT NOT NULL DEFAULT 200
            )`);
        await this.addColumnIfMissing('review_config', 'reviewMode', `VARCHAR(12) NOT NULL DEFAULT 'service'`);
        await this.addColumnIfMissing('review_config', 'productReviewUrlTemplate', `VARCHAR(400) NOT NULL DEFAULT ''`);
        // One row per order that is being (or has been) invited: claimed BEFORE the
        // email goes out so the hourly cron (worker) and "Send due now" (server)
        // cannot both send for the same order.
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS review_claim (
                orderId INT PRIMARY KEY,
                channelId INT NULL,
                claimedAt DATETIME NOT NULL
            )`);
        // One row per customer email: stamped (conditionally) before an invitation goes out so
        // two due orders of one customer, or two overlapping runs, cannot both pass the cooldown.
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS review_email_claim (
                email VARCHAR(255) PRIMARY KEY,
                claimedAt DATETIME NOT NULL
            )`);
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS review_template (
                channelId INT PRIMARY KEY,
                subject VARCHAR(255),
                body MEDIUMTEXT
            )`);
        await this.widenTemplateBody();
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS review_log (
                id INT AUTO_INCREMENT PRIMARY KEY,
                orderId INT NOT NULL,
                orderCode VARCHAR(32),
                channelId INT,
                email VARCHAR(255),
                status VARCHAR(16) NOT NULL,
                reason VARCHAR(255),
                reviewUrl VARCHAR(500),
                createdAt DATETIME NOT NULL,
                clickedAt DATETIME NULL,
                queueId INT NULL,
                INDEX idx_rl_order (orderId),
                INDEX idx_rl_email (email, createdAt),
                INDEX idx_rl_created (createdAt),
                INDEX idx_rl_status (status, createdAt)
            )`);
        // Review-link click tracking (0.16.0): first click per invitation.
        await this.addColumnIfMissing('review_log', 'clickedAt', 'DATETIME NULL');
        for (const ddl of [
            'CREATE INDEX IF NOT EXISTS idx_rl_status ON review_log (status, createdAt)',
            'CREATE INDEX IF NOT EXISTS idx_rl_clicked ON review_log (clickedAt)',
        ]) { try { await this.db.query(ddl); } catch { /* exists */ } }
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS review_exclusion (
                id INT AUTO_INCREMENT PRIMARY KEY,
                type VARCHAR(16) NOT NULL,
                value VARCHAR(255) NOT NULL,
                note VARCHAR(255),
                createdAt DATETIME NOT NULL,
                INDEX idx_re_val (type, value)
            )`);
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS review_optout (
                email VARCHAR(255) PRIMARY KEY,
                createdAt DATETIME NOT NULL
            )`);
        // 0.17.0: customers waiting for a staff-started invitation — rows from a pasted or CSV
        // list (source 'list') and orders a bulk send left for the background (source 'order').
        // state: scheduled (a list scheduled for later) → outbox (due, sent a batch at a time
        // within the hourly limit) → sending (claimed) → sent | skipped | failed.
        await this.db.query(`
            CREATE TABLE IF NOT EXISTS review_queue (
                id INT AUTO_INCREMENT PRIMARY KEY,
                channelId INT NOT NULL,
                source VARCHAR(16) NOT NULL,
                orderId INT NULL,
                batchId VARCHAR(32) NOT NULL DEFAULT '',
                email VARCHAR(255) NOT NULL,
                name VARCHAR(190) NOT NULL DEFAULT '',
                state VARCHAR(16) NOT NULL,
                reason VARCHAR(255) NULL,
                dueAt DATETIME NOT NULL,
                createdAt DATETIME NOT NULL,
                updatedAt DATETIME NOT NULL,
                INDEX idx_rq_state (state, dueAt),
                INDEX idx_rq_order (orderId),
                INDEX idx_rq_batch (batchId)
            )`);
        // The list row an invitation was sent for (list invitations have no order: orderId 0).
        await this.addColumnIfMissing('review_log', 'queueId', 'INT NULL');
    }

    // ── Config ──────────────────────────────────────────────────────────
    /** `ADD COLUMN IF NOT EXISTS` is MariaDB/Postgres syntax; MySQL 8 needs the check up front. */
    private async addColumnIfMissing(table: string, column: string, ddl: string): Promise<void> {
        const scope = this.db.dialect === 'postgres' ? 'table_catalog = current_database() AND table_schema = current_schema()' : 'table_schema = DATABASE()';
        const rows: any[] = await this.db.query(
            `SELECT COUNT(*) AS n FROM information_schema.columns WHERE ${scope} AND LOWER(table_name) = LOWER(?) AND LOWER(column_name) = LOWER(?)`, [table, column],
        ).catch(() => []);
        if (Number(rows?.[0]?.n ?? rows?.[0]?.N ?? 0) > 0) return;
        try { await this.db.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`); }
        catch (e: any) { if (!/duplicate|exists/i.test(String(e?.message || ''))) throw e; }
    }

    /** `review_template.body` started life as TEXT (64 KB on MySQL/MariaDB) — a template with
     *  inlined images silently truncated. Widen to MEDIUMTEXT once; Postgres TEXT is unbounded. */
    private async widenTemplateBody(): Promise<void> {
        if (this.db.dialect === 'postgres') return;
        const rows: any[] = await this.db.query(
            `SELECT DATA_TYPE AS dataType FROM information_schema.columns
             WHERE table_schema = DATABASE() AND LOWER(table_name) = 'review_template' AND LOWER(column_name) = 'body'`,
        ).catch(() => []);
        const type = String(rows?.[0]?.dataType ?? rows?.[0]?.DATA_TYPE ?? '').toLowerCase();
        if (type !== 'text' && type !== 'tinytext') return;
        try { await this.db.query(`ALTER TABLE review_template MODIFY body MEDIUMTEXT`); }
        catch (e: any) { Logger.warn(`could not widen review_template.body: ${e?.message}`, loggerCtx); }
    }

    /** Monthly housekeeping (worker): drop skipped/failed audit rows older than `months`
     *  in id-ordered batches. 'sent' rows are kept — they drive dedup and cooldown. */
    async pruneLog(months = 18, batch = 5000): Promise<number> {
        let deleted = 0;
        for (let round = 0; round < 400; round++) {
            const rows: any[] = await this.db.query(
                `SELECT id FROM review_log WHERE status <> 'sent' AND createdAt < DATE_SUB(NOW(), INTERVAL ? MONTH) ORDER BY id LIMIT ?`,
                [months, batch],
            );
            if (!rows.length) break;
            const ids = rows.map((r: any) => Number(r.id));
            await this.db.query(`DELETE FROM review_log WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
            deleted += ids.length;
            if (ids.length < batch) break;
        }
        return deleted;
    }

    /** Claim an order for sending; false when another process already has it. */
    private async claimOrder(orderId: number, channelId: number): Promise<boolean> {
        const r = await this.db.query(
            `INSERT IGNORE INTO review_claim (orderId, channelId, claimedAt) VALUES (?, ?, NOW())`, [orderId, channelId], { needAffected: true },
        ).catch(() => null);
        return Number(r?.affectedRows ?? r?.rowCount ?? 0) > 0;
    }

    private async releaseClaim(orderId: number): Promise<void> {
        await this.db.query(`DELETE FROM review_claim WHERE orderId = ?`, [orderId]).catch(() => undefined);
    }

    /** Claim a customer email for the cooldown window: true when nobody claimed it within
     *  `cooldownDays` (insert, or a conditional re-stamp of an expired claim). Atomic across
     *  processes; fails closed. `review_log` stays the record — this only closes the race. */
    private async claimEmail(email: string, cooldownDays: number): Promise<boolean> {
        try {
            const ins = await this.db.query(
                `INSERT IGNORE INTO review_email_claim (email, claimedAt) VALUES (?, NOW())`, [email], { needAffected: true });
            if (Number(ins?.affectedRows ?? ins?.rowCount ?? 0) > 0) return true;
            const upd = await this.db.query(
                `UPDATE review_email_claim SET claimedAt = NOW() WHERE email = ? AND claimedAt <= DATE_SUB(NOW(), INTERVAL ? DAY)`,
                [email, cooldownDays], { needAffected: true });
            return Number(upd?.affectedRows ?? upd?.rowCount ?? 0) > 0;
        } catch (e: any) {
            Logger.warn(`email claim failed: ${e?.message || e}`, loggerCtx);
            return false;
        }
    }

    private async releaseEmailClaim(email: string): Promise<void> {
        await this.db.query(`DELETE FROM review_email_claim WHERE email = ?`, [email]).catch(() => undefined);
    }

    /** The order states at or beyond the configured trigger (an order delivered 14 days ago is no longer "PaymentSettled"). */
    static statesFor(trigger: string): string[] {
        return ({
            PaymentSettled: ['PaymentSettled', 'PartiallyShipped', 'Shipped', 'PartiallyDelivered', 'Delivered'],
            Shipped: ['Shipped', 'PartiallyDelivered', 'Delivered'],
            Delivered: ['Delivered'],
        } as Record<string, string[]>)[trigger] || ['Delivered'];
    }

    private rowToConfig(row: any, code?: string): ReviewChannelConfig {
        return {
            channelId: row.channelId,
            channelCode: code,
            enabled: !!row.enabled,
            triggerState: (['Delivered', 'PaymentSettled', 'Shipped'].includes(row.triggerState) ? row.triggerState : 'Delivered') as TriggerState,
            delayDays: row.delayDays ?? DEFAULT_CONFIG.delayDays,
            minOrderValuePence: row.minOrderValuePence ?? 0,
            cooldownDays: row.cooldownDays ?? DEFAULT_CONFIG.cooldownDays,
            trustpilotDomain: row.trustpilotDomain || '',
            // An old Reviews.io link format (company-review/store/{id}/new, a dead page) reads as the current one.
            reviewUrlTemplate: currentTemplate(row.reviewUrlTemplate || DEFAULT_CONFIG.reviewUrlTemplate),
            trustpilotApiKey: row.trustpilotApiKey || '',
            trustpilotBusinessUnitId: row.trustpilotBusinessUnitId || '',
            businessName: row.businessName || '',
            replyTo: row.replyTo || '',
            maxPerRun: row.maxPerRun ?? DEFAULT_CONFIG.maxPerRun,
            reviewMode: (['service', 'product', 'both'].includes(row.reviewMode) ? row.reviewMode : 'service'),
            productReviewUrlTemplate: row.productReviewUrlTemplate || '',
        };
    }

    async getAllConfigs(scope: ChannelScope = null): Promise<ReviewChannelConfig[]> {
        const { sql: chScope, params: chParams } = scopeFilter(scope, 'id');
        const channels = await this.db.query(`SELECT id AS channelId, code AS channelCode FROM channel WHERE 1 = 1${chScope} ORDER BY id`, chParams);
        const rows = await this.db.query(`SELECT * FROM review_config`).catch(() => []);
        return channels.map((ch: any) => {
            const existing = rows.find((r: any) => r.channelId === ch.channelId);
            return existing ? this.rowToConfig(existing, ch.channelCode)
                : { ...DEFAULT_CONFIG, channelId: ch.channelId, channelCode: ch.channelCode };
        });
    }

    async getConfig(channelId: number): Promise<ReviewChannelConfig> {
        const rows = await this.db.query(`SELECT * FROM review_config WHERE channelId = ?`, [channelId]).catch(() => []);
        return rows.length ? this.rowToConfig(rows[0]) : { ...DEFAULT_CONFIG, channelId };
    }

    async saveConfig(c: ReviewChannelConfig): Promise<void> {
        await this.db.query(
            `INSERT INTO review_config (channelId, enabled, triggerState, delayDays, minOrderValuePence, cooldownDays,
                trustpilotDomain, reviewUrlTemplate, trustpilotApiKey, trustpilotBusinessUnitId, businessName, replyTo, maxPerRun,
                reviewMode, productReviewUrlTemplate)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE enabled=VALUES(enabled), triggerState=VALUES(triggerState), delayDays=VALUES(delayDays),
                minOrderValuePence=VALUES(minOrderValuePence), cooldownDays=VALUES(cooldownDays),
                trustpilotDomain=VALUES(trustpilotDomain), reviewUrlTemplate=VALUES(reviewUrlTemplate),
                trustpilotApiKey=VALUES(trustpilotApiKey), trustpilotBusinessUnitId=VALUES(trustpilotBusinessUnitId),
                businessName=VALUES(businessName), replyTo=VALUES(replyTo), maxPerRun=VALUES(maxPerRun),
                reviewMode=VALUES(reviewMode), productReviewUrlTemplate=VALUES(productReviewUrlTemplate)`,
            [c.channelId, c.enabled ? 1 : 0, c.triggerState, c.delayDays, c.minOrderValuePence, c.cooldownDays,
             c.trustpilotDomain || '', c.reviewUrlTemplate || DEFAULT_CONFIG.reviewUrlTemplate, c.trustpilotApiKey || '',
             c.trustpilotBusinessUnitId || '', c.businessName || '', c.replyTo || '', c.maxPerRun || 200,
             c.reviewMode || 'service', c.productReviewUrlTemplate || ''],
            { conflictColumns: ['channelId'] },
        );
        this.invalidatePending();
    }

    // ── Pending (dry-run) summary, memoised ─────────────────────────────
    // `GET /stats` used to run the full candidate scan on every Overview /
    // Exclusions tab open. The result is held for 60 s and dropped after
    // anything that changes eligibility (a real run, a manual send, a config
    // or exclusion change), and concurrent callers share one scan.
    private pendingCache: { at: number; value: any[] } | null = null;
    private pendingInFlight: Promise<any[]> | null = null;
    private static readonly PENDING_TTL_MS = 60_000;

    async pendingSummary(scope: ChannelScope = null): Promise<any[]> {
        const all = await this.pendingAll();
        return scope ? all.filter(r => scope.includes(Number(r.channelId))) : all;
    }

    private async pendingAll(): Promise<any[]> {
        if (this.pendingCache && Date.now() - this.pendingCache.at < ReviewRequestService.PENDING_TTL_MS) return this.pendingCache.value;
        if (this.pendingInFlight) return this.pendingInFlight;
        this.pendingInFlight = this.runAll(true)
            .then(value => { this.pendingCache = { at: Date.now(), value }; return value; })
            .finally(() => { this.pendingInFlight = null; });
        return this.pendingInFlight;
    }

    invalidatePending(): void { this.pendingCache = null; }

    // ── Template ────────────────────────────────────────────────────────
    async getTemplate(channelId: number): Promise<Template & { isDefault: boolean }> {
        const rows = await this.db.query(`SELECT subject, body FROM review_template WHERE channelId = ?`, [channelId]).catch(() => []);
        return rows.length ? { subject: rows[0].subject, body: rows[0].body, isDefault: false }
            : { ...DEFAULT_TEMPLATE, isDefault: true };
    }
    async saveTemplate(channelId: number, subject: string, body: string): Promise<void> {
        await this.db.query(
            `INSERT INTO review_template (channelId, subject, body) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE subject = VALUES(subject), body = VALUES(body)`,
            [channelId, subject, body],
            { conflictColumns: ['channelId'] },
        );
    }
    async resetTemplate(channelId: number): Promise<void> {
        await this.db.query(`DELETE FROM review_template WHERE channelId = ?`, [channelId]);
    }

    // ── Exclusions + opt-out ────────────────────────────────────────────
    async listExclusions(): Promise<any[]> {
        return this.db.query(`SELECT * FROM review_exclusion ORDER BY createdAt DESC LIMIT 500`).catch(() => []);
    }
    async addExclusion(type: string, value: string, note?: string): Promise<void> {
        const t = type === 'email_domain' ? 'email_domain' : 'email';
        const v = String(value || '').trim().toLowerCase();
        if (!v) throw new Error('empty value');
        await this.db.query(`INSERT INTO review_exclusion (type, value, note, createdAt) VALUES (?, ?, ?, NOW())`, [t, v, note || '']);
        this.invalidatePending();
    }
    async removeExclusion(id: number): Promise<void> {
        await this.db.query(`DELETE FROM review_exclusion WHERE id = ?`, [id]);
        this.invalidatePending();
    }

    /** Is this email excluded, and via what? Used by the admin "check". */
    async checkExcluded(email: string): Promise<{ excluded: boolean; via: string | null }> {
        const e = String(email || '').toLowerCase();
        const domain = e.split('@')[1] || '';
        const [opt] = await this.db.query(`SELECT email FROM review_optout WHERE email = ? LIMIT 1`, [e]).catch(() => []);
        if (opt) return { excluded: true, via: 'unsubscribed' };
        const ex = await this.db.query(
            `SELECT type FROM review_exclusion WHERE (type='email' AND value=?) OR (type='email_domain' AND value=?) LIMIT 1`,
            [e, domain],
        ).catch(() => []);
        if (ex.length) return { excluded: true, via: ex[0].type === 'email_domain' ? 'domain rule' : 'excluded' };
        return { excluded: false, via: null };
    }

    /** Live customer search with a batched "already excluded?" flag per row. */
    async searchCustomers(q: string, limit = 10, scope: ChannelScope = null): Promise<any[]> {
        const term = String(q || '').trim();
        if (term.length < 2) return [];
        const like = `%${term}%`;
        const ch = scopeFilter(scope, 'ccc.\`channelId\`');
        const custScope = scope ? ` AND EXISTS (SELECT 1 FROM customer_channels_channel ccc WHERE ccc.\`customerId\` = customer.id${ch.sql})` : '';
        const rows = await this.db.query(
            `SELECT id, \`firstName\`, \`lastName\`, \`emailAddress\` FROM customer
             WHERE \`deletedAt\` IS NULL
               AND (\`emailAddress\` LIKE ? OR \`firstName\` LIKE ? OR \`lastName\` LIKE ? OR CONCAT(\`firstName\`, ' ', \`lastName\`) LIKE ?)${custScope}
             ORDER BY (LOWER(\`emailAddress\`) = ?) DESC, id DESC
             LIMIT ?`,
            [like, like, like, like, ...ch.params, term.toLowerCase(), Math.min(limit, 25)],
        ).catch(() => []);
        if (!rows.length) return [];
        const emails = rows.map((r: any) => String(r.emailAddress || '').toLowerCase());
        const domains = [...new Set(emails.map((e: string) => e.split('@')[1]).filter(Boolean))];
        const emailPh = emails.map(() => '?').join(',');
        const domPh = domains.length ? domains.map(() => '?').join(',') : "''";
        const exRows = await this.db.query(
            `SELECT type, value FROM review_exclusion
             WHERE (type='email' AND value IN (${emailPh})) OR (type='email_domain' AND value IN (${domPh}))`,
            [...emails, ...(domains.length ? domains : [])],
        ).catch(() => []);
        const optRows = await this.db.query(`SELECT email FROM review_optout WHERE email IN (${emailPh})`, emails).catch(() => []);
        const exEmails = new Set(exRows.filter((r: any) => r.type === 'email').map((r: any) => r.value));
        const exDomains = new Set(exRows.filter((r: any) => r.type === 'email_domain').map((r: any) => r.value));
        const optSet = new Set(optRows.map((r: any) => r.email));
        return rows.map((r: any) => {
            const e = String(r.emailAddress || '').toLowerCase();
            const d = e.split('@')[1] || '';
            const via = optSet.has(e) ? 'unsubscribed' : exEmails.has(e) ? 'excluded' : exDomains.has(d) ? 'domain rule' : null;
            return { id: r.id, firstName: r.firstName, lastName: r.lastName, email: r.emailAddress, excluded: !!via, via };
        });
    }

    async isExcluded(email: string): Promise<boolean> {
        const e = email.toLowerCase();
        const domain = e.split('@')[1] || '';
        const [opt] = await this.db.query(`SELECT email FROM review_optout WHERE email = ? LIMIT 1`, [e]).catch(() => []);
        if (opt) return true;
        const ex = await this.db.query(
            `SELECT id FROM review_exclusion WHERE (type='email' AND value=?) OR (type='email_domain' AND value=?) LIMIT 1`,
            [e, domain],
        ).catch(() => []);
        return ex.length > 0;
    }

    private optOutSecretCache: string | null = null;

    /** The HMAC secret for unsubscribe links: configured, else a per-install
     *  random one persisted in the licence store (never the literal default
     *  every install used to share, which let anyone forge opt-outs). */
    private async optOutSecret(): Promise<string> {
        const configured = this.options.optOutSecret || process.env.HULO_IP_SALT;
        if (configured) return configured;
        if (this.optOutSecretCache) return this.optOutSecretCache;
        // Read errors propagate (callers fail closed): a swallowed read used to look like "no secret
        // yet", the upsert then replaced the secret and every link already sent stopped working —
        // and a store outage fell back to a literal anyone could sign with. Creation is
        // insert-if-absent, so concurrent first calls (server + worker) agree on one secret.
        await this.licenceStore.ensureTable();
        const read = async (): Promise<string | null> => {
            const rows: any[] = await this.db.query(`SELECT licenceKey FROM hulo_licence_store WHERE pluginId = ?`, [OPTOUT_SECRET_ID]);
            const v = rows?.[0]?.licenceKey;
            return typeof v === 'string' && v.length > 0 ? v : null;
        };
        let s = await read();
        if (!s) {
            await this.db.query(
                `INSERT IGNORE INTO hulo_licence_store (pluginId, licenceKey, updatedAt) VALUES (?, ?, NOW())`,
                [OPTOUT_SECRET_ID, randomBytes(32).toString('hex')]);
            s = await read();
        }
        if (!s) throw new Error('unsubscribe-link secret unavailable');
        this.optOutSecretCache = s;
        return s;
    }

    async optOutToken(email: string): Promise<string> {
        const secret = await this.optOutSecret();
        return createHmac('sha256', secret).update(email.toLowerCase()).digest('hex').slice(0, 32);
    }
    /** '' without a public base URL or when the secret is unavailable — the send then refuses. */
    async optOutUrl(email: string): Promise<string> {
        const base = (this.options.publicBaseUrl || '').replace(/\/$/, '');
        if (!base) return '';
        try { return `${base}/review-requests/optout?e=${encodeURIComponent(email)}&t=${await this.optOutToken(email)}`; }
        catch (e: any) { Logger.warn(`no unsubscribe link: ${e?.message || e}`, loggerCtx); return ''; }
    }
    /** Token check without applying (the GET confirmation page). */
    async optOutTokenValid(email: string, token: string): Promise<boolean> {
        const e = String(email || '').toLowerCase();
        if (!e || !/^[0-9a-f]{32}$/i.test(String(token || ''))) return false;
        let expected: string;
        try { expected = await this.optOutToken(e); } catch { return false; }
        try { return timingSafeEqual(Buffer.from(String(token).toLowerCase()), Buffer.from(expected)); } catch { return false; }
    }
    async optOut(email: string, token: string): Promise<boolean> {
        const e = String(email || '').toLowerCase();
        if (!(await this.optOutTokenValid(e, token))) return false;
        await this.db.query(`INSERT IGNORE INTO review_optout (email, createdAt) VALUES (?, NOW())`, [e]);
        this.invalidatePending();
        return true;
    }

    // ── Review rating (Trustpilot or Google, cached in memory) ──────────
    // A successful lookup is held for 6 h; a failed one (bad key, outage,
    // timeout) for 10 min so a transient error does not blank the star
    // block out of every email until the next restart.
    private ratingCache = new Map<string, { rating: TrustpilotRating | null; at: number }>();
    private static readonly RATING_OK_TTL_MS = 6 * 3600_000;
    private static readonly RATING_FAIL_TTL_MS = 10 * 60_000;

    /** Which review platform a config targets, inferred from its link. */
    platformOf(cfg: ReviewChannelConfig): 'trustpilot' | 'google' | 'other' {
        const t = cfg.reviewUrlTemplate || '';
        if (t.includes('google.com')) return 'google';
        if (t.includes('trustpilot.com')) return 'trustpilot';
        return 'other';
    }
    platformName(cfg: ReviewChannelConfig): string {
        const p = this.platformOf(cfg);
        return p === 'google' ? 'Google' : p === 'trustpilot' ? 'Trustpilot' : (cfg.businessName || 'us');
    }

    /** Live rating for a channel. `cache: false` (the admin "check" button, which posts
     *  whatever key/domain is in the form) neither reads nor writes the shared cache. */
    async getRating(cfg: ReviewChannelConfig, opts: { cache?: boolean } = {}): Promise<TrustpilotRating | null> {
        const platform = this.platformOf(cfg);
        if (!cfg.trustpilotApiKey || !cfg.trustpilotDomain) return null;
        const useCache = opts.cache !== false;
        const cacheKey = `${platform}|${cfg.trustpilotDomain}|${cfg.trustpilotBusinessUnitId}`;
        if (useCache) {
            const hit = this.ratingCache.get(cacheKey);
            const ttl = hit?.rating ? ReviewRequestService.RATING_OK_TTL_MS : ReviewRequestService.RATING_FAIL_TTL_MS;
            if (hit && Date.now() - hit.at < ttl) return hit.rating;
        }

        let rating: TrustpilotRating | null = null;
        if (platform === 'google') {
            // For Google the identifier field holds the Place ID.
            rating = await fetchGoogleRating(cfg.trustpilotDomain, cfg.trustpilotApiKey);
        } else if (platform === 'trustpilot') {
            let unitId = cfg.trustpilotBusinessUnitId;
            if (!unitId) unitId = (await findBusinessUnitId(cfg.trustpilotDomain, cfg.trustpilotApiKey)) || '';
            rating = unitId ? await fetchRating(unitId, cfg.trustpilotApiKey) : null;
        }
        if (useCache) {
            if (this.ratingCache.size > 200) this.ratingCache.clear();
            this.ratingCache.set(cacheKey, { rating, at: Date.now() });
        }
        return rating;
    }

    /** One-shot auto-detect: from a domain (+ optional free API key) resolve
     *  the review link, the business-unit id and the live rating — so the
     *  admin "Connect" button fills everything in without manual lookups. */
    async detect(domain: string, apiKey: string, template?: string): Promise<{ ok: boolean; reviewUrl: string; businessUnitId: string; rating: TrustpilotRating | null; message: string }> {
        const page = validateReviewPage({ reviewUrlTemplate: template || DEFAULT_CONFIG.reviewUrlTemplate, trustpilotDomain: domain }, DEFAULT_CONFIG.reviewUrlTemplate);
        if (domain && page.errors.length) {
            return { ok: false, reviewUrl: '', businessUnitId: '', rating: null, message: page.errors[0] };
        }
        const tpl = page.reviewUrlTemplate;
        domain = page.trustpilotDomain || domain;
        const reviewUrl = buildReviewUrl(tpl, domain);
        const isGoogle = tpl.includes('google.com');
        const isTrustpilot = tpl.includes('trustpilot.com');
        let businessUnitId = '';
        let rating: TrustpilotRating | null = null;
        if (domain && apiKey && isGoogle) {
            rating = await fetchGoogleRating(domain, apiKey);
            this.ratingCache.delete(`google|${domain}|`);
        } else if (domain && apiKey && isTrustpilot) {
            businessUnitId = (await findBusinessUnitId(domain, apiKey)) || '';
            if (businessUnitId) rating = await fetchRating(businessUnitId, apiKey);
            this.ratingCache.delete(`trustpilot|${domain}|${businessUnitId}`);
        }
        const platformLabel = isGoogle ? 'Google Place ID' : isTrustpilot ? 'Trustpilot domain' : 'identifier';
        const message = !domain ? `Enter your ${platformLabel} first.`
            : !apiKey ? 'Review link ready. Add an API key to also show your star rating in emails.'
            : rating ? `Connected — ${formatScore(rating)}★ from ${rating.numberOfReviews.toLocaleString()} reviews.`
            : (isGoogle || isTrustpilot) ? `Couldn't read a rating — check the ${platformLabel} + API key.`
            : 'Review link ready (this platform has no live-rating lookup).';
        return { ok: !!reviewUrl, reviewUrl, businessUnitId, rating, message };
    }

    // ── Compose + send one invitation ───────────────────────────────────
    private smtp() {
        if (this.options.smtp) return this.options.smtp;
        if (process.env.SMTP_SERVER && process.env.SMTP_USER) {
            return {
                host: process.env.SMTP_SERVER, port: Number(process.env.SMTP_PORT || 587),
                user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || '',
                from: process.env.SMTP_FROM || process.env.SMTP_USER,
            };
        }
        return null;
    }

    /**
     * Products on an order (name + slug), for product-review links. One translation per product:
     * the order channel's default language, else English, else any (0.18.0: it used to read English
     * only, so a store without English translations had no product links).
     */
    async getOrderProducts(orderId: number): Promise<Array<{ name: string; slug: string }>> {
        if (!orderId) return [];
        const rows: any[] = await this.db.query(
            `SELECT p.id AS productId, pt.\`languageCode\` AS languageCode, pt.name, pt.slug
             FROM order_line ol
             JOIN product_variant pv ON pv.id = ol.\`productVariantId\`
             JOIN product p ON p.id = pv.\`productId\`
             JOIN product_translation pt ON pt.\`baseId\` = p.id
             WHERE ol.\`orderId\` = ?
             ORDER BY ol.id
             LIMIT 400`,
            [orderId],
        ).catch(() => []);
        if (!rows.length) return [];
        const [ch] = await this.db.query(
            `SELECT c.\`defaultLanguageCode\` AS lang FROM channel c
             JOIN order_channels_channel occ ON occ.\`channelId\` = c.id
             WHERE occ.\`orderId\` = ? ORDER BY c.id DESC LIMIT 1`,
            [orderId],
        ).catch(() => []);
        return pickProductTranslations(rows, String(ch?.lang || ''));
    }

    private productReviewUrl(template: string, slug: string, name: string, orderCode: string): string {
        return String(template || '')
            .replace(/\{slug\}/g, encodeURIComponent(slug || ''))
            .replace(/\{name\}/g, encodeURIComponent(name || ''))
            .replace(/\{orderCode\}/g, encodeURIComponent(orderCode || ''));
    }

    renderProductList(products: Array<{ name: string; slug: string }>, template: string, orderCode: string): string {
        if (!products.length || !template) return '';
        const accent = resolveDesign(this.options.email).accentColor;
        return productListHtml(products.map(p => ({ name: p.name, url: this.productReviewUrl(template, p.slug, p.name, orderCode) })), accent);
    }

    // ── Review-link click tracking ──────────────────────────────────────
    /** The signed redirect for one invitation, or '' without a public base URL. */
    private async clickUrl(logId: number): Promise<string> {
        const base = (this.options.publicBaseUrl || '').replace(/\/$/, '');
        if (!base || !logId) return '';
        try { return `${base}/review-requests/r/${signClickToken(await this.optOutSecret(), logId)}`; }
        catch { return ''; } // no secret: the send refuses anyway (no unsubscribe link)
    }

    /** Verify a click token, stamp `clickedAt` on first click and return the
     *  review URL to redirect to — `null` for a bad token or an unknown row. */
    async recordClick(token: string): Promise<string | null> {
        const logId = parseClickToken(await this.optOutSecret(), token);
        if (!logId) return null;
        const [row] = await this.db.query(`SELECT reviewUrl FROM review_log WHERE id = ? LIMIT 1`, [logId]).catch(() => []);
        const url = String(row?.reviewUrl || '');
        if (!/^https?:\/\//i.test(url)) return null;
        await this.db.query(`UPDATE review_log SET clickedAt = NOW() WHERE id = ? AND clickedAt IS NULL`, [logId]).catch(() => undefined);
        return url;
    }

    /**
     * The invitation for one customer. `opts.override` renders an unsaved subject/body (the editor's
     * preview); `opts.preview` uses '#' for the unsubscribe link instead of signing a real one.
     */
    async composeEmail(cfg: ReviewChannelConfig, to: string, firstName: string, orderCode: string, orderId = 0, logId = 0,
        opts: { override?: Template; preview?: boolean } = {}): Promise<{ subject: string; html: string; text: string; unsubscribeUrl: string } | null> {
        const tpl = opts.override ? { ...opts.override, isDefault: false } : await this.getTemplate(cfg.channelId);
        // Real sends (a log row exists) link through the signed click redirect; previews and tests link straight to the review page.
        const reviewUrl = (await this.clickUrl(logId)) || buildReviewUrl(cfg.reviewUrlTemplate, cfg.trustpilotDomain);
        // The star-rating box is premium (0.17.0): without a licence or evaluation the rating is not even fetched.
        const rating = this.hasPremium() ? await this.getRating(cfg) : null;
        const businessName = cfg.businessName || cfg.trustpilotDomain || 'us';
        const design = resolveDesign(this.options.email);
        const wantService = cfg.reviewMode === 'service' || cfg.reviewMode === 'both';
        const wantProduct = cfg.reviewMode === 'product' || cfg.reviewMode === 'both';
        // A customer from a list has no order: no products, and the built-in e-mail drops the order sentence.
        const fromList = !orderCode;

        let productList = '';
        if (wantProduct && cfg.productReviewUrlTemplate && !fromList) {
            const products = orderId ? await this.getOrderProducts(orderId)
                : [{ name: 'Sample Product A', slug: 'sample-a' }, { name: 'Sample Product B', slug: 'sample-b' }];
            productList = this.renderProductList(products, cfg.productReviewUrlTemplate, orderCode);
        }
        // With no products to show (a list customer, or no product link) the store review button is always included.
        const showService = wantService || !productList;
        const ratingBlock = (showService && rating && Number.isFinite(rating.trustScore))
            ? ratingBlockHtml(renderStars(rating.stars), formatScore(rating), rating.numberOfReviews, this.platformName(cfg))
            : '';
        const reviewButton = showService && /^https?:\/\//i.test(reviewUrl) ? reviewButtonHtml(reviewUrl, design.accentColor) : '';

        const unsubscribeUrl = opts.preview ? '#' : await this.optOutUrl(to);
        const known = (firstName || '').trim();
        const vars = {
            firstName: escapeHtml(known || 'there'), orderCode: escapeHtml(orderCode), businessName: escapeHtml(businessName),
            reviewUrl: escapeHtml(reviewUrl), ratingBlock, reviewButton, productList,
            signOff: signOffHtml(businessName, cfg.replyTo, design.accentColor),
            unsubscribeUrl: escapeHtml(unsubscribeUrl),
        };
        const body = fromList && tpl.isDefault ? DEFAULT_LIST_BODY : tpl.body;
        const subjectTpl = !known && tpl.isDefault ? DEFAULT_SUBJECT_NO_NAME : tpl.subject;
        const subject = renderTemplate(subjectTpl, { firstName: known || 'there', orderCode, businessName }).replace(/[\r\n]+/g, ' ');
        const bodyHtml = renderTemplate(body, vars);
        const html = wrapEmail(bodyHtml, businessName, unsubscribeUrl, this.options.email);
        return { subject, html, text: htmlToText(html), unsubscribeUrl };
    }

    async sendInvitation(cfg: ReviewChannelConfig, order: { id: number; code: string; email: string; firstName: string }, logId = 0): Promise<{ ok: boolean; reason?: string }> {
        const smtp = this.smtp();
        if (!smtp) return { ok: false, reason: 'SMTP not configured' };
        const composed = await this.composeEmail(cfg, order.email, order.firstName, order.code, order.id, logId);
        if (!composed) return { ok: false, reason: 'compose failed' };
        if (!composed.unsubscribeUrl) return { ok: false, reason: 'publicBaseUrl not configured — refusing to send without an unsubscribe link' };
        try {
            const transporter = this.transporter(smtp);
            const senderName = String(cfg.businessName || '').replace(/["\r\n]/g, "'").trim();
            await transporter.sendMail({
                from: senderName ? `"${senderName}" <${smtp.from}>` : smtp.from,
                to: order.email,
                replyTo: cfg.replyTo || undefined,
                subject: composed.subject,
                html: composed.html,
                text: composed.text,
                headers: {
                    'List-Unsubscribe': `<${composed.unsubscribeUrl}>`,
                    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
                    Precedence: 'bulk',
                },
            });
            return { ok: true };
        } catch (e: any) {
            try { this.transportCache?.t.close(); } catch { /* ignore */ }
            this.transportCache = null;
            return { ok: false, reason: String(e?.message || e).slice(0, 255) };
        }
    }

    private transportCache: { key: string; t: nodemailer.Transporter } | null = null;

    /** One pooled transport per SMTP settings tuple, with timeouts (defaults are 2 min / 10 min). */
    private transporter(smtp: { host: string; port: number; user?: string; pass?: string; from: string }): nodemailer.Transporter {
        const key = [smtp.host, smtp.port, smtp.user || '', smtp.pass || ''].join('|');
        if (this.transportCache?.key === key) return this.transportCache.t;
        try { this.transportCache?.t.close(); } catch { /* ignore */ }
        const t = nodemailer.createTransport({
            host: smtp.host, port: smtp.port, secure: smtp.port === 465, requireTLS: smtp.port !== 465,
            auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
            pool: true, maxConnections: 2, maxMessages: 100,
            connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000,
        } as any);
        this.transportCache = { key, t };
        return t;
    }

    /** Append a log row; returns its id (0 when the driver gives none). A real
     *  send writes its row as `sending` first so the email can carry the signed
     *  click link for that row, then `finishLog` sets the outcome. */
    async logSend(orderId: number, orderCode: string, channelId: number, email: string, status: string, reason: string, reviewUrl: string, queueId: number | null = null): Promise<number> {
        const r = await this.db.query(
            `INSERT INTO review_log (orderId, orderCode, channelId, email, status, reason, reviewUrl, createdAt, queueId)
             VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
            [orderId, String(orderCode || '').slice(0, 32), channelId, String(email || '').slice(0, 255), status, String(reason || '').slice(0, 255), String(reviewUrl || '').slice(0, 500), queueId],
            { needInsertId: true },
        );
        return Number(r?.insertId || 0);
    }

    /** Outcome for the `sending` row — by id, or by order when the driver returned no insert id. */
    private async finishLog(logId: number, orderId: number, status: 'sent' | 'failed', reason: string, queueId: number | null = null): Promise<void> {
        const r = String(reason || '').slice(0, 255);
        if (logId) await this.db.query(`UPDATE review_log SET status = ?, reason = ? WHERE id = ?`, [status, r, logId]);
        else if (queueId) await this.db.query(`UPDATE review_log SET status = ?, reason = ? WHERE queueId = ? AND status = 'sending'`, [status, r, queueId]);
        else await this.db.query(`UPDATE review_log SET status = ?, reason = ? WHERE orderId = ? AND status = 'sending'`, [status, r, orderId]);
    }

    /** Log a skip at most once per order (or list row) and reason: the hourly scan re-visits every
     *  order for its whole lookback window, and repeated identical rows only bury the audit trail. */
    private async logSkipOnce(o: { id: number; code: string; email: string }, channelId: number, reason: string, queueId: number | null = null): Promise<void> {
        const [already] = queueId
            ? await this.db.query(`SELECT id FROM review_log WHERE queueId = ? AND status = 'skipped' AND reason = ? LIMIT 1`, [queueId, reason])
            : await this.db.query(`SELECT id FROM review_log WHERE orderId = ? AND status = 'skipped' AND reason = ? LIMIT 1`, [o.id, reason]);
        if (!already) await this.logSend(o.id, o.code, channelId, o.email, 'skipped', reason, '', queueId);
    }

    /** "Review invitation e-mailed to …" on the order's history (staff-only note), as the WordPress
     *  edition adds to the WooCommerce order. Best effort: a failure never fails the send. */
    async addOrderNote(orderId: number, email: string): Promise<void> {
        if (!orderId || !this.history || !this.requestContextService) return;
        try {
            const ctx = await this.requestContextService.create({ apiType: 'admin' });
            await this.history.createHistoryEntryForOrder(
                { ctx, orderId, type: 'ORDER_NOTE' as any, data: { note: `Review invitation e-mailed to ${email}.` } }, false);
        } catch (e: any) {
            Logger.warn(`order note for order ${orderId} not added: ${e?.message || e}`, loggerCtx);
        }
    }

    /** Invitations sent on this channel in the last hour (scheduled and manual together). */
    async sentLastHour(channelId: number): Promise<number> {
        const [r] = await this.db.query(
            `SELECT COUNT(*) AS n FROM review_log WHERE status = 'sent' AND channelId = ? AND createdAt > DATE_SUB(NOW(), INTERVAL 1 HOUR)`, [channelId]);
        return Number(r?.n || 0);
    }

    /** Send one invitation with its audit row written first (so the email links
     *  through the click redirect), then record the outcome on that row. */
    private async sendLogged(cfg: ReviewChannelConfig, o: { id: number; code: string; email: string; firstName: string }, manual: boolean | string, queueId: number | null = null): Promise<{ ok: boolean; reason?: string }> {
        const how = manual === true ? 'manual' : manual || '';
        const reviewUrl = buildReviewUrl(cfg.reviewUrlTemplate, cfg.trustpilotDomain);
        const logId = await this.logSend(o.id, o.code, cfg.channelId, o.email, 'sending', how, reviewUrl, queueId);
        const res = await this.sendInvitation(cfg, o, logId);
        await this.finishLog(logId, o.id, res.ok ? 'sent' : 'failed', res.ok ? how : (res.reason || 'send failed'), queueId);
        if (res.ok && o.id) await this.addOrderNote(o.id, o.email);
        return res;
    }

    // ── Eligibility scan (the cron's engine) ────────────────────────────
    /** Opt-out + exclusion + cooldown sets for a batch of (lowercased) emails: three
     *  IN (…) queries regardless of batch size. Same pattern as `searchCustomers`. */
    private async batchEligibility(emails: string[], cooldownDays: number): Promise<{ excluded: Set<string>; cooldown: Set<string> }> {
        const excluded = new Set<string>();
        const cooldown = new Set<string>();
        if (!emails.length) return { excluded, cooldown };
        const domains = [...new Set(emails.map(e => e.split('@')[1]).filter(Boolean))];
        const emailPh = emails.map(() => '?').join(',');
        const domPh = domains.length ? domains.map(() => '?').join(',') : "''";
        const optRows: any[] = await this.db.query(`SELECT email FROM review_optout WHERE email IN (${emailPh})`, emails);
        for (const r of optRows) excluded.add(String(r.email || '').toLowerCase());
        const exRows: any[] = await this.db.query(
            `SELECT type, value FROM review_exclusion
             WHERE (type='email' AND value IN (${emailPh})) OR (type='email_domain' AND value IN (${domPh}))`,
            [...emails, ...domains],
        );
        const exDomains = new Set<string>();
        for (const r of exRows) {
            const v = String(r.value || '').toLowerCase();
            if (r.type === 'email_domain') exDomains.add(v); else excluded.add(v);
        }
        if (exDomains.size) for (const e of emails) if (exDomains.has(e.split('@')[1] || '')) excluded.add(e);
        if (cooldownDays > 0) {
            const cdRows: any[] = await this.db.query(
                `SELECT DISTINCT email FROM review_log
                 WHERE status = 'sent' AND createdAt > DATE_SUB(NOW(), INTERVAL ? DAY) AND email IN (${emailPh})`,
                [cooldownDays, ...emails],
            );
            for (const r of cdRows) cooldown.add(String(r.email || '').toLowerCase());
        }
        return { excluded, cooldown };
    }

    /**
     * Find orders placed ~delayDays ago that reached the trigger state, aren't
     * excluded / in cooldown / already invited, and send the invitation.
     * Returns a per-channel summary. `dryRun` computes eligibility without
     * sending (used for the Overview "pending" count and preview).
     */
    async runChannel(cfg: ReviewChannelConfig, dryRun = false): Promise<{ sent: number; skipped: number; failed: number; eligible: number; notReady?: string }> {
        const out: { sent: number; skipped: number; failed: number; eligible: number; notReady?: string } = { sent: 0, skipped: 0, failed: 0, eligible: 0 };
        if (!cfg.enabled && !dryRun) return out;
        // No review page yet: nothing is sent (the button would lead nowhere) and nobody is
        // logged or claimed, so the cooldown does not hold these customers back once it is set.
        const problem = reviewPageProblem(cfg);
        if (problem) { out.notReady = problem; return out; }

        // Candidate window: placed at least delayDays ago, within a 45-day
        // lookback (slow carriers, worker downtime). Orders already invited are
        // excluded in SQL so LIMIT counts real work. Backticks keep Vendure's
        // camelCase columns intact on Postgres.
        const states = ReviewRequestService.statesFor(cfg.triggerState);
        const orders = await this.db.query(
            `SELECT o.id, o.code, o.state, o.\`subTotalWithTax\`, o.\`orderPlacedAt\`, c.\`emailAddress\` AS email, c.\`firstName\`
             FROM \`order\` o
             JOIN customer c ON c.id = o.\`customerId\`
             JOIN order_channels_channel occ ON occ.\`orderId\` = o.id AND occ.\`channelId\` = ?
             WHERE o.state IN (${states.map(() => '?').join(',')})
               AND o.\`orderPlacedAt\` <= DATE_SUB(NOW(), INTERVAL ? DAY)
               AND o.\`orderPlacedAt\` >  DATE_SUB(NOW(), INTERVAL ? DAY)
               AND o.\`subTotalWithTax\` >= ?
               AND c.\`emailAddress\` IS NOT NULL AND c.\`emailAddress\` <> ''
               AND NOT EXISTS (SELECT 1 FROM review_log rl WHERE rl.orderId = o.id AND rl.status = 'sent')
               AND NOT EXISTS (SELECT 1 FROM review_claim rc WHERE rc.orderId = o.id)
             ORDER BY o.\`orderPlacedAt\` ASC
             LIMIT ?`,
            [cfg.channelId, ...states, cfg.delayDays, cfg.delayDays + LOOKBACK_DAYS, cfg.minOrderValuePence, cfg.maxPerRun],
        ).catch((e: any) => { Logger.error(`candidate query failed: ${e.message}`, loggerCtx); return []; });

        // Opt-out, exclusion and cooldown are resolved for the whole batch in three
        // IN (…) queries (the per-candidate lookups used to cost 3 round trips per order).
        const emails: string[] = [...new Set<string>(orders.map((o: any) => String(o.email || '').toLowerCase()).filter(Boolean))];
        let gate: { excluded: Set<string>; cooldown: Set<string> };
        try { gate = await this.batchEligibility(emails, cfg.cooldownDays); }
        catch (e: any) {
            // Fail closed: without the exclusion/cooldown sets we could email people who asked us not to.
            Logger.error(`eligibility lookup failed for channel ${cfg.channelId}: ${e?.message || e}`, loggerCtx);
            return out;
        }

        // One hourly budget for scheduled and staff sends (maxPerRun = the most invitations per hour).
        const room = dryRun ? Infinity : Math.max(0, cfg.maxPerRun - await this.sentLastHour(cfg.channelId).catch(() => 0));

        for (const o of orders) {
          if (!dryRun && out.sent >= room) break;
          try {
            const email = String(o.email).toLowerCase();
            const logSkipOnce = async (reason: string) => {
                if (!dryRun) await this.logSkipOnce({ id: o.id, code: o.code, email }, cfg.channelId, reason);
            };
            // excluded / opted out?
            if (gate.excluded.has(email)) {
                await logSkipOnce('excluded');
                out.skipped++; continue;
            }
            // cooldown: invited (any order) within cooldownDays?
            if (gate.cooldown.has(email)) {
                await logSkipOnce('cooldown');
                out.skipped++; continue;
            }
            out.eligible++;
            if (dryRun) continue;
            if (!(await this.claimOrder(Number(o.id), cfg.channelId))) continue; // another process has it
            // The cooldown gate above was read once for the batch: a second due order of the same
            // customer (this run or an overlapping one) must lose here, not get its own email.
            const emailClaimed = cfg.cooldownDays > 0;
            if (emailClaimed && !(await this.claimEmail(email, cfg.cooldownDays))) {
                await this.releaseClaim(Number(o.id));
                out.eligible--;
                await logSkipOnce('cooldown');
                out.skipped++; continue;
            }
            const res = await this.sendLogged(cfg, { id: o.id, code: o.code, email, firstName: o.firstName }, false);
            if (res.ok) out.sent++;
            else {
                await this.releaseClaim(Number(o.id));
                if (emailClaimed) await this.releaseEmailClaim(email);
                out.failed++;
            }
          } catch (e: any) {
            Logger.error(`review invitation for order ${o?.code || o?.id} failed: ${e?.message || e}`, loggerCtx);
            out.failed++;
          }
        }
        return out;
    }

    async runAll(dryRun = false, scope: ChannelScope = null): Promise<any[]> {
        // Every order also sits in the default channel: run the storefront channels first so their branding wins.
        const configs = (await this.getAllConfigs(scope)).slice().sort((a: any, b: any) => Number(a.channelCode === '__default_channel__') - Number(b.channelCode === '__default_channel__'));
        const results = [];
        for (const cfg of configs) {
            if (!cfg.enabled) continue;
            results.push({ channelId: cfg.channelId, channelCode: cfg.channelCode, ...(await this.runChannel(cfg, dryRun)) });
        }
        if (!dryRun) this.invalidatePending();
        return results;
    }

    /** The scope channels an order belongs to (all of them for an unscoped caller). */
    private async orderChannelsInScope(orderId: number, scope: ChannelScope): Promise<number[] | null> {
        if (!scope) return null;
        const { sql: occScope, params } = scopeFilter(scope, '\`channelId\`');
        const rows: any[] = await this.db.query(
            `SELECT \`channelId\` AS channelId FROM order_channels_channel WHERE \`orderId\` = ?${occScope} ORDER BY \`channelId\``,
            [orderId, ...params]).catch(() => []);
        return rows.map(r => Number(r.channelId));
    }

    /** One order as a send target: its customer and the channel whose settings and branding apply
     *  (a channel-scoped admin's own channel; otherwise the order's storefront channel). */
    private async orderTarget(orderId: number, scope: ChannelScope): Promise<{ id: number; code: string; email: string; firstName: string; channelId: number } | null> {
        const inScope = await this.orderChannelsInScope(orderId, scope);
        if (inScope && !inScope.length) return null;
        const [o] = await this.db.query(
            `SELECT o.id, o.code, c.\`emailAddress\` AS email, c.\`firstName\`,
                    (SELECT occ.\`channelId\` FROM order_channels_channel occ JOIN channel ch ON ch.id = occ.\`channelId\` WHERE occ.\`orderId\` = o.id ORDER BY (ch.code = '__default_channel__') ASC, occ.\`channelId\` DESC LIMIT 1) AS channelId
             FROM \`order\` o JOIN customer c ON c.id = o.\`customerId\` WHERE o.id = ? LIMIT 1`, [orderId]).catch(() => []);
        if (!o) return null;
        return {
            id: Number(o.id), code: String(o.code || ''), email: String(o.email || '').trim().toLowerCase(),
            firstName: String(o.firstName || ''), channelId: inScope ? inScope[0] : Number(o.channelId),
        };
    }

    /** Per-order invitation state for the admin order-detail panel. */
    async orderReviewStatus(orderId: number, scope: ChannelScope = null): Promise<any> {
        const t = await this.orderTarget(orderId, scope);
        if (!t) return { found: false };
        const email = t.email;
        const history = await this.db.query(
            `SELECT status, reason, createdAt FROM review_log WHERE orderId = ? ORDER BY createdAt DESC LIMIT 10`, [orderId]).catch(() => []);
        const [opt] = email ? await this.db.query(`SELECT email FROM review_optout WHERE email = ? LIMIT 1`, [email]).catch(() => []) : [];
        const cfg = await this.getConfig(t.channelId);
        let cooldown = false;
        if (email && cfg.cooldownDays > 0) {
            try { cooldown = (await this.batchEligibility([email], cfg.cooldownDays)).cooldown.has(email); } catch { /* shown as not in cooldown */ }
        }
        return {
            found: true,
            orderCode: t.code,
            email,
            sent: history.some((r: any) => r.status === 'sent'),
            optedOut: !!opt,
            excluded: email ? await this.isExcluded(email) : false,
            cooldown,
            cooldownDays: cfg.cooldownDays,
            notReady: reviewPageProblem(cfg) || null,
            premium: this.hasPremium(),
            history,
        };
    }

    /**
     * Staff send for one order (the order page, the orders-list bulk action, Invite selected).
     * Free (0.17.0). Nothing goes out while the review page is not set; opt-outs are ALWAYS
     * honoured. Without `force`: an order is invited once, and exclusions, the per-customer
     * cooldown and the hourly limit apply, as for scheduled sends. `force` (Resend, premium — the
     * controller checks) overrides a previous invitation, exclusions, the cooldown and the limit.
     * Refusals that say something about the customer are logged once per order (Activity tab).
     */
    async sendForOrder(orderId: number, force = false, scope: ChannelScope = null): Promise<SendResult> {
        const t = await this.orderTarget(orderId, scope);
        if (!t) return { ok: false, reason: 'Order not found', code: 'not_found' };
        const email = t.email;
        if (!email) return { ok: false, reason: 'Order has no customer email', code: 'invalid' };
        const cfg = await this.getConfig(t.channelId);
        const problem = reviewPageProblem(cfg);
        if (problem) return { ok: false, reason: problem, code: 'not_set_up' };
        const skip = async (code: SendResult['code'], logged: string, reason: string): Promise<SendResult> => {
            await this.logSkipOnce(t, cfg.channelId, logged).catch(() => undefined);
            return { ok: false, reason, code };
        };
        if (!isEmail(email)) return skip('invalid', 'invalid email', 'The order has no valid customer email address.');
        const [opt] = await this.db.query(`SELECT email FROM review_optout WHERE email = ? LIMIT 1`, [email]).catch(() => []);
        if (opt) return skip('unsubscribed', 'unsubscribed', 'Customer has opted out of review emails');
        let emailClaimed = false;
        if (!force) {
            const [prior] = await this.db.query(`SELECT id FROM review_log WHERE orderId = ? AND status = 'sent' LIMIT 1`, [t.id]);
            if (prior) return { ok: false, reason: 'Already sent for this order — use Resend to send again', code: 'already' };
            let gate: { excluded: Set<string>; cooldown: Set<string> };
            try { gate = await this.batchEligibility([email], cfg.cooldownDays); }
            catch { return { ok: false, reason: 'Could not check the opt-out list, so nothing was sent. Try again shortly.', code: 'failed' }; }
            if (gate.excluded.has(email)) return skip('excluded', 'excluded', 'Customer/domain is excluded — use Resend to override');
            if (gate.cooldown.has(email)) return skip('cooldown', 'cooldown', `This customer was invited in the last ${cfg.cooldownDays} days (cooldown) — use Resend to override`);
            if (await this.sentLastHour(cfg.channelId) >= cfg.maxPerRun) {
                return { ok: false, reason: `The limit of ${cfg.maxPerRun} invitations per hour has been reached. Try again later.`, code: 'capped' };
            }
            if (!(await this.claimOrder(t.id, cfg.channelId))) return { ok: false, reason: 'An invitation for this order is already being sent', code: 'claimed' };
            if (cfg.cooldownDays > 0) {
                if (!(await this.claimEmail(email, cfg.cooldownDays))) {
                    await this.releaseClaim(t.id);
                    return skip('cooldown', 'cooldown', `This customer was invited in the last ${cfg.cooldownDays} days (cooldown) — use Resend to override`);
                }
                emailClaimed = true;
            }
        }
        const res = await this.sendLogged(cfg, { id: t.id, code: t.code, email, firstName: t.firstName }, force ? 'resend' : true);
        if (!res.ok && !force) {
            await this.releaseClaim(t.id);
            if (emailClaimed) await this.releaseEmailClaim(email);
        }
        this.invalidatePending();
        return res.ok ? { ok: true, code: 'sent' } : { ok: false, reason: res.reason, code: 'failed' };
    }

    // ── Staff sends to many customers (premium): bulk, lists, outbox ─────
    /**
     * Several orders at once (the orders-list bulk action, Invite selected): the first
     * SEND_BATCH now, each through sendForOrder(); the rest, and any the hourly limit holds back,
     * go to the outbox and out in the background, SEND_BATCH a minute, within the hourly limit.
     */
    async bulkSendOrders(orderIds: number[], scope: ChannelScope = null): Promise<BulkResult> {
        const ids = [...new Set((orderIds || []).map(n => Math.floor(Number(n))).filter(n => Number.isInteger(n) && n > 0))].slice(0, 1000);
        const out: BulkResult = { sent: 0, skipped: 0, queued: 0, reasons: {} };
        const later = ids.slice(SEND_BATCH);
        const reason = (r: string) => { out.skipped++; out.reasons[r] = (out.reasons[r] || 0) + 1; };
        for (const id of ids.slice(0, SEND_BATCH)) {
            const r = await this.sendForOrder(id, false, scope);
            if (r.ok) out.sent++;
            else if (r.code === 'capped') later.push(id);
            else if (r.code === 'not_set_up') { out.blocked = r.reason; reason(r.reason || 'not set up'); }
            else reason(r.reason || 'not sent');
        }
        for (const id of later) {
            const t = await this.orderTarget(id, scope);
            if (!t || !t.email) { reason(t ? 'Order has no customer email' : 'Order not found'); continue; }
            if (await this.enqueueOrder(t)) out.queued++;
            else reason('Already sent or already waiting');
        }
        this.invalidatePending();
        return out;
    }

    /** An order into the outbox, unless it was invited or is already waiting. */
    private async enqueueOrder(t: { id: number; email: string; firstName: string; channelId: number }): Promise<boolean> {
        const [sent] = await this.db.query(`SELECT id FROM review_log WHERE orderId = ? AND status = 'sent' LIMIT 1`, [t.id]);
        if (sent) return false;
        const [waiting] = await this.db.query(`SELECT id FROM review_queue WHERE orderId = ? AND state IN ('outbox', 'sending') LIMIT 1`, [t.id]);
        if (waiting) return true;
        await this.db.query(
            `INSERT INTO review_queue (channelId, source, orderId, batchId, email, name, state, dueAt, createdAt, updatedAt)
             VALUES (?, 'order', ?, '', ?, ?, 'outbox', NOW(), NOW(), NOW())`,
            [t.channelId, t.id, t.email.slice(0, 255), String(t.firstName || '').slice(0, 190)]);
        return true;
    }

    /**
     * A pasted or CSV list for one channel. `now`: everyone goes to the outbox and the first
     * SEND_BATCH are sent straight away, the rest in the background. `schedule`: each customer is
     * invited `delayDays` from now by the hourly run (while the channel's sending is on).
     * Opt-outs, exclusions, the cooldown and the hourly limit apply. Without a review page the
     * list is neither sent nor kept.
     */
    async sendList(channelId: number, text: string, mode: 'now' | 'schedule'): Promise<BulkResult & { ok: boolean; message: string; scheduled: number; invalid: number; unread: number }> {
        const cfg = await this.getConfig(channelId);
        const parsed: ParsedList = readList(text);
        const base = { ok: false, sent: 0, skipped: 0, queued: 0, scheduled: 0, reasons: {} as Record<string, number>, invalid: parsed.invalid, unread: parsed.unread };
        const problem = reviewPageProblem(cfg);
        if (problem) return { ...base, blocked: problem, message: problem };
        if (!parsed.rows.length) return { ...base, message: unreadableMessage(parsed, true) };
        const batchId = `L${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
        const schedule = mode === 'schedule';
        for (const r of parsed.rows) {
            await this.db.query(
                `INSERT INTO review_queue (channelId, source, orderId, batchId, email, name, state, dueAt, createdAt, updatedAt)
                 VALUES (?, 'list', NULL, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY), NOW(), NOW())`,
                [channelId, batchId, r.email, r.name, schedule ? 'scheduled' : 'outbox', schedule ? cfg.delayDays : 0]);
        }
        const tail = [
            parsed.invalid ? unreadableMessage(parsed, false) : '',
            parsed.unread ? `${parsed.unread} line${parsed.unread === 1 ? '' : 's'} past the 5,000-line limit ${parsed.unread === 1 ? 'was' : 'were'} not read: send ${parsed.unread === 1 ? 'it' : 'them'} as another list.` : '',
        ].filter(Boolean).join(' ');
        if (schedule) {
            const n = parsed.rows.length;
            const msg = cfg.enabled
                ? `${n} customer${n === 1 ? '' : 's'} scheduled; invitations go out in ${cfg.delayDays} day${cfg.delayDays === 1 ? '' : 's'}.`
                : `${n} customer${n === 1 ? '' : 's'} scheduled. Sending is switched off for this channel, so nothing goes out until you switch it on.`;
            return { ...base, ok: true, scheduled: n, message: [msg, tail].filter(Boolean).join(' ') };
        }
        const rows: any[] = await this.db.query(
            `SELECT * FROM review_queue WHERE batchId = ? AND state = 'outbox' ORDER BY id LIMIT ?`, [batchId, SEND_BATCH]);
        const out: BulkResult = { sent: 0, skipped: 0, queued: 0, reasons: {} };
        for (const row of rows) {
            const r = await this.processQueueRow(row);
            if (r.ok) out.sent++;
            else if (r.code === 'capped' || r.code === 'claimed') break;
            else { out.skipped++; out.reasons[r.reason || 'not sent'] = (out.reasons[r.reason || 'not sent'] || 0) + 1; }
        }
        const [left] = await this.db.query(`SELECT COUNT(*) AS n FROM review_queue WHERE batchId = ? AND state = 'outbox'`, [batchId]);
        out.queued = Number(left?.n || 0);
        return { ...base, ...out, ok: true, message: [bulkSummary(out), tail].filter(Boolean).join(' ') };
    }

    /**
     * Send for one queue row (claimed here). Lasting refusals (unsubscribed, excluded, cooldown,
     * no valid address, already invited) end the row as `skipped` with the reason logged; the
     * hourly limit and a missing review page leave it in the outbox for a later run.
     */
    async processQueueRow(row: any): Promise<SendResult> {
        const id = Number(row.id);
        const claimed = await this.db.query(
            `UPDATE review_queue SET state = 'sending', updatedAt = NOW() WHERE id = ? AND state IN ('outbox', 'scheduled')`, [id], { needAffected: true });
        if (!(Number(claimed?.affectedRows ?? claimed?.rowCount ?? 0) > 0)) return { ok: false, code: 'claimed', reason: 'Already being sent' };
        const finish = async (state: 'sent' | 'skipped' | 'failed' | 'outbox', reason: string | null) => {
            await this.db.query(`UPDATE review_queue SET state = ?, reason = ?, updatedAt = NOW() WHERE id = ?`, [state, reason ? reason.slice(0, 255) : null, id]);
        };
        try {
            if (row.source === 'order' && row.orderId) {
                const r = await this.sendForOrder(Number(row.orderId), false, null);
                if (r.ok) await finish('sent', null);
                else if (r.code === 'capped' || r.code === 'not_set_up' || r.code === 'claimed') await finish('outbox', r.reason || null);
                else await finish(r.code === 'failed' ? 'failed' : 'skipped', r.reason || null);
                return r;
            }
            const cfg = await this.getConfig(Number(row.channelId));
            const problem = reviewPageProblem(cfg);
            if (problem) { await finish('outbox', problem); return { ok: false, code: 'not_set_up', reason: problem }; }
            const email = String(row.email || '').trim().toLowerCase();
            const who = { id: 0, code: '', email };
            const skip = async (code: SendResult['code'], logged: string, reason: string): Promise<SendResult> => {
                await this.logSkipOnce(who, cfg.channelId, logged, id).catch(() => undefined);
                await finish('skipped', reason);
                return { ok: false, code, reason };
            };
            if (!isEmail(email)) return skip('invalid', 'invalid email', 'There is no valid e-mail address.');
            let gate: { excluded: Set<string>; cooldown: Set<string> };
            try { gate = await this.batchEligibility([email], cfg.cooldownDays); }
            catch { await finish('outbox', null); return { ok: false, code: 'claimed', reason: 'Could not check the opt-out list' }; }
            const [opt] = await this.db.query(`SELECT email FROM review_optout WHERE email = ? LIMIT 1`, [email]);
            if (opt) return skip('unsubscribed', 'unsubscribed', 'The customer has unsubscribed from review e-mails.');
            if (gate.excluded.has(email)) return skip('excluded', 'excluded', 'The customer or their domain is excluded.');
            if (gate.cooldown.has(email)) return skip('cooldown', 'cooldown', `This customer was invited in the last ${cfg.cooldownDays} days (cooldown).`);
            if (await this.sentLastHour(cfg.channelId) >= cfg.maxPerRun) {
                await finish('outbox', null);
                return { ok: false, code: 'capped', reason: `The limit of ${cfg.maxPerRun} invitations per hour has been reached.` };
            }
            if (cfg.cooldownDays > 0 && !(await this.claimEmail(email, cfg.cooldownDays))) {
                return skip('cooldown', 'cooldown', `This customer was invited in the last ${cfg.cooldownDays} days (cooldown).`);
            }
            const res = await this.sendLogged(cfg, { id: 0, code: '', email, firstName: firstNameOf(row.name || '') }, 'list', id);
            if (res.ok) { await finish('sent', null); return { ok: true, code: 'sent' }; }
            if (cfg.cooldownDays > 0) await this.releaseEmailClaim(email);
            await finish('failed', res.reason || 'send failed');
            return { ok: false, code: 'failed', reason: res.reason };
        } catch (e: any) {
            await finish('outbox', null).catch(() => undefined);
            throw e;
        }
    }

    /**
     * Background run of the outbox (worker, every minute, premium): rows left `sending` by a
     * crashed process go back first, then up to SEND_BATCH due rows are sent. A channel that hits
     * its hourly limit or has no review page is passed over until a later run.
     */
    async processOutbox(limit = SEND_BATCH): Promise<{ sent: number; skipped: number; left: number }> {
        await this.db.query(
            `UPDATE review_queue SET state = 'outbox', updatedAt = NOW() WHERE state = 'sending' AND updatedAt < DATE_SUB(NOW(), INTERVAL 15 MINUTE)`);
        const rows: any[] = await this.db.query(
            `SELECT * FROM review_queue WHERE state = 'outbox' AND dueAt <= NOW() ORDER BY dueAt, id LIMIT ?`, [Math.max(1, limit * 3)]);
        const out = { sent: 0, skipped: 0, left: 0 };
        const paused = new Set<number>();
        let done = 0;
        for (const row of rows) {
            if (done >= limit) break;
            if (paused.has(Number(row.channelId))) continue;
            const r = await this.processQueueRow(row).catch((e: any) => {
                Logger.error(`review outbox row ${row.id} failed: ${e?.message || e}`, loggerCtx);
                return { ok: false, code: 'claimed' } as SendResult;
            });
            done++;
            if (r.ok) out.sent++;
            else if (r.code === 'capped' || r.code === 'not_set_up') paused.add(Number(row.channelId));
            else if (r.code !== 'claimed') out.skipped++;
        }
        const [left] = await this.db.query(`SELECT COUNT(*) AS n FROM review_queue WHERE state = 'outbox'`);
        out.left = Number(left?.n || 0);
        if (out.sent || out.skipped) this.invalidatePending();
        return out;
    }

    /** Scheduled list rows that are due move to the outbox, for channels whose sending is on (hourly run). */
    async promoteScheduled(): Promise<number> {
        const enabled = (await this.getAllConfigs()).filter(c => c.enabled && !reviewPageProblem(c)).map(c => c.channelId);
        if (!enabled.length) return 0;
        const r = await this.db.query(
            `UPDATE review_queue SET state = 'outbox', updatedAt = NOW() WHERE state = 'scheduled' AND dueAt <= NOW() AND channelId IN (${enabled.map(() => '?').join(',')})`,
            enabled, { needAffected: true });
        return Number(r?.affectedRows ?? r?.rowCount ?? 0);
    }

    /**
     * "Not invited yet" (premium): recent orders at or beyond each channel's trigger state that
     * have no invitation and are not waiting in the outbox (unsubscribed customers are left out;
     * excluded customers and those in their cooldown are flagged), plus scheduled list rows and
     * the outbox count.
     */
    async notInvited(scope: ChannelScope = null, limit = 100): Promise<{ orders: any[]; scheduled: any[]; outbox: number; failed: number }> {
        const take = Math.max(1, Math.min(limit, 200));
        const configs = (await this.getAllConfigs(scope)).slice()
            .sort((a, b) => Number(a.channelCode === '__default_channel__') - Number(b.channelCode === '__default_channel__'));
        const byOrder = new Map<number, any>();
        for (const cfg of configs) {
            const states = ReviewRequestService.statesFor(cfg.triggerState);
            const rows: any[] = await this.db.query(
                `SELECT o.id, o.code, o.state, o.\`orderPlacedAt\`, c.\`emailAddress\` AS email, c.\`firstName\`, c.\`lastName\`
                 FROM \`order\` o
                 JOIN customer c ON c.id = o.\`customerId\`
                 JOIN order_channels_channel occ ON occ.\`orderId\` = o.id AND occ.\`channelId\` = ?
                 WHERE o.state IN (${states.map(() => '?').join(',')})
                   AND o.\`orderPlacedAt\` > DATE_SUB(NOW(), INTERVAL ? DAY)
                   AND c.\`emailAddress\` IS NOT NULL AND c.\`emailAddress\` <> ''
                   AND NOT EXISTS (SELECT 1 FROM review_log rl WHERE rl.orderId = o.id AND rl.status IN ('sent', 'sending'))
                   AND NOT EXISTS (SELECT 1 FROM review_claim rc WHERE rc.orderId = o.id)
                   AND NOT EXISTS (SELECT 1 FROM review_queue rq WHERE rq.orderId = o.id AND rq.state IN ('outbox', 'sending'))
                 ORDER BY o.\`orderPlacedAt\` DESC
                 LIMIT ?`,
                [cfg.channelId, ...states, cfg.delayDays + LOOKBACK_DAYS, take]);
            for (const r of rows) {
                if (byOrder.has(Number(r.id))) continue;
                byOrder.set(Number(r.id), {
                    orderId: Number(r.id), code: r.code, state: r.state, placedAt: r.orderPlacedAt, channelId: cfg.channelId, channelCode: cfg.channelCode,
                    email: String(r.email || '').toLowerCase(), name: [r.firstName, r.lastName].filter(Boolean).join(' '), cooldownDays: cfg.cooldownDays,
                });
            }
        }
        let orders = [...byOrder.values()].sort((a, b) => new Date(b.placedAt).getTime() - new Date(a.placedAt).getTime()).slice(0, take);
        if (orders.length) {
            const emails = [...new Set(orders.map(o => o.email))];
            const maxCooldown = Math.max(0, ...orders.map(o => Number(o.cooldownDays) || 0));
            const optRows: any[] = await this.db.query(`SELECT email FROM review_optout WHERE email IN (${emails.map(() => '?').join(',')})`, emails);
            const opted = new Set(optRows.map(r => String(r.email || '').toLowerCase()));
            const gate = await this.batchEligibility(emails, maxCooldown).catch(() => ({ excluded: new Set<string>(), cooldown: new Set<string>() }));
            orders = orders.filter(o => !opted.has(o.email)).map(o => ({
                ...o, flag: gate.excluded.has(o.email) ? 'excluded' : (o.cooldownDays > 0 && gate.cooldown.has(o.email)) ? 'cooldown' : null,
            }));
        }
        const { sql: qScope, params: qp } = scopeFilter(scope, 'channelId');
        const scheduled: any[] = await this.db.query(
            `SELECT id, channelId, email, name, dueAt, createdAt FROM review_queue WHERE state = 'scheduled'${qScope} ORDER BY dueAt, id LIMIT ?`, [...qp, take]);
        const [ob] = await this.db.query(`SELECT COUNT(*) AS n FROM review_queue WHERE state IN ('outbox', 'sending')${qScope}`, qp);
        const [fl] = await this.db.query(`SELECT COUNT(*) AS n FROM review_queue WHERE state = 'failed' AND updatedAt > DATE_SUB(NOW(), INTERVAL 7 DAY)${qScope}`, qp);
        return { orders, scheduled, outbox: Number(ob?.n || 0), failed: Number(fl?.n || 0) };
    }

    /** Invite selected (premium): orders through the bulk path; scheduled list rows go to the outbox now. */
    async inviteSelected(orderIds: number[], queueIds: number[], scope: ChannelScope = null): Promise<BulkResult> {
        const out = await this.bulkSendOrders(orderIds, scope);
        const ids = [...new Set((queueIds || []).map(n => Math.floor(Number(n))).filter(n => Number.isInteger(n) && n > 0))].slice(0, 1000);
        if (ids.length) {
            const { sql: qScope, params: qp } = scopeFilter(scope, 'channelId');
            const moved = await this.db.query(
                `UPDATE review_queue SET state = 'outbox', dueAt = NOW(), updatedAt = NOW() WHERE state = 'scheduled' AND id IN (${ids.map(() => '?').join(',')})${qScope}`,
                [...ids, ...qp], { needAffected: true });
            const n = Number(moved?.affectedRows ?? moved?.rowCount ?? 0);
            const r = await this.processOutbox(Math.max(0, SEND_BATCH - out.sent));
            out.sent += r.sent; out.skipped += r.skipped;
            out.queued += Math.max(0, n - r.sent - r.skipped);
        }
        return out;
    }

    /** Drop a scheduled list row before it goes out. */
    async cancelQueued(id: number, scope: ChannelScope = null): Promise<boolean> {
        const { sql: qScope, params: qp } = scopeFilter(scope, 'channelId');
        const r = await this.db.query(
            `DELETE FROM review_queue WHERE id = ? AND state IN ('scheduled', 'outbox')${qScope}`, [id, ...qp], { needAffected: true });
        return Number(r?.affectedRows ?? r?.rowCount ?? 0) > 0;
    }

    /** Customers who used the unsubscribe link, newest first (install-wide: opt-outs apply to every channel). */
    async listOptOuts(q = '', limit = 200): Promise<{ rows: Array<{ email: string; createdAt: any }>; total: number }> {
        const term = String(q || '').trim().toLowerCase().slice(0, 190);
        const take = Math.max(1, Math.min(limit, 500));
        const rows: any[] = term
            ? await this.db.query(`SELECT email, createdAt FROM review_optout WHERE email LIKE ? ORDER BY createdAt DESC LIMIT ?`, [`%${term.replace(/[\\%_]/g, m => '\\' + m)}%`, take])
            : await this.db.query(`SELECT email, createdAt FROM review_optout ORDER BY createdAt DESC LIMIT ?`, [take]);
        const [t] = await this.db.query(`SELECT COUNT(*) AS n FROM review_optout`);
        return { rows: rows.map(r => ({ email: r.email, createdAt: r.createdAt })), total: Number(t?.n || 0) };
    }

    // ── Stats + log for the admin ───────────────────────────────────────
    async stats(days = 30, scope: ChannelScope = null): Promise<any> {
        const d = Math.max(1, Math.min(days, 365));
        const { sql: logScope, params: lp } = scopeFilter(scope, 'channelId');
        // `clicked` counts invitations from this window whose review link was opened — the click-through denominator is `sent`.
        const [totals] = await this.db.query(
            `SELECT SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent, SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) AS skipped, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
                    SUM(CASE WHEN clickedAt IS NOT NULL THEN 1 ELSE 0 END) AS clicked
             FROM review_log WHERE createdAt > DATE_SUB(NOW(), INTERVAL ? DAY)${logScope}`, [d, ...lp]);
        const daily = await this.db.query(
            `SELECT DATE(createdAt) AS day, SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent
             FROM review_log WHERE createdAt > DATE_SUB(NOW(), INTERVAL ? DAY)${logScope} GROUP BY DATE(createdAt) ORDER BY day`, [d, ...lp]);
        const [optouts] = await this.db.query(`SELECT COUNT(*) AS n FROM review_optout`);
        return { totals: totals || {}, daily, optOuts: Number(optouts?.n || 0) };
    }

    async log(status?: string, take = 100, scope: ChannelScope = null): Promise<any[]> {
        const { sql: logScope, params } = scopeFilter(scope, 'channelId');
        const where = status ? `WHERE status = ?` : 'WHERE 1 = 1';
        return this.db.query(
            `SELECT * FROM review_log ${where}${logScope} ORDER BY createdAt DESC LIMIT ${Math.min(take, 500)}`,
            [...(status ? [status] : []), ...params],
        ).catch(() => []);
    }
}
