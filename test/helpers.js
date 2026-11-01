const http = require("http");

// Starts an HTTP server on a random free port. `handler` can be swapped later
// through the returned object to change how the server responds mid-test.
const startServer = (handler) => new Promise((resolve) => {
  const box = { handler };
  const server = http.createServer((req, res) => box.handler(req, res));
  server.listen(0, () => {
    box.url = `http://localhost:${server.address().port}`;
    box.close = () => new Promise((r) => server.close(r));
    resolve(box);
  });
});

const json = (status, body) => (req, res) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

// A backend that answers "/" with its own URL and "/health" with `health`.
const startBackend = async (health = { status: "healthy", cpu: 10 }) => {
  const box = await startServer(() => {});
  box.health = health;
  box.handler = (req, res) => {
    if (req.url === "/health") return json(200, box.health)(req, res);
    res.end(box.url);
  };
  return box;
};

// Mounts an Express-style handler on a real Express app so res.locals,
// res.status and res.json behave as they do in Api.js.
const startApp = (setup) => new Promise((resolve) => {
  const express = require("express");
  const app = express();
  setup(app);
  const server = app.listen(0, () => {
    resolve({
      url: `http://localhost:${server.address().port}`,
      close: () => new Promise((r) => server.close(r)),
    });
  });
});

// Silences console.log for the duration of a test (the balancer logs every request).
const quiet = (t) => t.mock.method(console, "log", () => {});

module.exports = { startServer, startBackend, startApp, json, quiet };
