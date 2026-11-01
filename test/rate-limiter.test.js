const test = require("node:test");
const assert = require("node:assert");
const { rateLimiter, RateLimiterAlgorithm } = require("../rate-limiter");

// Runs the middleware once and reports whether it let the request through.
const hit = (middleware, ip) => {
  let status = null;
  let passed = false;
  const res = {
    status(code) { status = code; return this; },
    json() { return this; },
  };
  middleware({ ip }, res, () => { passed = true; });
  return passed ? 200 : status;
};

for (const algorithm of Object.values(RateLimiterAlgorithm)) {
  test(`${algorithm}: allows up to the limit, then returns 429`, () => {
    const limiter = rateLimiter(3, 60_000, algorithm);
    const ip = `10.0.0.${algorithm.length}`;
    assert.deepStrictEqual([1, 2, 3, 4].map(() => hit(limiter, ip)), [200, 200, 200, 429]);
  });

  test(`${algorithm}: tracks each client IP separately`, () => {
    const limiter = rateLimiter(1, 60_000, algorithm);
    assert.strictEqual(hit(limiter, `${algorithm}-a`), 200);
    assert.strictEqual(hit(limiter, `${algorithm}-a`), 429);
    assert.strictEqual(hit(limiter, `${algorithm}-b`), 200);
  });
}

test("token-bucket: refills over time", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const limiter = rateLimiter(2, 1000, RateLimiterAlgorithm.TOKEN_BUCKET);
  assert.strictEqual(hit(limiter, "refill"), 200);
  assert.strictEqual(hit(limiter, "refill"), 200);
  assert.strictEqual(hit(limiter, "refill"), 429);
  t.mock.timers.tick(500); // 2 tokens per second -> 1 token back
  assert.strictEqual(hit(limiter, "refill"), 200);
  assert.strictEqual(hit(limiter, "refill"), 429);
});

test("sliding-window: frees a slot once the oldest request leaves the window", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 2_000_000 });
  const limiter = rateLimiter(1, 1000, RateLimiterAlgorithm.SLIDING_WINDOW);
  assert.strictEqual(hit(limiter, "window"), 200);
  t.mock.timers.tick(999);
  assert.strictEqual(hit(limiter, "window"), 429);
  t.mock.timers.tick(1);
  assert.strictEqual(hit(limiter, "window"), 200);
});
