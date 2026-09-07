/**
 * Campaign Web Push Service Worker
 * Place at the root scope — must be served from / (or configure serviceworker scope).
 * Handles push events, notification clicks/dismissals, and subscription change events.
 *
 * Version: 1.3.0
 */

'use strict';

// ── Notification inbox (IndexedDB) ──────────────────────────────────────────
//
// Every push payload is written here BEFORE showNotification() is even
// called, so a visitor who misses/dismisses the OS toast can still find it
// later inside the product — see notificationInbox.ts (the page-side reader)
// for the full design. Schema here MUST stay byte-identical to that file's
// DB_NAME/DB_VERSION/STORE_NAME/keyPath — they're two separate files opening
// the same on-origin IndexedDB database.
//
// Rows are removed the instant they're acted on: notificationclick deletes
// its own row below (the visitor engaged immediately, nothing left to surface
// later). notificationclose deliberately does NOT delete — a dismissed-without
// -clicking toast (or one that simply timed out; browsers don't reliably
// distinguish the two here) is exactly the case this feature exists to catch,
// so it stays recoverable in the inbox rather than being treated as "handled."
// Everything is pruned once it's 7 days old regardless — see pruneOldNotifications().

const INBOX_DB_NAME = 'campaign_notification_inbox';
const INBOX_DB_VERSION = 1;
const INBOX_STORE_NAME = 'notifications';
const INBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function openInboxDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(INBOX_DB_NAME, INBOX_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(INBOX_STORE_NAME)) {
        const store = db.createObjectStore(INBOX_STORE_NAME, { keyPath: 'id' });
        store.createIndex('timestamp', 'timestamp');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function saveInboxNotification(record) {
  return openInboxDb()
    .then(
      (db) =>
        new Promise((resolve) => {
          const tx = db.transaction(INBOX_STORE_NAME, 'readwrite');
          tx.objectStore(INBOX_STORE_NAME).put(record);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve(); // best-effort — never block showNotification() on this
        })
    )
    .catch(() => {});
}

function deleteInboxNotification(id) {
  if (!id) return Promise.resolve();
  return openInboxDb()
    .then(
      (db) =>
        new Promise((resolve) => {
          const tx = db.transaction(INBOX_STORE_NAME, 'readwrite');
          tx.objectStore(INBOX_STORE_NAME).delete(id);
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        })
    )
    .catch(() => {});
}

/**
 * Age-based, not calendar-based — runs opportunistically on every push/activate
 * (a SW has no persistent timer to run a literal "every Monday" job), so it's
 * cheap enough to just check every time rather than tracking a last-run date.
 */
function pruneOldInboxNotifications() {
  const cutoff = Date.now() - INBOX_MAX_AGE_MS;
  return openInboxDb()
    .then(
      (db) =>
        new Promise((resolve) => {
          const tx = db.transaction(INBOX_STORE_NAME, 'readwrite');
          const index = tx.objectStore(INBOX_STORE_NAME).index('timestamp');
          const range = IDBKeyRange.upperBound(cutoff);
          const cursorReq = index.openCursor(range);
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (cursor) {
              cursor.delete();
              cursor.continue();
            }
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
        })
    )
    .catch(() => {});
}

function broadcastInboxChanged() {
  try {
    new BroadcastChannel('campaign_notification_inbox').postMessage({ type: 'CAMPAIGN_INBOX_CHANGED' });
  } catch {
    // Unsupported — the widget just won't live-update across tabs.
  }
}

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

  const url      = payload.data?.url || '/';
  const title    = payload.title  || 'Notification';
  const body     = payload.body   || '';
  const tracking = payload.data?.tracking || null;
  // Default-on: only an explicit `false` opts a campaign out — absence must
  // behave as "store it" (see Campaign_Comms/channels/webpush/index.ts).
  const storeInInbox = payload.data?.store_in_inbox !== false;
  // Unique per push occurrence (not per campaign) — id is only ever used to
  // find-and-delete this exact row on notificationclick, never displayed.
  const notificationId = `${tracking?.campaign_id || 'n'}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

  const options = {
    body,
    icon:    payload.icon  || '/icons/icon-192.png',
    badge:   payload.badge || '/icons/badge-72.png',
    data:    { url, tracking, notificationId },
    vibrate: [200, 100, 200],
    requireInteraction: false,
  };

  event.waitUntil(Promise.all([
    self.registration.showNotification(title, options),
    reportWebPushStatus(url, tracking, 'delivered'),
    storeInInbox
      ? saveInboxNotification({ id: notificationId, title, body, url, tracking, timestamp: Date.now() }).then(broadcastInboxChanged)
      : Promise.resolve(),
    pruneOldInboxNotifications().then(broadcastInboxChanged),
  ]));
});

// ── Notification click ────────────────────────────────────────────────────────

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  const tracking = event.notification.data?.tracking;
  const notificationId = event.notification.data?.notificationId;

  event.waitUntil(
    Promise.all([
      reportWebPushStatus(url, tracking, 'clicked'),
      // Acted on immediately — nothing left to surface in the inbox later.
      deleteInboxNotification(notificationId).then(broadcastInboxChanged),
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
  // Deliberately does NOT delete the inbox row — a dismissed-without-clicking
  // toast stays recoverable in the inbox until acted on or aged out after 7 days.
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
self.addEventListener('activate', (event) => event.waitUntil(
  Promise.all([clients.claim(), pruneOldInboxNotifications().then(broadcastInboxChanged)])
));
