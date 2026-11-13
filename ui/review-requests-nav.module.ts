import { NgModule } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { SharedModule, NotificationService, registerBulkAction, addNavMenuItem, registerDashboardWidget } from '@vendure/admin-ui/core';

/**
 * Registers the "Review Requests" entry in the admin nav (Marketing
 * section), the dashboard widget (Dashboard → Add widget → Review
 * Requests) and the "Send review invitation" bulk action on the Orders
 * list (premium: the first 20 now, the rest in the background within the
 * hourly limit; opt-outs, exclusions and the cooldown apply). Gated on the
 * same permissions the page itself uses.
 */
@NgModule({
    imports: [SharedModule],
    providers: [
        addNavMenuItem(
            {
                id: 'hulo-vendure-plugin-review-requests',
                label: 'Review Requests',
                routerLink: ['/extensions/review-requests'],
                icon: 'star',
                requiresPermission: 'ReadSettings',
            },
            'marketing',
        ),
        registerDashboardWidget('hulo-vendure-plugin-review-requests', {
            title: 'Review Requests',
            supportedWidths: [4, 6, 8],
            requiresPermissions: ['ReadSettings'],
            loadComponent: () => import('./components/review-requests-widget.component').then(m => m.ReviewRequestsWidgetComponent),
        }),
        registerBulkAction({
            location: 'order-list',
            label: 'Send review invitation',
            icon: 'star',
            requiresPermission: 'UpdateSettings',
            onClick: ({ injector, selection, clearSelection }) => {
                const http = injector.get(HttpClient);
                const notify = injector.get(NotificationService);
                const orderIds = (selection || []).map((o: any) => Number(o.id)).filter((n: number) => Number.isInteger(n) && n > 0);
                if (!orderIds.length) return;
                http.post<any>('/review-requests/bulk-send', { orderIds }).subscribe({
                    next: r => { notify.success(`Review invitations: ${r?.message || 'done'}`); clearSelection(); },
                    error: e => notify.error(e?.status === 402
                        ? 'Sending review invitations for many orders needs a Review Requests licence (or the 14-day evaluation).'
                        : (e?.error?.message || 'Could not send the review invitations')),
                });
            },
        }),
    ],
})
export class ReviewRequestsNavModule {}
