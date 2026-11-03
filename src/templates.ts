/**
 * Default review-invitation email. Editable per channel in the admin.
 * Variables: {{firstName}} {{orderCode}} {{businessName}} {{reviewUrl}}
 * {{ratingBlock}} {{unsubscribeUrl}}
 *
 * The template is HTML so the Trustpilot-style stars + button render as an
 * inviting email; {{ratingBlock}} is injected only when a live rating is
 * available (free API), otherwise it collapses to nothing.
 */

export interface Template {
    subject: string;
    body: string;
}

export const DEFAULT_TEMPLATE: Template = {
    subject: 'How did we do, {{firstName}}? Leave {{businessName}} a quick review',
    body: `<p style="margin:0 0 14px;line-height:1.6">Hi {{firstName}},</p>
<p style="margin:0 0 14px;line-height:1.6">Thanks again for your recent order <strong>{{orderCode}}</strong>. We hope everything arrived perfectly and you're happy with it.</p>
<p style="margin:0 0 18px;line-height:1.6">Reviews genuinely help a small business like ours — and help other shoppers buy with confidence. If you have a spare minute, we'd love to hear how we did:</p>
{{ratingBlock}}
{{reviewButton}}
{{productList}}
<p style="margin:0 0 14px;line-height:1.6">It only takes a moment, and it means a lot. Thank you!</p>
<p style="margin:0;line-height:1.6">— The {{businessName}} team</p>`,
};

export function renderTemplate(tpl: string, vars: Record<string, string | number | undefined>): string {
    return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => {
        const v = vars[k];
        return v === undefined || v === null ? '' : String(v);
    });
}

/** Wrap the rendered body in a minimal, email-client-safe shell with a footer. */
export function wrapEmail(bodyHtml: string, businessName: string, unsubscribeUrl: string): string {
    return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#0f172a;background:#ffffff">
  ${bodyHtml}
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:26px 0 14px">
  <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.6">
    You're receiving this because you recently ordered from ${escapeHtml(businessName || 'us')}.
    ${unsubscribeUrl ? `Prefer not to get review requests? <a href="${unsubscribeUrl}" style="color:#94a3b8">Unsubscribe</a>.` : ''}
  </p>
</div>`;
}

export function escapeHtml(s: string): string {
    // Quotes too: customer-controlled values (first name, product names) may land in an attribute of an edited template.
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
