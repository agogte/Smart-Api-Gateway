// Sends a steady stream of requests to the load balancer so the dashboard has
// something to show. Usage: node load-test.js <requestsPerSecond> <seconds>
const { port } = require("./config");

const rps = parseInt(process.argv[2], 10) || 5;
const seconds = parseInt(process.argv[3], 10) || 60;
const url = `http://localhost:${port}/`;

const counts = {};
let sent = 0;

const timer = setInterval(async () => {
  sent++;
  try {
    const res = await fetch(url);
    await res.text();
    counts[res.status] = (counts[res.status] || 0) + 1;
  } catch {
    counts.failed = (counts.failed || 0) + 1;
  }
}, 1000 / rps);

setTimeout(() => {
  clearInterval(timer);
  setTimeout(() => {
    console.log(`Sent ${sent} requests to ${url}:`, counts);
    process.exit(0);
  }, 1000);
}, seconds * 1000);

console.log(`Sending ${rps} req/s to ${url} for ${seconds}s...`);
