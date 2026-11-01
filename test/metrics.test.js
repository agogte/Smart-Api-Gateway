const test = require("node:test");
const assert = require("node:assert");
const { MetricsCollector } = require("../metrics");
const { HealthChecker } = require("../health-checker");
const { rateLimiter, RateLimiterAlgorithm } = require("../rate-limiter");
const { startApp } = require("./helpers");

const servers = ["http://a", "http://b"];
const healthChecker = () => new HealthChecker(servers, { logging: false });

test("counts outcomes and attributes requests to servers", () => {
  const metrics = new MetricsCollector();
  metrics.record("http://a", 200, 10);
  metrics.record("http://a", 502, 30);
  metrics.record("http://b", 200, 20);
  metrics.record(undefined, 429, 1);

  const snap = metrics.snapshot(healthChecker(), "round-robin");
  assert.deepStrictEqual(snap.totals, { requests: 4, success: 2, rateLimited: 1, errors: 1 });
  assert.strictEqual(snap.strategy, "round-robin");

  const [a, b] = snap.servers;
  assert.deepStrictEqual([a.requests, a.errors, a.avgLatency], [2, 1, 20]);
  assert.deepStrictEqual([b.requests, b.errors, b.avgLatency], [1, 0, 20]);
});

test("computes latency percentiles", () => {
  const metrics = new MetricsCollector();
  for (let ms = 1; ms <= 100; ms++) metrics.record("http://a", 200, ms);
  const { latency } = metrics.snapshot(healthChecker(), "x");
  assert.deepStrictEqual(latency, { avg: 50.5, p50: 51, p95: 96, p99: 100 });
});

test("returns a zero-filled per-second timeseries", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  const metrics = new MetricsCollector({ timeseriesSeconds: 5 });
  metrics.record("http://a", 200, 1);
  t.mock.timers.tick(3000);
  metrics.record("http://a", 429, 1);

  const { timeseries } = metrics.snapshot(healthChecker(), "x");
  assert.strictEqual(timeseries.length, 5);
  assert.deepStrictEqual(timeseries.map((b) => b.success + b.rateLimited), [0, 1, 0, 0, 1]);
  assert.deepStrictEqual(timeseries.map((b) => b.t - timeseries[0].t), [0, 1000, 2000, 3000, 4000]);
});

test("middleware records rate-limited requests and the chosen backend", async (t) => {
  const metrics = new MetricsCollector();
  const lb = await startApp((app) => app.get("/",
    metrics.middleware(),
    rateLimiter(2, 60_000, RateLimiterAlgorithm.SLIDING_WINDOW),
    (req, res) => { res.locals.target = "http://a"; res.send("ok"); }));
  t.after(() => lb.close());

  for (let i = 0; i < 3; i++) await (await fetch(`${lb.url}/`)).text();
  await new Promise((r) => setImmediate(r)); // let the last "finish" event fire

  const snap = metrics.snapshot(healthChecker(), "x");
  assert.deepStrictEqual(snap.totals, { requests: 3, success: 2, rateLimited: 1, errors: 0 });
  assert.strictEqual(snap.servers[0].requests, 2);
});
