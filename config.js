const startPort = parseInt(process.argv[2], 10) || 4012;
const serverCount = parseInt(process.argv[3], 10) || 3;

const port = 5001;

// How often (ms) the load balancer polls each backend's /health endpoint
const healthCheckInterval = 5000;
const healthCheckTimeout = 1000;

module.exports = {
    startPort,
    serverCount,
    port,
    healthCheckInterval,
    healthCheckTimeout
}