/* ─────────────────────────────────────────────────────────────────
   REKU Order Book Dashboard — app.js  v6
───────────────────────────────────────────────────────────────── */
"use strict";

/* ── API endpoints (proxy via server.js / _worker.js) ── */
const API = {
  bidask:      "/api/reku/bidask",
  // ALWAYS /v2/orderbookall — /v2/orderbook is capped at 40 levels
  rekuBook:    (a) => `/api/reku/orderbookall?symbol=${encodeURIComponent(a)}`,
  binanceBook: (a) => `/api/binance/depth?symbol=${encodeURIComponent(a+"USDT")}&limit=1000`,
  gateBook:    (a) => `/api/gate/order_book?currency_pair=${encodeURIComponent(a+"_USDT")}&limit=1000`,
};

const EXCLUDED      = new Set(["MIRA","AK12","DRX","CST","ANOA","ANA","USDT"]);
const DIFF_STEP_PCT = 0.05;
const OB_LIMIT      = 1000;
const REFRESH_MS    = 120_000;

const state = {
  assets: [], selectedAsset: "BTC",
  rekuBook:      { asks: [], bids: [] },
  targetBook:    { asks: [], bids: [], exchange: "binance" },
  fallbackTarget: null,
  rekuFetchedAt: null, targetFetchedAt: null, latestRefreshAt: null,
  // Computed by updateDerivedMetrics; used by renderAssetList for selected asset
  checkerDiff:        0,
  checkerCurrentDiff: null,  // null = not computed yet
  checkerDefaultPrice: 0,
  checkerTick:        0,
};

let audioCtx = null;

/* ── DOM refs ── */
const el = {
  chosenAssetTitle:   document.getElementById("chosenAssetTitle"),
  connectionStatus:   document.getElementById("connectionStatus"),
  refreshButton:      document.getElementById("refreshButton"),
  themeToggle:        document.getElementById("themeToggle"),
  rateSystem:         document.getElementById("rateSystem"),
  targetExchange:     document.getElementById("targetExchange"),
  bestAskTarget:      document.getElementById("bestAskTarget"),
  tickSize:           document.getElementById("tickSize"),
  defaultPrice:       document.getElementById("defaultPrice"),
  diffPerTick:        document.getElementById("diffPerTick"),
  currentDiffPerTick: document.getElementById("currentDiffPerTick"),
  takerSide:          document.getElementById("takerSide"),
  valueIn:            document.getElementById("valueIn"),
  tradeAmount:        document.getElementById("tradeAmount"),
  priceImpact:        document.getElementById("priceImpact"),
  priceChange:        document.getElementById("priceChange"),
  vwap:               document.getElementById("vwap"),
  askMaxPrice:        document.getElementById("askMaxPrice"),
  askTotalAsset:      document.getElementById("askTotalAsset"),
  askTotalIdr:        document.getElementById("askTotalIdr"),
  bidMinPrice:        document.getElementById("bidMinPrice"),
  bidTotalAsset:      document.getElementById("bidTotalAsset"),
  bidTotalIdr:        document.getElementById("bidTotalIdr"),
  rekuAsks:           document.getElementById("rekuAsks"),
  rekuBids:           document.getElementById("rekuBids"),
  targetAsks:         document.getElementById("targetAsks"),
  targetBids:         document.getElementById("targetBids"),
  targetExchangeName: document.getElementById("targetExchangeName"),
  rekuMeta:           document.getElementById("rekuMeta"),
  targetMeta:         document.getElementById("targetMeta"),
  rekuLevelCount:     document.getElementById("rekuLevelCount"),
  targetLevelCount:   document.getElementById("targetLevelCount"),
  assetList:          document.getElementById("assetList"),
  assetSearch:        document.getElementById("assetSearch"),
  rekuPanel:          document.getElementById("rekuPanel"),
  targetPanel:        document.getElementById("targetPanel"),
  rekuAskWrap:        document.getElementById("rekuAskWrap"),
  rekuBidWrap:        document.getElementById("rekuBidWrap"),
  targetAskWrap:      document.getElementById("targetAskWrap"),
  targetBidWrap:      document.getElementById("targetBidWrap"),
  levelTooltip:       document.getElementById("levelTooltip"),
};

/* ═══════════════════════════════════════════════════════════════
   NUMBER PARSERS
═══════════════════════════════════════════════════════════════ */

/** User-typed inputs — Indonesian locale (dot=thousands, comma=decimal) */
function parseUserInput(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v ?? "").trim().replace(/\./g, "").replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

/** API values — standard dot-decimal (REKU, Binance, Gate all use this) */
function parseAPI(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v ?? "").trim());
  return Number.isFinite(n) ? n : 0;
}

/* ═══════════════════════════════════════════════════════════════
   NUMBER FORMATTERS
═══════════════════════════════════════════════════════════════ */

/**
 * Count meaningful decimal places of a raw API dot-decimal string.
 * Trailing zeros stripped: "9.0"→0, "96500.50"→1, "0.000519"→6.
 */
function apiDecimalPlaces(raw) {
  const s = String(raw ?? "").trim();
  if (/[eE]/.test(s)) {
    const fixed = parseAPI(s).toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
    return (fixed.split(".")[1] || "").length;
  }
  return (s.split(".")[1] || "").replace(/0+$/, "").length;
}

/** Format API price for display (id-ID locale, no trailing zeros). */
function fmtApiPrice(rawStr) {
  const num = parseAPI(rawStr);
  if (!Number.isFinite(num) || num === 0) return "0";
  const dp = apiDecimalPlaces(rawStr);
  return new Intl.NumberFormat("id-ID", {
    minimumFractionDigits: dp, maximumFractionDigits: dp,
  }).format(num);
}

/** Format a JS number with up to maxDp decimal places, id-ID locale. */
function fmt(num, maxDp = 8) {
  if (num == null || !Number.isFinite(num) || num === 0) return "0";
  return new Intl.NumberFormat("id-ID", { maximumFractionDigits: maxDp }).format(num);
}

function fmtMoney(num, maxDp = 2) {
  if (num == null || !Number.isFinite(num) || num === 0) return "0";
  return new Intl.NumberFormat("id-ID", { maximumFractionDigits: maxDp }).format(num);
}

function fmtPct(num) {
  if (!Number.isFinite(num)) return "-";
  // Always id-ID locale: comma as decimal separator, e.g. +0,10% not +0.1%
  const sign = num >= 0 ? "+" : "";
  const formatted = new Intl.NumberFormat("id-ID", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(num));
  return `${sign}${num < 0 ? "-" : ""}${formatted}%`;
}

function fmtDateTime(date) {
  if (!date) return "-";
  return new Intl.DateTimeFormat("id-ID", {
    day:"2-digit", month:"2-digit", year:"2-digit",
    hour:"2-digit", minute:"2-digit", second:"2-digit",
  }).format(date);
}
function fmtTime(date) {
  if (!date) return "-";
  return new Intl.DateTimeFormat("id-ID", {
    hour:"2-digit", minute:"2-digit", second:"2-digit",
  }).format(date);
}
function fmtAge(date) {
  if (!date) return "-";
  const s = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  return `${Math.floor(s/60)}m ${s%60}s`;
}

/* ── Live input formatting with cursor preservation ── */
function formatInputLive(input, isAsset = false) {
  const raw = parseUserInput(input.value);
  if (!raw) return;
  const formatted = new Intl.NumberFormat("id-ID", {
    maximumFractionDigits: isAsset ? 8 : 0,
  }).format(raw);
  if (input.value !== formatted) {
    const pos = input.selectionStart;
    const delta = formatted.length - input.value.length;
    input.value = formatted;
    try { input.setSelectionRange(pos + delta, pos + delta); } catch(_) {}
  }
}

let _rateTimer = null, _amtTimer = null;

function liveFormatRate() {
  clearTimeout(_rateTimer);
  _rateTimer = setTimeout(() => formatInputLive(el.rateSystem, false), 120);
}
function liveFormatAmount() {
  clearTimeout(_amtTimer);
  const isAsset = el.valueIn.value === "asset";
  _amtTimer = setTimeout(() => formatInputLive(el.tradeAmount, isAsset), 120);
}

/* ═══════════════════════════════════════════════════════════════
   MATH HELPERS
═══════════════════════════════════════════════════════════════ */

function ceilToStep(value, step) {
  const s = Math.max(step, Number.EPSILON);
  return Math.ceil(value / s) * s;
}

/** Round to nearest step (standard mathematical rounding, not ceiling) */
function roundToStep(value, step) {
  const s = Math.max(step, Number.EPSILON);
  return Math.round(value / s) * s;
}

/**
 * Diff = ROUND(tick/defaultPrice×100, 0.05) [%]
 * Uses standard mathematical rounding (not ceiling).
 */
function calcDiff(tick, defaultPrice) {
  if (!defaultPrice) return 0;
  return roundToStep((tick / defaultPrice) * 100, DIFF_STEP_PCT);
}

/**
 * Current Diff = (1 − ROUND(defaultPrice / bestBidReku, 0.0005)) × 100 [%]
 * Uses standard mathematical rounding (not ceiling).
 */
function calcCurrentDiff(defaultPrice, bestBidReku) {
  if (!defaultPrice || !bestBidReku) return 0;
  return (1 - roundToStep(defaultPrice / bestBidReku, DIFF_STEP_PCT / 100)) * 100;
}

function inferTickSize(book, bidaskRow) {
  const prices = [...book.bids, ...book.asks]
    .map(r => r.price).filter(Boolean).sort((a,b) => a - b);
  let minStep = Infinity;
  for (let i = 1; i < prices.length; i++) {
    const step = Math.abs(prices[i] - prices[i-1]);
    if (step > 0 && step < minStep) minStep = step;
  }
  if (Number.isFinite(minStep) && minStep > 0) return minStep;
  const bid = parseAPI(bidaskRow?.bid);
  const ask = parseAPI(bidaskRow?.ask);
  const spread = ask - bid;
  if (spread > 0) return spread;
  if (ask >= 1_000_000) return 1_000;
  if (ask >= 10_000)    return 10;
  if (ask >= 1_000)     return 5;
  if (ask >= 1)         return 0.1;
  return 0.001;
}

/* ═══════════════════════════════════════════════════════════════
   ORDER BOOK NORMALISATION
═══════════════════════════════════════════════════════════════ */

function normaliseRekuSide(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => {
    if (Array.isArray(row)) {
      const amtIdr   = parseAPI(row[0]);
      const priceRaw = String(row[1] ?? "");
      const price    = parseAPI(priceRaw);
      const amount   = parseAPI(row[2]) || (price ? amtIdr / price : 0);
      return { price, priceRaw, amount, quoteVolume: amtIdr || price * amount };
    }
    const priceRaw = String(row.price ?? row.p ?? "0");
    const price    = parseAPI(priceRaw);
    const amount   = parseAPI(row.amount ?? row.qty ?? row.q ?? 0);
    return { price, priceRaw, amount, quoteVolume: price * amount };
  }).filter(r => r.price > 0 && r.amount > 0);
}

function normaliseTargetSide(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => {
    let priceRaw, amountRaw;
    if (Array.isArray(row)) {
      priceRaw = String(row[0] ?? ""); amountRaw = String(row[1] ?? "");
    } else {
      priceRaw  = String(row.p ?? row.price ?? "0");
      amountRaw = String(row.s ?? row.amount ?? row.qty ?? "0");
    }
    const price  = parseAPI(priceRaw);
    const amount = parseAPI(amountRaw);
    return { price, priceRaw, amount, quoteVolume: price * amount };
  }).filter(r => r.price > 0 && r.amount > 0);
}

/* ═══════════════════════════════════════════════════════════════
   FETCH
═══════════════════════════════════════════════════════════════ */

async function getJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function loadAssets() {
  const rows = await getJson(API.bidask);
  state.assets = rows
    .filter(r => r.code && !EXCLUDED.has(String(r.code).toUpperCase()))
    .map(r => ({
      ...r,
      code:   String(r.code).toUpperCase(),
      bid:    parseAPI(r.bid),
      ask:    parseAPI(r.ask),
      spread: Math.max(0, parseAPI(r.ask) - parseAPI(r.bid)),
    }))
    .filter(r => r.bid > 0 && r.ask > 0)
    .sort((a,b) => a.code.localeCompare(b.code));

  if (!state.assets.some(a => a.code === state.selectedAsset))
    state.selectedAsset = state.assets[0]?.code || "BTC";
  renderAssetList();
}

async function loadRekuBook() {
  // ALWAYS /v2/orderbookall — never /v2/orderbook (capped at 40)
  const data = await getJson(API.rekuBook(state.selectedAsset));
  state.rekuBook = {
    asks: normaliseRekuSide(data.s ?? data.asks ?? [])
            .sort((a,b) => b.price - a.price).slice(0, OB_LIMIT),
    bids: normaliseRekuSide(data.b ?? data.bids ?? [])
            .sort((a,b) => b.price - a.price).slice(0, OB_LIMIT),
  };
  state.rekuFetchedAt = new Date();
  renderBook(el.rekuAsks, el.rekuAskWrap, state.rekuBook.asks, "idr", "ask");
  renderBook(el.rekuBids, el.rekuBidWrap, state.rekuBook.bids, "idr", "bid");
  el.rekuLevelCount.textContent =
    `ASK ${state.rekuBook.asks.length} · BID ${state.rekuBook.bids.length}`;
}

async function tryTarget(exchange) {
  if (exchange === "binance") {
    const data = await getJson(API.binanceBook(state.selectedAsset));
    return {
      exchange: "binance",
      asks: normaliseTargetSide(data.asks).sort((a,b) => b.price-a.price).slice(0, OB_LIMIT),
      bids: normaliseTargetSide(data.bids).sort((a,b) => b.price-a.price).slice(0, OB_LIMIT),
    };
  }
  const data = await getJson(API.gateBook(state.selectedAsset));
  return {
    exchange: "gate",
    asks: normaliseTargetSide(data.asks).sort((a,b) => b.price-a.price).slice(0, OB_LIMIT),
    bids: normaliseTargetSide(data.bids).sort((a,b) => b.price-a.price).slice(0, OB_LIMIT),
  };
}

async function loadTargetBook() {
  const desired = el.targetExchange.value;
  state.fallbackTarget = null;
  try {
    state.targetBook = await tryTarget(desired);
  } catch (e1) {
    // Auto-fallback to the other exchange
    const fallback = desired === "binance" ? "gate" : "binance";
    try {
      state.targetBook = await tryTarget(fallback);
      state.fallbackTarget = fallback;
      console.warn(`${desired} failed → fallback to ${fallback}`);
    } catch (e2) {
      state.targetBook = { exchange: desired, asks: [], bids: [] };
      throw new Error(`Both exchanges failed`);
    }
  }
  state.targetFetchedAt = new Date();
  renderBook(el.targetAsks, el.targetAskWrap, state.targetBook.asks, "usdt", "ask");
  renderBook(el.targetBids, el.targetBidWrap, state.targetBook.bids, "usdt", "bid");
  el.targetExchangeName.textContent =
    state.targetBook.exchange.toUpperCase() + (state.fallbackTarget ? " ⚠" : "");
  el.targetLevelCount.textContent =
    `ASK ${state.targetBook.asks.length} · BID ${state.targetBook.bids.length}`;
}

/* ═══════════════════════════════════════════════════════════════
   RENDER ORDER BOOK
═══════════════════════════════════════════════════════════════ */

function renderBook(tbody, wrapper, rows, currency, side) {
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="placeholder">No data</td></tr>`;
    return;
  }
  const cls = side === "ask" ? "price-ask" : "price-bid";
  tbody.innerHTML = rows.map((row, i) => {
    const rowNum = side === "ask" ? rows.length - i : i + 1;
    const vol = currency === "idr" ? fmt(row.quoteVolume, 0) : fmt(row.quoteVolume, 4);
    return `<tr data-index="${i}" data-side="${side}" data-currency="${currency}">
      <td>${rowNum}</td>
      <td class="${cls}">${fmtApiPrice(row.priceRaw)}</td>
      <td>${fmt(row.amount, 8)}</td>
      <td>${vol}</td>
    </tr>`;
  }).join("");
  if (side === "ask") {
    requestAnimationFrame(() => { wrapper.scrollTop = wrapper.scrollHeight; });
  }
}

/* ═══════════════════════════════════════════════════════════════
   HOVER TOOLTIP
═══════════════════════════════════════════════════════════════ */

function computeCumulative(rows, idx, side) {
  const slice = side === "ask" ? rows.slice(idx) : rows.slice(0, idx + 1);
  let cumAsset = 0, cumVol = 0;
  for (const r of slice) { cumAsset += r.amount; cumVol += r.quoteVolume; }
  return { cumAsset, cumVol, vwap: cumAsset ? cumVol / cumAsset : 0, levels: slice.length };
}

function showTooltip(event, rows, idx, side, currency) {
  const { cumAsset, cumVol, vwap, levels } = computeCumulative(rows, idx, side);
  const cur = currency.toUpperCase();
  const lvl = side === "ask" ? rows.length - idx : idx + 1;
  const vwapRaw = vwap === 0 ? "0" : vwap.toPrecision(10).replace(/\.?0+$/, "");
  el.levelTooltip.innerHTML = `
    <div class="tt-title">${side==="ask"?"ASK":"BID"} Level ${lvl}</div>
    <div class="tt-row"><span class="tt-label">Cum. Amount</span><span class="tt-val">${fmt(cumAsset,8)}</span></div>
    <div class="tt-row"><span class="tt-label">Cum. Volume (${cur})</span><span class="tt-val">${fmt(cumVol,cur==="IDR"?0:4)}</span></div>
    <div class="tt-row"><span class="tt-label">VWAP (${cur})</span><span class="tt-val">${fmtApiPrice(vwapRaw)}</span></div>
    <div class="tt-row"><span class="tt-label">Levels</span><span class="tt-val">${levels}</span></div>
  `;
  el.levelTooltip.hidden = false;
  positionTooltip(event);
}
function positionTooltip(e) {
  const tt = el.levelTooltip, pad = 12;
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + tt.offsetWidth  > window.innerWidth  - pad) x = e.clientX - tt.offsetWidth  - pad;
  if (y + tt.offsetHeight > window.innerHeight - pad) y = e.clientY - tt.offsetHeight - pad;
  tt.style.left = `${x}px`; tt.style.top = `${y}px`;
}
function hideTooltip() { el.levelTooltip.hidden = true; }
function attachTooltips(tbody, getRows) {
  tbody.addEventListener("mousemove", e => {
    const tr = e.target.closest("tr[data-index]");
    if (!tr) { hideTooltip(); return; }
    showTooltip(e, getRows(tr.dataset.side),
      parseInt(tr.dataset.index, 10), tr.dataset.side, tr.dataset.currency);
  });
  tbody.addEventListener("mouseleave", hideTooltip);
}

/* ═══════════════════════════════════════════════════════════════
   ASSET LIST
═══════════════════════════════════════════════════════════════ */

/**
 * Anomaly conditions:
 *   spread > 4 × tick
 *   OR currentDiff < −(diff + 0.05%)
 *   OR currentDiff > diff
 */
function isAnomaly(asset, tick, currentDiff, diff) {
  if (asset.spread > 4 * tick) return true;
  if (currentDiff < -(diff + DIFF_STEP_PCT)) return true;
  if (currentDiff > diff) return true;
  return false;
}

function renderAssetList() {
  const q = el.assetSearch.value.trim().toUpperCase();
  const list = state.assets.filter(a => !q || a.code.includes(q));

  el.assetList.innerHTML = list.map(asset => {
    const isSelected = asset.code === state.selectedAsset;

    /*
     * For the SELECTED asset: use the exact same values computed by
     * updateDerivedMetrics (checker panel) — live order book bestBid,
     * rateSystem × bestAskTarget, real tick from order book.
     * This guarantees curr diff in asset list === curr diff in checker.
     *
     * For OTHER assets: estimate from bidask snapshot.
     * defaultPrice ≈ CEILING(asset.ask, tick)  (ask already in IDR)
     * This will differ from checker because:
     *   - we don't have live order book for every asset
     *   - we can't compute rateSystem × USDT_ask without fetching each book
     */
    let tick, defaultPrice, diff, currentDiff;

    if (isSelected && state.checkerCurrentDiff !== null) {
      // Mirror checker panel values exactly
      tick         = state.checkerTick;
      defaultPrice = state.checkerDefaultPrice;
      diff         = state.checkerDiff;
      currentDiff  = state.checkerCurrentDiff;
    } else {
      tick         = inferTickSize({ bids: [], asks: [] }, asset);
      defaultPrice = ceilToStep(asset.ask, tick);
      diff         = calcDiff(tick, defaultPrice);
      currentDiff  = calcCurrentDiff(defaultPrice, asset.bid);
    }

    const anomaly = isAnomaly(asset, tick, currentDiff, diff);
    const active  = isSelected ? "active" : "";
    return `<button type="button" class="asset-row ${anomaly?"anomaly":""} ${active}" data-asset="${asset.code}">
      <span><strong>${asset.code}</strong></span>
      <span>${fmtMoney(asset.spread, 6)}</span>
      <span>${fmtPct(currentDiff)}</span>
    </button>`;
  }).join("");
}

/* ═══════════════════════════════════════════════════════════════
   SIMULATION
   Follows the SQL logic in the screenshot:
     ob = order book levels with cumulative asset/idr
     best_price = first price in traversal order (ORDER BY price ASC/DESC LIMIT 1)
     fill_price = first level where cumulative value >= input_amount
     price_impact = ABS(fill_price - best_price) / best_price
     vwap = cumulative_idr_at_fill / cumulative_asset_at_fill
═══════════════════════════════════════════════════════════════ */

function simulateTrade() {
  const amount  = parseUserInput(el.tradeAmount.value);
  const side    = el.takerSide.value;
  const valueIn = el.valueIn.value;

  // Empty amount guard
  if (!amount) {
    const msg = "Please fill the Amount";
    [el.priceImpact, el.priceChange, el.vwap].forEach(e => {
      e.textContent = msg;
      e.classList.add("placeholder-text");
    });
    return;
  }
  [el.priceImpact, el.priceChange, el.vwap].forEach(e => e.classList.remove("placeholder-text"));

  // Rows in fill order: buy → asks ASC (cheapest first); sell → bids DESC (highest first)
  const rows = side === "buy"
    ? [...state.rekuBook.asks].sort((a,b) => a.price - b.price)
    : [...state.rekuBook.bids].sort((a,b) => b.price - a.price);

  if (!rows.length) {
    [el.priceImpact, el.priceChange, el.vwap].forEach(e => e.textContent = "-");
    return;
  }

  // best_price = first row in traversal order
  const bestPrice = rows[0].price;

  let cumAsset = 0, cumIdr = 0;
  let fillPrice = null;
  let vwapAsset = 0, vwapIdr = 0;
  let filled = false;

  for (const row of rows) {
    const rowAsset = row.amount;
    const rowIdr   = row.quoteVolume;

    if (!filled) {
      // Check if this row brings cumulative over the threshold
      const newCumAsset = cumAsset + rowAsset;
      const newCumIdr   = cumIdr   + rowIdr;
      const cumCheck    = valueIn === "asset" ? newCumAsset : newCumIdr;

      if (cumCheck >= amount) {
        // Partial fill at this level
        const remaining = amount - (valueIn === "asset" ? cumAsset : cumIdr);
        if (valueIn === "asset") {
          vwapAsset += remaining;
          vwapIdr   += remaining * row.price;
        } else {
          vwapIdr   += remaining;
          vwapAsset += row.price ? remaining / row.price : 0;
        }
        fillPrice = row.price;
        filled = true;
      } else {
        // Full fill of this level
        vwapAsset += rowAsset;
        vwapIdr   += rowIdr;
        cumAsset   = newCumAsset;
        cumIdr     = newCumIdr;
      }
    }
  }

  // If order book depth not enough to fill, use last available price
  if (fillPrice === null) fillPrice = rows[rows.length - 1].price;

  const vwap        = vwapAsset ? vwapIdr / vwapAsset : 0;
  const priceImpact = bestPrice ? Math.abs(fillPrice - bestPrice) / bestPrice * 100 : 0;

  el.vwap.textContent        = fmtMoney(vwap, 4);
  el.priceChange.textContent = fmtMoney(fillPrice, 4);
  // Always show as positive percentage (ABS in SQL), id-ID locale
  const impactFormatted = new Intl.NumberFormat("id-ID", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(priceImpact);
  el.priceImpact.textContent = `+${impactFormatted}%`;
}

/* ═══════════════════════════════════════════════════════════════
   DERIVED METRICS
═══════════════════════════════════════════════════════════════ */

function summariseSide(rows) {
  return {
    totalAsset: rows.reduce((s,r) => s + r.amount, 0),
    totalVol:   rows.reduce((s,r) => s + r.quoteVolume, 0),
  };
}

function updateDerivedMetrics() {
  const bidask        = state.assets.find(a => a.code === state.selectedAsset);
  const tick          = inferTickSize(state.rekuBook, bidask);
  const bestAskTarget = [...state.targetBook.asks].sort((a,b) => a.price-b.price)[0]?.price || 0;
  const rateRaw       = el.rateSystem.value.trim();
  const rateSystem    = parseUserInput(rateRaw);
  const ask           = summariseSide(state.rekuBook.asks);
  const bid           = summariseSide(state.rekuBook.bids);

  el.chosenAssetTitle.textContent = state.selectedAsset;
  el.askMaxPrice.textContent   = fmt(state.rekuBook.asks[0]?.price, 4);
  el.askTotalAsset.textContent = fmt(ask.totalAsset, 8);
  el.askTotalIdr.textContent   = fmtMoney(ask.totalVol, 0);
  el.bidMinPrice.textContent   = fmt(state.rekuBook.bids.at(-1)?.price, 4);
  el.bidTotalAsset.textContent = fmt(bid.totalAsset, 8);
  el.bidTotalIdr.textContent   = fmtMoney(bid.totalVol, 0);

  // If Rate System is empty — show placeholder on all dependent outputs
  if (!rateRaw || !rateSystem) {
    const msg = "Please fill the Rate System";
    [el.bestAskTarget, el.tickSize, el.defaultPrice, el.diffPerTick, el.currentDiffPerTick].forEach(e => {
      e.textContent = msg;
      e.classList.add("placeholder-text");
    });
    simulateTrade();
    renderAssetList();
    return;
  }
  [el.bestAskTarget, el.tickSize, el.defaultPrice, el.diffPerTick, el.currentDiffPerTick].forEach(e => {
    e.classList.remove("placeholder-text");
  });

  const defaultPrice = ceilToStep(rateSystem * bestAskTarget, tick);
  // Best Bid REKU: first element of bids (sorted desc = highest bid first)
  const bestBidReku  = state.rekuBook.bids[0]?.price || bidask?.bid || 0;
  const currentDiff  = calcCurrentDiff(defaultPrice, bestBidReku);
  const diff         = calcDiff(tick, defaultPrice);

  // Store checker values so renderAssetList can mirror them for the selected asset
  state.checkerTick         = tick;
  state.checkerDefaultPrice = defaultPrice;
  state.checkerDiff         = diff;
  state.checkerCurrentDiff  = currentDiff;

  el.bestAskTarget.textContent      = fmt(bestAskTarget, 8);
  el.tickSize.textContent           = fmt(tick, 8);
  el.defaultPrice.textContent       = fmt(defaultPrice, 8);
  el.diffPerTick.textContent        = fmtPct(diff);
  el.currentDiffPerTick.textContent = fmtPct(currentDiff);

  simulateTrade();
  renderAssetList();  // mirrors checker values for selected asset
}

function updateBookMeta() {
  const latest = state.latestRefreshAt || new Date();
  // No exchange name prefix — just timestamps
  el.rekuMeta.textContent =
    `Latest: ${fmtTime(latest)} · Fetched: ${fmtDateTime(state.rekuFetchedAt)} · Age: ${fmtAge(state.rekuFetchedAt)}`;
  const fb = state.fallbackTarget ? ` (fallback: ${state.fallbackTarget.toUpperCase()})` : "";
  el.targetMeta.textContent =
    `Latest: ${fmtTime(latest)} · Fetched: ${fmtDateTime(state.targetFetchedAt)} · Age: ${fmtAge(state.targetFetchedAt)}${fb}`;
}

function flashPanels() {
  [el.rekuPanel, el.targetPanel].forEach(p => {
    p.classList.remove("flash");
    requestAnimationFrame(() => p.classList.add("flash"));
  });
}

function updateStatus(msg, isError = false) {
  el.connectionStatus.textContent = msg;
  el.connectionStatus.classList.toggle("error", isError);
}

/* ═══════════════════════════════════════════════════════════════
   AUDIO
   Click (asset change): short triangle sweep — high pitch
   Refresh tick: soft sine double-chime — distinctly different
═══════════════════════════════════════════════════════════════ */

function getAudioCtx() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  audioCtx ||= new Ctx();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function playClickSound() {
  const ctx = getAudioCtx(); if (!ctx) return;
  try {
    const osc = ctx.createOscillator(), gain = ctx.createGain(), now = ctx.currentTime;
    osc.type = "triangle";
    osc.frequency.setValueAtTime(900, now);
    osc.frequency.exponentialRampToValueAtTime(420, now + 0.09);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.42, now + 0.007);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(now); osc.stop(now + 0.15);
  } catch(_) {}
}

// Auto-refresh sound: soft two-note ascending chime (clearly different from click)
function playRefreshTick() {
  const ctx = getAudioCtx(); if (!ctx) return;
  try {
    const now = ctx.currentTime;
    [[330, 0], [440, 0.12]].forEach(([freq, offset]) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now + offset);
      gain.gain.setValueAtTime(0.001, now + offset);
      gain.gain.linearRampToValueAtTime(0.18, now + offset + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.2);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(now + offset); osc.stop(now + offset + 0.22);
    });
  } catch(_) {}
}

/* ═══════════════════════════════════════════════════════════════
   MAIN REFRESH
═══════════════════════════════════════════════════════════════ */

async function refreshAll(silent = false) {
  try {
    updateStatus("Loading…");
    // Reset checker so asset list shows fresh values after refresh
    state.checkerCurrentDiff = null;
    await loadAssets();
    await Promise.all([loadRekuBook(), loadTargetBook()]);
    state.latestRefreshAt = new Date();
    // updateDerivedMetrics computes checker values AND calls renderAssetList
    updateDerivedMetrics();
    updateBookMeta();
    updateStatus("Ready");
    if (!silent) playRefreshTick();
  } catch (err) {
    console.error(err);
    updateStatus("Error — check network", true);
  }
}

/* ═══════════════════════════════════════════════════════════════
   EVENT LISTENERS
═══════════════════════════════════════════════════════════════ */

// Asset list click
el.assetList.addEventListener("click", async e => {
  const btn = e.target.closest("[data-asset]");
  if (!btn) return;
  playClickSound();
  state.selectedAsset = btn.dataset.asset;
  renderAssetList();
  await refreshAll(true); // silent — no refresh chime on asset change
  flashPanels();
});

// Simulation selects
[el.takerSide, el.valueIn].forEach(inp => inp.addEventListener("change", updateDerivedMetrics));

// Rate System — live format + spinner
function changeRate(delta) {
  const cur  = parseUserInput(el.rateSystem.value);
  const next = Math.max(0, Math.round((cur + delta) * 1000) / 1000);
  el.rateSystem.value = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 3 }).format(next);
  updateDerivedMetrics();
}
document.getElementById("rateUp").addEventListener("click",   () => changeRate(+1));
document.getElementById("rateDown").addEventListener("click", () => changeRate(-1));
el.rateSystem.addEventListener("input", () => { liveFormatRate(); updateDerivedMetrics(); });
el.rateSystem.addEventListener("keydown", e => {
  if (e.key === "ArrowUp")   { e.preventDefault(); changeRate(+1); }
  if (e.key === "ArrowDown") { e.preventDefault(); changeRate(-1); }
});

// Amount — live format + live simulation (both on every keystroke)
el.tradeAmount.addEventListener("input", () => { liveFormatAmount(); updateDerivedMetrics(); });

// Target exchange
el.targetExchange.addEventListener("change", async () => {
  try {
    updateStatus("Loading…");
    await loadTargetBook();
    updateDerivedMetrics(); updateBookMeta();
    updateStatus("Ready");
  } catch (err) {
    console.error(err);
    updateStatus("Error — check network", true);
  }
});

el.assetSearch.addEventListener("input", renderAssetList);
el.refreshButton.addEventListener("click", () => refreshAll(false));

el.themeToggle.addEventListener("click", () => {
  const dark = document.body.classList.toggle("dark");
  localStorage.setItem("reku-theme", dark ? "dark" : "light");
  el.themeToggle.textContent = dark ? "☀ Light" : "☾ Dark";
});
if (localStorage.getItem("reku-theme") === "dark") {
  document.body.classList.add("dark");
  el.themeToggle.textContent = "☀ Light";
}

document.addEventListener("mousemove", e => {
  if (!el.levelTooltip.hidden) positionTooltip(e);
});

attachTooltips(el.rekuAsks,   side => side==="ask" ? state.rekuBook.asks   : state.rekuBook.bids);
attachTooltips(el.rekuBids,   side => side==="ask" ? state.rekuBook.asks   : state.rekuBook.bids);
attachTooltips(el.targetAsks, side => side==="ask" ? state.targetBook.asks : state.targetBook.bids);
attachTooltips(el.targetBids, side => side==="ask" ? state.targetBook.asks : state.targetBook.bids);

/* ── Boot ── */
refreshAll(true);                                    // first load: silent
setInterval(() => refreshAll(false), REFRESH_MS);   // auto-refresh with chime
setInterval(updateBookMeta, 1_000);                 // age counter
