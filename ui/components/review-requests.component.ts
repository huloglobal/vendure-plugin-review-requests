import { Component, OnInit, ChangeDetectorRef, ViewChild, ElementRef } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { NotificationService, ModalService, AssetPickerDialogComponent } from '@vendure/admin-ui/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

interface ReviewConfig {
    channelId: number; channelCode?: string; enabled: boolean;
    triggerState: 'Delivered' | 'PaymentSettled' | 'Shipped';
    delayDays: number; minOrderValuePence: number; cooldownDays: number;
    trustpilotDomain: string; reviewUrlTemplate: string;
    trustpilotApiKey: string; trustpilotBusinessUnitId: string;
    businessName: string; replyTo: string; maxPerRun: number;
    reviewMode: 'service' | 'product' | 'both'; productReviewUrlTemplate: string;
}
type Tab = 'overview' | 'settings' | 'email' | 'exclusions' | 'activity';

@Component({
    selector: 'ees-review-requests',
    standalone: false,
    template: `
        <vdr-page-block>
            <div class="hulo-hero">
                <div class="hulo-hero-logo" aria-hidden="true">
                    <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
                        <rect width="64" height="64" rx="14" fill="#0f1419"/>
                        <rect x="13" y="20" width="38" height="26" rx="4" fill="none" stroke="#fff" stroke-width="2.4"/>
                        <path d="M14 22 L32 35 L50 22" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
                        <circle cx="46" cy="44" r="11" fill="#0f1419"/>
                        <path d="M46 35.5 l2.5 5.1 5.6 .8 -4.05 3.95 .95 5.55 -5.0 -2.63 -5.0 2.63 .95 -5.55 -4.05 -3.95 5.6 -.8 z" fill="#f59e0b"/>
                    </svg>
                </div>
                <div class="hulo-hero-text">
                    <h2 class="hulo-hero-title">Review requests</h2>
                    <p class="hulo-hero-sub">Automatically invite happy customers to review you on Trustpilot — timed off their order date, in your voice, using the free Trustpilot review page. No paid Automatic Feedback Service needed.</p>
                </div>
                <div class="hulo-hero-actions">
                    <button class="gbtn gbtn-hero" (click)="reloadAll()" [disabled]="loading"><clr-icon shape="refresh"></clr-icon> Refresh</button>
                </div>
            </div>
        </vdr-page-block>

        <vdr-page-block *ngIf="meta?.update?.updateAvailable && !updateDismissed">
            <div class="update-banner">
                <div>
                    <strong>⬆️ Update available</strong> —
                    <!--email_off-->v{{ meta.update.current }} → <strong>v{{ meta.update.latest }}</strong><!--/email_off-->.
                    Run <code class="upd-cmd">npm install &#64;huloglobal/vendure-plugin-review-requests&#64;{{ meta.update.latest }}</code> and restart.
                </div>
                <div class="actions">
                    <button class="gbtn gbtn-primary gbtn-sm" *ngIf="meta?.selfUpdate?.allowed" (click)="runSelfUpdate()" [disabled]="updating">{{ updating ? updateProgress : 'Update now' }}</button>
                    <button class="gbtn gbtn-outline gbtn-sm" (click)="copyUpdateCmd()">{{ cmdCopied ? 'Copied ✓' : 'Copy command' }}</button>
                    <a href="https://huloglobal.com/vendure-plugins/review-requests/changelog/" target="_blank" class="gbtn gbtn-outline gbtn-sm">What&rsquo;s new ↗</a>
                    <button class="gbtn gbtn-outline gbtn-sm" (click)="updateDismissed = true">Dismiss</button>
                </div>
            </div>
        </vdr-page-block>

        <vdr-page-block *ngIf="meta && meta.licensed">
            <div class="notice-strip" *ngIf="meta.notice?.message">{{ meta.notice.message }}</div>
            <div class="update-banner" style="margin-top:8px">
                <div><strong>✅ Licensed</strong> — {{ licenceLabel() }}</div>
                <div class="actions eval-actions">
                    <ng-container *ngIf="meta.licence && !meta.licence.master && meta.licence.plan !== 'lifetime'">
                        <button class="gbtn gbtn-outline gbtn-sm" (click)="openPortal()" [disabled]="portalOpening">{{ portalOpening ? 'Opening…' : 'Manage billing ↗' }}</button>
                        <button class="gbtn gbtn-primary gbtn-sm" (click)="buyLifetime()" [disabled]="buying">{{ buying ? 'Opening checkout…' : 'Upgrade to lifetime →' }}</button>
                    </ng-container>
                    <span *ngIf="claim?.state === 'pending'" style="font-size:12.5px;font-weight:600">⏳ Waiting for checkout to finish — the licence installs itself. <a (click)="checkClaim(true)" style="cursor:pointer;text-decoration:underline">Check now</a></span>
                    <a href="https://huloglobal.com/vendure-plugins/review-requests/" target="_blank" class="gbtn gbtn-outline gbtn-sm">Details ↗</a>
                </div>
            </div>
        </vdr-page-block>
        <vdr-page-block *ngIf="meta && !meta.licensed">
            <div class="notice-strip" *ngIf="meta.notice?.message">{{ meta.notice.message }}</div>
            <div class="update-banner major" *ngIf="meta.tier === 'trial'">
                <div>
                    <strong>⏳ Full-featured evaluation</strong> —
                    <ng-container *ngIf="meta.eval?.daysRemaining != null; else evalNoClock">
                        <strong>{{ meta.eval.daysRemaining }} day{{ meta.eval.daysRemaining === 1 ? '' : 's' }} left</strong> with everything enabled, scheduled sending included.
                    </ng-container>
                    <ng-template #evalNoClock>everything is enabled, scheduled sending included.</ng-template>
                    Afterwards the plugin drops to the free tier (configure, preview + test-send).
                    <div class="banner-extra" *ngIf="meta.premiumFeatures?.length">Included now: {{ meta.premiumFeatures.join(' · ') }}</div>
                    <div class="banner-extra" *ngIf="meta.recentStats?.length"><strong>So far:</strong> {{ statsLine() }}</div>
                </div>
                <div class="actions eval-actions">
                    <ng-container *ngIf="!remindMeSent">
                        <input class="eval-email" type="email" placeholder="you@company.com" [(ngModel)]="remindEmail" [disabled]="remindMeSending">
                        <button class="gbtn gbtn-outline gbtn-sm" (click)="sendRemindMe()" [disabled]="remindMeSending || !remindEmail">{{ remindMeSending ? 'Saving…' : 'Email me before it ends' }}</button>
                    </ng-container>
                    <span *ngIf="remindMeSent" class="eval-ok">✓ We'll email you before it ends</span>
                    <select [(ngModel)]="buyPlan" [disabled]="buying" style="padding:5px 9px;border:1px solid #d1d5db;border-radius:7px;font-size:12.5px;background:#fff;color:inherit"><option value="monthly">Monthly</option><option value="annual">Annual · 2 months free</option><option value="lifetime">Lifetime · one-off</option></select>
                    <button class="gbtn gbtn-primary gbtn-sm" (click)="buyLicence()" [disabled]="buying">{{ buying ? 'Opening checkout…' : (buyPlan === 'lifetime' ? 'Buy lifetime →' : (meta?.tier === 'trial' ? 'Subscribe — first charge when the evaluation ends →' : 'Subscribe →')) }}</button>
                    <span *ngIf="claim?.state === 'pending'" style="font-size:12.5px;font-weight:600">⏳ Waiting for checkout to finish — the licence installs itself. <a (click)="checkClaim(true)" style="cursor:pointer;text-decoration:underline">Check now</a></span>
                    <a href="https://huloglobal.com/vendure-plugins/review-requests/" target="_blank" class="gbtn gbtn-outline gbtn-sm">Details ↗</a>
                </div>
            </div>
            <div class="update-banner major" *ngIf="meta.tier !== 'trial'">
                <div><strong>🔓 Free tier</strong> — premium features need a licence. Subscribe below (monthly or annual, cancel any time) or buy a lifetime licence. Configure, preview and test-send stay active; scheduled sending needs a licence. Your setup is saved and reactivates instantly with a key.
                    <div class="banner-extra" *ngIf="meta.premiumFeatures?.length">With a licence: {{ meta.premiumFeatures.join(' · ') }}</div>
                    <div class="banner-extra" *ngIf="meta.recentStats?.length"><strong>{{ meta.eval?.source === 'server' ? 'During your evaluation:' : 'So far:' }}</strong> {{ statsLine() }}</div>
                </div>
                <div class="actions"><select [(ngModel)]="buyPlan" [disabled]="buying" style="padding:5px 9px;border:1px solid #d1d5db;border-radius:7px;font-size:12.5px;background:#fff;color:inherit"><option value="monthly">Monthly</option><option value="annual">Annual (2 months free)</option><option value="lifetime">Lifetime</option></select>
                    <button class="gbtn gbtn-primary gbtn-sm" (click)="buyLicence()" [disabled]="buying">{{ buying ? 'Opening checkout…' : 'Buy licence →' }}</button>
                    <span *ngIf="claim?.state === 'pending'" style="font-size:12.5px;font-weight:600">⏳ Waiting for checkout to finish — the licence installs itself. <a (click)="checkClaim(true)" style="cursor:pointer;text-decoration:underline">Check now</a></span>
                    <a href="https://huloglobal.com/vendure-plugins/review-requests/" target="_blank" class="gbtn gbtn-outline gbtn-sm">Details ↗</a></div>
            </div>
            <div class="update-banner" style="margin-top:8px">
                <div><strong>🔑 Already have a licence key?</strong> Paste it from your purchase email to activate instantly — no .env edit, no redeploy.</div>
                <div class="actions eval-actions">
                    <input class="eval-email" style="min-width:280px" type="text" placeholder="eyJhbGciOi…" [(ngModel)]="licenceKeyInput" [disabled]="activating">
                    <button class="gbtn gbtn-primary gbtn-sm" (click)="activateLicence()" [disabled]="activating || !licenceKeyInput">{{ activating ? 'Verifying…' : 'Activate' }}</button>
                </div>
            </div>
        </vdr-page-block>

        <vdr-page-block *ngIf="!loading && current">
            <div class="card top-bar">
                <div class="card-block">
                    <div class="chan-row">
                        <label class="lbl">Channel</label>
                        <select class="form-select" [(ngModel)]="currentIdx" (ngModelChange)="onChannel()">
                            <option *ngFor="let c of configs; let i = index" [ngValue]="i">{{ c.channelCode }}</option>
                        </select>
                        <span class="gb-switch-group">
                            <button class="gb-switch" role="switch" [attr.aria-checked]="current.enabled" [class.on]="current.enabled" (click)="current.enabled = !current.enabled; markDirty()" aria-label="Enable review requests"><span class="gb-switch-knob" aria-hidden="true"></span></button>
                            <span class="gb-switch-label">{{ current.enabled ? 'Sending on' : 'Sending off' }}</span>
                        </span>
                        <span class="dirty-flag" *ngIf="dirty">● Unsaved</span>
                    </div>
                    <p class="status-sentence" [class.status-off]="!current.enabled">{{ statusSentence() }}</p>
                    <div class="tabs" role="tablist">
                        <button class="tab" role="tab" [class.active]="tab==='overview'" (click)="go('overview')">Overview</button>
                        <button class="tab" role="tab" [class.active]="tab==='settings'" (click)="go('settings')">Settings</button>
                        <button class="tab" role="tab" [class.active]="tab==='email'" (click)="go('email')">Email</button>
                        <button class="tab" role="tab" [class.active]="tab==='exclusions'" (click)="go('exclusions')">Exclusions<span class="tab-count" *ngIf="exclusions.length">{{ exclusions.length }}</span></button>
                        <button class="tab" role="tab" [class.active]="tab==='activity'" (click)="go('activity')">Activity</button>
                    </div>
                </div>
            </div>
        </vdr-page-block>

        <!-- OVERVIEW -->
        <ng-container *ngIf="!loading && current && tab==='overview'">
            <vdr-page-block *ngIf="showSetup()">
                <div class="card setup-card"><div class="card-block">
                    <div class="row-between">
                        <h3 class="step-title" style="margin:0">Set-up checklist <small>{{ setupDone() }} of {{ setup.items.length }} done</small></h3>
                        <a class="hint-link" (click)="hideSetup()">Hide</a>
                    </div>
                    <div class="setup-row" *ngFor="let i of setup.items">
                        <span class="dot" [class.on]="i.done" aria-hidden="true"></span>
                        <div class="setup-text"><strong>{{ i.label }}</strong><div class="hint" style="margin:0">{{ i.hint }}</div></div>
                        <button class="gbtn gbtn-outline gbtn-sm" *ngIf="!i.done && i.tab && i.tab !== tab" (click)="go($any(i.tab))">Open {{ i.tab }}</button>
                        <a class="gbtn gbtn-outline gbtn-sm" *ngIf="!i.done && !i.tab && i.url" [href]="i.url" target="_blank" rel="noopener">Docs ↗</a>
                    </div>
                </div></div>
            </vdr-page-block>
            <vdr-page-block>
                <div class="kpi-row">
                    <div class="kpi"><div class="kpi-label">Sent</div><div class="kpi-num">{{ stats?.totals?.sent || 0 }}</div><div class="kpi-sub">last 30 days</div></div>
                    <div class="kpi"><div class="kpi-label">Clicked</div><div class="kpi-num">{{ stats?.totals?.clicked || 0 }}<span class="kpi-pct" *ngIf="clickRate() !== null"> · {{ clickRate() }}%</span></div><div class="kpi-sub">review link opened · last 30 days</div></div>
                    <div class="kpi" [class.kpi-alert]="pendingTotal()>0"><div class="kpi-label">Eligible now</div><div class="kpi-num">{{ pendingTotal() }}</div><div class="kpi-sub">will send on next run</div></div>
                    <div class="kpi"><div class="kpi-label">Opt-outs</div><div class="kpi-num">{{ stats?.optOuts || 0 }}</div><div class="kpi-sub">all time</div></div>
                    <div class="kpi" [class.kpi-alert]="stats?.totals?.failed>0"><div class="kpi-label">Failed</div><div class="kpi-num">{{ stats?.totals?.failed || 0 }}</div><div class="kpi-sub">last 30 days</div></div>
                </div>
            </vdr-page-block>
            <vdr-page-block>
                <div class="card"><div class="card-block">
                    <div class="row-between"><h3 class="step-title" style="margin:0">Your review rating</h3>
                        <button class="gbtn gbtn-outline gbtn-sm" (click)="runNow()" [disabled]="running || (meta && meta.tier === 'free')">{{ running ? 'Sending…' : 'Send due now' }}</button></div>
                    <div *ngIf="rating" class="rating-box">
                        <div class="stars"><span class="star" *ngFor="let s of [1,2,3,4,5]" [class.on]="s <= (rating.stars||0)">★</span></div>
                        <div class="hint">TrustScore <strong>{{ rating.trustScore | number:'1.1-1' }}</strong> · {{ rating.numberOfReviews | number }} reviews</div>
                    </div>
                    <p class="hint" *ngIf="!rating">Connect Trustpilot or Google in Settings to show your live star rating in emails (optional — emails work without it).</p>
                </div></div>
            </vdr-page-block>
            <vdr-page-block>
                <div class="card"><div class="card-block">
                    <h3 class="step-title">Recent invitations</h3>
                    <table class="table" *ngIf="logRows.length; else noLog">
                        <thead><tr><th>When</th><th>Order</th><th>Customer</th><th>Status</th></tr></thead>
                        <tbody><tr *ngFor="let r of logRows.slice(0,10)">
                            <td class="hint">{{ r.createdAt | date:'d MMM HH:mm' }}</td>
                            <td><strong>{{ r.orderCode }}</strong></td><td>{{ r.email }}</td>
                            <td><span class="pill" [ngClass]="'st-'+r.status">{{ r.status }}<span *ngIf="r.reason"> · {{ r.reason }}</span></span></td>
                        </tr></tbody>
                    </table>
                    <ng-template #noLog><p class="hint">No invitations sent yet.</p></ng-template>
                </div></div>
            </vdr-page-block>
        </ng-container>

        <!-- SETTINGS -->
        <ng-container *ngIf="!loading && current && tab==='settings'">
            <vdr-page-block><div class="card"><div class="card-block">
                <h3 class="step-title">Where should reviews go?</h3>
                <p class="hint">Pick a platform and we build the review link. Trustpilot can also show your live star rating in the email (free API key). Google &amp; Reviews.io use the link only.</p>
                <div class="form-grid">
                    <div class="form-row"><label>Review platform</label>
                        <select class="form-input" [(ngModel)]="platform" (ngModelChange)="onPlatform()">
                            <option value="trustpilot">Trustpilot (recommended)</option>
                            <option value="google">Google reviews</option>
                            <option value="reviewsio">Reviews.io</option>
                            <option value="custom">Custom link</option>
                        </select></div>
                    <div class="form-row"><label>{{ platformLabel() }}</label>
                        <input class="form-input" [(ngModel)]="current.trustpilotDomain" (ngModelChange)="markDirty()" [placeholder]="platformPlaceholder()">
                        <div class="hint" style="margin-top:4px">{{ platformHelp() }}</div></div>
                    <div class="form-row" *ngIf="platform==='trustpilot' || platform==='google'"><label>{{ keyLabel() }} <small>(optional — for the star rating)</small></label>
                        <input class="form-input mono" [(ngModel)]="current.trustpilotApiKey" (ngModelChange)="markDirty()" placeholder="paste key or leave blank">
                        <div class="hint" style="margin-top:4px"><a [href]="keyLink()" target="_blank">{{ keyLinkText() }} &#8594;</a></div></div>
                </div>
                <div class="picker">
                    <button class="gbtn gbtn-primary gbtn-sm" (click)="connect()" [disabled]="connecting || !current.trustpilotDomain">{{ connecting ? 'Checking…' : (platform==='trustpilot' ? 'Connect Trustpilot' : platform==='google' ? 'Connect Google' : 'Check link') }}</button>
                    <span class="hint inline" *ngIf="connectMsg" [style.color]="connectOk ? 'var(--gb-amber-edge)' : 'var(--gb-muted)'">{{ connectMsg }}</span>
                </div>
                <div *ngIf="rating" class="rating-box" style="margin-top:6px">
                    <div class="stars"><span class="star" *ngFor="let s of [1,2,3,4,5]" [class.on]="s <= (rating.stars||0)">&#9733;</span></div>
                    <div class="hint">TrustScore <strong>{{ rating.trustScore | number:'1.1-1' }}</strong> &middot; {{ rating.numberOfReviews | number }} reviews</div>
                </div>
            </div></div></vdr-page-block>

            <vdr-page-block><div class="card"><div class="card-block">
                <h3 class="step-title">The basics</h3>
                <div class="form-grid">
                    <div class="form-row"><label>Business name <small>(shown in the email)</small></label>
                        <input class="form-input" [(ngModel)]="current.businessName" (ngModelChange)="markDirty()" placeholder="ELITE Software"></div>
                    <div class="form-row"><label>Ask this many days after the order</label>
                        <input class="form-input" type="number" min="0" [(ngModel)]="current.delayDays" (ngModelChange)="markDirty()"></div>
                    <div class="form-row"><label>What to ask for</label>
                        <select class="form-input" [(ngModel)]="current.reviewMode" (ngModelChange)="markDirty()">
                            <option value="service">A review of my store ({{ platform === 'google' ? 'Google' : 'Trustpilot' }})</option>
                            <option value="product">Reviews of the products they bought</option>
                            <option value="both">Both — store &amp; products</option>
                        </select></div>
                    <div class="form-row" *ngIf="current.reviewMode !== 'service'" style="grid-column:1/-1"><label>Product review link <small>(on your storefront — &#123;slug&#125;, &#123;name&#125; and &#123;orderCode&#125; are filled in)</small></label>
                        <input class="form-input mono" [(ngModel)]="current.productReviewUrlTemplate" (ngModelChange)="markDirty()" placeholder="https://elite-software.co.uk/product/&#123;slug&#125;?review=1">
                        <div class="hint" style="margin-top:4px">Each product on the order gets its own "Review this" button linking here. Point it at your product page's review form.</div></div>
                </div>
                <p class="hint" style="margin-top:8px">That's the essentials — flip the switch on at the top and you're live. Everything else has sensible defaults.</p>
            </div></div></vdr-page-block>

            <vdr-page-block><div class="card"><div class="card-block">
                <div class="row-between">
                    <h3 class="step-title" style="margin:0">Weekly report</h3>
                    <span class="gb-switch-group" *ngIf="digest">
                        <button class="gb-switch" role="switch" [attr.aria-checked]="digest.enabled" [class.on]="digest.enabled" (click)="toggleDigest()" [disabled]="digestSaving" aria-label="Send the weekly report"><span class="gb-switch-knob" aria-hidden="true"></span></button>
                        <span class="gb-switch-label">{{ digest.enabled ? 'On' : 'Off' }}</span>
                    </span>
                </div>
                <p class="hint">Every Monday at 08:00 (server time) one email sums up last week — invitations sent, review links clicked, opt-outs, failures — with the next set-up step while the checklist is incomplete. It goes through the same SMTP as the invitations.</p>
                <ng-container *ngIf="digest; else digestLoading">
                    <div class="picker">
                        <input class="form-input" style="min-width:280px" type="email" [(ngModel)]="digestRecipient" [placeholder]="digest.defaultRecipient ? 'Defaults to ' + digest.defaultRecipient : 'you@yourstore.com'">
                        <button class="gbtn gbtn-primary gbtn-sm" (click)="saveDigestRecipient()" [disabled]="digestSaving">{{ digestSaving ? 'Saving…' : 'Save recipient' }}</button>
                        <button class="gbtn gbtn-outline gbtn-sm" (click)="sendDigestTest()" [disabled]="digestSending">{{ digestSending ? 'Sending…' : 'Send me a test' }}</button>
                        <button class="gbtn gbtn-outline gbtn-sm" (click)="previewDigest()" [disabled]="digestPreviewing">{{ digestPreviewing ? 'Building…' : 'Preview' }}</button>
                    </div>
                    <p class="hint">Last sent {{ digest.lastSentAt ? (digest.lastSentAt | date:'d MMM y, HH:mm') : 'never' }} · next {{ digest.nextDueAt ? (digest.nextDueAt | date:'d MMM y, HH:mm') : '—' }}<span *ngIf="digest.enabled && !digest.recipient && !digest.defaultRecipient"> · <strong>no recipient yet</strong> — enter one above or set a reply-to for the channel</span></p>
                </ng-container>
                <ng-template #digestLoading><p class="hint">{{ digestError || 'Loading…' }}</p></ng-template>
            </div></div></vdr-page-block>

            <vdr-page-block><div class="card"><div class="card-block">
                <button class="gbtn gbtn-outline" (click)="advancedOpen = !advancedOpen" [attr.aria-expanded]="advancedOpen">{{ advancedOpen ? '&#9662; Hide advanced settings' : '&#9656; Advanced settings' }}</button>
                <span class="hint inline" style="margin-left:10px">trigger state, minimum value, cooldown, throttle, review-link, reply-to</span>
            </div></div></vdr-page-block>
            <vdr-page-block *ngIf="advancedOpen"><div class="card"><div class="card-block">
                <div class="form-grid">
                    <div class="form-row"><label>Send after order reaches</label>
                        <select class="form-input" [(ngModel)]="current.triggerState" (ngModelChange)="markDirty()">
                            <option value="Delivered">Delivered</option><option value="PaymentSettled">Payment settled</option><option value="Shipped">Shipped</option></select></div>
                    <div class="form-row"><label>Only orders over <small>(&pound;, 0 = any)</small></label>
                        <input class="form-input" type="number" min="0" [ngModel]="current.minOrderValuePence/100" (ngModelChange)="current.minOrderValuePence=$event*100; markDirty()"></div>
                    <div class="form-row"><label>Don't re-ask within <small>(days)</small></label>
                        <input class="form-input" type="number" min="0" [(ngModel)]="current.cooldownDays" (ngModelChange)="markDirty()"></div>
                    <div class="form-row"><label>Max per hourly run</label>
                        <input class="form-input" type="number" min="1" [(ngModel)]="current.maxPerRun" (ngModelChange)="markDirty()"></div>
                    <div class="form-row"><label>Reply-to <small>(optional)</small></label>
                        <input class="form-input" [(ngModel)]="current.replyTo" (ngModelChange)="markDirty()" placeholder="hello@yourstore.com"></div>
                    <div class="form-row" style="grid-column:1/-1"><label>Review link template <small>(&#123;domain&#125; is filled in &mdash; or point at Google, etc.)</small></label>
                        <input class="form-input mono" [(ngModel)]="current.reviewUrlTemplate" (ngModelChange)="markDirty()"></div>
                    <div class="form-row"><label>Business unit ID <small>(auto-filled by Connect)</small></label>
                        <input class="form-input mono" [(ngModel)]="current.trustpilotBusinessUnitId" (ngModelChange)="markDirty()"></div>
                </div>
            </div></div></vdr-page-block>
        </ng-container>

        <!-- EMAIL -->
        <ng-container *ngIf="!loading && current && tab==='email'">
            <vdr-page-block><div class="card"><div class="card-block">
                <h3 class="step-title">Invitation email <small>({{ current.channelCode }})</small></h3>
                <p class="hint"><span class="mini-chip" *ngIf="template?.isDefault">default</span><span class="mini-chip custom" *ngIf="template && !template.isDefault">customised</span> Build your email visually, drag in the variables, or click <strong>HTML</strong> to edit the source directly.</p>

                <div class="form-row" *ngIf="template"><label>Subject</label>
                    <input class="form-input" [(ngModel)]="template.subject" (ngModelChange)="tplDirty=true" (focus)="lastFocus='subject'" #subjectInput></div>

                <div class="rte" *ngIf="template">
                    <div class="rte-head">
                        <div class="rte-toolbar" *ngIf="!htmlMode">
                            <button type="button" class="rte-btn" title="Bold" (click)="exec('bold')"><b>B</b></button>
                            <button type="button" class="rte-btn" title="Italic" (click)="exec('italic')"><i>i</i></button>
                            <button type="button" class="rte-btn" title="Underline" (click)="exec('underline')"><u>U</u></button>
                            <button type="button" class="rte-btn" title="Strikethrough" (click)="exec('strikeThrough')"><s>S</s></button>
                            <span class="rte-sep"></span>
                            <select class="rte-select" title="Text style" (change)="setBlock($any($event.target).value); $any($event.target).selectedIndex=0">
                                <option value="">Style</option><option value="p">Normal</option><option value="h2">Heading</option><option value="h3">Subheading</option><option value="blockquote">Quote</option>
                            </select>
                            <select class="rte-select" title="Text size" (change)="exec('fontSize', $any($event.target).value); $any($event.target).selectedIndex=0">
                                <option value="">Size</option><option value="1">XS</option><option value="2">S</option><option value="3">M</option><option value="4">L</option><option value="5">XL</option><option value="6">XXL</option>
                            </select>
                            <span class="rte-sep"></span>
                            <label class="rte-btn rte-color" title="Text colour"><span style="text-decoration:underline;text-decoration-color:#e11d48">A</span><input type="color" (change)="exec('foreColor', $any($event.target).value)"></label>
                            <label class="rte-btn rte-color" title="Highlight"><span style="background:#fde68a;padding:0 2px;color:#111">H</span><input type="color" value="#ffff00" (change)="exec('hiliteColor', $any($event.target).value)"></label>
                            <span class="rte-sep"></span>
                            <button type="button" class="rte-btn" title="Bulleted list" (click)="exec('insertUnorderedList')">&#8226;</button>
                            <button type="button" class="rte-btn" title="Numbered list" (click)="exec('insertOrderedList')">1.</button>
                            <button type="button" class="rte-btn" title="Indent" (click)="exec('indent')">&#8677;|</button>
                            <button type="button" class="rte-btn" title="Outdent" (click)="exec('outdent')">|&#8676;</button>
                            <span class="rte-sep"></span>
                            <button type="button" class="rte-btn" title="Link" (click)="addLink()">&#128279;</button>
                            <button type="button" class="rte-btn" title="Insert image by URL" (click)="insertImage()">&#128247;</button>
                            <button type="button" class="rte-btn" title="Upload / choose from asset library" (click)="pickAsset()">&#128193;</button>
                            <button type="button" class="rte-btn" title="Insert button" (click)="insertButton()">Btn</button>
                            <button type="button" class="rte-btn" title="Divider" (click)="exec('insertHorizontalRule')">&#8213;</button>
                            <span class="rte-sep"></span>
                            <button type="button" class="rte-btn" title="Align left" (click)="exec('justifyLeft')">&#8676;</button>
                            <button type="button" class="rte-btn" title="Centre" (click)="exec('justifyCenter')">&#8803;</button>
                            <button type="button" class="rte-btn" title="Align right" (click)="exec('justifyRight')">&#8677;</button>
                            <span class="rte-sep"></span>
                            <button type="button" class="rte-btn" title="Clear formatting" (click)="exec('removeFormat')">T&#215;</button>
                            <button type="button" class="rte-btn" title="Undo" (click)="exec('undo')">&#8630;</button>
                            <button type="button" class="rte-btn" title="Redo" (click)="exec('redo')">&#8631;</button>
                        </div>
                        <div class="rte-viewtoggle">
                            <button type="button" class="rte-tab" [class.active]="!htmlMode" (click)="setHtmlMode(false)">Visual</button>
                            <button type="button" class="rte-tab" [class.active]="htmlMode" (click)="setHtmlMode(true)">HTML</button>
                        </div>
                    </div>

                    <div class="rte-vars">
                        <span class="rte-varlabel">Drag or click to insert:</span>
                        <span class="rte-chip" *ngFor="let v of emailVars" draggable="true" (dragstart)="onVarDrag($event, v.token)" (click)="insertVar(v.token)" [title]="v.token">{{ v.label }}</span>
                    </div>

                    <div class="rte-editor" *ngIf="!htmlMode" #emailEditor contenteditable="true"
                         (input)="onEditorInput()" (blur)="onEditorInput()" (keyup)="saveRange()" (mouseup)="saveRange()" (dragover)="$event.preventDefault()" (drop)="onEditorDrop($event)"></div>
                    <textarea class="rte-source" *ngIf="htmlMode" [(ngModel)]="template.body" (ngModelChange)="tplDirty=true" rows="14" spellcheck="false"></textarea>
                </div>

                <div class="picker" style="margin-top:12px">
                    <button class="gbtn gbtn-primary gbtn-sm" (click)="saveTemplate()" [disabled]="!tplDirty">Save email</button>
                    <button class="gbtn gbtn-outline gbtn-sm" (click)="previewTemplate()">Preview</button>
                    <button class="gbtn gbtn-ghost gbtn-sm" (click)="resetTemplate()" [disabled]="template?.isDefault">Reset to default</button>
                </div>
                <div *ngIf="preview" class="tpl-preview">
                    <div class="tpl-preview-subject">{{ preview.subject }}</div>
                    <div [innerHTML]="previewSafe"></div>
                </div>
                <h4 class="subsection-title">Send a test</h4>
                <div class="picker">
                    <input class="form-input" style="max-width:280px" [(ngModel)]="testEmail" placeholder="you@yourstore.com">
                    <button class="gbtn gbtn-outline gbtn-sm" (click)="sendTest()" [disabled]="!testEmail || testing">{{ testing ? 'Sending…' : 'Send test' }}</button>
                </div>
            </div></div></vdr-page-block>
        </ng-container>

        <!-- EXCLUSIONS -->
        <ng-container *ngIf="!loading && current && tab==='exclusions'">
            <vdr-page-block><div class="card"><div class="card-block">
                <h3 class="step-title">Excluded customers</h3>
                <p class="hint">Emails or whole domains that never get a review request — wholesale accounts, staff, anyone who asked not to be contacted. Customers who click "unsubscribe" in an email are added automatically ({{ stats?.optOuts || 0 }} so far).</p>

                <h4 class="subsection-title">Find a customer</h4>
                <div class="picker">
                    <input class="form-input" style="min-width:300px" placeholder="Search customers by name or email…" [(ngModel)]="custQuery" (ngModelChange)="onCustSearch()">
                    <span class="hint inline" *ngIf="custSearching">Searching…</span>
                </div>
                <div class="cust-results" *ngIf="custQuery.length>=2 && !custSearching">
                    <div class="cust-row" *ngFor="let c of custResults">
                        <div class="cust-info"><strong>{{ c.firstName }} {{ c.lastName }}</strong><span class="hint mono">{{ c.email }}</span></div>
                        <span class="pill st-skipped" *ngIf="c.excluded" [title]="'Already ' + c.via">✓ {{ c.via }}</span>
                        <button class="gbtn gbtn-outline gbtn-sm" *ngIf="!c.excluded" (click)="excludeCustomer(c)">Exclude</button>
                    </div>
                    <p class="hint" *ngIf="!custResults.length">No customers match “{{ custQuery }}”.</p>
                </div>

                <h4 class="subsection-title">Or add manually</h4>
                <div class="picker">
                    <select class="form-select" style="min-width:150px" [(ngModel)]="newExcl.type">
                        <option value="email">email</option><option value="email_domain">email domain</option>
                    </select>
                    <input class="form-input" placeholder="value" [(ngModel)]="newExcl.value" (keyup.enter)="addExclusion()">
                    <input class="form-input" placeholder="note (optional)" [(ngModel)]="newExcl.note">
                    <button class="gbtn gbtn-outline gbtn-sm" (click)="addExclusion()" [disabled]="!newExcl.value">+ Add</button>
                </div>
                <table class="table" *ngIf="exclusions.length">
                    <thead><tr><th>Type</th><th>Value</th><th>Note</th><th></th></tr></thead>
                    <tbody><tr *ngFor="let e of exclusions">
                        <td>{{ e.type }}</td><td class="mono">{{ e.value }}</td><td class="hint">{{ e.note }}</td>
                        <td class="num-col"><button class="chip-x" (click)="removeExclusion(e)" [attr.aria-label]="'Remove '+e.value">×</button></td>
                    </tr></tbody>
                </table>
                <p class="hint" *ngIf="!exclusions.length">No exclusions yet.</p>
            </div></div></vdr-page-block>
        </ng-container>

        <!-- ACTIVITY -->
        <ng-container *ngIf="!loading && current && tab==='activity'">
            <vdr-page-block><div class="card"><div class="card-block">
                <div class="row-between"><h3 class="step-title" style="margin:0">Send log</h3>
                    <select class="form-select" [(ngModel)]="logStatus" (ngModelChange)="loadLog()">
                        <option value="">all</option><option value="sent">sent</option><option value="skipped">skipped</option><option value="failed">failed</option>
                    </select></div>
                <table class="table" *ngIf="logRows.length; else noAct">
                    <thead><tr><th>When</th><th>Order</th><th>Customer</th><th>Status</th><th>Detail</th></tr></thead>
                    <tbody><tr *ngFor="let r of logRows">
                        <td class="hint">{{ r.createdAt | date:'d MMM HH:mm' }}</td>
                        <td><strong>{{ r.orderCode }}</strong></td><td>{{ r.email }}</td>
                        <td><span class="pill" [ngClass]="'st-'+r.status">{{ r.status }}</span></td>
                        <td class="hint">{{ r.reason || '—' }}</td>
                    </tr></tbody>
                </table>
                <ng-template #noAct><p class="hint">Nothing logged yet.</p></ng-template>
            </div></div></vdr-page-block>
        </ng-container>

        <!-- SAVE BAR -->
        <vdr-page-block *ngIf="!loading && current && (tab==='settings' || tab==='overview')">
            <div class="save-bar" [class.is-dirty]="dirty">
                <span class="save-msg" *ngIf="dirty"><span class="save-dot"></span> Unsaved changes</span>
                <span class="save-msg quiet" *ngIf="!dirty">All changes saved</span>
                <span class="save-spacer"></span>
                <button class="gbtn gbtn-ghost" (click)="reloadAll()" [disabled]="saving || !dirty">Discard</button>
                <button class="gbtn gbtn-primary" (click)="save()" [disabled]="saving || !dirty">{{ saving ? 'Saving…' : 'Save changes' }}</button>
            </div>
        </vdr-page-block>
    `,
    styles: [`
        :host { display:block; color:var(--gb-strong); }
        :host {
            --gb-surface:var(--color-component-bg-100,#fafafa); --gb-surface-2:var(--color-component-bg-200,#f2f3f5);
            --gb-line:var(--color-component-border-200,#d5d8de); --gb-line-soft:var(--color-component-border-100,#e8eaee);
            --gb-strong:#3d4147; --gb-muted:#5d6470; --gb-ui-border:#79818f;
            --gb-amber:#f59e0b; --gb-amber-hover:#e18f06; --gb-amber-edge:#b45309; --gb-amber-ink:#231602;
            --gb-danger-ink:#b91c1c; --gb-ok:#10b981; --gb-warn:#f59e0b; --gb-bad:#ef4444; --gb-info:#3b82f6;
            --gb-tint-ok:color-mix(in srgb,var(--gb-ok) 10%,var(--gb-surface)); --gb-tint-warn:color-mix(in srgb,var(--gb-warn) 12%,var(--gb-surface));
            --gb-tint-bad:color-mix(in srgb,var(--gb-bad) 10%,var(--gb-surface)); --gb-tint-info:color-mix(in srgb,var(--gb-info) 10%,var(--gb-surface));
            --gb-line-ok:color-mix(in srgb,var(--gb-ok) 45%,transparent); --gb-line-warn:color-mix(in srgb,var(--gb-warn) 50%,transparent);
            --gb-line-bad:color-mix(in srgb,var(--gb-bad) 45%,transparent); --gb-line-info:color-mix(in srgb,var(--gb-info) 45%,transparent);
            --gb-shadow-1:0 1px 2px rgba(15,23,42,.06);
        }
        :host-context([data-theme='dark']) { --gb-strong:var(--color-text-100,hsl(210,16%,93%)); --gb-muted:hsl(205,14%,74%); --gb-ui-border:hsl(203,12%,50%); --gb-amber-edge:#f59e0b; --gb-danger-ink:#f87171; --gb-shadow-1:0 1px 2px rgba(0,0,0,.35); }
        .gbtn { display:inline-flex; align-items:center; justify-content:center; gap:6px; min-height:36px; padding:0 16px; border-radius:8px; font-size:13px; font-weight:600; border:1px solid transparent; background:none; cursor:pointer; color:var(--gb-strong); text-decoration:none; transition:background .12s,border-color .12s,color .12s; }
        .gbtn:disabled { opacity:.45; cursor:not-allowed; }
        .gbtn-sm { min-height:30px; padding:0 12px; font-size:12px; }
        .gbtn-primary { background:var(--gb-amber); border-color:var(--gb-amber-edge); color:var(--gb-amber-ink); box-shadow:var(--gb-shadow-1); }
        .gbtn-primary:hover:not(:disabled){ background:var(--gb-amber-hover); }
        .gbtn-outline { border-color:var(--gb-ui-border); background:var(--gb-surface); }
        .gbtn-outline:hover:not(:disabled){ border-color:var(--gb-amber-edge); background:var(--gb-surface-2); }
        .gbtn-ghost { color:var(--gb-muted); } .gbtn-ghost:hover:not(:disabled){ color:var(--gb-strong); background:var(--gb-surface-2); }
        .gbtn-hero { color:#e2e8f0; } .gbtn-hero:hover:not(:disabled){ color:#fff; background:rgba(255,255,255,.12); }
        .hulo-hero { display:flex; align-items:center; gap:18px; padding:20px 22px; border-radius:14px; background:linear-gradient(135deg,#0f1419,#1e293b); color:#fff; box-shadow:0 1px 3px rgba(15,23,42,.15),0 8px 24px rgba(15,23,42,.08); }
        .hulo-hero-logo { flex:0 0 auto; width:56px; height:56px; } .hulo-hero-logo svg { width:100%; height:100%; display:block; }
        .hulo-hero-text { flex:1; min-width:0; } .hulo-hero-title { color:#fff; font-size:22px; font-weight:700; margin:0; }
        .hulo-hero-sub { color:#cbd5e1; font-size:13px; line-height:1.5; margin:4px 0 0; max-width:720px; }
        .hulo-hero-actions { display:flex; gap:6px; }
        .card { background:var(--gb-surface); border:1px solid var(--gb-line); border-radius:12px; box-shadow:var(--gb-shadow-1); margin-bottom:16px; }
        .card-block { padding:18px 20px; }
        .row-between { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:8px; }
        .step-title { font-size:15px; font-weight:700; color:var(--gb-strong); margin:0 0 4px; } .step-title small { font-weight:500; font-size:12px; color:var(--gb-muted); }
        .subsection-title { margin:20px 0 10px; font-size:11px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--gb-muted); }
        .hint { font-size:12px; color:var(--gb-muted); margin:2px 0 12px; } .hint.inline { display:inline; margin:0; }
        .mono { font-family:ui-monospace,monospace; }
        .top-bar { border-left:4px solid var(--gb-amber); }
        .chan-row { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
        .lbl { font-size:11px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--gb-muted); }
        .form-select, .form-input { padding:7px 10px; border-radius:8px; min-height:36px; border:1px solid var(--gb-ui-border); background:var(--gb-surface); color:var(--gb-strong); font-size:13px; }
        .form-select:focus, .form-input:focus { outline:none; border-color:var(--gb-amber-edge); box-shadow:0 0 0 3px color-mix(in srgb,var(--gb-amber) 30%,transparent); }
        .form-select { min-width:180px; }
        .gb-switch-group { display:inline-flex; align-items:center; gap:8px; }
        .gb-switch { position:relative; width:44px; height:24px; border-radius:999px; border:1px solid transparent; padding:0; background:var(--gb-ui-border); cursor:pointer; }
        .gb-switch.on { background:var(--gb-amber); border-color:var(--gb-amber-edge); }
        .gb-switch-knob { position:absolute; top:2px; left:2px; width:18px; height:18px; border-radius:50%; background:#fff; box-shadow:0 1px 2px rgba(15,23,42,.35); transition:transform .15s; }
        .gb-switch.on .gb-switch-knob { transform:translateX(20px); }
        .gb-switch-label { font-size:13px; font-weight:700; }
        .dirty-flag { font-size:12px; font-weight:700; color:var(--gb-amber-edge); }
        .status-sentence { margin:12px 0 0; padding:10px 14px; border-radius:8px; font-size:13px; line-height:1.5; background:var(--gb-tint-ok); border:1px solid var(--gb-line-ok); border-left-width:4px; }
        .status-sentence.status-off { background:var(--gb-surface-2); border-color:var(--gb-line); color:var(--gb-muted); }
        .tabs { display:flex; gap:4px; margin-top:14px; flex-wrap:wrap; border-top:1px solid var(--gb-line-soft); padding-top:12px; }
        .tab { display:inline-flex; align-items:center; gap:6px; padding:7px 14px; min-height:34px; border-radius:999px; border:1px solid transparent; background:none; cursor:pointer; font-size:13px; font-weight:600; color:var(--gb-muted); }
        .tab:hover { color:var(--gb-strong); background:var(--gb-surface-2); } .tab.active { background:var(--gb-amber); border-color:var(--gb-amber-edge); color:var(--gb-amber-ink); }
        .tab-count { font-size:10px; font-weight:800; min-width:16px; height:16px; padding:0 4px; border-radius:999px; display:inline-grid; place-items:center; background:color-mix(in srgb,currentColor 18%,transparent); }
        .kpi-row { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; }
        .kpi { background:var(--gb-surface); border:1px solid var(--gb-line); border-radius:12px; padding:16px 18px; }
        .kpi-alert { border-color:var(--gb-line-warn); border-left:4px solid var(--gb-amber); }
        .kpi-label { font-size:11px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--gb-muted); }
        .kpi-num { margin-top:6px; font-size:26px; font-weight:700; color:var(--gb-strong); font-variant-numeric:tabular-nums; }
        .kpi-sub { margin-top:4px; font-size:12px; color:var(--gb-muted); }
        .form-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:12px 18px; }
        .form-row label { display:block; font-size:12px; font-weight:700; color:var(--gb-strong); margin-bottom:4px; } .form-row label small { font-weight:500; color:var(--gb-muted); }
        .form-row .form-input, .form-row .form-select { width:100%; }
        .rating-box { display:flex; align-items:center; gap:16px; flex-wrap:wrap; }
        .stars { font-size:22px; letter-spacing:2px; } .star { color:#dcdce6; } .star.on { color:#00b67a; }
        .table { width:100%; border-collapse:collapse; font-size:13px; }
        .table th { text-align:left; font-size:11px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:var(--gb-muted); padding:8px 10px; border-bottom:1px solid var(--gb-line); }
        .table td { padding:9px 10px; border-bottom:1px solid var(--gb-line-soft); color:var(--gb-strong); }
        .table .num-col { text-align:right; }
        .pill { font-size:11px; font-weight:700; padding:2px 9px; border-radius:999px; border:1px solid var(--gb-line); background:var(--gb-surface-2); }
        .st-sent { background:var(--gb-tint-ok); border-color:var(--gb-line-ok); } .st-skipped { background:var(--gb-tint-info); border-color:var(--gb-line-info); } .st-failed { background:var(--gb-tint-bad); border-color:var(--gb-line-bad); } .st-sending { background:var(--gb-tint-warn); border-color:var(--gb-line-warn); }
        .kpi-pct { font-size:14px; font-weight:600; color:var(--gb-muted); }
        .notice-strip { margin:8px 0 0; padding:10px 14px; border-radius:8px; font-size:13px; line-height:1.5; background:#fffbeb; border:1px solid #fcd34d; color:#92400e; }
        .banner-extra { margin-top:6px; font-size:12.5px; color:var(--gb-muted); }
        .setup-card { border-left:4px solid var(--gb-amber); }
        .setup-row { display:flex; align-items:flex-start; gap:12px; padding:10px 0; }
        .setup-row + .setup-row { border-top:1px solid var(--gb-line-soft); }
        .setup-text { flex:1; min-width:0; font-size:13px; }
        .dot { flex:0 0 auto; width:12px; height:12px; margin-top:4px; border-radius:50%; background:var(--gb-line); }
        .dot.on { background:var(--gb-ok); box-shadow:0 0 0 3px color-mix(in srgb,var(--gb-ok) 25%,transparent); }
        .hint-link { font-size:12px; color:var(--gb-muted); cursor:pointer; text-decoration:underline; }
        .picker { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:12px; }
        .form-row { margin-bottom:14px; }
        .mini-chip { font-size:11px; font-weight:600; padding:2px 7px; border-radius:5px; background:var(--gb-surface); border:1px solid var(--gb-line-warn); color:var(--gb-strong); }
        .mini-chip.custom { border-color:var(--gb-line-info); }
        .chip-x { display:inline-grid; place-items:center; min-width:22px; min-height:22px; border-radius:999px; background:none; border:0; cursor:pointer; font-size:15px; color:var(--gb-muted); }
        .chip-x:hover { color:var(--gb-danger-ink); background:var(--gb-tint-bad); }
        .rte { border:1px solid var(--gb-line); border-radius:10px; overflow:hidden; background:var(--gb-surface); }
        .rte-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 8px; background:var(--gb-surface-2); border-bottom:1px solid var(--gb-line); flex-wrap:wrap; }
        .rte-toolbar { display:flex; gap:2px; flex-wrap:wrap; }
        .rte-btn { min-width:30px; height:30px; padding:0 8px; border:1px solid transparent; background:none; border-radius:6px; cursor:pointer; color:var(--gb-strong); font-size:14px; }
        .rte-btn:hover { background:var(--gb-surface); border-color:var(--gb-line); }
        .rte-viewtoggle { display:inline-flex; border:1px solid var(--gb-ui-border); border-radius:999px; overflow:hidden; }
        .rte-tab { padding:4px 12px; border:0; background:none; cursor:pointer; font-size:11px; font-weight:700; color:var(--gb-muted); }
        .rte-tab.active { background:var(--gb-amber); color:var(--gb-amber-ink); }
        .rte-vars { display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:8px 10px; border-bottom:1px solid var(--gb-line-soft); background:var(--gb-surface); }
        .rte-varlabel { font-size:11px; font-weight:700; color:var(--gb-muted); text-transform:uppercase; letter-spacing:.05em; }
        .rte-chip { font-size:12px; font-weight:600; padding:3px 10px; border-radius:999px; background:var(--gb-tint-info); border:1px solid var(--gb-line-info); color:var(--gb-strong); cursor:grab; user-select:none; }
        .rte-chip:hover { border-color:var(--gb-amber-edge); }
        .rte-editor { min-height:240px; max-height:520px; overflow:auto; margin:12px; padding:16px 18px; background:#fff; color:#0f172a; caret-color:#0f172a; border-radius:8px; box-shadow:0 1px 3px rgba(15,23,42,.14); font-family:Arial,Helvetica,sans-serif; font-size:14px; line-height:1.6; outline:none; }
        :host-context([data-theme='dark']) .rte-editor { box-shadow:0 2px 14px rgba(0,0,0,.5); }
        .rte-editor ::selection { background:#b3d4fc; color:#0f172a; }
        .rte-editor:focus { box-shadow:inset 0 0 0 2px color-mix(in srgb,var(--gb-amber) 30%,transparent); }
        .rte-editor p, .rte-editor li, .rte-editor h1, .rte-editor h2, .rte-editor h3, .rte-editor h4, .rte-editor div, .rte-editor span, .rte-editor strong, .rte-editor em, .rte-editor td, .rte-editor th, .rte-editor blockquote, .rte-editor ul, .rte-editor ol { color: inherit; }
        .rte-editor img { max-width:100%; height:auto; }
        .rte-editor blockquote { border-left:3px solid #cbd5e1; margin:0 0 12px; padding:2px 0 2px 14px; color:#475569; }
        .rte-sep { display:inline-block; width:1px; height:20px; background:var(--gb-line); margin:0 3px; vertical-align:middle; }
        .rte-select { height:30px; border:1px solid var(--gb-line); border-radius:6px; background:var(--gb-surface); color:var(--gb-strong); font-size:12px; padding:0 4px; cursor:pointer; }
        .rte-color { position:relative; overflow:hidden; display:inline-grid; place-items:center; }
        .rte-color input[type=color] { position:absolute; inset:0; width:100%; height:100%; opacity:0; cursor:pointer; border:0; padding:0; }
        .rte-editor h2 { font-size:18px; margin:0 0 8px; } .rte-editor a { color:#00b67a; }
        .rte-source { width:100%; border:0; padding:14px 16px; background:var(--gb-surface); color:var(--gb-strong); font-family:ui-monospace,monospace; font-size:12px; line-height:1.5; outline:none; resize:vertical; }
        .tpl-preview { margin-top:14px; padding:16px 18px; border-radius:10px; border:1px dashed var(--gb-ui-border); background:#fff; color:#0f172a; font-size:13px; }
        .tpl-preview-subject { font-weight:700; margin-bottom:10px; padding-bottom:8px; border-bottom:1px solid var(--gb-line); }
        .save-bar { position:sticky; bottom:12px; z-index:5; display:flex; align-items:center; gap:10px; padding:12px 16px; border-radius:12px; background:var(--gb-surface); border:1px solid var(--gb-line); box-shadow:var(--gb-shadow-1); }
        .save-bar.is-dirty { border-color:var(--gb-amber-edge); box-shadow:0 8px 24px rgba(15,23,42,.18); }
        .save-msg { display:inline-flex; align-items:center; gap:8px; font-size:13px; font-weight:600; } .save-msg.quiet { color:var(--gb-muted); font-weight:500; }
        .save-dot { width:8px; height:8px; border-radius:50%; background:var(--gb-amber); box-shadow:0 0 0 3px color-mix(in srgb,var(--gb-amber) 25%,transparent); }
        .save-spacer { flex:1; }
        .cust-results { border:1px solid var(--gb-line); border-radius:10px; overflow:hidden; margin-bottom:12px; }
        .cust-row { display:flex; align-items:center; gap:12px; padding:10px 14px; }
        .cust-row + .cust-row { border-top:1px solid var(--gb-line-soft); }
        .cust-row:hover { background:var(--gb-surface-2); }
        .cust-info { flex:1; display:flex; flex-direction:column; gap:2px; min-width:0; }
        .cust-info strong { font-size:13px; } .cust-info .hint { margin:0; }
        .update-banner { display:flex; gap:12px; align-items:center; justify-content:space-between; flex-wrap:wrap; padding:12px 16px; border-radius:10px; font-size:13px; background:var(--gb-tint-warn); border:1px solid var(--gb-line-warn); }
        .update-banner .actions { display:flex; gap:6px; }
        .upd-cmd { font-family: monospace; font-size: 12px; background: rgba(0,0,0,.06); padding: 2px 6px; border-radius: 5px; }
        :host-context([data-theme='dark']) .upd-cmd { background: rgba(255,255,255,.1); }
        .eval-actions { align-items:center; }
        .eval-email { padding:5px 9px; border:1px solid var(--gb-ui-border); border-radius:7px; font-size:12.5px; min-width:190px; background:#fff; color:#0f172a; }
        .eval-ok { font-size:12.5px; color:var(--gb-strong); font-weight:600; }
    `],
})
export class ReviewRequestsComponent implements OnInit {
    loading = true;
    meta: any = null;
    updating = false;
    updateProgress = 'Updating…';

    runSelfUpdate() {
        const target = this.meta?.update?.latest;
        if (!target || this.updating) return;
        this.updating = true;
        this.updateProgress = 'Installing…';
        this.cdr.markForCheck();
        this.http.post<any>('/review-requests/update/run', { version: target }).subscribe({
            next: r => {
                if (r?.restartScheduled) {
                    this.updateProgress = 'Restarting…';
                    this.notify.success(r.message || 'Updated — server restarting');
                    this.pollAfterRestart(target);
                } else {
                    this.updating = false;
                    this.notify.success(r?.message || 'Installed — restart the server to load it');
                }
                this.cdr.markForCheck();
            },
            error: e => {
                this.updating = false;
                this.notify.error(e?.error?.message || 'Update failed — nothing was changed');
                this.cdr.markForCheck();
            },
        });
    }

    private pollAfterRestart(target: string, attempt = 0) {
        if (attempt > 40) {
            this.updating = false;
            this.notify.error('The server has not come back yet — check your process manager');
            this.cdr.markForCheck();
            return;
        }
        this.restartTimer = setTimeout(() => {
            this.http.get<any>('/review-requests/meta').subscribe({
                next: m => {
                    const v = m?.version || m?.update?.current;
                    if (v === target) {
                        this.updating = false;
                        this.meta = m;
                        this.notify.success(`Now running v${target}`);
                        this.cdr.markForCheck();
                    } else {
                        this.pollAfterRestart(target, attempt + 1);
                    }
                },
                error: () => this.pollAfterRestart(target, attempt + 1),
            });
        }, 3000);
    }
    remindEmail = '';
    remindMeSending = false;
    remindMeSent = false;
    updateDismissed = false;
    cmdCopied = false;

    copyUpdateCmd() {
        const cmd = `npm install @huloglobal/vendure-plugin-review-requests@${this.meta?.update?.latest || 'latest'}`;
        navigator.clipboard?.writeText(cmd).then(() => {
            this.cmdCopied = true;
            this.cdr.markForCheck();
            setTimeout(() => { this.cmdCopied = false; this.cdr.markForCheck(); }, 2500);
        });
    }
    licenceKeyInput = '';
    activating = false;
    configs: ReviewConfig[] = [];
    currentIdx = 0;
    dirty = false; saving = false;
    tab: Tab = 'overview';
    stats: any = null;
    rating: any = null;
    logRows: any[] = [];
    logStatus = '';
    exclusions: any[] = [];
    newExcl = { type: 'email', value: '', note: '' };
    custQuery = ''; custResults: any[] = []; custSearching = false; private custTimer: any;
    template: any = null; tplDirty = false; preview: any = null;
    testEmail = ''; testing = false;
    htmlMode = false;
    lastFocus: 'body' | 'subject' = 'body';
    @ViewChild('emailEditor') emailEditorRef?: ElementRef<HTMLElement>;
    @ViewChild('subjectInput') subjectInputRef?: ElementRef<HTMLInputElement>;
    emailVars = [
        { token: '{{firstName}}', label: 'First name' },
        { token: '{{orderCode}}', label: 'Order code' },
        { token: '{{businessName}}', label: 'Business name' },
        { token: '{{reviewButton}}', label: 'Review button' },
        { token: '{{productList}}', label: 'Product list' },
        { token: '{{ratingBlock}}', label: 'Star rating' },
        { token: '{{reviewUrl}}', label: 'Review link' },
    ];
    running = false; checking = false; checkMsg = '';
    advancedOpen = false; connecting = false; connectMsg = ''; connectOk = false;
    platform = 'trustpilot';
    platformTemplates: any = { trustpilot: 'https://www.trustpilot.com/evaluate/{domain}', google: 'https://search.google.com/local/writereview?placeid={domain}', reviewsio: 'https://www.reviews.io/company-review/store/{domain}/new' };

    constructor(private http: HttpClient, private notify: NotificationService, private cdr: ChangeDetectorRef, private sanitizer: DomSanitizer, private modalService: ModalService) {}

    get current(): ReviewConfig | null { return this.configs[this.currentIdx] || null; }

    ngOnInit() {
        this.checkClaim(false);
        this.reloadAll();
        this.http.get<any>('/review-requests/meta').subscribe({ next: m => { this.meta = m; this.cdr.markForCheck(); }, error: () => undefined });
    }

    sendRemindMe() {
        const email = (this.remindEmail || '').trim();
        if (!email) return;
        this.remindMeSending = true;
        this.http.post<any>('/review-requests/eval/remind-me', { email }).subscribe({
            next: () => { this.remindMeSending = false; this.remindMeSent = true; this.notify.success('Reminder set — check your inbox for a confirmation'); this.cdr.markForCheck(); },
            error: () => { this.remindMeSending = false; this.notify.error('Could not save the reminder — try again shortly'); this.cdr.markForCheck(); },
        });
    }

    /** "12 review invitations sent · 3 review links clicked" from the 30-day figures the server computed. */
    statsLine(): string {
        return (this.meta?.recentStats || []).map((s: any) => `${s.value} ${s.label}`).join(' · ');
    }

    /** One wording for every "needs a licence" failure (402 or a licence error code), else the server's message. */
    errMsg(e: any, what: string, fallback?: string): string {
        const code = e?.error?.error;
        if (e?.status === 402 || code === 'licence-required' || code === 'licence_required' || code === 'premium-feature') {
            return `${what} needs a licence — start the free trial or activate a key at the top of this page.`;
        }
        return e?.error?.message || e?.error?.reason || fallback || `${what} failed`;
    }

    // ── Set-up checklist (Overview) ───────────────────────────────────
    setup: { items: Array<{ key: string; label: string; done: boolean; hint: string; tab?: string; url?: string }>; complete: boolean } | null = null;
    private static readonly SETUP_HIDDEN_KEY = 'hulo-vendure-plugin-review-requests-setup-hidden';
    private static readonly SETUP_HIDDEN_UNDONE_KEY = 'hulo-vendure-plugin-review-requests-setup-hidden-undone';
    loadSetup() { this.http.get<any>('/review-requests/setup').subscribe({ next: s => { this.setup = s; this.cdr.markForCheck(); }, error: () => undefined }); }
    setupDone(): number { return (this.setup?.items || []).filter(i => i.done).length; }
    /** Hidden once complete, or after "Hide" — unless an item has come undone since it was hidden. */
    showSetup(): boolean {
        if (!this.setup || this.setup.complete) return false;
        let hidden = '', snapshot = '';
        try { hidden = localStorage.getItem(ReviewRequestsComponent.SETUP_HIDDEN_KEY) || ''; snapshot = localStorage.getItem(ReviewRequestsComponent.SETUP_HIDDEN_UNDONE_KEY) || ''; } catch { /* storage unavailable */ }
        if (hidden !== '1') return true;
        const wasUndone = new Set(snapshot.split(',').filter(Boolean));
        return this.setup.items.some(i => !i.done && !wasUndone.has(i.key));
    }
    hideSetup() {
        const undone = (this.setup?.items || []).filter(i => !i.done).map(i => i.key).join(',');
        try { localStorage.setItem(ReviewRequestsComponent.SETUP_HIDDEN_KEY, '1'); localStorage.setItem(ReviewRequestsComponent.SETUP_HIDDEN_UNDONE_KEY, undone); } catch { /* storage unavailable */ }
        this.cdr.markForCheck();
    }
    clickRate(): number | null {
        const sent = Number(this.stats?.totals?.sent || 0);
        if (!sent) return null;
        return Math.round((Number(this.stats?.totals?.clicked || 0) / sent) * 1000) / 10;
    }

    // ── Weekly report (Settings) ──────────────────────────────────────
    digest: { enabled: boolean; recipient: string | null; defaultRecipient: string | null; lastSentAt: string | null; nextDueAt: string | null } | null = null;
    digestRecipient = '';
    digestError = '';
    digestSaving = false; digestSending = false; digestPreviewing = false;
    loadDigest() {
        this.http.get<any>('/review-requests/digest/settings').subscribe({
            next: d => { this.digest = d; this.digestRecipient = d?.recipient || ''; this.cdr.markForCheck(); },
            error: () => { this.digestError = 'Weekly report settings are unavailable.'; this.cdr.markForCheck(); },
        });
    }
    private saveDigest(patch: { enabled?: boolean; recipient?: string | null }, okMsg: string) {
        this.digestSaving = true;
        this.http.post<any>('/review-requests/digest/settings', patch).subscribe({
            next: d => { this.digestSaving = false; this.digest = d; this.digestRecipient = d?.recipient || ''; this.notify.success(okMsg); this.cdr.markForCheck(); },
            error: e => { this.digestSaving = false; this.notify.error(this.errMsg(e, 'Saving the weekly report settings')); this.cdr.markForCheck(); },
        });
    }
    toggleDigest() { if (this.digest) this.saveDigest({ enabled: !this.digest.enabled }, this.digest.enabled ? 'Weekly report switched off' : 'Weekly report switched on'); }
    saveDigestRecipient() { this.saveDigest({ recipient: (this.digestRecipient || '').trim() || null }, 'Recipient saved'); }
    sendDigestTest() {
        this.digestSending = true;
        const to = (this.digestRecipient || '').trim();
        this.http.post<any>('/review-requests/digest/send-test', to ? { to } : {}).subscribe({
            next: r => {
                this.digestSending = false;
                if (r?.sent) this.notify.success(`Sent "${r.subject}" to ${r.to}`);
                else this.notify.error(r?.reason === 'no-recipient' ? 'No recipient — enter an address first' : (r?.reason || 'Could not send the report'));
                this.loadDigest();
            },
            error: e => { this.digestSending = false; this.notify.error(this.errMsg(e, 'Sending the test report')); this.cdr.markForCheck(); },
        });
    }
    /** Fetched with the same authenticated HttpClient (works with cookie or bearer auth), then shown from a Blob URL. */
    previewDigest() {
        this.digestPreviewing = true;
        this.http.get('/review-requests/digest/preview', { responseType: 'text' }).subscribe({
            next: html => {
                this.digestPreviewing = false;
                const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
                window.open(url, '_blank', 'noopener');
                setTimeout(() => URL.revokeObjectURL(url), 60_000);
                this.cdr.markForCheck();
            },
            error: e => { this.digestPreviewing = false; this.notify.error(this.errMsg(e, 'Building the preview')); this.cdr.markForCheck(); },
        });
    }

    // Buy-from-admin: opens HULO checkout in a new tab; the licence server
    // binds the purchase to this install and the key installs itself.
    buyPlan: 'monthly' | 'annual' | 'lifetime' = 'monthly';
    buying = false;
    claim: any = null;
    private claimTimer: any = null;
    buyLicence() {
        this.buying = true;
        this.http.post<any>('/review-requests/licence/purchase-link', { plan: this.buyPlan }).subscribe({
            next: r => {
                this.buying = false;
                if (r?.url) {
                    window.open(r.url, '_blank', 'noopener');
                    this.claim = { state: 'pending' };
                    this.startClaimPoll();
                }
                this.cdr.markForCheck();
            },
            error: e => { this.buying = false; this.notify.error(e?.error?.message || 'Could not start checkout — try again shortly'); this.cdr.markForCheck(); },
        });
    }
    checkClaim(force = false) {
        this.http.get<any>('/review-requests/licence/claim-status' + (force ? '?check=1' : '')).subscribe({
            next: r => {
                const wasPending = this.claim?.state === 'pending';
                this.claim = r;
                if (r?.state === 'pending') { if (!this.claimTimer) this.startClaimPoll(); }
                else this.stopClaimPoll();
                if (r?.licensed && (wasPending || r?.state === 'installed') && !this.meta?.licensed) {
                    this.notify.success('Licence installed — all features enabled');
                    this.http.get<any>('/review-requests/meta').subscribe({ next: m => { this.meta = m; this.cdr.markForCheck(); }, error: () => undefined });
                }
                this.cdr.markForCheck();
            },
            error: () => undefined,
        });
    }
    private startClaimPoll() { this.stopClaimPoll(); this.claimTimer = setInterval(() => this.checkClaim(false), 15000); }
    private stopClaimPoll() { if (this.claimTimer) { clearInterval(this.claimTimer); this.claimTimer = null; } }
    private restartTimer: any = null;
    ngOnDestroy() { this.stopClaimPoll(); clearTimeout(this.custTimer); clearTimeout(this.restartTimer); }

    portalOpening = false;
    licenceLabel(): string {
        const l: any = this.meta?.licence;
        if (!l) return 'active licence';
        const d = (s: string) => new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
        if (l.master) return 'master licence — covers every HULO plugin on this server';
        if (l.plan === 'lifetime') return 'lifetime licence — never expires, every update included';
        if (l.trialEndsAt && new Date(l.trialEndsAt).getTime() > Date.now()) {
            return `free trial on the ${l.plan} plan — first charge on ${d(l.trialEndsAt)}; cancel any time before then via Manage billing`;
        }
        return `${l.plan} subscription. Renews automatically${l.expiresAt ? ' — current key valid until ' + d(l.expiresAt) : ''}`;
    }
    openPortal() {
        this.portalOpening = true;
        this.http.post<any>('/review-requests/licence/portal-link', {}).subscribe({
            next: r => { this.portalOpening = false; if (r?.url) window.open(r.url, '_blank', 'noopener'); this.cdr.markForCheck(); },
            error: e => { this.portalOpening = false; this.notify.error(e?.error?.message || 'Could not open the billing portal'); this.cdr.markForCheck(); },
        });
    }
    buyLifetime() { this.buyPlan = 'lifetime'; this.buyLicence(); }

    activateLicence() {
        const key = (this.licenceKeyInput || '').trim();
        if (!key) return;
        this.activating = true;
        this.http.post<any>('/review-requests/licence/activate', { key }).subscribe({
            next: (r) => {
                this.activating = false;
                this.licenceKeyInput = '';
                this.notify.success(r?.message || 'Licence activated — all features enabled');
                this.http.get<any>('/review-requests/meta').subscribe({ next: m => { this.meta = m; this.cdr.markForCheck(); }, error: () => undefined });
                this.cdr.markForCheck();
            },
            error: (e) => {
                this.activating = false;
                this.notify.error(e?.error?.message || 'That key did not validate — check it was copied completely');
                this.cdr.markForCheck();
            },
        });
    }

    reloadAll() {
        this.loading = true; this.dirty = false;
        this.http.get<ReviewConfig[]>('/review-requests/config').subscribe({
            next: c => { this.configs = c; if (this.currentIdx >= c.length) this.currentIdx = 0; this.loading = false; this.derivePlatform(); this.loadForTab(this.tab); this.cdr.markForCheck(); },
            error: () => { this.loading = false; this.notify.error('Failed to load review-request config'); },
        });
    }
    onChannel() { this.dirty = false; this.rating = null; this.derivePlatform(); this.loadForTab(this.tab); }
    derivePlatform() {
        const t = this.current?.reviewUrlTemplate || '';
        if (t.includes('trustpilot.com')) this.platform = 'trustpilot';
        else if (t.includes('google.com')) this.platform = 'google';
        else if (t.includes('reviews.io')) this.platform = 'reviewsio';
        else this.platform = 'custom';
    }
    onPlatform() {
        if (!this.current) return;
        if (this.platform !== 'custom') this.current.reviewUrlTemplate = this.platformTemplates[this.platform];
        this.connectMsg = ''; this.rating = null;
        this.markDirty();
    }
    platformLabel(): string {
        return this.platform === 'google' ? 'Your Google Place ID'
            : this.platform === 'reviewsio' ? 'Your Reviews.io store ID'
            : this.platform === 'custom' ? 'Your identifier (fills {domain} in the link)'
            : 'Your Trustpilot domain';
    }
    platformPlaceholder(): string {
        return this.platform === 'google' ? 'ChIJ… (Google Place ID)'
            : this.platform === 'reviewsio' ? 'your-store-id'
            : this.platform === 'custom' ? 'value for {domain}'
            : 'elite-software.co.uk';
    }
    keyLabel(): string { return this.platform === 'google' ? 'Google Maps API key' : 'Trustpilot API key'; }
    keyLink(): string { return this.platform === 'google' ? 'https://console.cloud.google.com/apis/library/places-backend.googleapis.com' : 'https://developers.trustpilot.com/'; }
    keyLinkText(): string { return this.platform === 'google' ? 'Enable the Places API' : 'Get a free key'; }
    platformHelp(): string {
        return this.platform === 'google' ? 'Find your Place ID at developers.google.com/maps/documentation/places/web-service/place-id. Add a Google Maps API key (Places API) below and we pull your live Google star rating too.'
            : this.platform === 'reviewsio' ? 'Your Reviews.io store ID from your Reviews.io dashboard.'
            : this.platform === 'custom' ? 'Edit the full link template under Advanced settings.'
            : 'Your domain exactly as it appears on Trustpilot.';
    }
    go(t: Tab) { this.tab = t; this.loadForTab(t); }
    private loadForTab(t: Tab) {
        if (t === 'overview') { this.loadSetup(); this.loadStats(); this.loadLog(); }
        if (t === 'settings') this.loadDigest();
        if (t === 'email') this.loadTemplate();
        if (t === 'exclusions') { this.loadExclusions(); this.loadStats(); }
        if (t === 'activity') this.loadLog();
    }

    markDirty() { this.dirty = true; }
    statusSentence(): string {
        const c = this.current; if (!c) return '';
        if (!c.enabled) return 'Review requests are OFF for this channel — nothing is sent.';
        const val = c.minOrderValuePence ? ` over £${(c.minOrderValuePence/100).toFixed(0)}` : '';
        const tp = c.trustpilotDomain ? `your Trustpilot page for ${c.trustpilotDomain}` : '(set your Trustpilot domain in Settings)';
        return `${c.delayDays} days after an order${val} reaches ${c.triggerState}, the customer is invited to review ${tp} — at most once every ${c.cooldownDays} days.`;
    }
    save() {
        if (!this.current) return; this.saving = true;
        this.http.post('/review-requests/config', { configs: [this.current] }).subscribe({
            next: () => { this.saving = false; this.dirty = false; this.notify.success('Settings saved'); this.cdr.markForCheck(); },
            error: () => { this.saving = false; this.notify.error('Save failed'); },
        });
    }

    loadStats() { this.http.get<any>('/review-requests/stats').subscribe({ next: s => { this.stats = s; this.cdr.markForCheck(); }, error: () => undefined }); }
    pendingTotal(): number { return (this.stats?.pending || []).reduce((n: number, r: any) => n + (r.eligible || 0), 0); }
    loadLog() { const q = this.logStatus ? `?status=${this.logStatus}` : ''; this.http.get<any[]>(`/review-requests/log${q}`).subscribe({ next: r => { this.logRows = r; this.cdr.markForCheck(); }, error: () => undefined }); }
    loadExclusions() { this.http.get<any[]>('/review-requests/exclusions').subscribe({ next: r => { this.exclusions = r; this.cdr.markForCheck(); }, error: () => undefined }); }

    runNow() {
        this.running = true;
        this.http.post<any>('/review-requests/run', {}).subscribe({
            next: r => { this.running = false; const sent = (r.results||[]).reduce((n:number,x:any)=>n+(x.sent||0),0); this.notify.success(`Sent ${sent} invitation(s)`); this.loadStats(); this.loadLog(); this.loadSetup(); },
            error: err => { this.running = false; this.notify.error(this.errMsg(err, 'Sending due invitations', 'Run failed')); },
        });
    }
    connect() {
        if (!this.current) return; this.connecting = true; this.connectMsg = ''; this.connectOk = false;
        this.http.post<any>('/review-requests/trustpilot/detect', this.current).subscribe({
            next: r => {
                this.connecting = false; this.connectOk = r.ok && (!!r.rating || !!r.businessUnitId || !this.current!.trustpilotApiKey);
                this.connectMsg = r.message;
                if (r.businessUnitId && this.current) { this.current.trustpilotBusinessUnitId = r.businessUnitId; this.markDirty(); }
                if (!this.current!.businessName && this.current) { /* leave for the user */ }
                this.rating = r.rating || null; this.cdr.markForCheck();
            },
            error: () => { this.connecting = false; this.connectMsg = 'Connection failed — try again.'; },
        });
    }

    checkRating() {
        if (!this.current) return; this.checking = true; this.checkMsg = '';
        this.http.post<any>('/review-requests/trustpilot/check', this.current).subscribe({
            next: r => { this.checking = false; this.rating = r.rating; this.checkMsg = r.ok ? `✓ ${r.rating.trustScore} from ${r.rating.numberOfReviews} reviews · link: ${r.reviewUrl}` : `Link: ${r.reviewUrl} (no live rating — check API key/domain)`; this.cdr.markForCheck(); },
            error: () => { this.checking = false; this.checkMsg = 'Check failed'; },
        });
    }

    // ── Rich email editor ───────────────────────────────────────────
    private editorEl(): HTMLElement | null { return this.emailEditorRef?.nativeElement || null; }
    private syncEditorFromModel() { const ed = this.editorEl(); if (ed && this.template) ed.innerHTML = this.template.body || ''; }
    onEditorInput() { const ed = this.editorEl(); if (ed && this.template) { this.template.body = ed.innerHTML; this.tplDirty = true; } }
    setHtmlMode(on: boolean) {
        if (on === this.htmlMode) return;
        if (!on) { this.htmlMode = false; setTimeout(() => this.syncEditorFromModel(), 0); }
        else { this.onEditorInput(); this.htmlMode = true; }
    }
    private savedRange: Range | null = null;
    saveRange() { const sel = window.getSelection(); const ed = this.editorEl(); if (sel && sel.rangeCount && ed && ed.contains(sel.anchorNode)) this.savedRange = sel.getRangeAt(0).cloneRange(); }
    private restoreRange() { const ed = this.editorEl(); if (!ed) return; ed.focus(); if (this.savedRange && ed.contains(this.savedRange.commonAncestorContainer)) { const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(this.savedRange); } }
    exec(cmd: string, val?: string) { const ed = this.editorEl(); if (!ed) return; this.restoreRange(); try { document.execCommand(cmd, false, val); } catch {} this.saveRange(); this.onEditorInput(); }
    pickAsset() {
        const ed = this.editorEl(); if (!ed) return;
        this.modalService.fromComponent(AssetPickerDialogComponent as any, { size: 'xl' }).subscribe((result: any) => {
            if (result && result.length) {
                const imgs = result.map((a: any) => `<img src="${a.preview || a.source}" alt="${String(a.name || '').replace(/"/g, '&quot;')}" style="max-width:100%;height:auto;border-radius:6px">`).join('');
                this.restoreRange();
                try { document.execCommand('insertHTML', false, imgs); } catch {}
                this.onEditorInput();
            }
        });
    }
    setBlock(tag: string) { if (tag) this.exec('formatBlock', '<' + tag + '>'); }
    insertImage() {
        const ed = this.editorEl(); if (!ed) return;
        const url = prompt('Image URL (https://…)', 'https://');
        if (!url) return;
        const alt = prompt('Alt text (for accessibility)', '') || '';
        this.restoreRange();
        const html = `<img src="${url}" alt="${alt.replace(/"/g, '&quot;')}" style="max-width:100%;height:auto;border-radius:6px">`;
        try { document.execCommand('insertHTML', false, html); } catch {}
        this.onEditorInput();
    }
    addLink() { const url = prompt('Link URL (you can use a variable like {{reviewUrl}})', 'https://'); if (url) this.exec('createLink', url); }
    insertButton() {
        const ed = this.editorEl(); if (!ed) return;
        const label = prompt('Button text', 'Leave a review'); if (label === null) return;
        const url = prompt('Button link', '{{reviewUrl}}'); if (url === null) return;
        this.restoreRange();
        const html = `<p style="text-align:center;margin:18px 0"><a href="${url}" style="display:inline-block;background:#00b67a;color:#fff;text-decoration:none;font-weight:700;font-size:16px;padding:14px 28px;border-radius:8px">${label.replace(/</g, '&lt;')}</a></p>`;
        try { document.execCommand('insertHTML', false, html); } catch {}
        this.onEditorInput();
    }
    onVarDrag(ev: DragEvent, token: string) { ev.dataTransfer?.setData('text/plain', token); }
    onEditorDrop(ev: DragEvent) {
        ev.preventDefault();
        const token = ev.dataTransfer?.getData('text/plain') || ''; if (!token) return;
        const ed = this.editorEl(); if (!ed) return;
        const doc: any = document;
        let range: Range | null = null;
        if (doc.caretRangeFromPoint) range = doc.caretRangeFromPoint(ev.clientX, ev.clientY);
        else if (doc.caretPositionFromPoint) { const p = doc.caretPositionFromPoint(ev.clientX, ev.clientY); if (p) { range = document.createRange(); range.setStart(p.offsetNode, p.offset); range.collapse(true); } }
        if (range) { const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(range); }
        ed.focus();
        try { document.execCommand('insertText', false, token); } catch {}
        this.onEditorInput();
    }
    insertVar(token: string) {
        if (this.lastFocus === 'subject' && this.subjectInputRef && this.template) {
            const el = this.subjectInputRef.nativeElement; const start = el.selectionStart ?? el.value.length; const end = el.selectionEnd ?? start;
            this.template.subject = el.value.slice(0, start) + token + el.value.slice(end); this.tplDirty = true;
            setTimeout(() => { el.focus(); const pos = start + token.length; el.setSelectionRange(pos, pos); }, 0);
            return;
        }
        if (this.htmlMode && this.template) { this.template.body = (this.template.body || '') + token; this.tplDirty = true; return; }
        const ed = this.editorEl(); if (!ed) return; ed.focus();
        try { document.execCommand('insertText', false, token); } catch {}
        this.onEditorInput();
    }

    loadTemplate() { if (!this.current) return; this.preview = null; this.tplDirty = false; this.htmlMode = false; this.http.get<any>(`/review-requests/template?channelId=${this.current.channelId}`).subscribe({ next: t => { this.template = t; this.cdr.markForCheck(); setTimeout(() => this.syncEditorFromModel(), 0); }, error: () => undefined }); }
    saveTemplate() { if (!this.current || !this.template) return; this.http.post('/review-requests/template', { channelId: this.current.channelId, subject: this.template.subject, body: this.template.body }).subscribe({ next: () => { this.tplDirty = false; this.notify.success('Email saved'); this.loadTemplate(); }, error: (e: any) => this.notify.error(e?.error?.message || 'Save failed') }); }
    resetTemplate() { if (!this.current) return; this.http.post('/review-requests/template', { channelId: this.current.channelId, reset: true }).subscribe({ next: () => { this.notify.success('Reset to default'); this.loadTemplate(); }, error: () => this.notify.error('Failed') }); }
    previewSafe: SafeHtml | null = null;
    previewTemplate() { if (!this.current || !this.template) return; this.http.post<any>('/review-requests/template/preview', { channelId: this.current.channelId, subject: this.template.subject, body: this.template.body }).subscribe({ next: p => { this.preview = p; this.previewSafe = this.sanitizer.bypassSecurityTrustHtml(p?.html || ''); this.cdr.markForCheck(); }, error: () => this.notify.error('Preview failed') }); }
    safeHtml(html: string): SafeHtml { return this.sanitizer.bypassSecurityTrustHtml(html); }
    sendTest() {
        if (!this.current || !this.testEmail) return; this.testing = true;
        this.http.post<any>('/review-requests/test-send', { channelId: this.current.channelId, email: this.testEmail }).subscribe({
            next: r => { this.testing = false; r.ok ? this.notify.success('Test sent — check your inbox') : this.notify.error(r.reason || 'Send failed'); },
            error: err => { this.testing = false; this.notify.error(this.errMsg(err, 'Sending a test email', 'Send failed')); },
        });
    }

    onCustSearch() {
        clearTimeout(this.custTimer);
        const q = this.custQuery.trim();
        if (q.length < 2) { this.custResults = []; this.custSearching = false; return; }
        this.custSearching = true;
        this.custTimer = setTimeout(() => {
            this.http.get<any[]>(`/review-requests/customers/search?q=${encodeURIComponent(q)}`).subscribe({
                next: r => { this.custSearching = false; this.custResults = r; this.cdr.markForCheck(); },
                error: () => { this.custSearching = false; this.cdr.markForCheck(); },
            });
        }, 250);
    }
    excludeCustomer(c: any) {
        const name = [c.firstName, c.lastName].filter(Boolean).join(' ');
        this.http.post('/review-requests/exclusions', { type: 'email', value: c.email, note: name || 'customer' }).subscribe({
            next: () => { c.excluded = true; c.via = 'excluded'; this.loadExclusions(); this.notify.success(`Excluded ${c.email}`); this.cdr.markForCheck(); },
            error: () => this.notify.error('Failed to exclude'),
        });
    }

    addExclusion() { if (!this.newExcl.value) return; this.http.post('/review-requests/exclusions', this.newExcl).subscribe({ next: () => { this.newExcl = { type: 'email', value: '', note: '' }; this.loadExclusions(); }, error: () => this.notify.error('Failed to add') }); }
    removeExclusion(e: any) { this.http.delete(`/review-requests/exclusions/${e.id}`).subscribe({ next: () => { this.exclusions = this.exclusions.filter(x => x.id !== e.id); this.cdr.markForCheck(); }, error: () => this.notify.error('Failed') }); }
}
