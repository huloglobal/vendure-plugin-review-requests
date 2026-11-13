import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { UntypedFormGroup } from '@angular/forms';
import { Observable, Subscription } from 'rxjs';
import { CustomDetailComponent, NotificationService, SharedModule } from '@vendure/admin-ui/core';

/**
 * Review-invitation panel on the admin order-detail page: shows whether
 * this order's customer has been invited to review, and lets staff send
 * the invitation manually (free: exclusions, the cooldown and the hourly
 * limit apply) or force-resend it (Resend, premium). Opt-outs are always
 * honoured server-side. Colours adapt to the admin light/dark theme.
 */
@Component({
    selector: 'hulo-order-review-panel',
    changeDetection: ChangeDetectionStrategy.OnPush,
    standalone: true,
    imports: [SharedModule],
    template: `
    <div class="rev-card" *ngIf="status?.found">
        <div class="rev-head">
            <span class="rev-title">⭐ Review invitation</span>
            <span class="chip sent" *ngIf="status.sent">Sent {{ lastSentAt | date: 'd MMM y' }}</span>
            <span class="chip none" *ngIf="!status.sent && !status.optedOut">Not sent</span>
            <span class="chip warn" *ngIf="status.optedOut">Customer opted out</span>
            <span class="chip warn" *ngIf="!status.optedOut && status.excluded">Excluded</span>
        </div>
        <div class="rev-body">
            <div class="rev-line" *ngIf="status.optedOut">
                This customer unsubscribed from review emails — manual sending is disabled.
            </div>
            <div class="rev-line" *ngIf="!status.optedOut && status.notReady">
                Set your review page first (Marketing → Review Requests → Settings). Nothing is sent until then.
            </div>
            <div class="rev-line" *ngIf="!status.optedOut && !status.sent && !status.excluded && status.cooldown">
                This customer was invited in the last {{ status.cooldownDays }} days (cooldown).
            </div>
            <div class="rev-actions" *ngIf="!status.optedOut && !status.notReady">
                <button type="button" class="act-btn primary" *ngIf="!status.sent && !status.excluded && !status.cooldown" (click)="send(false)" [disabled]="sending">
                    {{ sending ? 'Sending…' : 'Send invitation now' }}
                </button>
                <span class="hint-inline" *ngIf="!status.premium && (status.sent || status.excluded || status.cooldown)">Resend needs a licence.</span>
                <ng-container *ngIf="status.premium && !status.sent && (status.excluded || status.cooldown)">
                    <button type="button" class="act-btn" *ngIf="!confirmResend" (click)="confirmResend = true" [disabled]="sending">Send anyway…</button>
                    <ng-container *ngIf="confirmResend">
                        <span class="confirm-note">{{ status.excluded ? 'This customer/domain is excluded' : 'This customer is in the cooldown' }} — send regardless?</span>
                        <button type="button" class="act-btn primary" (click)="send(true)" [disabled]="sending">{{ sending ? 'Sending…' : 'Yes, send' }}</button>
                        <button type="button" class="act-btn" (click)="confirmResend = false" [disabled]="sending">Cancel</button>
                    </ng-container>
                </ng-container>
                <ng-container *ngIf="status.sent && status.premium">
                    <button type="button" class="act-btn" *ngIf="!confirmResend" (click)="confirmResend = true" [disabled]="sending">Resend…</button>
                    <ng-container *ngIf="confirmResend">
                        <span class="confirm-note">Email the customer again?</span>
                        <button type="button" class="act-btn primary" (click)="send(true)" [disabled]="sending">{{ sending ? 'Sending…' : 'Yes, resend' }}</button>
                        <button type="button" class="act-btn" (click)="confirmResend = false" [disabled]="sending">Cancel</button>
                    </ng-container>
                </ng-container>
            </div>
            <ul class="hist" *ngIf="status.history?.length">
                <li *ngFor="let h of status.history.slice(0, 4)">
                    <span class="h-status" [class.ok]="h.status === 'sent'" [class.bad]="h.status === 'failed'">{{ h.status }}</span>
                    <span class="h-reason">{{ h.reason || '—' }}</span>
                    <span class="h-date">{{ h.createdAt | date: 'd MMM HH:mm' }}</span>
                </li>
            </ul>
        </div>
    </div>
    `,
    styles: [`
        .rev-card { margin: 12px 0; padding: 14px 16px; border-radius: 10px; border: 1px solid #e2e8f0; background: #ffffff; font-size: 13px; color: #0f172a; }
        .rev-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .rev-title { font-weight: 700; font-size: 13.5px; }
        .chip { padding: 2px 10px; border-radius: 999px; font-size: 11.5px; font-weight: 700; }
        .chip.sent { background: #ecfdf5; color: #065f46; border: 1px solid #34d399; }
        .chip.none { background: #f1f5f9; color: #475569; border: 1px solid #cbd5e1; }
        .chip.warn { background: #fffbeb; color: #92400e; border: 1px solid #fbbf24; }
        .rev-body { margin-top: 8px; }
        .rev-line { color: #475569; }
        .rev-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
        .act-btn { background: #fff; border: 1px solid #cbd5e1; border-radius: 7px; padding: 4px 12px; font-size: 12.5px; cursor: pointer; color: #334155; }
        .act-btn:hover:not(:disabled) { background: #f1f5f9; }
        .act-btn.primary { background: #1d4ed8; border-color: #1d4ed8; color: #fff; }
        .act-btn.primary:hover:not(:disabled) { background: #1e40af; }
        .act-btn:disabled { opacity: .6; cursor: default; }
        .confirm-note { font-weight: 600; color: #92400e; }
        .hint-inline { color: #94a3b8; font-size: 12px; }
        .hist { list-style: none; margin: 10px 0 0; padding: 0; }
        .hist li { display: flex; gap: 10px; align-items: baseline; padding: 2px 0; font-size: 12px; }
        .h-status { font-weight: 700; min-width: 52px; color: #64748b; }
        .h-status.ok { color: #059669; }
        .h-status.bad { color: #dc2626; }
        .h-reason { color: #64748b; flex: 1; }
        .h-date { color: #94a3b8; }

        :host-context([data-theme='dark']) .rev-card { background: #1e293b; border-color: #334155; color: #e2e8f0; }
        :host-context([data-theme='dark']) .chip.none { background: rgba(148,163,184,.12); color: #cbd5e1; border-color: #475569; }
        :host-context([data-theme='dark']) .chip.sent { background: rgba(52,211,153,.12); color: #6ee7b7; }
        :host-context([data-theme='dark']) .chip.warn { background: rgba(251,191,36,.12); color: #fcd34d; }
        :host-context([data-theme='dark']) .rev-line, :host-context([data-theme='dark']) .h-reason { color: #94a3b8; }
        :host-context([data-theme='dark']) .act-btn { background: #0f172a; border-color: #475569; color: #cbd5e1; }
        :host-context([data-theme='dark']) .act-btn:hover:not(:disabled) { background: #334155; }
        :host-context([data-theme='dark']) .act-btn.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
        :host-context([data-theme='dark']) .h-status { color: #94a3b8; }
        :host-context([data-theme='dark']) .h-status.ok { color: #6ee7b7; }
        :host-context([data-theme='dark']) .h-status.bad { color: #fca5a5; }
    `],
})
export class OrderReviewPanelComponent implements CustomDetailComponent, OnInit, OnDestroy {
    entity$: Observable<any>;
    detailForm: UntypedFormGroup;

    status: any = null;
    sending = false;
    confirmResend = false;
    private orderId: number | null = null;
    private sub: Subscription | null = null;

    constructor(private http: HttpClient, private notify: NotificationService, private cdr: ChangeDetectorRef) {}

    ngOnInit() {
        this.sub = this.entity$.subscribe(order => {
            if (!order?.id || this.orderId === Number(order.id)) return;
            this.orderId = Number(order.id);
            this.load();
        });
    }

    ngOnDestroy() { this.sub?.unsubscribe(); }

    get lastSentAt(): string | null {
        const sent = (this.status?.history || []).find((h: any) => h.status === 'sent');
        return sent?.createdAt || null;
    }

    private load() {
        if (!this.orderId) return;
        this.http.get<any>(`/review-requests/order-status/${this.orderId}`).subscribe({
            next: s => { this.status = s; this.cdr.markForCheck(); },
            error: () => undefined,
        });
    }

    send(force: boolean) {
        if (!this.orderId) return;
        this.sending = true;
        this.confirmResend = false;
        this.http.post<any>(`/review-requests/send-order/${this.orderId}`, { force }).subscribe({
            next: r => {
                this.sending = false;
                this.notify.success('Review invitation sent');
                this.load();
                this.cdr.markForCheck();
            },
            error: e => {
                this.sending = false;
                this.notify.error(e?.error?.reason || e?.error?.message || 'Could not send the invitation');
                this.load();
                this.cdr.markForCheck();
            },
        });
    }
}
