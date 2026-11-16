/**
 * The review-invitation e-mail. The subject and body are editable per channel
 * in the admin; the body renders, unchanged, inside a mail-client-safe card
 * (the shared design: logo or store name, accent bar, body, footer strip with
 * the unsubscribe link). Inline styles and tables only: some mail clients and
 * senders strip `<style>` blocks.
 *
 * Variables: {{firstName}} {{orderCode}} {{businessName}} {{reviewUrl}}
 * {{ratingBlock}} {{reviewButton}} {{productList}} {{signOff}} {{unsubscribeUrl}}
 *
 * {{ratingBlock}} renders only when a live rating is available (premium),
 * otherwise it collapses to nothing.
 */

export interface Template {
    subject: string;
    body: string;
}

/** How the card looks. Every field is optional; see `resolveDesign`. */
export interface EmailDesign {
    /** Accent colour (#rrggbb) for the bar under the header and the buttons. Default #155dfc. */
    accentColor?: string;
    /** An https link to the store's logo; without it the header shows the store name in bold. */
    logoUrl?: string;
    /** Logo width in pixels (default 140). */
    logoWidth?: number;
    /** The store's own footer or legal text, shown in the footer strip. Plain text; new lines are kept. */
    footerText?: string;
}

export interface ResolvedDesign {
    accentColor: string;
    logoUrl: string;
    logoWidth: number;
    footerText: string;
}

export const DEFAULT_ACCENT = '#155dfc';

const P = 'margin:0 0 14px;font-size:14px;line-height:22px;color:#374151';
const H = 'margin:0 0 14px;font-size:22px;line-height:28px;font-weight:bold;color:#111827';
const MONO = "font-family:Consolas,Menlo,Monaco,'Courier New',monospace";

export const DEFAULT_TEMPLATE: Template = {
    subject: 'How did we do, {{firstName}}? Leave {{businessName}} a quick review',
    body: `<p style="${H}">How did we do?</p>
<p style="${P}">Hi {{firstName}},</p>
<p style="${P}">Thank you again for your recent order <strong style="color:#111827;${MONO}">{{orderCode}}</strong>. We hope everything arrived as expected and you're happy with it.</p>
<p style="margin:0 0 18px;font-size:14px;line-height:22px;color:#374151">Reviews genuinely help a business like ours, and help other shoppers buy with confidence. If you have a spare minute, we'd love to hear how we did:</p>
{{ratingBlock}}
{{reviewButton}}
{{productList}}
<p style="${P}">It only takes a moment, and it means a lot. Thank you!</p>
{{signOff}}`,
};

/** The built-in e-mail for a customer from a list (no order to mention). */
export const DEFAULT_LIST_BODY = `<p style="${H}">How did we do?</p>
<p style="${P}">Hi {{firstName}},</p>
<p style="${P}">Thank you for choosing {{businessName}}. We hope you're happy with everything.</p>
<p style="margin:0 0 18px;font-size:14px;line-height:22px;color:#374151">Reviews genuinely help a business like ours, and help other shoppers buy with confidence. If you have a spare minute, we'd love to hear how we did:</p>
{{ratingBlock}}
{{reviewButton}}
<p style="${P}">It only takes a moment, and it means a lot. Thank you!</p>
{{signOff}}`;

/** The built-in subject for a customer whose name is not known ("How did we do?" rather than "How did we do, there?"). */
export const DEFAULT_SUBJECT_NO_NAME = 'How did we do? Leave {{businessName}} a quick review';

export function renderTemplate(tpl: string, vars: Record<string, string | number | undefined>): string {
    return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => {
        const v = vars[k];
        return v === undefined || v === null ? '' : String(v);
    });
}

export function escapeHtml(s: string): string {
    // Quotes too: customer-controlled values (first name, product names) may land in an attribute of an edited template.
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** A #rgb / #rrggbb colour, else the default (nothing else may reach a style attribute). */
export function safeColour(c: string | undefined, fallback = DEFAULT_ACCENT): string {
    const v = String(c || '').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
    if (/^#[0-9a-fA-F]{3}$/.test(v)) return ('#' + v.slice(1).split('').map(x => x + x).join('')).toLowerCase();
    return fallback;
}

/** Only absolute http(s) links reach an href or src. */
export function safeUrl(u: string | undefined): string {
    const v = String(u || '').trim();
    return /^https?:\/\/[^\s"'<>]+$/i.test(v) ? v : '';
}

export function resolveDesign(d: EmailDesign | undefined): ResolvedDesign {
    const w = Math.round(Number(d?.logoWidth));
    return {
        accentColor: safeColour(d?.accentColor),
        logoUrl: safeUrl(d?.logoUrl),
        logoWidth: Number.isFinite(w) && w >= 40 && w <= 560 ? w : 140,
        footerText: String(d?.footerText || '').trim().slice(0, 2000),
    };
}

/** Primary button: accent background, white bold text. `url` must already be a safe link. */
export function reviewButtonHtml(url: string, accent: string): string {
    return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 22px"><tr><td style="border-radius:8px;background-color:${safeColour(accent)}">`
        + `<a href="${escapeHtml(url)}" style="display:inline-block;padding:13px 26px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px">&#9733; Leave a review</a>`
        + `</td></tr></table>`;
}

/** One row per product with a secondary (accent outline) "Review this" button. */
export function productListHtml(products: Array<{ name: string; url: string }>, accent: string): string {
    if (!products.length) return '';
    const a = safeColour(accent);
    const rows = products.map(p => `<tr>
<td style="padding:10px 0;border-bottom:1px solid #f3f4f6;font-size:14px;line-height:20px;color:#111827">${escapeHtml(p.name)}</td>
<td align="right" style="padding:10px 0;border-bottom:1px solid #f3f4f6"><a href="${escapeHtml(p.url)}" style="display:inline-block;padding:7px 14px;border:1px solid ${a};border-radius:8px;color:${a};font-size:13px;font-weight:bold;text-decoration:none;white-space:nowrap">Review this</a></td>
</tr>`).join('');
    return `<div style="margin:0 0 6px;font-size:12px;line-height:16px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;font-weight:bold">Tell others about what you bought</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 22px">${rows}</table>`;
}

/** The star rating in an info box. `starsHtml` is trusted markup (renderStars); the rest is escaped. */
export function ratingBlockHtml(starsHtml: string, score: string, count: number, platform: string): string {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px"><tr>
<td align="center" style="padding:14px 16px;background-color:#f9fafb;border:1px solid #e5e7eb;border-radius:8px">${starsHtml}
<div style="font-size:13px;line-height:20px;color:#6b7280;margin-top:6px">Rated <strong style="color:#111827">${escapeHtml(score)}</strong> by ${escapeHtml(Number(count || 0).toLocaleString('en-GB'))} customers on ${escapeHtml(platform)}</div></td>
</tr></table>`;
}

/** "Kind regards," then the store name, plus the support (reply-to) address if set. */
export function signOffHtml(storeName: string, supportEmail: string, accent: string): string {
    const email = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(String(supportEmail || '').trim()) ? String(supportEmail).trim() : '';
    return `<p style="margin:18px 0 0;font-size:14px;line-height:22px;color:#374151">Kind regards,<br><strong style="color:#111827">${escapeHtml(storeName)}</strong>`
        + (email ? `<br><a href="mailto:${escapeHtml(email)}" style="color:${safeColour(accent)};text-decoration:none">${escapeHtml(email)}</a>` : '')
        + `</p>`;
}

/**
 * Wrap the rendered body in the card. The body is the merchant's (saved or
 * built-in) HTML and is inserted as it is; everything else is escaped here.
 */
export function wrapEmail(bodyHtml: string, businessName: string, unsubscribeUrl: string, design?: EmailDesign): string {
    const d = resolveDesign(design);
    const name = escapeHtml(businessName || 'us');
    const header = d.logoUrl
        ? `<img src="${escapeHtml(d.logoUrl)}" alt="${escapeHtml(businessName || '')}" width="${d.logoWidth}" style="display:block;border:0;outline:none;height:auto;width:${d.logoWidth}px;max-width:100%">`
        : `<span style="font-size:20px;line-height:26px;font-weight:bold;color:#111827">${name}</span>`;
    const unsub = safeUrl(unsubscribeUrl) || (unsubscribeUrl === '#' ? '#' : '');
    const footer = [
        `You're receiving this because you recently ordered from ${name}.`
            + (unsub ? ` Prefer not to get review requests? <a href="${escapeHtml(unsub)}" style="color:#6b7280;text-decoration:underline">Unsubscribe</a>.` : ''),
        d.footerText ? escapeHtml(d.footerText).replace(/\r?\n/g, '<br>') : '',
    ].filter(Boolean).map(t => `<p style="margin:0 0 6px;font-size:11px;line-height:17px;color:#6b7280">${t}</p>`).join('');
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"></head>
<body style="margin:0;padding:0;background-color:#f3f4f6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;font-family:Arial,Helvetica,sans-serif"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:10px;border-collapse:separate">
<tr><td style="padding:22px 28px;border-bottom:3px solid ${d.accentColor}">${header}</td></tr>
<tr><td style="padding:28px 28px 24px 28px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#374151">
${bodyHtml}
</td></tr>
<tr><td style="padding:16px 28px 12px 28px;background-color:#f9fafb;border-top:1px solid #e5e7eb;border-radius:0 0 10px 10px">${footer}</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

/** The unsubscribe confirmation pages: the same card on a grey page. `bodyHtml` is trusted markup; the title is escaped. */
export function publicPageHtml(title: string, bodyHtml: string, design?: EmailDesign): string {
    const d = resolveDesign(design);
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:520px;margin:48px auto;padding:0 16px">
<div style="background-color:#ffffff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden">
<div style="height:3px;background-color:${d.accentColor}"></div>
<div style="padding:28px">
<h1 style="margin:0 0 12px;font-size:22px;line-height:28px;font-weight:bold;color:#111827">${escapeHtml(title)}</h1>
<div style="font-size:14px;line-height:22px;color:#374151">${bodyHtml}</div>
</div></div></div>
</body></html>`;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ', '#9733': '★', hellip: '…', mdash: '—', ndash: '–' };

/**
 * A readable plain-text alternative of an HTML e-mail: links become
 * "text (url)", block ends become line breaks, tags go, entities decode.
 */
export function htmlToText(html: string): string {
    let s = String(html || '');
    s = s.replace(/<head[\s\S]*?<\/head>/gi, '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
    s = s.replace(/<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_m, _q, href, inner) => {
        const text = inner.replace(/<[^>]+>/g, '').trim();
        const url = href.replace(/&amp;/g, '&');
        if (!/^(https?:|mailto:)/i.test(url)) return text;
        const shown = url.replace(/^mailto:/i, '');
        return text && text !== shown ? `${text} (${shown})` : shown;
    });
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/(p|div|h[1-6]|tr|table|li)>/gi, '\n');
    s = s.replace(/<\/td>/gi, '  ');
    s = s.replace(/<[^>]+>/g, '');
    s = s.replace(/&(#?\w+);/g, (m, e) => {
        if (ENTITIES[e] !== undefined) return ENTITIES[e];
        if (/^#\d+$/.test(e)) return String.fromCodePoint(Number(e.slice(1)));
        return m;
    });
    return s.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
