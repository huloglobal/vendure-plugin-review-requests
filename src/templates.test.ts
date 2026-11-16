import { describe, expect, it } from 'vitest';
import { escapeHtml, renderTemplate } from './templates';

describe('escapeHtml', () => {
    it('escapes quotes so a customer name cannot break out of an attribute in an edited template', () => {
        // A guest can check out under any name; merchants put {{firstName}} wherever they like.
        const tpl = '<a href="https://shop.test" title="For {{firstName}}">Shop</a>';
        const name = 'x" href="https://evil.test" data-x="';
        const html = renderTemplate(tpl, { firstName: escapeHtml(name) });
        expect(html).not.toContain('href="https://evil.test"');
        expect(html).toBe('<a href="https://shop.test" title="For x&quot; href=&quot;https://evil.test&quot; data-x=&quot;">Shop</a>');
        expect(escapeHtml(`O'Brien <b>&`)).toBe('O&#39;Brien &lt;b&gt;&amp;');
    });
});

import {
    DEFAULT_TEMPLATE, DEFAULT_LIST_BODY, wrapEmail, htmlToText, safeColour, resolveDesign, reviewButtonHtml,
    productListHtml, signOffHtml, publicPageHtml, ratingBlockHtml,
} from './templates';
import { pickProductTranslations } from './review-request.service';

describe('invitation e-mail design (0.18.0)', () => {
    it('wraps the body in the 600px card with the accent bar, store name header and footer strip', () => {
        const html = wrapEmail('<p>Body</p>', 'Acme & Co', 'https://shop.test/review-requests/optout?e=a%40b.co&t=abc');
        expect(html).toContain('max-width:600px');
        expect(html).toContain('background-color:#f3f4f6');
        expect(html).toContain('border:1px solid #e5e7eb;border-radius:10px');
        expect(html).toContain('border-bottom:3px solid #155dfc');
        expect(html).toContain('font-weight:bold;color:#111827">Acme &amp; Co</span>');
        expect(html).toContain('href="https://shop.test/review-requests/optout?e=a%40b.co&amp;t=abc"');
        expect(html).toContain('font-size:11px');
        expect(html).not.toMatch(/<style/i);
    });

    it('uses the configured accent, logo (explicit width) and escaped footer text', () => {
        const html = wrapEmail('<p>x</p>', 'Shop', '#', { accentColor: '#AA00cc', logoUrl: 'https://cdn.test/logo.png', logoWidth: 180, footerText: 'Shop Ltd <b>\nReg 123' });
        expect(html).toContain('border-bottom:3px solid #aa00cc');
        expect(html).toContain('<img src="https://cdn.test/logo.png" alt="Shop" width="180"');
        expect(html).toContain('Shop Ltd &lt;b&gt;<br>Reg 123');
    });

    it('never lets an option inject markup or styles', () => {
        expect(safeColour('red;background:url(x)')).toBe('#155dfc');
        expect(safeColour('#abc')).toBe('#aabbcc');
        expect(resolveDesign({ logoUrl: 'javascript:alert(1)' }).logoUrl).toBe('');
        expect(resolveDesign({ logoUrl: 'https://x.test/a" onerror="x' }).logoUrl).toBe('');
        expect(resolveDesign({ logoWidth: 9999 }).logoWidth).toBe(140);
    });

    it('renders a saved custom template unchanged inside the new card', () => {
        const saved = '<div style="color:red">Hello {{firstName}} from {{businessName}} {{reviewButton}}</div>';
        const body = saved.replace('{{firstName}}', 'Sam').replace('{{businessName}}', 'Shop').replace('{{reviewButton}}', reviewButtonHtml('https://r.test/x?a=1&b=2', '#155dfc'));
        const html = wrapEmail(body, 'Shop', '#');
        expect(html).toContain('<div style="color:red">Hello Sam from Shop');
        expect(html).toContain('href="https://r.test/x?a=1&amp;b=2"');
        expect(html).toContain('background-color:#155dfc');
    });

    it('the built-in templates use the shared heading/body styles and the sign-off variable', () => {
        for (const b of [DEFAULT_TEMPLATE.body, DEFAULT_LIST_BODY]) {
            expect(b).toContain('font-size:22px');
            expect(b).toContain('color:#374151');
            expect(b).toContain('{{signOff}}');
            expect(b).toContain('{{reviewButton}}');
        }
        expect(DEFAULT_LIST_BODY).not.toContain('{{orderCode}}');
    });

    it('signs off with Kind regards, the store name and the support address when valid', () => {
        expect(signOffHtml('Shop <x>', 'help@shop.test', '#155dfc')).toContain('Kind regards,<br><strong style="color:#111827">Shop &lt;x&gt;</strong><br><a href="mailto:help@shop.test"');
        expect(signOffHtml('Shop', 'not an email', '#155dfc')).not.toContain('mailto:');
    });

    it('product rows use the secondary (outline) button and escape names', () => {
        const h = productListHtml([{ name: 'Mug <3', url: 'https://s.test/p/mug' }], '#112233');
        expect(h).toContain('Mug &lt;3');
        expect(h).toContain('border:1px solid #112233');
        expect(h).toContain('text-transform:uppercase');
    });

    it('the rating box is an info box', () => {
        expect(ratingBlockHtml('<span>★</span>', '4.5', 1234, 'Trustpilot')).toContain('background-color:#f9fafb;border:1px solid #e5e7eb;border-radius:8px');
    });

    it('builds a readable plain-text alternative', () => {
        const html = wrapEmail('<p>Hi Sam,</p>' + reviewButtonHtml('https://r.test/x?a=1&b=2', '#155dfc') + signOffHtml('Shop', 'help@shop.test', '#155dfc'), 'Shop', 'https://s.test/u');
        const text = htmlToText(html);
        expect(text).toContain('Hi Sam,');
        expect(text).toContain('★ Leave a review (https://r.test/x?a=1&b=2)');
        expect(text).toContain('Kind regards,\nShop\nhelp@shop.test');
        expect(text).toContain('Unsubscribe (https://s.test/u)');
        expect(text).not.toMatch(/<[a-z]/i);
    });

    it('the unsubscribe page uses the card and escapes the title', () => {
        const page = publicPageHtml('<Bye>', '<p>ok</p>', { accentColor: '#00ff00' });
        expect(page).toContain('&lt;Bye&gt;');
        expect(page).toContain('background-color:#00ff00');
        expect(page).toContain('noindex');
    });
});

describe('pickProductTranslations', () => {
    it('prefers the channel language, then English, then any; one per product', () => {
        const rows = [
            { productId: 1, languageCode: 'en', name: 'Mug', slug: 'mug' },
            { productId: 1, languageCode: 'de', name: 'Tasse', slug: 'tasse' },
            { productId: 2, languageCode: 'fr', name: 'Bol', slug: 'bol' },
            { productId: 3, languageCode: 'en', name: 'Cup', slug: 'cup' },
        ];
        expect(pickProductTranslations(rows, 'de')).toEqual([{ name: 'Tasse', slug: 'tasse' }, { name: 'Bol', slug: 'bol' }, { name: 'Cup', slug: 'cup' }]);
        expect(pickProductTranslations(rows, '')).toEqual([{ name: 'Mug', slug: 'mug' }, { name: 'Bol', slug: 'bol' }, { name: 'Cup', slug: 'cup' }]);
    });
});
