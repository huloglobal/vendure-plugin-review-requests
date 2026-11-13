import * as https from 'https';
import { cleanDomain } from './review-page';

/**
 * Free Trustpilot integration.
 *
 * Two free capabilities, no paid Automatic Feedback Service:
 *   1. The review CTA links to the public "evaluate" page
 *      (https://www.trustpilot.com/evaluate/<domain>) — anyone can open it
 *      and leave a Service Review. These land as organic reviews.
 *   2. The public Business Unit API (a free developer API key) is READ-ONLY
 *      here — we fetch the current TrustScore + review count to show as
 *      social proof in the email. Optional; the email works without it.
 */

export function buildReviewUrl(template: string, domain: string): string {
    const d = cleanDomain(domain || '');
    return (template || 'https://www.trustpilot.com/evaluate/{domain}').replace(/\{domain\}/g, encodeURIComponent(d));
}

export interface TrustpilotRating {
    stars: number;          // 1–5 (rounded display stars)
    trustScore: number;     // 0–5 (one decimal)
    numberOfReviews: number;
    fetchedAt: string;
}

function getJson(url: string, timeoutMs = 6000): Promise<any> {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: timeoutMs, headers: { accept: 'application/json' } }, res => {
            if (res.statusCode && res.statusCode >= 400) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
            let data = '';
            res.on('data', c => (data += c));
            res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

/** Resolve a business-unit id from a domain using the free find endpoint. */
export async function findBusinessUnitId(domain: string, apiKey: string): Promise<string | null> {
    if (!domain || !apiKey) return null;
    const d = domain.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    try {
        const j = await getJson(`https://api.trustpilot.com/v1/business-units/find?name=${encodeURIComponent(d)}&apikey=${encodeURIComponent(apiKey)}`);
        return j?.id || null;
    } catch {
        return null;
    }
}

/** Read the live rating. Returns null on any failure (caller degrades gracefully). */
export async function fetchRating(businessUnitId: string, apiKey: string): Promise<TrustpilotRating | null> {
    if (!businessUnitId || !apiKey) return null;
    try {
        const j = await getJson(`https://api.trustpilot.com/v1/business-units/${encodeURIComponent(businessUnitId)}?apikey=${encodeURIComponent(apiKey)}`);
        return normaliseRating(
            Number(j?.score?.trustScore ?? j?.trustScore ?? 0),
            Number(j?.score?.stars ?? NaN),
            Number(j?.numberOfReviews?.total ?? j?.numberOfReviews ?? 0),
        );
    } catch {
        return null;
    }
}

/** Coerce an API response into a rating with finite numbers, or null when there is
 *  nothing to show. A NaN `trustScore` used to reach `toFixed` and throw mid-send. */
export function normaliseRating(trustScore: number, stars: number, numberOfReviews: number): TrustpilotRating | null {
    const score = Number.isFinite(trustScore) ? trustScore : 0;
    const reviews = Number.isFinite(numberOfReviews) ? Math.max(0, Math.round(numberOfReviews)) : 0;
    if (!score && !reviews) return null;
    const s = Number.isFinite(stars) ? stars : Math.round(score);
    return { stars: Math.max(0, Math.min(5, s)), trustScore: score, numberOfReviews: reviews, fetchedAt: new Date().toISOString() };
}

/** `trustScore` with one decimal — never throws on a malformed rating. */
export function formatScore(rating: { trustScore: number } | null | undefined): string {
    const n = Number(rating?.trustScore);
    return Number.isFinite(n) ? n.toFixed(1) : '–';
}

/** Inline Trustpilot-green star row for the email (no external images). */
export function renderStars(stars: number): string {
    const full = Math.max(0, Math.min(5, Math.round(stars || 0)));
    const star = (on: boolean) =>
        `<span style="display:inline-block;width:22px;height:22px;line-height:22px;text-align:center;margin:0 1px;` +
        `background:${on ? '#00b67a' : '#dcdce6'};color:#fff;border-radius:3px;font-size:15px">★</span>`;
    let out = '';
    for (let i = 1; i <= 5; i++) out += star(i <= full);
    return `<div style="white-space:nowrap">${out}</div>`;
}
