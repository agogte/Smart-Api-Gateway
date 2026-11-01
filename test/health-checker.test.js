const test = require("node:test");
const assert = require("node:assert");
const { HealthChecker, HealthStatus } = require("../health-checker");
const { startServer, json } = require("./helpers");

const checker = (servers, options = {}) => new HealthChecker(servers, { logging: false, ...options });

test("marks a server healthy or degraded from its /health response", async (t) => {
  const healthy = await startServer(json(200, { status: "healthy", cpu: 12 }));
  const degraded = await startServer(json(200, { status: "degraded", cpu: 80 }));
  t.after(() => Promise.all([healthy.close(), degraded.close()]));

  const hc = checker([healthy.url, degraded.url]);
  await hc.checkAll();

  assert.strictEqual(hc.getStatus(healthy.url), HealthStatus.HEALTHY);
  assert.strictEqual(hc.getStatus(degraded.url), HealthStatus.DEGRADED);
  assert.strictEqual(hc.getCpu(healthy.url), 12);
  assert.strictEqual(hc.getCpu(degraded.url), 80);
  assert.deepStrictEqual(hc.getAvailableServers(), [healthy.url, degraded.url]);
});

test("a server that has never passed is unhealthy after its first failure", async (t) => {
  const failing = await startServer(json(503, { status: "unhealthy", cpu: 99 }));
  t.after(() => failing.close());

  const hc = checker([failing.url]);
  assert.strictEqual(hc.getStatus(failing.url), HealthStatus.UNKNOWN);
  await hc.checkAll();
  assert.strictEqual(hc.getStatus(failing.url), HealthStatus.UNHEALTHY);
  assert.deepStrictEqual(hc.getAvailableServers(), []);
});

test("needs consecutive failures to go down and consecutive successes to come back", async (t) => {
  const server = await startServer(json(200, { status: "healthy", cpu: 20 }));
  t.after(() => server.close());
  const hc = checker([server.url], { unhealthyThreshold: 2, healthyThreshold: 2 });

  await hc.checkAll();
  assert.strictEqual(hc.getStatus(server.url), HealthStatus.HEALTHY);

  server.handler = json(503, { status: "unhealthy" });
  await hc.checkAll();
  assert.strictEqual(hc.getStatus(server.url), HealthStatus.HEALTHY, "one failure is not enough");
  await hc.checkAll();
  assert.strictEqual(hc.getStatus(server.url), HealthStatus.UNHEALTHY);

  server.handler = json(200, { status: "healthy", cpu: 20 });
  await hc.checkAll();
  assert.strictEqual(hc.getStatus(server.url), HealthStatus.UNHEALTHY, "one success is not enough");
  await hc.checkAll();
  assert.strictEqual(hc.getStatus(server.url), HealthStatus.HEALTHY);
});

test("treats a 200 that reports status unhealthy as a failure", async (t) => {
  const server = await startServer(json(200, { status: "unhealthy", cpu: 50 }));
  t.after(() => server.close());
  const hc = checker([server.url]);
  await hc.checkAll();
  assert.strictEqual(hc.getStatus(server.url), HealthStatus.UNHEALTHY);
});

test("treats a slow response as a failure", async (t) => {
  const slow = await startServer((req, res) => setTimeout(() => json(200, { status: "healthy" })(req, res), 300));
  t.after(() => slow.close());
  const hc = checker([slow.url], { timeout: 50 });
  await hc.checkAll();
  assert.strictEqual(hc.getStatus(slow.url), HealthStatus.UNHEALTHY);
});

test("treats a refused connection as a failure and records a CPU gap", async () => {
  const closed = await startServer(() => {});
  await closed.close();
  const hc = checker([closed.url]);
  await hc.checkAll();
  const entry = hc.snapshot()[closed.url];
  assert.strictEqual(entry.status, HealthStatus.UNHEALTHY);
  assert.strictEqual(entry.history[0].cpu, null);
});

test("keeps a bounded history and counts passed checks", async (t) => {
  const server = await startServer(json(200, { status: "healthy", cpu: 5 }));
  t.after(() => server.close());
  const hc = checker([server.url], { historySize: 3 });
  for (let i = 0; i < 5; i++) await hc.checkAll();

  const entry = hc.snapshot()[server.url];
  assert.strictEqual(entry.history.length, 3);
  assert.strictEqual(entry.checks, 5);
  assert.strictEqual(entry.passedChecks, 5);
});
