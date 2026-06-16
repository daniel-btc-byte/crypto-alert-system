const baseEndpoint = "https://open-api.bingx.com/openApi/swap/v2/quote/klines";
const allowedSymbols = new Set(["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "DOGE-USDT"]);
const allowedIntervals = new Set(["15m", "4h"]);

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(body)
  };
}

function numberFrom(...values) {
  return values.map(Number).find(Number.isFinite);
}

function normalizeSymbol(value) {
  const symbol = String(value || "BTC-USDT").toUpperCase();
  return allowedSymbols.has(symbol) ? symbol : "BTC-USDT";
}

function displaySymbol(symbol) {
  return `BINGX:${symbol.replace("-", "")}.P`;
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

function normalizePayload(payload) {
  const raw = Array.isArray(payload) ? payload : payload && payload.data;
  if (!Array.isArray(raw)) {
    throw new Error("BingX kline response did not contain a data array");
  }

  const candles = raw.map(normalizeKline)
    .filter((item) => [item.time, item.open, item.high, item.low, item.close].every(Number.isFinite))
    .sort((a, b) => a.time - b.time);

  if (!candles.length) {
    throw new Error("BingX kline response did not contain usable candles");
  }

  return candles;
}

exports.handler = async function handler(event) {
  const symbol = normalizeSymbol(event.queryStringParameters && event.queryStringParameters.symbol);
  const interval = event.queryStringParameters && event.queryStringParameters.interval || "15m";
  const requestedLimit = Number(event.queryStringParameters && event.queryStringParameters.limit || 300);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.floor(requestedLimit), 1), 1000) : 300;

  if (!allowedIntervals.has(interval)) {
    return json(400, {
      error: "Unsupported interval",
      interval,
      symbol
    });
  }

  const url = new URL(baseEndpoint);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(limit));

  let responseBody = "";
  try {
    const response = await fetch(url.toString(), {
      headers: { Accept: "application/json" }
    });
    responseBody = await response.text();

    console.log("[BingX kline fetch]", {
      endpoint: url.toString(),
      interval,
      symbol,
      httpStatus: response.status,
      responseBody
    });

    if (!response.ok) {
      return json(500, {
        error: `BingX kline HTTP ${response.status}`,
        endpoint: url.toString(),
        interval,
        symbol,
        responseBody
      });
    }

    const payload = JSON.parse(responseBody);
    if (payload.code !== undefined && Number(payload.code) !== 0) {
      return json(500, {
        error: payload.msg || payload.message || "BingX returned a kline error",
        endpoint: url.toString(),
        interval,
        symbol,
        responseBody
      });
    }

    const candles = normalizePayload(payload);
    console.log("[BingX kline normalized]", {
      endpoint: url.toString(),
      interval,
      symbol,
      normalizedCount: candles.length
    });

    return json(200, {
      exchange: "BingX",
      symbol,
      interval,
      originalSymbol: displaySymbol(symbol),
      count: candles.length,
      data: candles
    });
  } catch (error) {
    console.log("[BingX kline fetch failed]", {
      endpoint: url.toString(),
      interval,
      symbol,
      error: error.message,
      responseBody
    });

    return json(500, {
      error: error.message,
      endpoint: url.toString(),
      interval,
      symbol,
      responseBody
    });
  }
};
