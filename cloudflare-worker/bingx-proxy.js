const BINGX_BASE = "https://open-api.bingx.com/openApi/swap/v2/quote";
const ALLOWED_SYMBOLS = new Set(["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "DOGE-USDT"]);
const ALLOWED_INTERVALS = new Set(["15m", "4h"]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Access-Control-Max-Age": "86400"
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function normalizeSymbol(value) {
  const symbol = String(value || "BTC-USDT").toUpperCase();
  return ALLOWED_SYMBOLS.has(symbol) ? symbol : "BTC-USDT";
}

function displaySymbol(symbol) {
  return `BINGX:${symbol.replace("-", "")}.P`;
}

function numberFrom(...values) {
  return values.map(Number).find(Number.isFinite);
}

function normalizeKline(item) {
  if (Array.isArray(item)) {
    return {
      time: numberFrom(item[0], item[6]),
      open: Number(item[1]),
      high: Number(item[2]),
      low: Number(item[3]),
      close: Number(item[4]),
      volume: Number(item[5])
    };
  }

  return {
    time: numberFrom(item.time, item.openTime, item.timestamp, item.T, item.t),
    open: Number(item.open ?? item.o),
    high: Number(item.high ?? item.h),
    low: Number(item.low ?? item.l),
    close: Number(item.close ?? item.c),
    volume: Number(item.volume ?? item.vol ?? item.v ?? item.amount)
  };
}

function normalizeKlines(payload) {
  const raw = Array.isArray(payload) ? payload : payload && payload.data;
  if (!Array.isArray(raw)) throw new Error("BingX kline response did not contain a data array");

  const candles = raw.map(normalizeKline)
    .filter((item) => [item.time, item.open, item.high, item.low, item.close].every(Number.isFinite))
    .sort((a, b) => a.time - b.time);

  if (!candles.length) throw new Error("BingX kline response did not contain usable candles");
  return candles;
}

function extractPrice(payload) {
  const data = payload && payload.data ? payload.data : payload;
  const price = [
    data && data.price,
    data && data.lastPrice,
    data && data.last,
    data && data.close,
    data && data.markPrice,
    Array.isArray(data) && data[0] ? data[0].price : undefined
  ].map(Number).find(Number.isFinite);

  if (!Number.isFinite(price)) throw new Error("BingX response did not contain a numeric price");
  return price;
}

async function fetchBingx(path, params) {
  const url = new URL(`${BINGX_BASE}/${path}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));

  const response = await fetch(url.toString(), {
    headers: { Accept: "application/json" }
  });
  const responseBody = await response.text();

  console.log("[BingX Worker Proxy]", {
    endpoint: url.toString(),
    httpStatus: response.status,
    responseBody
  });

  if (!response.ok) {
    throw new Error(`BingX HTTP ${response.status}: ${responseBody}`);
  }

  const payload = JSON.parse(responseBody);
  if (payload.code !== undefined && Number(payload.code) !== 0) {
    throw new Error(payload.msg || payload.message || "BingX returned an error");
  }

  return payload;
}

async function handlePrice(requestUrl) {
  const symbol = normalizeSymbol(requestUrl.searchParams.get("symbol"));
  const payload = await fetchBingx("price", { symbol });
  return json({
    price: extractPrice(payload),
    displaySource: "🟢 BingX Futures",
    exchange: "BingX",
    symbol,
    originalSymbol: displaySymbol(symbol)
  });
}

async function handleKlines(requestUrl) {
  const symbol = normalizeSymbol(requestUrl.searchParams.get("symbol"));
  const interval = requestUrl.searchParams.get("interval") || "15m";
  const requestedLimit = Number(requestUrl.searchParams.get("limit") || 300);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.floor(requestedLimit), 1), 1000) : 300;

  if (!ALLOWED_INTERVALS.has(interval)) {
    return json({ error: "Unsupported interval", interval, symbol }, 400);
  }

  const payload = await fetchBingx("klines", { symbol, interval, limit });
  const candles = normalizeKlines(payload);
  return json({
    exchange: "BingX",
    symbol,
    interval,
    originalSymbol: displaySymbol(symbol),
    count: candles.length,
    data: candles
  });
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const requestUrl = new URL(request.url);
    try {
      if (requestUrl.pathname === "/price") return await handlePrice(requestUrl);
      if (requestUrl.pathname === "/klines") return await handleKlines(requestUrl);

      return json({
        error: "Not found",
        routes: [
          "/price?symbol=BTC-USDT",
          "/klines?symbol=BTC-USDT&interval=15m&limit=200"
        ]
      }, 404);
    } catch (error) {
      console.log("[BingX Worker Proxy failed]", {
        path: requestUrl.pathname,
        error: error.message
      });
      return json({ error: error.message }, 500);
    }
  }
};
