const express = require("express");
const path = require("path");
const { LoadBalancerBuilder, LoadBalancerAlgorithm } = require("./loadbalancing-algorithms");
const { rateLimiter, RateLimiterAlgorithm } = require("./rate-limiter");
const { HealthChecker } = require("./health-checker");
const { MetricsCollector } = require("./metrics");
const { startPort, serverCount, port, healthCheckInterval, healthCheckTimeout } = require("./config");

const app = express();

// Generate the list of server URLs
const servers = Array.from(
  { length: serverCount },
  (_, i) => `http://localhost:${startPort + i}`
);
console.log("Available servers: ", servers);

const healthChecker = new HealthChecker(servers, {
  interval: healthCheckInterval,
  timeout: healthCheckTimeout,
}).start();

const metrics = new MetricsCollector();
const strategy = LoadBalancerAlgorithm.ROUND_ROBIN;

const loadbalancer = new LoadBalancerBuilder()
                        .setServers(servers)
                        .setHealthChecker(healthChecker)
                        .setStrategy(strategy)
                        .setLogging(true)
                        .build();

// Current health, CPU and latency of every backend as seen by the load balancer
app.get("/lb/health", (req, res) => res.json(healthChecker.snapshot()));

// Live dashboard (served from ./dashboard) and the metrics it polls
app.get("/lb/metrics", (req, res) => res.json(metrics.snapshot(healthChecker, strategy)));
app.use("/dashboard", express.static(path.join(__dirname, "dashboard")));

// Apply rate limiter middleware before the load balancer; metrics go first so 429s are counted
app.get("/", metrics.middleware(), rateLimiter(5, 60 * 1000, RateLimiterAlgorithm.TOKEN_BUCKET), loadbalancer);

const server = app.listen(port, () => {
  console.log(`Load balancer running on http://localhost:${port}`);
  console.log(`Dashboard: http://localhost:${port}/dashboard`);
});

// Enable raw mode and listen for key presses
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (d) => {
  if (d.toString().trim() === "0") {
    console.log("Exiting...");
    healthChecker.stop();
    server.close(() => process.exit(0));
  }
});