// Local test server for the Do The Dew PVP game.
//
// Serves the repo statically AND emulates the Vercel /api/pvp function in
// one process, so two browser tabs (or two laptops on the same LAN) can
// play a full match without deploying. PvP state is in-memory, which works
// because every client talks to this single process; wheel/admin state is
// saved to data/wheel-state.json.
//
// Run:  node scripts/pvp-local-server.js [port]

const http = require("http");
const fs = require("fs");
const path = require("path");

const pvpHandler = require("../api/pvp.js");
const wheelConfigHandler = require("../api/wheel-config.js");
const spinHandler = require("../api/spin.js");
const exportInventoryHandler = require("../api/export-inventory.js");

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
  ".woff2": "font/woff2",
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

// Vercel-style helpers on plain Node res, used by all shimmed handlers.
function adaptRes(res) {
  res.status = function (code) {
    res.statusCode = code;
    return res;
  };
  res.json = function (obj) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = function (data) {
    res.end(data);
    return res;
  };
}

// These handlers read the request stream themselves (or ignore it), so the
// shim must NOT pre-consume the body like the pvp shim does.
const WHEEL_API_ROUTES = [
  { prefix: "/api/wheel-config", handler: wheelConfigHandler },
  { prefix: "/api/spin", handler: spinHandler },
  { prefix: "/api/export-inventory", handler: exportInventoryHandler },
];

const server = http.createServer((req, res) => {
  const urlPath = req.url || "/";

  const wheelRoute = WHEEL_API_ROUTES.find((route) =>
    urlPath.startsWith(route.prefix)
  );
  if (wheelRoute) {
    adaptRes(res);
    Promise.resolve(wheelRoute.handler(req, res)).catch((err) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: String(err) }));
    });
    return;
  }

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
  console.log(`Do The Dew local server running:`);
  console.log(`  Wheel:     http://localhost:${PORT}/spin_the_wheel.html`);
  console.log(`  Admin:     http://localhost:${PORT}/admin.html`);
  console.log(`  Player 1:  http://localhost:${PORT}/pvp.html?p=1`);
  console.log(`  Player 2:  http://localhost:${PORT}/pvp.html?p=2`);
  console.log(
    `  (second laptop on same LAN: use this machine's IP instead of localhost)`
  );
  console.log(`  Wheel/admin state is saved to data/wheel-state.json.`);
});
