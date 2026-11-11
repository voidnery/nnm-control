# Webhooks

English · [Русский](../ru/Webhooks.md)

A webhook is an address of your program to which NNM-Control sends events by itself: a stream went down,
a server stopped answering, a playlist was deployed, a setting was changed. No need to poll the panel.
The event format is shared by Eterix products (`evt/1`).

## Subscription

1. **Access and audit → Webhooks → New subscription** (needs `webhooks.manage`).
2. **Name** and **Address** — `https://…`. Plain `http://` only with **Allow plain http://** ticked, and
   only inside your own network: without TLS anyone on the way can read and alter the event.
3. **Events** — which to send. None ticked — all.
4. **Create** and copy the **signing secret** right away: it is shown once.
5. **Test** — the panel sends a `webhook.test` event to this subscription only. The result is under
   **Deliveries**.

A username and password in the address are not accepted — the signature is there to prove authenticity.

## What arrives

A `POST` to your address, the body is JSON:

```json
{
  "schema_version": "evt/1",
  "id": "01JD3Z6M2Q4V8X0B1C2D3E4F5G",
  "type": "stream.down",
  "occurred_at": "2026-11-11T09:30:12Z",
  "product": "nnm-control",
  "instance": { "id": "01JC…", "name": "panel.example.net" },
  "subject": { "kind": "stream", "id": "live/news", "server_id": "6650…", "name": "live/news" },
  "actor": { "kind": "system", "name": "nnm-control" },
  "data": { "server": "edge-1", "missed_polls": 2 }
}
```

- `id` is unique per event. One event can arrive **more than once** (say, when your answer was lost on
  the way) — drop repeats by `id`.
- `instance` — which panel sent it. Its `id` is created at first start and does not change on updates.
- `actor` — who caused it: `user` (an operator in the panel), `token` (a program through the API) or
  `system` (the panel itself).
- Passwords, keys, tokens and credentials in addresses inside `data` are replaced with `***`.

Headers:

| Header | What is in it |
|---|---|
| `X-Eterix-Event` | the event type, as `type` |
| `X-Eterix-Delivery` | the event `id` |
| `X-Eterix-Timestamp` | send time, Unix seconds |
| `X-Eterix-Signature` | `v1=` and HMAC-SHA256 in hex |

## Checking the signature

The signature is computed over `<X-Eterix-Timestamp>.<the request body as is>` with the subscription's
secret. Check it against the **raw** body, before parsing JSON, and reject requests older than 5 minutes —
then an intercepted request cannot be replayed later.

Node.js:

```js
import crypto from 'node:crypto';

function verify(secret, headers, rawBody) {
  const ts = headers['x-eterix-timestamp'];
  const got = String(headers['x-eterix-signature'] || '');
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const want = 'v1=' + crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
```

Python:

```python
import hmac, hashlib, time

def verify(secret: str, headers, raw_body: bytes) -> bool:
    ts = headers.get('X-Eterix-Timestamp', '')
    got = headers.get('X-Eterix-Signature', '')
    if abs(time.time() - int(ts or 0)) > 300:
        return False
    want = 'v1=' + hmac.new(secret.encode(), ts.encode() + b'.' + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(got, want)
```

## Answer and retries

- Answer `2xx` fast — within 10 seconds. Do long work after answering.
- Any other answer, a timeout or a broken connection is a failure. Retries: after 1 min, 5 min, 30 min,
  2 h, 6 h and 12 h — about a day in total; then the delivery is marked given up.
- Redirects (`3xx`) are not followed and count as a failure — give the final address.
- After 50 failures in a row the subscription is **turned off** with the reason. Fix the receiver and
  click **Turn on** — the counter resets.
- **Deliveries** — the last 100 attempts of a subscription: answer code, error, start of the answer;
  **Send again** — repeat with the same `id`.
- The delivery log and the events are kept 30 days. Anything missed can be caught up through
  [`GET /api/v1/events`](API.md#event-log).

## Where the panel does not send

So that a subscription cannot be used to reach the panel's own internal services, the address is checked
after name resolution — on every attempt, for every address of the name — and the connection goes to
exactly the checked address. Refused if the address is:

- loopback (`127.0.0.0/8`, `::1`) or the panel's own machine;
- link-local (`169.254.0.0/16`, `fe80::/10`), including cloud metadata addresses;
- multicast, broadcast, `0.0.0.0`.

Private networks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) are allowed: receivers usually live
there.

## Watching servers and streams

The same page holds the poll that produces the `server.*` and `stream.*` events: whether it is on, how
often to poll (every 30 s by default), after how many misses in a row a server or stream counts as gone (2
by default). Details — [Events and reactions](Events-and-reactions.md).
