// In-memory request metrics for the dashboard. Counts every request that hits
// the load balancer route (including rate-limited ones), which backend served
// it, and how long it took end to end.
class MetricsCollector {
  constructor({ latencySamples = 1000, timeseriesSeconds = 120 } = {}) {
    this.startedAt = Date.now();
    this.latencySamples = latencySamples;
    this.timeseriesSeconds = timeseriesSeconds;

    this.totals = { requests: 0, success: 0, rateLimited: 0, errors: 0 };
    this.latencies = [];
    this.servers = new Map();
    // One bucket per second: { t, success, rateLimited, errors }
    this.timeseries = [];
  }

  // Express middleware: put it in front of the rate limiter so 429s are counted.
  middleware = () => (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      this.record(res.locals.target, res.statusCode, ms);
    });
    next();
  }

  record = (target, statusCode, ms) => {
    const outcome = statusCode === 429 ? "rateLimited" : statusCode >= 500 ? "errors" : "success";
    this.totals.requests++;
    this.totals[outcome]++;

    this.latencies.push(ms);
    if (this.latencies.length > this.latencySamples) this.latencies.shift();

    this._bucket()[outcome]++;

    if (target) {
      const s = this.servers.get(target) ?? { requests: 0, errors: 0, totalLatency: 0 };
      s.requests++;
      if (outcome === "errors") s.errors++;
      s.totalLatency += ms;
      this.servers.set(target, s);
    }
  }

  _bucket = () => {
    const t = Math.floor(Date.now() / 1000) * 1000;
    let last = this.timeseries[this.timeseries.length - 1];
    if (!last || last.t !== t) {
      last = { t, success: 0, rateLimited: 0, errors: 0 };
      this.timeseries.push(last);
      while (this.timeseries.length > this.timeseriesSeconds) this.timeseries.shift();
    }
    return last;
  }

  // Last `timeseriesSeconds` seconds with zero-filled buckets for quiet seconds.
  _denseTimeseries = () => {
    const byTime = new Map(this.timeseries.map((b) => [b.t, b]));
    const end = Math.floor(Date.now() / 1000) * 1000;
    return Array.from({ length: this.timeseriesSeconds }, (_, i) => {
      const t = end - (this.timeseriesSeconds - 1 - i) * 1000;
      return byTime.get(t) ?? { t, success: 0, rateLimited: 0, errors: 0 };
    });
  }

  _percentile = (sorted, p) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null;

  // Full metrics payload, merged with what the health checker knows.
  snapshot = (healthChecker, strategy) => {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const round = (n) => (n == null ? null : Math.round(n * 10) / 10);
    const last10 = this._denseTimeseries().slice(-11, -1); // completed seconds only
    const rps = last10.reduce((sum, b) => sum + b.success + b.rateLimited + b.errors, 0) / last10.length;

    return {
      strategy,
      now: Date.now(),
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      totals: this.totals,
      requestsPerSecond: round(rps),
      latency: {
        avg: round(sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null),
        p50: round(this._percentile(sorted, 50)),
        p95: round(this._percentile(sorted, 95)),
        p99: round(this._percentile(sorted, 99)),
      },
      timeseries: this._denseTimeseries(),
      servers: healthChecker.servers.map((url) => {
        const health = healthChecker.state.get(url);
        const traffic = this.servers.get(url) ?? { requests: 0, errors: 0, totalLatency: 0 };
        return {
          url,
          status: health.status,
          cpu: health.cpu,
          healthLatency: health.latency,
          checks: health.checks,
          passedChecks: health.passedChecks,
          history: health.history,
          requests: traffic.requests,
          errors: traffic.errors,
          avgLatency: traffic.requests ? round(traffic.totalLatency / traffic.requests) : null,
        };
      }),
    };
  }
}

module.exports = { MetricsCollector };
