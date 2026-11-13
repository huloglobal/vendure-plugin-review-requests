import { describe, expect, it } from 'vitest';
import {
    cleanUrlTemplate, currentTemplate, needsIdentifier, parseIdentifier, platformOfTemplate, PLATFORM_TEMPLATES,
    reviewPageProblem, validateReviewPage,
} from './review-page';
import { buildReviewUrl } from './trustpilot';

describe('parseIdentifier (cases from the WordPress edition)', () => {
    const cases: Array<[any, string, string | null]> = [
        ['trustpilot', 'https://www.trustpilot.com/review/harbourbakery.co.uk', 'harbourbakery.co.uk'],
        ['trustpilot', 'uk.trustpilot.com/evaluate/www.harbourbakery.co.uk?utm_medium=x', 'www.harbourbakery.co.uk'],
        ['trustpilot', 'https://www.HarbourBakery.co.uk/shop/', 'www.harbourbakery.co.uk'],
        ['trustpilot', 'https://www.trustpilot.com/', null],
        ['trustpilot', 'harbour bakery', null],
        ['google', 'https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4', 'ChIJN1t_tDeuEmsRUsoyG83frY4'],
        ['google', 'place_id:ChIJN1t_tDeuEmsRUsoyG83frY4', 'ChIJN1t_tDeuEmsRUsoyG83frY4'],
        ['google', 'ChIJN1t_tDeuEmsRUsoyG83frY4', 'ChIJN1t_tDeuEmsRUsoyG83frY4'],
        ['google', 'https://g.page/r/CabcdEFGH/review', null],
        ['google', 'harbourbakery.co.uk', null],
        ['reviewsio', 'https://www.reviews.io/company-reviews/store/harbour-bakery', 'harbour-bakery'],
        ['reviewsio', 'https://www.example.com/reviews', null],
        ['reviewsio', 'harbour-bakery', 'harbour-bakery'],
        ['reviewsio', 'harbour bakery!', null],
    ];
    it.each(cases)('%s %s', (platform, typed, want) => {
        const r = parseIdentifier(platform, typed);
        if (want === null) { expect(r.value).toBe(''); expect(r.error).not.toBe(''); }
        else expect(r).toEqual({ value: want, error: '' });
    });
    it('a Google review link points to "Custom link"', () => {
        expect(parseIdentifier('google', 'https://g.page/r/CabcdEFGH/review').error).toContain('Custom link');
    });
});

describe('review page', () => {
    it('a pasted Trustpilot page makes the right review link (not one for trustpilot.com itself)', () => {
        const v = validateReviewPage({ reviewUrlTemplate: PLATFORM_TEMPLATES.trustpilot, trustpilotDomain: 'https://www.trustpilot.com/review/harbourbakery.co.uk' }, '');
        expect(v.errors).toEqual([]);
        expect(buildReviewUrl(v.reviewUrlTemplate, v.trustpilotDomain)).toBe('https://www.trustpilot.com/evaluate/harbourbakery.co.uk');
        expect(buildReviewUrl(PLATFORM_TEMPLATES.trustpilot, 'https://uk.trustpilot.com/review/shop.example')).toBe('https://www.trustpilot.com/evaluate/shop.example');
    });
    it('Reviews.io uses company-reviews/store/{id}, and the old saved format is upgraded', () => {
        expect(PLATFORM_TEMPLATES.reviewsio).toBe('https://www.reviews.io/company-reviews/store/{domain}');
        expect(currentTemplate('https://www.reviews.io/company-review/store/{domain}/new')).toBe(PLATFORM_TEMPLATES.reviewsio);
        const v = validateReviewPage({ reviewUrlTemplate: 'https://www.reviews.io/company-review/store/{domain}/new', trustpilotDomain: 'https://www.reviews.io/company-reviews/store/harbour-bakery' }, '');
        expect(v).toEqual({ reviewUrlTemplate: PLATFORM_TEMPLATES.reviewsio, trustpilotDomain: 'harbour-bakery', errors: [] });
        expect(buildReviewUrl(v.reviewUrlTemplate, v.trustpilotDomain)).toBe('https://www.reviews.io/company-reviews/store/harbour-bakery');
    });
    it('an identifier the platform cannot use is not kept, so the page reads "not set"', () => {
        const v = validateReviewPage({ reviewUrlTemplate: PLATFORM_TEMPLATES.google, trustpilotDomain: 'https://g.page/r/CabcdEFGH/review' }, '');
        expect(v.trustpilotDomain).toBe('');
        expect(v.errors[0]).toContain('Custom link');
        expect(needsIdentifier(v)).toBe(true);
    });
    it('custom link must be http(s); a bad one keeps the previous link and says why', () => {
        const v = validateReviewPage({ reviewUrlTemplate: 'javascript:alert(1)', trustpilotDomain: '' }, 'https://g.page/r/abc/review');
        expect(v.reviewUrlTemplate).toBe('https://g.page/r/abc/review');
        expect(v.errors.join(' ')).toContain('is not a link');
        expect(cleanUrlTemplate('https://x.test/{domain}')).toBe('https://x.test/{domain}');
        expect(cleanUrlTemplate('ftp://x')).toBe('');
    });
    it('a custom link with {domain} needs the identifier', () => {
        const v = validateReviewPage({ reviewUrlTemplate: 'https://reviews.example/{domain}', trustpilotDomain: '' }, '');
        expect(v.errors.join(' ')).toContain('{domain}');
        expect(needsIdentifier(v)).toBe(true);
        expect(needsIdentifier({ reviewUrlTemplate: 'https://g.page/r/abc/review', trustpilotDomain: '' })).toBe(false);
    });
    it('reviewPageProblem: empty identifier or link → refuse to send', () => {
        expect(reviewPageProblem({ reviewUrlTemplate: PLATFORM_TEMPLATES.trustpilot, trustpilotDomain: '' })).toContain('Set your review page');
        expect(reviewPageProblem({ reviewUrlTemplate: '', trustpilotDomain: 'x.com' })).toContain('Set your review page');
        expect(reviewPageProblem({ reviewUrlTemplate: PLATFORM_TEMPLATES.trustpilot, trustpilotDomain: 'x.com' })).toBe('');
    });
    it('platformOfTemplate', () => {
        expect(platformOfTemplate(PLATFORM_TEMPLATES.trustpilot)).toBe('trustpilot');
        expect(platformOfTemplate(PLATFORM_TEMPLATES.google)).toBe('google');
        expect(platformOfTemplate(PLATFORM_TEMPLATES.reviewsio)).toBe('reviewsio');
        expect(platformOfTemplate('https://g.page/r/abc/review')).toBe('custom');
    });
});
