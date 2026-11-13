/**
 * The review page an invitation links to: which platform a link template is
 * for, whether the page is set at all, and what the merchant typed or pasted
 * as the identifier (Trustpilot domain, Google Place ID, Reviews.io store ID).
 *
 * Nothing is sent while the review page is not set: the button in the e-mail
 * would lead nowhere, and the cooldown would then hold the customer back from
 * a proper invitation later (0.17.0, same rule as the WordPress edition).
 */

export type ReviewPlatform = 'trustpilot' | 'google' | 'reviewsio' | 'custom';

/** Review-link templates per platform; `{domain}` is the identifier. */
export const PLATFORM_TEMPLATES: Record<Exclude<ReviewPlatform, 'custom'>, string> = {
    trustpilot: 'https://www.trustpilot.com/evaluate/{domain}',
    google: 'https://search.google.com/local/writereview?placeid={domain}',
    reviewsio: 'https://www.reviews.io/company-reviews/store/{domain}',
};

/** Reviews.io link formats earlier versions saved (the admin offered `company-review/store/{id}/new`, which 404s). */
const OLD_REVIEWS_IO = /^https?:\/\/(?:www\.)?reviews\.io\/company-review\/store\/\{domain\}(?:\/new)?\/?$/i;

/** The template a stored config should use: an old Reviews.io link becomes the current one. */
export function currentTemplate(template: string): string {
    const t = String(template || '').trim();
    return OLD_REVIEWS_IO.test(t) ? PLATFORM_TEMPLATES.reviewsio : t;
}

/** Which platform a link template is for. */
export function platformOfTemplate(template: string): ReviewPlatform {
    const t = String(template || '').toLowerCase();
    if (/^https?:\/\/([a-z0-9-]+\.)*trustpilot\.com\//.test(t)) return 'trustpilot';
    if (/^https?:\/\/search\.google\.com\/local\/writereview/.test(t)) return 'google';
    if (/^https?:\/\/([a-z0-9-]+\.)*reviews\.(io|co\.uk)\//.test(t) && t.includes('{domain}')) return 'reviewsio';
    return 'custom';
}

/** An http(s) link with `{placeholders}` kept intact, or '' when it is not one. */
export function cleanUrlTemplate(t: string): string {
    const v = String(t ?? '').trim().slice(0, 400);
    return v && /^https?:\/\/[^\s<>"']+$/i.test(v) ? v : '';
}

/** "https://www.yourstore.com/shop?x" → "www.yourstore.com"; a pasted Trustpilot page → the domain it is for. */
export function cleanDomain(domain: string): string {
    const d = String(domain || '').trim();
    const tp = d.match(/^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*trustpilot\.com\/(?:review|evaluate)\/([^/?#\s]+)/i);
    if (tp) {
        try { return decodeURIComponent(tp[1]).toLowerCase(); } catch { return tp[1].toLowerCase(); }
    }
    return d.replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '');
}

/** True while the review page is not set: no link, or a link that needs an identifier and has none. */
export function needsIdentifier(cfg: { reviewUrlTemplate?: string; trustpilotDomain?: string }): boolean {
    const template = String(cfg.reviewUrlTemplate || '').trim();
    return !template || (!String(cfg.trustpilotDomain || '').trim() && template.includes('{domain}'));
}

/** Why nothing can be sent yet ('' once the review page is set). */
export function reviewPageProblem(cfg: { reviewUrlTemplate?: string; trustpilotDomain?: string }): string {
    return needsIdentifier(cfg) ? 'Set your review page on the Settings tab first. Nothing was sent.' : '';
}

/**
 * What the merchant typed or pasted as the identifier, as the platform's review
 * link needs it. `error` says why the entry cannot be used ('' when it can; the
 * value is then ''), so a wrong identifier is never stored and nothing is sent
 * with a dead link.
 *   - Trustpilot: the domain the business is listed under (also from a pasted
 *     trustpilot.com/review/<domain> page or the site's own address).
 *   - Google: the Place ID (also from a pasted writereview?placeid=… link).
 *   - Reviews.io: the store ID (also from a pasted reviews.io/company-reviews/store/<id> page).
 */
export function parseIdentifier(platform: ReviewPlatform, raw: string): { value: string; error: string } {
    const v = String(raw ?? '').trim();
    if (!v) return { value: '', error: '' };
    const no = (error: string) => ({ value: '', error });
    const link = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) || v.includes('/');
    if (platform === 'trustpilot') {
        if (/^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*trustpilot\.com(?:[/?#]|$)/i.test(v) && !/trustpilot\.com\/(?:review|evaluate)\/[^/?#\s]+/i.test(v)) {
            return no(`"${v}" is Trustpilot's own address. Enter the domain your business is listed under on Trustpilot, such as yourstore.com, or paste your Trustpilot page (trustpilot.com/review/yourstore.com).`);
        }
        const d = cleanDomain(v).toLowerCase();
        if (!/^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?)+$/u.test(d) || d.length > 190) {
            return no(`"${v}" is not a domain. Enter the domain your business is listed under on Trustpilot, such as yourstore.com.`);
        }
        return { value: d, error: '' };
    }
    if (platform === 'google') {
        let id = v;
        if (link || v.includes('.')) {
            let decoded = v;
            try { decoded = decodeURIComponent(v); } catch { /* keep as typed */ }
            const m = decoded.match(/(?:[?&](?:placeid|place_id|query_place_id)=|place_id:)([A-Za-z0-9_-]{10,})/);
            if (!m) return no(`"${v}" is not a Google Place ID. Enter your Place ID (it usually starts with ChIJ; Google's Place ID Finder shows it), or choose "Custom link" to use a review link such as https://g.page/r/…/review.`);
            id = m[1];
        }
        id = id.replace(/^place_id:/i, '');
        if (!/^[A-Za-z0-9_-]{10,300}$/.test(id)) {
            return no(`"${v}" is not a Google Place ID. A Place ID is a code of letters and digits that usually starts with ChIJ; Google's Place ID Finder shows yours.`);
        }
        return { value: id, error: '' };
    }
    if (platform === 'reviewsio') {
        let id = v;
        if (link) {
            const m = v.match(/^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*reviews\.(?:io|co\.uk)\/(?:company-reviews?|write-a-review)\/store\/([^/?#\s]+)/i);
            if (!m) return no(`"${v}" is not a Reviews.io store ID. Enter your store ID, or paste your Reviews.io page (reviews.io/company-reviews/store/your-store). For another link, choose "Custom link".`);
            try { id = decodeURIComponent(m[1]); } catch { id = m[1]; }
        }
        if (!/^[A-Za-z0-9._-]{1,190}$/.test(id)) {
            return no(`"${v}" is not a Reviews.io store ID. It is the last part of your Reviews.io page address (reviews.io/company-reviews/store/your-store).`);
        }
        return { value: id, error: '' };
    }
    return { value: v.slice(0, 190), error: '' };
}

/**
 * Validate the review-page part of a submitted channel config. Returns the
 * template and identifier to store plus the problems to show:
 *   - a named platform always uses its current link format;
 *   - an identifier the platform cannot use is not kept (the page reads "not set");
 *   - a custom link that is not an http(s) link keeps the previous template.
 */
export function validateReviewPage(
    input: { reviewUrlTemplate?: string; trustpilotDomain?: string },
    previousTemplate: string,
): { reviewUrlTemplate: string; trustpilotDomain: string; errors: string[] } {
    const errors: string[] = [];
    let template = currentTemplate(String(input.reviewUrlTemplate ?? ''));
    let raw = String(input.trustpilotDomain ?? '').trim();
    const platform = platformOfTemplate(template);
    if (platform === 'custom') {
        // A full link pasted into the identifier field (and the template left at a platform default) is the link.
        const named = Object.values(PLATFORM_TEMPLATES).includes(template);
        if (named && /^https?:\/\/\S+$/i.test(raw)) { template = raw; raw = ''; }
        const clean = cleanUrlTemplate(template);
        if (!clean) {
            errors.push(template
                ? `"${template.slice(0, 120)}" is not a link. Enter the full address of your review page, starting with https://.`
                : 'Enter your review link: the page your customers should open, such as https://g.page/r/…/review.');
            template = currentTemplate(previousTemplate) || PLATFORM_TEMPLATES.trustpilot;
        } else {
            template = clean;
        }
        const value = raw.slice(0, 190);
        if (!value && template.includes('{domain}')) {
            errors.push('Your review link contains {domain}: enter what goes there in the identifier field, or take {domain} out of the link.');
        }
        return { reviewUrlTemplate: template, trustpilotDomain: value, errors };
    }
    const r = parseIdentifier(platform, raw);
    if (r.error) errors.push(r.error);
    // Named platforms: the canonical template (a Trustpilot template on another subdomain stays as typed).
    const canonical = platform === 'reviewsio' ? PLATFORM_TEMPLATES.reviewsio : template;
    return { reviewUrlTemplate: canonical, trustpilotDomain: r.value, errors };
}
