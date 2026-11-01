const httpProxy = require("http-proxy");
const crypto = require("crypto");
const { HealthStatus } = require("./health-checker");
const proxy = httpProxy.createProxyServer();

// Without an error listener http-proxy throws and takes the whole process down
// when a backend refuses the connection.
proxy.on("error", (err, req, res) => {
  console.log(`Proxy error: ${err.message}`);
  if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Bad gateway" }));
});

const LoadBalancerAlgorithm = Object.freeze({
  ROUND_ROBIN: 'round-robin',
  RANDOM: 'random',
  CONSISTENT_HASH: 'consistent-hash',
  HEALTH_BASED: 'health-based',
  CPU_BASED: 'cpu-based'
});

const STRATEGIES_REQUIRING_HEALTH = [LoadBalancerAlgorithm.HEALTH_BASED, LoadBalancerAlgorithm.CPU_BASED];

// Records the chosen backend on res.locals so metrics can attribute the request.
const forward = (req, res, target) => {
  res.locals.target = target;
  proxy.web(req, res, { target });
};

const noServersAvailable = (res) =>
  res.status(503).json({ error: "No healthy servers available. Please try again later." });

const VIRTUAL_NODES_PER_SERVER = 100;

class LoadBalancerBuilder{

  constructor() {
    this.servers = [];
    this.current = 0;
    this.strategy = LoadBalancerAlgorithm.ROUND_ROBIN;
    this.loggingEnabled = true;
    this.healthChecker = null;
  }

  setServers = (servers) => {
    if(!Array.isArray(servers) || servers.length === 0)
        throw new Error("Servers list cannot be enpty");

    this.servers = servers;
    this.ring = this._buildRing(servers);
    return this;
  }

  setLogging = (enabled) => {
    this.loggingEnabled = !!enabled;
    return this;
  }
  setHealthChecker = (healthChecker) => {
    this.healthChecker = healthChecker;
    return this;
  }

  setStrategy = (strategy) => {
    if (!Object.values(LoadBalancerAlgorithm).includes(strategy)) {
      throw new Error("Unknown loadbalancer algorithm.");
    }
    this.strategy = strategy;
    return this;
  }

  randomLoadBalancer = (servers) => (req, res) => {
    const randomIndex = Math.floor(Math.random() * servers.length);
    const target = servers[randomIndex];
    console.log(`Random: Redirecting to ${target}`);
    forward(req, res, target);
  };

  roundRobinLoadBalancer = (servers, current) => (req, res) => {
    const target = servers[current];
    current = (current + 1) % servers.length;
    console.log(`Round Robin: Redirecting to ${target}`);
    forward(req, res, target);
  };

  _hash = (key) => {
    return parseInt(crypto.createHash("md5").update(key).digest("hex").substring(0, 8), 16);
  }

  _buildRing = (servers) => {
    const ring = [];
    servers.forEach((server) => {
      for (let i = 0; i < VIRTUAL_NODES_PER_SERVER; i++) {
        ring.push({ hash: this._hash(`${server}#${i}`), server });
      }
    });
    ring.sort((a, b) => a.hash - b.hash);
    return ring;
  }

  consistentHashLoadBalancer = (ring) => (req, res) => {
    const key = req.ip || req.socket.remoteAddress || "";
    const keyHash = this._hash(key);
    const node = ring.find((n) => n.hash >= keyHash) ?? ring[0];
    console.log(`Consistent Hash: ${key} → ${node.server}`);
    forward(req, res, node.server);
  };

  // Prefers HEALTHY servers and only falls back to DEGRADED ones when no
  // healthy server is left. Round robins within whichever tier is chosen.
  healthBasedLoadBalancer = (healthChecker) => {
    let current = 0;
    return (req, res) => {
      const available = healthChecker.getAvailableServers();
      const healthy = available.filter((s) => healthChecker.getStatus(s) === HealthStatus.HEALTHY);
      const pool = healthy.length > 0 ? healthy : available;
      if (pool.length === 0) return noServersAvailable(res);

      const target = pool[current % pool.length];
      current = (current + 1) % Number.MAX_SAFE_INTEGER;
      console.log(`Health Based: Redirecting to ${target} (${healthChecker.getStatus(target)})`);
      forward(req, res, target);
    };
  };

  // Weighted random by CPU headroom (100 - cpu). Always picking the single
  // least-loaded server would send every request to the same backend until the
  // next health check, so lighter servers are just more likely to be chosen.
  cpuBasedLoadBalancer = (healthChecker) => (req, res) => {
    const available = healthChecker.getAvailableServers();
    if (available.length === 0) return noServersAvailable(res);

    const weights = available.map((s) => Math.max(1, 100 - (healthChecker.getCpu(s) ?? 50)));
    const total = weights.reduce((sum, w) => sum + w, 0);
    let pick = Math.random() * total;
    let index = 0;
    while (pick >= weights[index] && index < weights.length - 1) {
      pick -= weights[index];
      index++;
    }

    const target = available[index];
    console.log(`CPU Based: Redirecting to ${target} (cpu: ${healthChecker.getCpu(target) ?? "n/a"}%)`);
    forward(req, res, target);
  };

  build = () => {
    const { servers, strategy } = this;

    if(servers.length === 0)
        throw new Error("No Servers configured");

    if (STRATEGIES_REQUIRING_HEALTH.includes(strategy) && !this.healthChecker)
        throw new Error(`The ${strategy} strategy requires a health checker. Call setHealthChecker() first.`);

    let handler;
    if (strategy === LoadBalancerAlgorithm.ROUND_ROBIN) {
      handler = this.roundRobinLoadBalancer(servers, this.current);
    } else if (strategy === LoadBalancerAlgorithm.CONSISTENT_HASH) {
      handler = this.consistentHashLoadBalancer(this.ring);
    } else if (strategy === LoadBalancerAlgorithm.HEALTH_BASED) {
      handler = this.healthBasedLoadBalancer(this.healthChecker);
    } else if (strategy === LoadBalancerAlgorithm.CPU_BASED) {
      handler = this.cpuBasedLoadBalancer(this.healthChecker);
    } else {
      handler = this.randomLoadBalancer(servers);
    }

    return (req, res) => handler(req, res);
  }
}



module.exports = {
  LoadBalancerBuilder,
  LoadBalancerAlgorithm
};