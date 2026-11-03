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
