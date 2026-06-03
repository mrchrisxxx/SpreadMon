/**
 * _worker.js — Cloudflare Pages Worker
 *
 * File ini diletakkan di root folder project.
 * Cloudflare Pages akan otomatis menggunakannya sebagai edge worker
 * sehingga proxy API berjalan di Cloudflare edge (bukan Node.js).
 *
 * Deploy:
 *   1. Push semua file (termasuk file ini) ke GitHub.
 *   2. Di Cloudflare Dashboard → Pages → Create Project → connect repo.
 *   3. Build command: (kosongkan)
 *   4. Build output directory: . (titik, artinya root)
 *   5. Selesai — Cloudflare otomatis mendeteksi _worker.js.
 */

const UPSTREAM = {
  "/api/reku/bidask":       () => "https://api.reku.id/v2/bidask",
  "/api/reku/orderbookall": (sp) =>
    `https://api.reku.id/v2/orderbookall?symbol=${encodeURIComponent(sp.get("symbol") || "BTC")}`,
  "/api/binance/depth":     (sp) =>
    `https://api.binance.com/api/v3/depth?symbol=${encodeURIComponent(sp.get("symbol") || "BTCUSDT")}&limit=${encodeURIComponent(sp.get("limit") || "1000")}`,
  "/api/gate/order_book":   (sp) =>
    `https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${encodeURIComponent(sp.get("currency_pair") || "BTC_USDT")}&limit=${encodeURIComponent(sp.get("limit") || "1000")}`,
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const builder = UPSTREAM[url.pathname];

    /* ── API proxy ── */
    if (builder) {
      const targetUrl = builder(url.searchParams);
      try {
        const upstream = await fetch(targetUrl, {
          headers: {
            accept:       "application/json",
            "user-agent": "Mozilla/5.0 (compatible; reku-orderbook-dashboard/2.0)",
          },
          cf: { cacheEverything: false },
        });
        const body = await upstream.arrayBuffer();
        return new Response(body, {
          status: upstream.status,
          headers: {
            "content-type":                upstream.headers.get("content-type") || "application/json; charset=utf-8",
            "cache-control":               "no-store",
            "access-control-allow-origin": "*",
          },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: "proxy_error", message: err.message }), {
          status: 502,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
    }

    /* ── Static assets served by Cloudflare Pages automatically ── */
    // For non-API paths, let Cloudflare Pages serve the static files.
    return env.ASSETS.fetch(request);
  },
};
