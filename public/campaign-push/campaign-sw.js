/**
 * Campaign Web Push Service Worker
 * Place at the root scope — must be served from / (or configure serviceworker scope).
 * Handles push events, notification clicks/dismissals, and subscription change events.
 *
 * Version: 1.2.0
 */

'use strict';

// ── Delivery/click/dismiss tracking ─────────────────────────────────────────
//
// Comms_WebPush's Message_Status='sent' only ever meant "handed off to the
// push service" at send time — this is the first genuine client-side
// confirmation the notification actually reached the device (the 'push'
// event), that the visitor clicked it ('notificationclick'), or dismissed it
// without clicking ('notificationclose').
//
// campaign_id: Campaign_Comms embeds it explicitly in the payload's
// `data.tracking.campaign_id` when it has a cached write key for the client —
// preferred when present since it's structured and doesn't depend on the
// target URL being well-formed. Falls back to parsing it out of the
// notification's own URL query string (`?campaignid=...` — no underscore,
// that's the actual param name on the target URL, distinct from the
// campaign_id field name used everywhere else internally), which is also set
// at send time and survives even if `tracking` wasn't embedded for some
// reason (e.g. no cached write key yet).
//
// Best-effort throughout: a failed/blocked network call here must never stop
// the notification from displaying or the click from opening its target.
function parseCampaignIdFromUrl(url) {
  try {
    return new URL(url, self.location.origin).searchParams.get('campaignid') || undefined;
  } catch {
    return undefined;
  }
}

function reportWebPushStatus(url, tracking, eventName) {
  if (!tracking || !tracking.ingest_url || !tracking.write_key) return Promise.resolve();
  const campaignId = tracking.campaign_id || parseCampaignIdFromUrl(url);
  if (!campaignId || !tracking.anonymous_id) return Promise.resolve();

  return fetch(tracking.ingest_url.replace(/\/$/, '') + '/v1/webpush/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-write-key': tracking.write_key },
    body: JSON.stringify({
      client_id: tracking.client_id,
      campaign_id: campaignId,
      campaign_schedule_sequence_id: tracking.campaign_schedule_sequence_id,
      end_user_sequence_id: tracking.end_user_sequence_id,
      anonymous_id: tracking.anonymous_id,
      event: eventName,
    }),
  }).catch(() => {});
}

// ── Push received ─────────────────────────────────────────────────────────────

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: event.data.text(), body: '' };
  }

  const url = payload.data?.url || '/';
  const title   = payload.title  || 'Notification';
  const options = {
    body:    payload.body  || '',
    icon:    payload.icon  || '/icons/icon-192.png',
    badge:   payload.badge || '/icons/badge-72.png',
    data:    { url, tracking: payload.data?.tracking || null },
    vibrate: [200, 100, 200],
    requireInteraction: false,
  };

  event.waitUntil(Promise.all([
    self.registration.showNotification(title, options),
    reportWebPushStatus(url, payload.data?.tracking, 'delivered'),
  ]));
});

// ── Notification click ────────────────────────────────────────────────────────

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  const tracking = event.notification.data?.tracking;

  event.waitUntil(
    Promise.all([
      reportWebPushStatus(url, tracking, 'clicked'),
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
        for (const client of windowClients) {
          if (client.url === url && 'focus' in client) {
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(url);
        }
      }),
    ])
  );
});

// ── Notification dismissed without clicking ────────────────────────────────────

self.addEventListener('notificationclose', (event) => {
  const url = event.notification.data?.url || '/';
  const tracking = event.notification.data?.tracking;
  event.waitUntil(reportWebPushStatus(url, tracking, 'discarded'));
});

// ── Subscription change (browser auto-refreshed the subscription) ─────────────

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    self.registration.pushManager.subscribe({
      userVisibleOnly:      true,
      applicationServerKey: event.oldSubscription?.options?.applicationServerKey,
    }).then((newSubscription) => {
      // Notify the page so it can re-register the new subscription
      return clients.matchAll({ type: 'window' }).then((windowClients) => {
        for (const client of windowClients) {
          client.postMessage({
            type: 'CAMPAIGN_SUBSCRIPTION_CHANGED',
            subscription: newSubscription.toJSON(),
          });
        }
      });
    })
  );
});

// ── Install & activate (no caching — this is a push-only SW) ─────────────────

self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(clients.claim()));
