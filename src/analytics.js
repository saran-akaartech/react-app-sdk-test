const events = [];
const listeners = new Set();

export function track(eventName, payload = {}) {
  const event = { eventName, payload, timestamp: new Date().toISOString() };
  events.push(event);
  console.log("[analytics]", event.eventName, event.payload);
  listeners.forEach((listener) => listener([...events]));
  return event;
}

export function getEvents() {
  return [...events];
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
