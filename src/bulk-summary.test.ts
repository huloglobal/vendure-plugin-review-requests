import { describe, expect, it } from 'vitest';
import { bulkSummary, PREMIUM_FEATURES, SEND_BATCH } from './review-request.service';
import { DEFAULT_LIST_BODY, DEFAULT_TEMPLATE } from './templates';

describe('bulkSummary', () => {
    it('sums up sent, skipped (with the top reasons) and the background rest', () => {
        expect(bulkSummary({ sent: 20, skipped: 2, queued: 5, reasons: { 'cooldown': 2 } }))
            .toBe(`20 invitations sent, 2 skipped. 2 × cooldown 5 more go out in the background, ${SEND_BATCH} at a time, within your hourly limit.`);
        expect(bulkSummary({ sent: 1, skipped: 0, queued: 1, reasons: {} })).toContain('1 more goes out');
    });
    it('says why nothing was sent when the review page is not set', () => {
        expect(bulkSummary({ sent: 0, skipped: 3, queued: 0, reasons: {}, blocked: 'Set your review page on the Settings tab first. Nothing was sent.' }))
            .toContain('Set your review page');
    });
});

describe('tiers and templates (0.17.0)', () => {
    it('PREMIUM_FEATURES no longer lists manual sends or exclusions, and lists the weekly report', () => {
        const all = PREMIUM_FEATURES.join(' | ');
        expect(all).not.toMatch(/Send-now for any order|Exclusions and opt-out/);
        expect(all).toContain('Weekly e-mail report and set-up checklist');
        expect(all).toContain('star-rating box');
        expect(all).toContain('Resend');
    });
    it('the built-in list e-mail mentions no order', () => {
        expect(DEFAULT_TEMPLATE.body).toContain('{{orderCode}}');
        expect(DEFAULT_LIST_BODY).not.toContain('{{orderCode}}');
        expect(DEFAULT_LIST_BODY).toContain('{{reviewButton}}');
    });
});
