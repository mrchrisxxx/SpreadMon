# REKU Order Book Dashboard

Dashboard web interaktif untuk membandingkan order book REKU IDR dengan order book target USDT dari Binance atau Gate.

---

## Cara Menjalankan Lokal

```powershell
node server.js
```

Buka browser ke `http://localhost:4173`.

---

## Deploy ke Cloudflare Pages (Gratis & Publik)

Cloudflare Pages adalah cara termudah dan tercepat untuk deploy project ini karena:
- Gratis untuk penggunaan personal
- Tidak ada cold start
- API proxy berjalan di Cloudflare Edge lewat `_worker.js`

### Langkah-langkah:

**1. Upload ke GitHub**

Pastikan semua file berikut ada di root repository (tidak di dalam subfolder):

```
_worker.js       ← Cloudflare Edge Worker (proxy API)
app.js
index.html
package.json
server.js        ← untuk lokal/Railway/Render
style.css
README.md
```

**2. Buat Cloudflare Pages Project**

1. Buka [pages.cloudflare.com](https://pages.cloudflare.com) → Login
2. Klik **"Create a project"** → **"Connect to Git"**
3. Pilih repository GitHub Anda
4. Konfigurasi build:
   - **Framework preset:** None
   - **Build command:** *(kosongkan)*
   - **Build output directory:** `.` (titik)
5. Klik **"Save and Deploy"**

Cloudflare otomatis mendeteksi `_worker.js` dan menjalankannya sebagai edge worker.

**3. Selesai**

URL publik akan tersedia seperti:
`https://nama-project.pages.dev`

---

## Deploy ke Platform Lain

### Railway
1. Push ke GitHub
2. Buka [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Pilih repo → Railway otomatis menjalankan `npm start`

### Render
1. Push ke GitHub
2. Buka [render.com](https://render.com) → New Web Service
3. Build Command: *(kosongkan)*
4. Start Command: `node server.js`

---

## Fitur

- Daftar aset dari `https://api.reku.id/v2/bidask`
- Aset `MIRA`, `AK12`, `DRX`, `CST`, `ANOA`, `ANA`, dan `USDT` tidak ditampilkan
- Order book REKU dari `https://api.reku.id/v2/orderbookall?symbol=ASSET` (hingga 1000 level)
- Order book target hanya pair USDT:
  - Binance: `ASSETUSDT` (limit 1000)
  - Gate: `ASSET_USDT` (limit 1000)
- Default target adalah Binance; otomatis fallback ke Gate jika pair tidak tersedia
- Tampilan 10 best ask dan 10 best bid secara default
  - Ask table dapat di-scroll ke atas untuk melihat harga yang lebih tinggi
  - Bid table dapat di-scroll ke bawah untuk melihat harga yang lebih rendah
- Hover tooltip pada setiap price level menampilkan VWAP kumulatif, Amount, dan Volume
- Harga ditampilkan sesuai data API (tanpa desimal paksa)
- Simulasi taker buy/sell: Price Impact, Price Change, VWAP
- Auto-refresh setiap 2 menit + refresh manual
- Dark mode dan light mode
- Suara klik saat memilih aset
- Panel aset diurutkan alfabetis dengan spread dan current diff

---

## Rumus

```
Default Price   = CEILING(Rate System × Best Ask Target, Tick Size)
Diff            = CEILING(Tick Size / Default Price × 100, 0.05%)
Current Diff    = 1 - CEILING(Default Price / Best Bid REKU, 0.05%)
```

---

## Catatan API REKU

`/v2/orderbookall` tidak mendukung parameter `?limit=`. API mengembalikan semua level yang tersedia untuk aset tersebut. Kedalaman bervariasi per aset (puluhan hingga ratusan level). Dashboard membatasi tampilan ke maksimal 1000 level di sisi client.

## Jika API Diblokir

Gunakan `server.js` (lokal) atau deploy ke Cloudflare Pages / Railway — jangan buka `index.html` langsung di browser karena akan terkena CORS block.
