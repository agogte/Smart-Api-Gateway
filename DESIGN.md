# Design Decisions

This document justifies the non-obvious choices made in the Smart API Gateway. Each section follows the same format: the decision, the alternatives considered, and why this option wins in production.

---

## 1. Why 302 (Temporary Redirect) instead of 301 (Permanent Redirect)

### The gateway doesn't redirect — and that's intentional

The gateway proxies requests using `http-proxy`. The client sends one request to `http://localhost:5001`, the gateway forwards it to a backend, and the response flows back transparently. No redirect is issued. This is the correct architecture for a load balancer.

But the 302-vs-301 question matters for two real scenarios in this kind of gateway:

### Scenario A: Health-redirect fallback

If all backends are down and we wanted to redirect users to a static error page or a CDN-hosted maintenance page, we'd issue a redirect. It must be 302.

A 301 is permanent: browsers and CDNs cache it indefinitely (often ignoring `Cache-Control` and `Expires` headers). Once the backends recover, a client that received a 301 continues hitting the maintenance page until their cache expires or they manually clear it. You've lost the ability to route them back. A 302 is temporary: every request re-checks the origin, so when the gateway comes back up, traffic resumes immediately.

### Scenario B: Redirect-based load balancing

A simpler (and weaker) form of load balancing issues 302 redirects pointing directly at backend URLs. Clients follow the redirect and land on a specific backend. Again, 301 breaks this: the client caches the backend URL and bypasses the load balancer for all future requests. That means:

- The circuit breaker never sees traffic to a dead backend — it can't trip.
- Session state in the load balancer (rate limiting, sticky sessions) is bypassed.
- Removing or reweighting a backend has no effect on clients with cached 301s.

With 302, every request goes through the gateway first. The load balancer stays in the critical path.

### The rule

**Use 301 only when the destination is guaranteed to never change.** For anything a load balancer controls — backends that can fail, routes that can be reweighted, maintenance pages that are temporary — 302 is the correct choice. The caching semantics of 301 trade control for performance; in a dynamic routing layer, that trade is always wrong.

---

## 2. Token bucket vs sliding window rate limiting

The gateway supports two rate limiting algorithms selectable via `RateLimiterAlgorithm`. The right choice depends on what traffic shape you want to allow.

### How they differ

**Sliding window** tracks the exact timestamps of recent requests. A request is allowed only if fewer than `rateLimit` requests occurred in the last `windowSize` ms. The window is continuous — it moves forward with each request rather than resetting on a fixed schedule.

**Token bucket** maintains a counter per IP that drains by 1 per request and refills continuously at `rateLimit / windowSize` tokens per ms up to a maximum of `rateLimit`. A request is allowed as long as at least 1 token is available.

### The key behavioral difference: bursts

Sliding window is strict about the request *count* over time. If the limit is 5 per minute and a client sends 5 requests at T=0, the 6th request is rejected until T=60 regardless of how much time has passed since then.

Token bucket allows bursts up to the bucket capacity. A client that has been idle accumulates tokens (up to the cap). When they suddenly send a burst of requests, they consume banked tokens and all of them go through — as long as the bucket isn't empty. Once empty, new requests are rejected until tokens refill.

### When to use each

Use **sliding window** when you want strict, predictable enforcement — e.g. protecting a billing or auth endpoint where any burst above the limit is suspicious.

Use **token bucket** when occasional bursts are legitimate and you want to reward well-behaved clients that space out their requests. It's the better default for a general-purpose API gateway where clients may batch work or reconnect after a pause.

The current default in `Api.js` is token bucket.

---

## 3. Why Redis TTL of 1 hour

### Context: the rate limiter currently uses in-memory state

`rate-limiter.js` stores per-IP state in `Map` objects keyed by client IP — timestamps for sliding window, `{ tokens, lastRefill }` for token bucket. This works in development but has two production problems:

1. **Single-process.** Scale to multiple gateway instances and each has its own counter. A client can make 5 requests to instance A and 5 more to instance B — 10 total, none rejected.
2. **No persistence.** A gateway restart resets all counters. An attacker who knows the restart schedule can exploit the window.

Production would move rate-limit state into Redis and share it across all instances.

### The window is 60 seconds — why 3600 seconds (1 hour) TTL?

The intuitive choice is a TTL equal to the window size (60 seconds). That's wrong for three reasons.

**Clock drift and skew.** Redis TTL is set when the key is written, based on the node's clock. If a key is created at T=0 with TTL=60, Redis expires it at T=60. But for sliding window, the rate limiter resets the window relative to the *oldest timestamp in the array*, not the key creation time. For token bucket, the refill calculation depends on `lastRefill`, which is also wall-clock time. If the Redis clock and the Node.js clock are 1 second apart, the key expires before the window is exhausted and a client gets a free reset. A TTL of 1 hour eliminates this class of bug entirely — the key outlives any reasonable clock skew.

**Burst behavior at window boundaries.** With a TTL equal to the window, a client that sends 5 requests at T=59 (one second before expiry) gets their counter reset at T=60. They can immediately send 5 more. The sliding window is supposed to prevent this, but only if the key survives long enough to track the timestamps. A longer TTL guarantees the key is present when the window logic runs.

**Memory cost is negligible.** A rate-limit key stores an array of at most 5 timestamps (integers, 8 bytes each). One million active clients = ~40 MB. Redis easily handles this even at 1-hour TTL. The cost of correctness is near-zero.

### Why not infinite TTL?

We don't want keys to live forever. An IP that makes one request and disappears should eventually be cleaned up. One hour covers any realistic user session — someone browning for 90 minutes would get a fresh counter anyway since their timestamps roll out of the sliding window. The TTL is a garbage-collection mechanism, not a reset trigger.

### The pattern generalizes

The same reasoning applies to other stateful data in the gateway:

| State | Window | TTL | Rationale |
|---|---|---|---|
| Rate limit counter | 60s | 1h | Safety margin against clock drift |
| Sticky session affinity | session | 1h | Match typical user session length |

---

## 4. Consistent hash ring for client-sticky routing

### The problem with round robin and random for stateful backends

Round robin and random both ignore the client entirely — the same client can land on a different backend on every request. That's fine when backends are stateless, but it breaks down the moment a backend holds per-client state in memory (an in-process cache, a session, a WebSocket upgrade): every request that lands on the "wrong" backend is a cache miss or a dropped session.

### Why not just hash `clientIp % serverCount`?

A naive modulo hash gives the same stickiness, but it has a scaling failure mode: adding or removing a single backend changes `serverCount`, which changes the modulo result for almost every client. Effectively the entire client population gets reshuffled across backends at once — exactly when you're scaling (the moment you can least afford a cache stampede).

### How the ring fixes this

Each backend is hashed (MD5) onto 100 points ("virtual nodes") around a fixed circular keyspace. A client is hashed onto the same keyspace, and we walk clockwise to the nearest backend node. Adding or removing one backend only remaps the slice of the ring owned by that backend's virtual nodes — roughly `1/serverCount` of clients — not the whole ring. This is the standard trade-off consistent hashing makes: a little uneven load distribution (mitigated by the 100 virtual nodes per server) in exchange for minimal remapping on topology change.

### Why client IP as the hash key

`req.ip` is what's available without requiring clients to send a session token, and it's stable for the lifetime of a TCP connection, which is enough to keep a given client on one backend across requests. The trade-off: clients behind a shared NAT or corporate proxy hash identically and pile onto the same backend. If that matters, switch the key to a session/auth token instead of IP — the ring logic doesn't care what the key represents.

### When to use this vs round robin/random

Use consistent hashing only when backend state actually depends on the client landing on the same server. For genuinely stateless backends, round robin's even distribution and simplicity win — the ring adds complexity (virtual nodes, MD5 hashing, ring rebuilds on `setServers`) that buys nothing if there's no state to be sticky about.

---

## 5. Why proxy (not redirect) as the core architecture

Using `http-proxy` instead of redirect-based load balancing has three systemic advantages:

**The load balancer stays in the critical path for every request.** Circuit breakers can trip. Rate limiters can count. Logging can capture latency. None of this is possible if the client holds a cached redirect to a backend.

**Backend URLs are internal implementation details.** Clients only ever see `http://localhost:5001`. You can add, remove, or replace backends without any client-side change. A redirect-based design leaks the backend topology to clients.

**Response transformation is possible.** Injecting headers, rewriting responses, and streaming partial results all require the proxy to see the response bytes. Redirects hand control to the client — the gateway gets no further visibility into what the backend returned.

The tradeoff is latency: every request makes two TCP connections (client→gateway, gateway→backend) instead of one. For a service where backends and gateway are colocated (same VPC or same machine), this round-trip cost is under 1ms and worth the control it buys.

---

## 6. Health checks and health/CPU-based routing

### Active checks with thresholds

The gateway polls each backend's `/health` endpoint on a fixed interval instead of inferring health from live traffic. That way a backend is taken out of rotation before real users hit it, and it can be detected as recovered without sending users to it as a test. A server needs 2 consecutive failures to be marked unhealthy and 2 consecutive successes to come back. A single threshold of 1 would flap a server in and out on every lost packet; higher thresholds make the gateway slower to react. Two is a common middle ground.

### Health-based: tiers, not weights

`healthy` servers always win over `degraded` ones, and `degraded` servers are only a fallback. A degraded server usually means "I'm still answering but something is wrong" (a slow dependency, a full disk), so sending it a share of traffic just spreads the problem. Keeping it in reserve means users still get an answer if every healthy server drops out.

### CPU-based: weighted random instead of least-loaded

CPU numbers are only as fresh as the last health check (5s by default). If the gateway always picked the server with the lowest reported CPU, every request in that 5s window would land on the same backend. Its CPU would spike, the next check would pick a different server, and load would swing between backends. Weighting by headroom (`100 - cpu`) still sends most traffic to lightly loaded servers, but spreads it, so the stale reading does less damage.
