const test = require("node:test");
const assert = require("node:assert");
const { LoadBalancerBuilder, LoadBalancerAlgorithm } = require("../loadbalancing-algorithms");
const { HealthChecker, HealthStatus } = require("../health-checker");
const { startBackend, startApp, startServer, quiet } = require("./helpers");

// Stand-in for HealthChecker with fixed status/CPU per server.
const fakeHealth = (entries) => ({
  getStatus: (s) => entries[s]?.status ?? HealthStatus.UNKNOWN,
  getCpu: (s) => entries[s]?.cpu ?? null,
  getAvailableServers: () => Object.keys(entries).filter((s) =>
    [HealthStatus.HEALTHY, HealthStatus.DEGRADED].includes(entries[s].status)),
});

const startBalancer = async (t, servers, strategy, healthChecker) => {
  const handler = new LoadBalancerBuilder()
    .setServers(servers)
    .setHealthChecker(healthChecker)
    .setStrategy(strategy)
    .build();
  const lb = await startApp((app) => app.get("/", handler));
  t.after(() => lb.close());
  return lb;
};

// Sends n requests and returns which backend answered each one.
const send = async (lb, n) => {
  const answers = [];
  for (let i = 0; i < n; i++) {
    const res = await fetch(`${lb.url}/`);
    answers.push(res.status === 200 ? await res.text() : res.status);
  }
  return answers;
};

const count = (answers) => answers.reduce((acc, a) => ({ ...acc, [a]: (acc[a] || 0) + 1 }), {});

const startBackends = async (t, n) => {
  const backends = await Promise.all(Array.from({ length: n }, () => startBackend()));
  t.after(() => Promise.all(backends.map((b) => b.close())));
  return backends.map((b) => b.url);
};

test("builder rejects an empty server list and unknown strategies", () => {
  assert.throws(() => new LoadBalancerBuilder().setServers([]));
  assert.throws(() => new LoadBalancerBuilder().setStrategy("nope"));
});

for (const strategy of [LoadBalancerAlgorithm.HEALTH_BASED, LoadBalancerAlgorithm.CPU_BASED]) {
  test(`${strategy} requires a health checker`, () => {
    const builder = new LoadBalancerBuilder().setServers(["http://localhost:1"]).setStrategy(strategy);
    assert.throws(() => builder.build(), /requires a health checker/);
  });
}

test("round robin cycles through servers in order", async (t) => {
  quiet(t);
  const servers = await startBackends(t, 3);
  const lb = await startBalancer(t, servers, LoadBalancerAlgorithm.ROUND_ROBIN);
  assert.deepStrictEqual(await send(lb, 6), [...servers, ...servers]);
});

test("random only routes to configured servers", async (t) => {
  quiet(t);
  const servers = await startBackends(t, 3);
  const lb = await startBalancer(t, servers, LoadBalancerAlgorithm.RANDOM);
  for (const answer of await send(lb, 20)) assert.ok(servers.includes(answer));
});

test("consistent hash sends the same client to the same server", async (t) => {
  quiet(t);
  const servers = await startBackends(t, 3);
  const lb = await startBalancer(t, servers, LoadBalancerAlgorithm.CONSISTENT_HASH);
  const answers = await send(lb, 10);
  assert.strictEqual(new Set(answers).size, 1);
});

test("health based prefers healthy servers over degraded ones", async (t) => {
  quiet(t);
  const [a, b, c] = await startBackends(t, 3);
  const health = fakeHealth({
    [a]: { status: HealthStatus.HEALTHY },
    [b]: { status: HealthStatus.DEGRADED },
    [c]: { status: HealthStatus.HEALTHY },
  });
  const lb = await startBalancer(t, [a, b, c], LoadBalancerAlgorithm.HEALTH_BASED, health);
  assert.deepStrictEqual(count(await send(lb, 10)), { [a]: 5, [c]: 5 });
});

test("health based falls back to degraded servers, then returns 503", async (t) => {
  quiet(t);
  const [a, b] = await startBackends(t, 2);
  const entries = { [a]: { status: HealthStatus.UNHEALTHY }, [b]: { status: HealthStatus.DEGRADED } };
  const lb = await startBalancer(t, [a, b], LoadBalancerAlgorithm.HEALTH_BASED, fakeHealth(entries));

  assert.deepStrictEqual(await send(lb, 3), [b, b, b]);
  entries[b].status = HealthStatus.UNHEALTHY;
  assert.deepStrictEqual(await send(lb, 1), [503]);
});

test("health based works end to end with a real HealthChecker", async (t) => {
  quiet(t);
  const good = await startBackend({ status: "healthy", cpu: 10 });
  const bad = await startBackend({ status: "unhealthy", cpu: 99 });
  t.after(() => Promise.all([good.close(), bad.close()]));

  const hc = new HealthChecker([good.url, bad.url], { logging: false });
  await hc.checkAll();
  const lb = await startBalancer(t, [good.url, bad.url], LoadBalancerAlgorithm.HEALTH_BASED, hc);
  assert.deepStrictEqual(await send(lb, 4), [good.url, good.url, good.url, good.url]);
});

test("cpu based sends more traffic to servers with more CPU headroom", async (t) => {
  quiet(t);
  const [idle, busy, down] = await startBackends(t, 3);
  const health = fakeHealth({
    [idle]: { status: HealthStatus.HEALTHY, cpu: 10 },
    [busy]: { status: HealthStatus.HEALTHY, cpu: 90 },
    [down]: { status: HealthStatus.UNHEALTHY, cpu: 0 },
  });
  // Deterministic "random" numbers spread evenly over [0, 1).
  let i = 0;
  t.mock.method(Math, "random", () => ((i++ % 100) + 0.5) / 100);

  const lb = await startBalancer(t, [idle, busy, down], LoadBalancerAlgorithm.CPU_BASED, health);
  const counts = count(await send(lb, 100));
  assert.strictEqual(counts[down], undefined, "unhealthy servers get no traffic");
  assert.deepStrictEqual(counts, { [idle]: 90, [busy]: 10 }); // headroom 90 vs 10
});

test("cpu based returns 503 when no server is available", async (t) => {
  quiet(t);
  const [a] = await startBackends(t, 1);
  const lb = await startBalancer(t, [a], LoadBalancerAlgorithm.CPU_BASED,
    fakeHealth({ [a]: { status: HealthStatus.UNHEALTHY, cpu: 50 } }));
  assert.deepStrictEqual(await send(lb, 1), [503]);
});

test("returns 502 instead of crashing when a backend is unreachable", async (t) => {
  quiet(t);
  const gone = await startServer(() => {});
  await gone.close();
  const lb = await startBalancer(t, [gone.url], LoadBalancerAlgorithm.ROUND_ROBIN);
  assert.deepStrictEqual(await send(lb, 2), [502, 502]);
});
