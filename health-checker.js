const http = require("http");

const HealthStatus = Object.freeze({
  HEALTHY: "healthy",
  DEGRADED: "degraded",
  UNHEALTHY: "unhealthy",
  UNKNOWN: "unknown",
});

// Periodically polls GET <server>/health and keeps the latest status, CPU
// utilization and latency for every backend. A server is only marked
// UNHEALTHY after `unhealthyThreshold` consecutive failed checks, and only
// returns to service after `healthyThreshold` consecutive successes, so a
// single blip doesn't flap it in and out of rotation.
class HealthChecker {
  constructor(servers, {
    interval = 5000,
    timeout = 1000,
    path = "/health",
    unhealthyThreshold = 2,
    healthyThreshold = 2,
    logging = true,
    historySize = 60,
  } = {}) {
    this.servers = servers;
    this.interval = interval;
    this.timeout = timeout;
    this.path = path;
    this.unhealthyThreshold = unhealthyThreshold;
    this.healthyThreshold = healthyThreshold;
    this.logging = logging;
    this.historySize = historySize;
    this.timer = null;

    this.state = new Map(
      servers.map((server) => [server, {
        status: HealthStatus.UNKNOWN,
        cpu: null,
        latency: null,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        lastChecked: null,
        checks: 0,
        passedChecks: 0,
        history: [],
      }])
    );
  }

  start = () => {
    if (this.timer) return this;
    this.checkAll();
    this.timer = setInterval(this.checkAll, this.interval);
    this.timer.unref();
    return this;
  }

  stop = () => {
    clearInterval(this.timer);
    this.timer = null;
    return this;
  }

  checkAll = () => Promise.all(this.servers.map(this.check));

  check = async (server) => {
    const started = Date.now();
    const result = await this._probe(server);
    const entry = this.state.get(server);
    const previous = entry.status;

    entry.lastChecked = Date.now();
    entry.latency = entry.lastChecked - started;

    if (result.ok) {
      entry.consecutiveFailures = 0;
      entry.consecutiveSuccesses++;
      entry.cpu = result.cpu;

      // A recovering server has to prove itself before rejoining rotation.
      const recovering = previous === HealthStatus.UNHEALTHY
        && entry.consecutiveSuccesses < this.healthyThreshold;
      if (!recovering) {
        entry.status = result.status === HealthStatus.DEGRADED ? HealthStatus.DEGRADED : HealthStatus.HEALTHY;
      }
    } else {
      entry.consecutiveSuccesses = 0;
      entry.consecutiveFailures++;
      if (result.cpu != null) entry.cpu = result.cpu;
      if (entry.consecutiveFailures >= this.unhealthyThreshold || previous === HealthStatus.UNKNOWN) {
        entry.status = HealthStatus.UNHEALTHY;
      }
    }

    entry.checks++;
    if (result.ok) entry.passedChecks++;
    // No CPU reading on a failed connection: record a gap rather than the stale value.
    const cpu = result.ok || result.cpu != null ? entry.cpu : null;
    entry.history.push({ t: entry.lastChecked, cpu, latency: entry.latency, status: entry.status });
    if (entry.history.length > this.historySize) entry.history.shift();

    if (this.logging && entry.status !== previous) {
      console.log(`Health: ${server} ${previous} → ${entry.status} (cpu: ${entry.cpu ?? "n/a"}%)`);
    }
    return entry;
  }

  _probe = (server) => new Promise((resolve) => {
    const req = http.get(`${server}${this.path}`, { timeout: this.timeout }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        let data = {};
        try { data = JSON.parse(body); } catch { /* non-JSON body: treat as status-code only */ }
        const cpu = typeof data.cpu === "number" ? data.cpu : null;
        const ok = res.statusCode >= 200 && res.statusCode < 300 && data.status !== HealthStatus.UNHEALTHY;
        resolve({ ok, status: data.status, cpu });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve({ ok: false }));
  });

  getStatus = (server) => this.state.get(server)?.status ?? HealthStatus.UNKNOWN;
  getCpu = (server) => this.state.get(server)?.cpu;

  // Servers that should receive traffic: anything not UNHEALTHY or UNKNOWN.
  getAvailableServers = () => this.servers.filter((server) => {
    const status = this.getStatus(server);
    return status === HealthStatus.HEALTHY || status === HealthStatus.DEGRADED;
  });

  snapshot = () => Object.fromEntries(this.state);
}

module.exports = { HealthChecker, HealthStatus };
