const baseEndpoint = "https://open-api.bingx.com/openApi/swap/v2/quote/price";
const allowedSymbols = new Set(["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "DOGE-USDT"]);

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

function normalizeSymbol(value) {
  const symbol = String(value || "BTC-USDT").toUpperCase();
  return allowedSymbols.has(symbol) ? symbol : "BTC-USDT";
}

function displaySymbol(symbol) {
  return `BINGX:${symbol.replace("-", "")}.P`;
}

function extractPrice(payload) {
  const data = payload && payload.data ? payload.data : payload;
  const candidates = [
    data && data.price,
    data && data.lastPrice,
    data && data.last,
    data && data.close,
    data && data.markPrice,
    Array.isArray(data) && data[0] ? data[0].price : undefined
  ];
  const price = candidates.map(Number).find(Number.isFinite);
  if (!Number.isFinite(price)) {
    throw new Error("BingX response did not contain a numeric price");
  }
  return price;
}

exports.handler = async function handler(event) {
  const symbol = normalizeSymbol(event.queryStringParameters && event.queryStringParameters.symbol);
  const url = new URL(baseEndpoint);
  url.searchParams.set("symbol", symbol);

  try {
    const response = await fetch(url.toString(), {
      headers: { Accept: "application/json" }
    });
    const responseBody = await response.text();

    console.log("[BingX price fetch]", {
      endpoint: url.toString(),
      symbol,
      httpStatus: response.status,
      responseBody
    });

    if (!response.ok) {
      return json(500, {
        error: `BingX HTTP ${response.status}`,
        endpoint: url.toString(),
        symbol,
        responseBody
      });
    }

    const payload = JSON.parse(responseBody);
    if (payload.code !== undefined && Number(payload.code) !== 0) {
      return json(500, {
        error: payload.msg || payload.message || "BingX returned an error",
        endpoint: url.toString(),
        symbol,
        responseBody
      });
    }

    return json(200, {
      price: extractPrice(payload),
      displaySource: "🟢 BingX Futures",
      exchange: "BingX",
      symbol,
      originalSymbol: displaySymbol(symbol)
    });
  } catch (error) {
    console.log("[BingX price fetch failed]", {
      endpoint: url.toString(),
      symbol,
      error: error.message
    });
    return json(500, {
      error: error.message,
      endpoint: url.toString(),
      symbol,
      responseBody: ""
    });
  }
};
