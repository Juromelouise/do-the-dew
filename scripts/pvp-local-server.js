// Local test server for the Do The Dew PVP game.
//
// Serves the repo statically AND emulates the Vercel /api/pvp function in
// one process, so two browser tabs (or two laptops on the same LAN) can
// play a full match without deploying. Without KV env vars, api/pvp.js
// automatically uses its in-memory store, which works here because every
// client talks to this single process.
//
// Run:  node scripts/pvp-local-server.js [port]

const http = require("http");
const fs = require("fs");
const path = require("path");

const pvpHandler = require("../api/pvp.js");

const PORT = parseInt(process.argv[2], 10) || 8123;
const ROOT = path.join(__dirname, "..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split("?")[0]);
  if (rel === "/") rel = "/index.html";

  const filePath = path.join(ROOT, rel);
  if (!filePath.startsWith(ROOT)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.statusCode = 404;
      res.end("Not found: " + rel);
      return;
    }
    res.statusCode = 200;
    res.setHeader(
      "Content-Type",
      MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream"
    );
    res.setHeader("Cache-Control", "no-store");
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const urlPath = req.url || "/";

  if (urlPath.startsWith("/api/pvp")) {
    // Shim the Vercel handler contract onto plain Node req/res
    res.status = function (code) {
      res.statusCode = code;
      return res;
    };

    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        req.body = raw ? JSON.parse(raw) : null;
      } catch (e) {
        req.body = null;
      }
      Promise.resolve(pvpHandler(req, res)).catch((err) => {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      });
    });
    return;
  }

  serveStatic(req, res, urlPath);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Do The Dew PVP local server running:`);
  console.log(`  Player 1:  http://localhost:${PORT}/pvp.html?p=1`);
  console.log(`  Player 2:  http://localhost:${PORT}/pvp.html?p=2`);
  console.log(
    `  (second laptop on same LAN: use this machine's IP instead of localhost)`
  );
});
