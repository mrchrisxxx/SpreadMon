/**
 * server.js — Local dev proxy for REKU Order Book Dashboard
 *
 * Untuk Cloudflare Pages: gunakan file _worker.js atau wrangler.toml
 * (lihat README untuk petunjuk deploy ke Cloudflare).
 *
 * Untuk lokal / Railway / Render: jalankan `node server.js`
 */

const http = require("node:http");
const fs   = require("node:fs");
const path = require("node:path");

// Disable SSL verification for environments with cert issues (Binance, etc.)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico":  "image/x-icon",
  ".png":  "image/png",
  ".svg":  "image/svg+xml",
};

/* ── Proxy route definitions ── */
const routes = [
  {
    prefix:   "/api/reku/bidask",
    buildUrl: () => "https://api.reku.id/v2/bidask",
  },
  {
    prefix:   "/api/reku/orderbookall",
    buildUrl: (url) => {
      const symbol = url.searchParams.get("symbol") || "BTC";
      // REKU does not support a ?limit= param on orderbookall;
      // it returns all available levels. We request with no extra params
      // so the API returns its full depth (the app slices to 1000 client-side).
      return `https://api.reku.id/v2/orderbookall?symbol=${encodeURIComponent(symbol)}`;
    },
  },
  {
    prefix:   "/api/binance/depth",
    buildUrl: (url) => {
      const symbol = url.searchParams.get("symbol") || "BTCUSDT";
      const limit  = url.searchParams.get("limit")  || "1000";
      return `https://api.binance.com/api/v3/depth?symbol=${encodeURIComponent(symbol)}&limit=${encodeURIComponent(limit)}`;
    },
  },
  {
    prefix:   "/api/gate/order_book",
    buildUrl: (url) => {
      const pair  = url.searchParams.get("currency_pair") || "BTC_USDT";
      const limit = url.searchParams.get("limit")         || "1000";
      return `https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${encodeURIComponent(pair)}&limit=${encodeURIComponent(limit)}`;
    },
  },
];

/* ── Proxy handler ── */
async function proxyJson(req, res, targetUrl) {
  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        accept:       "application/json",
        "user-agent": "Mozilla/5.0 (compatible; reku-orderbook-dashboard/2.0)",
      },
    });
    const body = await upstream.text();
    res.writeHead(upstream.status, {
      "content-type":               upstream.headers.get("content-type") || "application/json; charset=utf-8",
      "cache-control":              "no-store",
      "access-control-allow-origin":"*",
    });
    res.end(body);
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "proxy_error", message: err.message, targetUrl }));
  }
}

/* ── Static file handler ── */
function serveStatic(req, res, pathname) {
  const safe = pathname === "/" ? "/index.html" : pathname;
  const file = path.normalize(path.join(ROOT, safe));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(file, (err, content) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(content);
  });
}

/* ── Server ── */
const server = http.createServer((req, res) => {
  const url   = new URL(req.url, `http://${req.headers.host}`);
  const route = routes.find((r) => url.pathname === r.prefix);
  if (route) {
    proxyJson(req, res, route.buildUrl(url));
  } else {
    serveStatic(req, res, url.pathname);
  }
});

server.listen(PORT, () => {
  console.log(`REKU Order Book Dashboard → http://localhost:${PORT}`);
});
