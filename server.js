const express = require("express");

const startPort = parseInt(process.argv[2], 10) || 3000;
const serverCount = parseInt(process.argv[3], 10) || 1;

// Availability profiles used to simulate backends of varying reliability.
// - availability: probability that a health check succeeds at all
// - degradedChance: probability that a successful check reports "degraded"
// - cpu: [min, max] range of simulated CPU utilization (%)
// - latency: [min, max] extra response delay in ms
const AvailabilityProfile = Object.freeze({
  HIGH: { name: "high", availability: 0.99, degradedChance: 0.05, cpu: [5, 40], latency: [0, 20] },
  MEDIUM: { name: "medium", availability: 0.9, degradedChance: 0.2, cpu: [30, 70], latency: [20, 100] },
  LOW: { name: "low", availability: 0.6, degradedChance: 0.4, cpu: [60, 95], latency: [100, 400] },
  DOWN: { name: "down", availability: 0.1, degradedChance: 0.5, cpu: [85, 100], latency: [300, 800] },
});

// Servers cycle through the profiles: server 1 = HIGH, server 2 = MEDIUM, ...
const profiles = Object.values(AvailabilityProfile);

const randomBetween = ([min, max]) => min + Math.random() * (max - min);

for (let i = 0; i < serverCount; i++) {
  const app = express();
  const port = startPort + i;
  const profile = profiles[i % profiles.length];

  app.get("/", (req, res) => {
    res.send(`<h1>Server ${i + 1} - Port: ${port}</h1>`);
  });

  // Simulated health endpoint: reports a random CPU utilization and fails
  // according to the server's availability profile.
  app.get("/health", (req, res) => {
    const cpu = Math.round(randomBetween(profile.cpu));
    const delay = randomBetween(profile.latency);

    setTimeout(() => {
      if (Math.random() > profile.availability) {
        return res.status(503).json({ status: "unhealthy", cpu, profile: profile.name });
      }
      const status = Math.random() < profile.degradedChance ? "degraded" : "healthy";
      res.json({ status, cpu, profile: profile.name });
    }, delay);
  });

  const server = app.listen(port, () => {
    const addr = server.address();
    const host = addr.address === "::" ? "localhost" : addr.address;
    console.log(`Server running on http://${host}:${addr.port} (availability: ${profile.name})`);
    console.log('Press "0" to exit.');
  });

  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (d) => {
    if (d.toString().trim() === "0") {
      console.log("Exiting...");
      server.close(() => process.exit(0));
    }
  });
}
