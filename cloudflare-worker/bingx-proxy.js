const BINGX_BASE = "https://open-api.bingx.com/openApi/swap/v2/quote";
const ALLOWED_SYMBOLS = new Set(["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "DOGE-USDT"]);
const SCAN_SYMBOLS = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "DOGE-USDT"];
const ALLOWED_INTERVALS = new Set(["15m", "4h"]);
const COOLDOWN_MINUTES = 30;
const SIGNAL_INDEX_KEY = "signal:index";
const SIGNAL_INDEX_VERSION_KEY = "signal:index:version";
const SIGNAL_INDEX_VERSION = "2";
const SIGNAL_STATS_KEY = "signal:stats";
const SIGNAL_EXPIRY_BARS = 48;

const CONFIG = {
  minStopLossPercent: {
    BTC: 0.5,
    ETH: 0.7,
    SOL: 1,
    XRP: 1,
    DOGE: 1
  },
  ma30MaxDeviationPercent: {
    BTC: 1.2,
    ETH: 1.5,
    SOL: 2,
    XRP: 2,
    DOGE: 2
  },
  maxStopLossPercent: {
    BTC: 1.2,
    ETH: 1.5,
    SOL: 2.2,
    XRP: 2.5,
    DOGE: 2.5
  },
  chaseBufferPercent: 0.3
};

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

function baseSymbol(symbol) {
  return String(symbol || "").split("-")[0].toUpperCase();
}

function normalizeSymbol(value) {
  const symbol = String(value || "BTC-USDT").toUpperCase();
  return ALLOWED_SYMBOLS.has(symbol) ? symbol : "BTC-USDT";
}

function displaySymbol(symbol) {
  return `BINGX:${symbol.replace("-", "")}.P`;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function number(value, digits = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : "-";
}

function priceNumber(value) {
  if (!Number.isFinite(value)) return "-";
  if (value >= 100) return value.toFixed(2);
  if (value >= 1) return value.toFixed(4);
  return value.toFixed(6);
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

  if (!response.ok) throw new Error(`BingX HTTP ${response.status}: ${responseBody}`);

  const payload = JSON.parse(responseBody);
  if (payload.code !== undefined && Number(payload.code) !== 0) {
    throw new Error(payload.msg || payload.message || "BingX returned an error");
  }

  return payload;
}

async function fetchPriceValue(symbol) {
  return extractPrice(await fetchBingx("price", { symbol }));
}

async function fetchKlinesValue(symbol, interval, limit = 300) {
  return normalizeKlines(await fetchBingx("klines", { symbol, interval, limit }));
}

async function handlePrice(requestUrl) {
  const symbol = normalizeSymbol(requestUrl.searchParams.get("symbol"));
  return json({
    price: await fetchPriceValue(symbol),
    displaySource: "? BingX Futures",
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

  const candles = await fetchKlinesValue(symbol, interval, limit);
  return json({
    exchange: "BingX",
    symbol,
    interval,
    originalSymbol: displaySymbol(symbol),
    count: candles.length,
    data: candles
  });
}

function atr14(klines) {
  if (klines.length < 15) return null;
  const trueRanges = [];
  for (let index = 1; index < klines.length; index += 1) {
    const current = klines[index];
    const previous = klines[index - 1];
    trueRanges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ));
  }
  return average(trueRanges.slice(-14));
}

function adx14(klines) {
  if (!Array.isArray(klines) || klines.length < 30) return null;
  const period = 14;
  const trueRanges = [];
  const plusDm = [];
  const minusDm = [];
  for (let index = 1; index < klines.length; index += 1) {
    const current = klines[index];
    const previous = klines[index - 1];
    const upMove = current.high - previous.high;
    const downMove = previous.low - current.low;
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trueRanges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    ));
  }
  const dxValues = [];
  for (let index = period - 1; index < trueRanges.length; index += 1) {
    const tr = average(trueRanges.slice(index - period + 1, index + 1));
    if (!Number.isFinite(tr) || tr <= 0) continue;
    const plusDi = average(plusDm.slice(index - period + 1, index + 1)) / tr * 100;
    const minusDi = average(minusDm.slice(index - period + 1, index + 1)) / tr * 100;
    const sum = plusDi + minusDi;
    if (sum > 0) dxValues.push(Math.abs(plusDi - minusDi) / sum * 100);
  }
  return dxValues.length >= period ? average(dxValues.slice(-period)) : null;
}

function atrState(atr, price) {
  if (!Number.isFinite(atr) || !Number.isFinite(price) || price <= 0) {
    return { percent: null, status: "資料不足", low: false, high: false, normal: false };
  }
  const percent = (atr / price) * 100;
  if (percent < 0.12) return { percent, status: "波動不足", low: true, high: false, normal: false };
  if (percent > 1.2) return { percent, status: "高波動", low: false, high: true, normal: false };
  return { percent, status: "正常波動", low: false, high: false, normal: true };
}
function rsi14(values) {
  if (!Array.isArray(values) || values.length < 15) return null;
  let gains = 0;
  let losses = 0;
  const recent = values.slice(-15);
  for (let index = 1; index < recent.length; index += 1) {
    const change = recent[index] - recent[index - 1];
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }
  const averageGain = gains / 14;
  const averageLoss = losses / 14;
  if (averageLoss === 0) return 100;
  const rs = averageGain / averageLoss;
  return 100 - (100 / (1 + rs));
}

function emaSeries(values, period) {
  if (values.length < period) return [];
  const multiplier = 2 / (period + 1);
  let current = average(values.slice(0, period));
  const result = Array(period - 1).fill(null);
  result.push(current);
  values.slice(period).forEach((value) => {
    current = (value - current) * multiplier + current;
    result.push(current);
  });
  return result;
}

function macdCrossAge(macdLine, signalLine, crossType) {
  for (let index = macdLine.length - 1; index > 0; index -= 1) {
    const currentMacd = macdLine[index];
    const currentSignal = signalLine[index];
    const previousMacd = macdLine[index - 1];
    const previousSignal = signalLine[index - 1];
    if (![currentMacd, currentSignal, previousMacd, previousSignal].every(Number.isFinite)) continue;
    const goldenCross = previousMacd <= previousSignal && currentMacd > currentSignal;
    const deathCross = previousMacd >= previousSignal && currentMacd < currentSignal;
    if ((crossType === "golden" && goldenCross) || (crossType === "death" && deathCross)) return macdLine.length - 1 - index;
  }
  return null;
}

function buildMacdAnalysis(closes) {
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  if (!ema12.length || !ema26.length) return null;

  const macdLine = closes.map((_, index) => (
    Number.isFinite(ema12[index]) && Number.isFinite(ema26[index]) ? ema12[index] - ema26[index] : null
  ));
  const compactMacd = macdLine.filter(Number.isFinite);
  const compactSignal = emaSeries(compactMacd, 9);
  if (!compactSignal.length) return null;

  let signalIndex = 0;
  const signalLine = macdLine.map((value) => {
    if (!Number.isFinite(value)) return null;
    const signal = compactSignal[signalIndex];
    signalIndex += 1;
    return Number.isFinite(signal) ? signal : null;
  });
  const histogram = macdLine.map((value, index) => {
    const signal = signalLine[index];
    return Number.isFinite(value) && Number.isFinite(signal) ? value - signal : null;
  });

  const latestMacd = macdLine.at(-1);
  const latestSignal = signalLine.at(-1);
  const latestHistogram = histogram.at(-1);
  const previousHistogram = histogram.slice(0, -1).filter(Number.isFinite).at(-1);
  const recentHistogram = histogram.filter(Number.isFinite).slice(-4);
  if (![latestMacd, latestSignal, latestHistogram].every(Number.isFinite)) return null;

  const crossType = latestMacd > latestSignal ? "golden" : latestMacd < latestSignal ? "death" : "neutral";
  const histogramGrowing = recentHistogram.length >= 3
    && recentHistogram.at(-1) > recentHistogram.at(-2)
    && recentHistogram.at(-2) > recentHistogram.at(-3);
  const histogramFalling = recentHistogram.length >= 3
    && recentHistogram.at(-1) < recentHistogram.at(-2)
    && recentHistogram.at(-2) < recentHistogram.at(-3);

  return {
    line: latestMacd,
    signal: latestSignal,
    histogram: latestHistogram,
    histogramGrowing,
    histogramFalling,
    histogramNearBullFlip: latestHistogram < 0 && histogramGrowing,
    histogramNearBearFlip: latestHistogram > 0 && histogramFalling,
    crossType,
    crossAge: crossType === "neutral" ? null : macdCrossAge(macdLine, signalLine, crossType),
    status: crossType === "golden" ? "金叉" : crossType === "death" ? "死叉" : "中性",
    histogramStatus: latestHistogram > 0
      ? previousHistogram !== undefined && latestHistogram <= previousHistogram ? "多頭動能減弱" : "多頭動能增強"
      : latestHistogram < 0
        ? previousHistogram !== undefined && Math.abs(latestHistogram) <= Math.abs(previousHistogram) ? "空頭動能減弱" : "空頭動能增強"
        : "動能中性"
  };
}
function getBreakoutThreshold(symbol) {
  const base = baseSymbol(symbol);
  return ["SOL", "DOGE", "XRP", "ADA"].includes(base) ? 0.0005 : 0.001;
}

function stopLossDistancePercent(entryPrice, stopLoss) {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(stopLoss) || entryPrice <= 0) return null;
  return Math.abs(entryPrice - stopLoss) / entryPrice * 100;
}

function tradePlanMetrics(side, basic) {
  if (!side || !Number.isFinite(basic.price)) return { rr: null };

  const breakoutThreshold = getBreakoutThreshold(basic.symbol);
  const longBreakout = side === "long"
    && Number.isFinite(basic.previousRecentHigh)
    && basic.price > basic.previousRecentHigh * (1 + breakoutThreshold);
  const shortBreakout = side === "short"
    && Number.isFinite(basic.previousRecentLow)
    && basic.price < basic.previousRecentLow * (1 - breakoutThreshold);

  let stop;
  let tp1;
  let tp2;
  let breakout = false;
  if (side === "long" && longBreakout && Number.isFinite(basic.atr) && basic.atr > 0) {
    stop = Math.max(basic.ma10, basic.previousRecentHigh) * 0.997;
    tp1 = basic.price + basic.atr * 1.2;
    tp2 = basic.price + basic.atr * 2;
    breakout = true;
  } else if (side === "short" && shortBreakout && Number.isFinite(basic.atr) && basic.atr > 0) {
    stop = Math.min(basic.ma10, basic.previousRecentLow) * 1.003;
    tp1 = basic.price - basic.atr * 1.2;
    tp2 = basic.price - basic.atr * 2;
    breakout = true;
  } else if (side === "long") {
    stop = Math.min(basic.recentLow, basic.ma10) * 0.999;
    tp1 = basic.recentHigh;
    tp2 = basic.recentHigh * 1.004;
  } else {
    stop = Math.max(basic.recentHigh, basic.ma10) * 1.001;
    tp1 = basic.recentLow;
    tp2 = basic.recentLow * 0.996;
  }

  const risk = Math.abs(basic.price - stop);
  const reward = side === "long" ? Math.abs(tp1 - basic.price) : Math.abs(basic.price - tp1);
  const stopLossPercent = stopLossDistancePercent(basic.price, stop);
  const minStopLossPercent = CONFIG.minStopLossPercent[baseSymbol(basic.symbol)] ?? 1;
  const stopLossTooSmall = Number.isFinite(stopLossPercent) && stopLossPercent < minStopLossPercent;

  return {
    stop,
    tp1,
    tp2,
    rr: stopLossTooSmall ? null : risk > 0 ? reward / risk : null,
    breakout,
    stopLossPercent,
    minStopLossPercent,
    stopLossTooSmall
  };
}

function basicFromKlines(symbol, price, klines4h, klines15m) {
  const last20of15m = klines15m.slice(-20);
  const closedRecent15m = klines15m.slice(-21, -1);
  const recentHigh = Math.max(...last20of15m.map((item) => item.high));
  const recentLow = Math.min(...last20of15m.map((item) => item.low));
  const buffer = CONFIG.chaseBufferPercent / 100;
  const prev15m = klines15m.slice(0, -1);

  return {
    symbol,
    price,
    ma4h: average(klines4h.slice(-30).map((item) => item.close)),
    ma4h200: average(klines4h.slice(-200).map((item) => item.close)),
    ma15m30: average(klines15m.slice(-30).map((item) => item.close)),
    ma15m30Prev: average(prev15m.slice(-30).map((item) => item.close)),
    ma5: average(klines15m.slice(-5).map((item) => item.close)),
    ma10: average(klines15m.slice(-10).map((item) => item.close)),
    prevClose: prev15m.at(-1)?.close,
    prevMa10: average(prev15m.slice(-10).map((item) => item.close)),
    recentHigh,
    recentLow,
    previousRecentHigh: Math.max(...closedRecent15m.map((item) => item.high)),
    previousRecentLow: Math.min(...closedRecent15m.map((item) => item.low)),
    atr: atr14(klines15m),
    notNearHigh: price < recentHigh * (1 - buffer),
    notNearLow: price > recentLow * (1 + buffer)
  };
}

function marketScore(side, context) {
  if (!side) return 0;
  const isLong = side === "long";
  let score = 0;
  if (isLong ? context.price > context.ma4h : context.price < context.ma4h) score += 25;
  if (isLong ? context.price > context.ma15m30 : context.price < context.ma15m30) score += 20;
  if (isLong ? context.ma5 > context.ma10 : context.ma5 < context.ma10) score += 15;

  const macdOk = isLong
    ? context.macd.crossType === "golden" && context.macdFresh
    : context.macd.crossType === "death" && context.macdFresh;
  const macdMomentumOk = isLong
    ? context.macd.histogramGrowing || context.macd.histogramNearBullFlip
    : context.macd.histogramFalling || context.macd.histogramNearBearFlip;
  if (macdOk) score += 10;
  else if (macdMomentumOk) score += 7;

  if (Number.isFinite(context.rsi) && context.rsi >= 30 && context.rsi <= 70) score += 10;
  if (context.volumeRatio >= 0.8) score += 10;
  if (context.atrInfo.normal) score += 10;
  return Math.min(100, Math.max(0, Math.round(score)));
}

function momentumScore(side, context) {
  if (!side) return 0;
  const isLong = side === "long";
  let score = 0;
  if (isLong) {
    score += context.ma5 > context.ma10 ? 25 : context.price > context.ma15m30 ? 12 : 4;
    score += context.macd.crossType === "golden" ? 25 : (context.macd.histogramGrowing || context.macd.histogramNearBullFlip) ? 16 : context.macd.crossType !== "death" ? 8 : 0;
    score += context.rsi > 55 && context.rsi < 75 ? 20 : context.rsi > 45 && context.rsi < 85 ? 12 : 4;
    score += context.volumeRatio >= 1.2 ? 15 : context.volumeRatio >= 0.8 ? 10 : context.volumeRatio >= 0.5 ? 5 : 0;
    score += context.priceSlope > 0.25 ? 15 : context.priceSlope > 0 ? 8 : 3;
  } else {
    score += context.ma5 < context.ma10 ? 25 : context.price < context.ma15m30 ? 12 : 4;
    score += context.macd.crossType === "death" ? 25 : (context.macd.histogramFalling || context.macd.histogramNearBearFlip) ? 16 : context.macd.crossType !== "golden" ? 8 : 0;
    score += context.rsi < 45 && context.rsi > 25 ? 20 : context.rsi < 55 && context.rsi > 15 ? 12 : 4;
    score += context.volumeRatio >= 1.2 ? 15 : context.volumeRatio >= 0.8 ? 10 : context.volumeRatio >= 0.5 ? 5 : 0;
    score += context.priceSlope < -0.25 ? 15 : context.priceSlope < 0 ? 8 : 3;
  }
  return Math.min(100, Math.max(0, Math.round(score)));
}

function clampScore(value, max = 100) {
  return Math.min(max, Math.max(0, Math.round(value)));
}

function distancePercent(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return null;
  return Math.abs(a - b) / a * 100;
}

function riskQualityScore(stopLossPercent, maxStopLossPercent) {
  if (!Number.isFinite(stopLossPercent) || !Number.isFinite(maxStopLossPercent) || maxStopLossPercent <= 0) return 0;
  if (stopLossPercent <= maxStopLossPercent * 0.65) return 30;
  if (stopLossPercent <= maxStopLossPercent * 0.85) return 24;
  if (stopLossPercent <= maxStopLossPercent) return 20;
  return 0;
}

function rrScoreFromRatio(rr) {
  if (!Number.isFinite(rr)) return 0;
  if (rr >= 2) return 30;
  if (rr >= 1.8) return 24;
  if (rr >= 1.5) return 20;
  if (rr >= 1.2) return 12;
  return 0;
}

function capSignalLevel(level, cap) {
  const ranks = { D: 0, C: 1, B: 2, A: 3, S: 4, "S+": 5 };
  return ranks[level] <= ranks[cap] ? level : cap;
}

function trendEnvironmentV2(basic) {
  const longChecks = [
    basic.price > basic.ma4h200,
    basic.ma4h > basic.ma4h200,
    basic.ma15m30 > basic.ma15m30Prev,
    basic.price > basic.ma15m30 || (basic.price > basic.ma10 && basic.prevClose <= basic.prevMa10)
  ];
  const shortChecks = [
    basic.price < basic.ma4h200,
    basic.ma4h < basic.ma4h200,
    basic.ma15m30 < basic.ma15m30Prev,
    basic.price < basic.ma15m30 || (basic.price < basic.ma10 && basic.prevClose >= basic.prevMa10)
  ];
  const bullScore = longChecks.filter(Boolean).length;
  const bearScore = shortChecks.filter(Boolean).length;
  const direction = bullScore >= 2 && bullScore > bearScore ? "long" : bearScore >= 2 && bearScore > bullScore ? "short" : null;
  return { direction, bullScore, bearScore, longChecks, shortChecks };
}

function dynamicTradePlanMetrics(side, basic) {
  const rrToTp1 = 1.5;
  const rrToTp2 = 2.0;
  if (!side || !Number.isFinite(basic.price)) return { rr: null, rrToTp1: null, rrToTp2: null, rrDisplay: null, rrStretch: null };
  const entry = basic.price;
  const minStopLossPercent = CONFIG.minStopLossPercent[baseSymbol(basic.symbol)] ?? 1;
  const maxStopLossPercent = CONFIG.maxStopLossPercent[baseSymbol(basic.symbol)] ?? 2.5;
  const atrRisk = Number.isFinite(basic.atr) ? basic.atr * 0.6 : 0;
  const minRisk = Math.max(atrRisk, entry * minStopLossPercent / 100);
  let structureStop;
  if (side === "long") {
    structureStop = Math.min(
      Number.isFinite(basic.recentLow) ? basic.recentLow : entry,
      Number.isFinite(basic.ma15m30) ? basic.ma15m30 : entry
    ) * 0.999;
    const stop = Math.min(structureStop, entry - minRisk);
    const risk = entry - stop;
    const tp1 = entry + risk * rrToTp1;
    const tp2 = entry + risk * rrToTp2;
    const stopLossPercent = stopLossDistancePercent(entry, stop);
    const rr = risk > 0 ? rrToTp1 : null;
    return { entry, stop, tp1, tp2, rr, rrToTp1, rrToTp2, rrDisplay: rrToTp1, rrStretch: rrToTp2, risk, stopLossPercent, minStopLossPercent, maxStopLossPercent, stopLossTooSmall: false, stopLossTooLarge: Number.isFinite(stopLossPercent) && stopLossPercent > maxStopLossPercent };
  }
  structureStop = Math.max(
    Number.isFinite(basic.recentHigh) ? basic.recentHigh : entry,
    Number.isFinite(basic.ma15m30) ? basic.ma15m30 : entry
  ) * 1.001;
  const stop = Math.max(structureStop, entry + minRisk);
  const risk = stop - entry;
  const tp1 = entry - risk * rrToTp1;
  const tp2 = entry - risk * rrToTp2;
  const stopLossPercent = stopLossDistancePercent(entry, stop);
  const rr = risk > 0 ? rrToTp1 : null;
  return { entry, stop, tp1, tp2, rr, rrToTp1, rrToTp2, rrDisplay: rrToTp1, rrStretch: rrToTp2, risk, stopLossPercent, minStopLossPercent, maxStopLossPercent, stopLossTooSmall: false, stopLossTooLarge: Number.isFinite(stopLossPercent) && stopLossPercent > maxStopLossPercent };
}

function setupContextV2(direction, basic, macd, rsi, volumeRatio, atrInfo, ma30TooFar) {
  if (!direction) return { setupType: "none", pullbackValid: false, breakoutValid: false, nearMa: false, breakoutMove: null };
  const isLong = direction === "long";
  const nearThreshold = Math.max(0.003, Number.isFinite(basic.atr) && basic.price > 0 ? basic.atr / basic.price * 0.8 : 0.003);
  const nearMa10 = Number.isFinite(basic.ma10) && distancePercent(basic.price, basic.ma10) / 100 <= nearThreshold;
  const nearMa30 = Number.isFinite(basic.ma15m30) && distancePercent(basic.price, basic.ma15m30) / 100 <= nearThreshold;
  const nearMa = nearMa10 || nearMa30;
  const macdDirectional = isLong ? macd.crossType === "golden" : macd.crossType === "death";
  const histogramStrength = isLong ? macd.histogramGrowing || macd.histogramNearBullFlip : macd.histogramFalling || macd.histogramNearBearFlip;
  const pullbackValid = nearMa
    && (isLong ? basic.ma5 > basic.ma10 || histogramStrength : basic.ma5 < basic.ma10 || histogramStrength)
    && (isLong ? rsi >= 45 && rsi <= 72 : rsi >= 28 && rsi <= 55)
    && volumeRatio >= 0.8;
  const breakoutLevel = isLong ? basic.previousRecentHigh : basic.previousRecentLow;
  const breakoutMove = Number.isFinite(breakoutLevel) && breakoutLevel > 0
    ? isLong ? (basic.price - breakoutLevel) / breakoutLevel * 100 : (breakoutLevel - basic.price) / breakoutLevel * 100
    : null;
  const breakoutValid = Number.isFinite(breakoutMove)
    && breakoutMove >= 0.1
    && volumeRatio >= 1.2
    && (macdDirectional || histogramStrength)
    && !ma30TooFar;
  const setupType = breakoutValid ? "breakout" : pullbackValid ? "pullback" : "none";
  return { setupType, pullbackValid, breakoutValid, nearMa, breakoutMove, macdDirectional, histogramStrength };
}

function scoreAdvancedAnalysisV2(klines15m, basic) {
  if (klines15m.length < 220) return null;
  const closes = klines15m.map((item) => item.close);
  const volumes = klines15m.map((item) => item.volume).filter(Number.isFinite);
  if (volumes.length < 20) return null;

  const volumeRatio = volumes.at(-1) / average(volumes.slice(-20));
  const averageVolume = average(volumes.slice(-21, -1));
  const currentVolume = volumes.at(-1);
  const macd = buildMacdAnalysis(closes);
  const atr = atr14(klines15m);
  const adx = adx14(klines15m);
  const rsi = rsi14(closes);
  if (![volumeRatio, atr].every(Number.isFinite) || !macd || !Number.isFinite(rsi)) return null;

  const atrInfo = atrState(atr, basic.price);
  const env = trendEnvironmentV2(basic);
  const direction = env.direction;
  const ma30Limit = CONFIG.ma30MaxDeviationPercent[baseSymbol(basic.symbol)] ?? 2;
  const ma30Distance = Math.abs(basic.price - basic.ma15m30) / basic.price * 100;
  const ma30TooFar = Number.isFinite(ma30Distance) && ma30Distance > ma30Limit;
  const chaseRisk = direction === "long" ? !basic.notNearHigh : direction === "short" ? !basic.notNearLow : false;
  const setup = setupContextV2(direction, { ...basic, atr }, macd, rsi, volumeRatio, atrInfo, ma30TooFar);
  const plan = dynamicTradePlanMetrics(direction, { ...basic, atr });
  const isLong = direction === "long";

  let marketScore = 0;
  let entryScore = 0;
  if (direction) {
    if (isLong ? basic.price > basic.ma4h200 : basic.price < basic.ma4h200) marketScore += 10;
    if (isLong ? basic.ma4h > basic.ma4h200 : basic.ma4h < basic.ma4h200) marketScore += 8;
    if (isLong ? basic.ma15m30 > basic.ma15m30Prev : basic.ma15m30 < basic.ma15m30Prev) marketScore += 7;
    if (isLong ? basic.ma5 > basic.ma10 : basic.ma5 < basic.ma10) marketScore += 5;
    if (isLong ? basic.price > basic.ma10 : basic.price < basic.ma10) marketScore += 5;
    if (setup.breakoutValid || setup.pullbackValid) {
      marketScore += 5;
      entryScore = 5;
    }
  }
  marketScore = clampScore(marketScore, 40);
  let momentum = 0;
  if (direction) {
    if (setup.macdDirectional) momentum += 9;
    if (setup.histogramStrength) momentum += 7;
    if (isLong ? rsi >= 45 && rsi <= 72 : rsi >= 28 && rsi <= 55) momentum += 5;
    if (volumeRatio >= 0.8) momentum += 5;
    if (setup.setupType === "breakout" && volumeRatio >= 1.2) momentum += 4;
  }
  momentum = clampScore(momentum, 30);
  const gradingRr = Number.isFinite(plan.rrStretch) ? plan.rrStretch : plan.rrDisplay;
  const rrPart = Math.min(rrScoreFromRatio(gradingRr), riskQualityScore(plan.stopLossPercent, plan.maxStopLossPercent));
  const hardBlockReasons = [];
  if (!direction) hardBlockReasons.push("direction unclear");
  if (!Number.isFinite(plan.stopLossPercent)) hardBlockReasons.push("stop distance unavailable");
  if (Number.isFinite(gradingRr) && gradingRr < 1.2) hardBlockReasons.push("RR below 1.2");
  if (volumeRatio < 0.25) hardBlockReasons.push("volume too low");
  if (direction === "long" && rsi > 88) hardBlockReasons.push("RSI overheated");
  if (direction === "short" && rsi < 12) hardBlockReasons.push("RSI oversold");
  if (atrInfo.high && atrInfo.percent > 1.8) hardBlockReasons.push("ATR extremely high");
  if (plan.stopLossTooLarge) hardBlockReasons.push(`stop too wide ${number(plan.stopLossPercent, 2)}%`);
  const hardBlocked = hardBlockReasons.length > 0;
  let scorePenalty = 0;
  const penaltyWarnings = [];
  if (Number.isFinite(adx) && adx < 20) {
    scorePenalty += 10;
    penaltyWarnings.push(`ADX 低於 20：${number(adx, 1)}`);
  }
  if (Number.isFinite(currentVolume) && Number.isFinite(averageVolume) && currentVolume < averageVolume) {
    scorePenalty += 5;
    penaltyWarnings.push("量能低於均量");
  }
  if (rsi >= 45 && rsi <= 55) {
    scorePenalty += 5;
    penaltyWarnings.push("RSI 中性，方向動能不足");
  }
  const ma200DistancePercent = Number.isFinite(basic.price) && Number.isFinite(basic.ma4h200) && basic.ma4h200 > 0
    ? Math.abs(basic.price - basic.ma4h200) / basic.ma4h200 * 100
    : null;
  if (Number.isFinite(ma200DistancePercent) && ma200DistancePercent < 0.3) {
    scorePenalty += 5;
    penaltyWarnings.push("價格接近 MA200，方向可能震盪");
  }
  const totalScore = clampScore(marketScore + momentum + rrPart - scorePenalty);
  const counterTrend = !direction && (env.bullScore >= 2 || env.bearScore >= 2);
  let signalLevel = "D";
  const sGate = marketScore >= 35 && momentum >= 24 && rrPart >= 20;
  if (!hardBlocked && totalScore >= 95 && sGate) signalLevel = "S+";
  else if (!hardBlocked && totalScore >= 90 && sGate) signalLevel = "S";
  else if (!hardBlocked && totalScore >= 80) signalLevel = "A";
  else if (!hardBlocked && totalScore >= 70 && !counterTrend) signalLevel = "B";
  else if (!hardBlocked && totalScore >= 60 && !counterTrend) signalLevel = "C";
  if (!hardBlocked && Number.isFinite(gradingRr)) {
    if (gradingRr < 1.2) signalLevel = "D";
    else if (gradingRr < 1.5) signalLevel = capSignalLevel(signalLevel, "C");
    else if (gradingRr < 1.8) signalLevel = capSignalLevel(signalLevel, "B");
  }

  const warnings = [];
  if (ma30TooFar) warnings.push(`MA30 deviation high ${number(ma30Distance, 2)}%`);
  if (chaseRisk && setup.setupType !== "breakout") warnings.push("chase risk, wait for better entry");
  if (plan.stopLossTooLarge) warnings.push(`stop distance high ${number(plan.stopLossPercent, 2)}%`);
  if (setup.setupType === "none") warnings.push("setup not confirmed");
  if (volumeRatio < 0.8) warnings.push(`volume weak ${number(volumeRatio, 2)}x`);
  warnings.push(...penaltyWarnings);
  const nonTradeReasons = hardBlockReasons.length ? [...hardBlockReasons] : signalLevel === "D" ? ["score below 60"] : [];
  const canNotify = ["S+", "S", "A"].includes(signalLevel) || (signalLevel === "B" && totalScore >= 70 && gradingRr >= 1.2);
  const finalSignal = signalLevel === "D" ? "不建議" : `${signalLevel}級${direction === "long" ? "做多" : "做空"}`;

  return {
    symbol: basic.symbol,
    direction,
    sideLabel: direction === "long" ? "做多" : direction === "short" ? "做空" : "觀察",
    finalSignal,
    signalLevel,
    setupType: setup.setupType,
    totalScore,
    trendScore: marketScore,
    structureScore: marketScore,
    momentumScore: momentum,
    entryScore,
    rrScore: rrPart,
    marketScore,
    scorePenalty,
    adx,
    averageVolume,
    gradingRr,
    canNotify,
    price: basic.price,
    entryZone: priceNumber(plan.entry ?? basic.price),
    stop: plan.stop,
    tp1: plan.tp1,
    tp2: plan.tp2,
    rr: plan.rr,
    rrToTp1: plan.rrToTp1,
    rrToTp2: plan.rrToTp2,
    rrDisplay: plan.rrDisplay,
    rrStretch: plan.rrStretch,
    volumeRatio,
    atrPercent: atrInfo.percent,
    rsi,
    macd,
    warnings,
    hardBlockReasons,
    nonTradeReasons,
    ma30Distance,
    ma30TooFar,
    chaseRisk,
    stopLossPercent: plan.stopLossPercent,
    maxStopLossPercent: plan.maxStopLossPercent,
    notifyBlockedReason: !canNotify ? (signalLevel === "B" ? "B score/RR below notify threshold" : `${signalLevel}級不推播`) : ""
  };
}

function scoreAdvancedAnalysis(klines15m, basic) {
  return scoreAdvancedAnalysisV2(klines15m, basic);
}
function signalKey(analysis) {
  return analysis.symbol;
}

async function shouldNotify(analysis, env) {
  if (!analysis.canNotify) return { notify: false, reason: analysis.notifyBlockedReason || "不符合推播條件" };

  const key = signalKey(analysis);
  if (!env.SIGNAL_KV) {
    return { notify: true, key, reason: "new signal" };
  }

  const previous = await env.SIGNAL_KV.get(key, { type: "json" });
  const now = Date.now();
  if (!previous) return { notify: true, key, reason: "new signal" };

  const lastLevel = previous.lastNotifyLevel || previous.level || "D";
  const lastNotifyTime = Number(previous.lastNotifyTime || previous.time || 0);
  if (previous.direction && analysis.direction && previous.direction !== analysis.direction) {
    return { notify: true, key, reason: `signal direction changed ${previous.direction}->${analysis.direction}` };
  }
  if (signalLevelRank(analysis.signalLevel) > signalLevelRank(lastLevel)) {
    return { notify: true, key, reason: `signal upgraded ${lastLevel}->${analysis.signalLevel}` };
  }

  const elapsedMinutes = (now - lastNotifyTime) / 60000;
  if (elapsedMinutes >= COOLDOWN_MINUTES) return { notify: true, key, reason: "new signal" };

  return { notify: false, key, reason: "cooldown" };
}

async function rememberNotification(analysis, env, decision) {
  if (!env.SIGNAL_KV || !decision.key) return;
  const notifyTime = Date.now();
  await env.SIGNAL_KV.put(decision.key, JSON.stringify({
    symbol: analysis.symbol,
    direction: analysis.direction,
    level: analysis.signalLevel,
    lastNotifyLevel: analysis.signalLevel,
    price: analysis.price,
    finalSignal: analysis.finalSignal,
    time: notifyTime,
    lastNotifyTime: notifyTime
  }), { expirationTtl: COOLDOWN_MINUTES * 60 + 300 });
}

function signalLevelRank(level) {
  return { D: 0, C: 1, B: 2, A: 3, S: 4, "S+": 5 }[level] ?? 0;
}

function signalRecordId(analysis, createdAt = Date.now()) {
  return `${analysis.symbol}:${analysis.direction}:${analysis.signalLevel}:${analysis.setupType}:${createdAt}`;
}

function isValidBacktestSignal(analysis) {
  const rrForRecord = Number.isFinite(analysis.gradingRr) ? analysis.gradingRr : analysis.rrDisplay;
  return ["S+", "S", "A"].includes(analysis.signalLevel)
    || (analysis.signalLevel === "B" && analysis.totalScore >= 65 && rrForRecord >= 1.1);
}

function hasValidTradePlan(analysis) {
  return ["long", "short"].includes(analysis.direction)
    && ["pullback", "breakout"].includes(analysis.setupType)
    && [analysis.entryZone, analysis.stop, analysis.tp1, analysis.tp2].every((value) => Number.isFinite(Number(value)));
}

async function readSignalIndex(env) {
  if (!env.SIGNAL_KV) return [];
  const index = await env.SIGNAL_KV.get(SIGNAL_INDEX_KEY, { type: "json" }).catch(() => null);
  return Array.isArray(index) ? index : [];
}

async function writeSignalIndex(env, index) {
  if (!env.SIGNAL_KV) return;
  const uniqueIndex = Array.from(new Set(Array.isArray(index) ? index : []));
  await Promise.all([
    env.SIGNAL_KV.put(SIGNAL_INDEX_KEY, JSON.stringify(uniqueIndex)),
    env.SIGNAL_KV.put(SIGNAL_INDEX_VERSION_KEY, SIGNAL_INDEX_VERSION)
  ]);
}

async function readSignalRecord(env, id) {
  if (!env.SIGNAL_KV || !id) return null;
  return await env.SIGNAL_KV.get(`signal:${id}`, { type: "json" }).catch(() => null);
}

async function writeSignalRecord(env, record) {
  if (!env.SIGNAL_KV || !record?.id) return;
  await env.SIGNAL_KV.put(`signal:${record.id}`, JSON.stringify(record));
}

async function signalRecordsByIds(env, ids) {
  if (!env.SIGNAL_KV || !Array.isArray(ids) || !ids.length) return [];
  const records = await Promise.all(ids.map((id) => readSignalRecord(env, id)));
  return records.filter(Boolean);
}

async function recentSignalRecords(env, limit = null) {
  const index = await ensureCompleteSignalIndex(env);
  const ids = Number.isFinite(limit) ? index.slice(0, limit) : index;
  return signalRecordsByIds(env, ids);
}

function signalCreatedAtFromId(id) {
  const value = Number(String(id || "").split(":").at(-1));
  return Number.isFinite(value) ? value : 0;
}

async function rebuildCompleteSignalIndex(env) {
  if (!env.SIGNAL_KV) return [];
  if (typeof env.SIGNAL_KV.list !== "function") return readSignalIndex(env);
  const ids = [];
  let cursor;
  do {
    const page = await env.SIGNAL_KV.list({
      prefix: "signal:",
      limit: 1000,
      ...(cursor ? { cursor } : {})
    });
    const pageIds = (page.keys || [])
      .map((item) => item.name)
      .filter((name) => name !== SIGNAL_INDEX_KEY && name !== SIGNAL_INDEX_VERSION_KEY && name !== SIGNAL_STATS_KEY)
      .map((name) => name.slice("signal:".length))
      .filter(Boolean);
    ids.push(...pageIds);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  const sortedIds = Array.from(new Set(ids)).sort((a, b) => {
    const timeDifference = signalCreatedAtFromId(b) - signalCreatedAtFromId(a);
    return timeDifference || String(b).localeCompare(String(a));
  });
  await writeSignalIndex(env, sortedIds);
  return sortedIds;
}

async function ensureCompleteSignalIndex(env) {
  if (!env.SIGNAL_KV) return [];
  const [index, version] = await Promise.all([
    readSignalIndex(env),
    env.SIGNAL_KV.get(SIGNAL_INDEX_VERSION_KEY).catch(() => null)
  ]);
  if (version === SIGNAL_INDEX_VERSION) return index;
  const rebuiltIndex = await rebuildCompleteSignalIndex(env);
  await rebuildSignalStats(env);
  return rebuiltIndex;
}

async function allSignalRecords(env) {
  const index = await ensureCompleteSignalIndex(env);
  return signalRecordsByIds(env, index);
}

function parsePagination(requestUrl) {
  const rawPage = requestUrl.searchParams.get("page");
  const rawLimit = requestUrl.searchParams.get("limit");
  const parseInteger = (rawValue, fallback, name, minimum, maximum = Number.MAX_SAFE_INTEGER) => {
    if (rawValue === null) return fallback;
    if (!rawValue.trim() || !/^\d+$/.test(rawValue.trim())) {
      const error = new Error(`${name} 必須是有效的正整數`);
      error.status = 400;
      throw error;
    }
    const value = Number(rawValue);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      const error = new Error(`${name} 必須介於 ${minimum} 到 ${maximum} 之間`);
      error.status = 400;
      throw error;
    }
    return value;
  };
  return {
    page: parseInteger(rawPage, 1, "page", 1),
    limit: parseInteger(rawLimit, 50, "limit", 20, 100)
  };
}

function buildSignalRecord(analysis) {
  const createdAt = Date.now();
  const latestBar = Array.isArray(analysis.latestKlines15m) ? analysis.latestKlines15m.at(-1) : null;
  const id = signalRecordId(analysis, createdAt);
  return {
    id,
    createdAt,
    createdAtBarTime: Number.isFinite(Number(latestBar?.time)) ? Number(latestBar.time) : null,
    trackingPolicy: "next_bar",
    symbol: analysis.symbol,
    direction: analysis.direction,
    signalLevel: analysis.signalLevel,
    initialSignalLevel: analysis.signalLevel,
    currentSignalLevel: analysis.signalLevel,
    lastSeenScore: analysis.totalScore,
    setupType: analysis.setupType,
    totalScore: analysis.totalScore,
    trendScore: analysis.trendScore,
    structureScore: analysis.structureScore,
    momentumScore: analysis.momentumScore,
    entryScore: analysis.entryScore,
    rrScore: analysis.rrScore,
    entry: Number(analysis.entryZone),
    stop: analysis.stop,
    tp1: analysis.tp1,
    tp2: analysis.tp2,
    rrToTp1: analysis.rrToTp1,
    rrToTp2: analysis.rrToTp2,
    stopLossPercent: analysis.stopLossPercent,
    maxStopLossPercent: analysis.maxStopLossPercent,
    status: "OPEN",
    outcome: null,
    resolvedAt: null,
    barsHeld: 0,
    warnings: Array.isArray(analysis.warnings) ? analysis.warnings : []
  };
}

function resolveSignalRecord(record, klines15m) {
  if (!record || (record.status !== "OPEN" && record.result !== "OPEN")) return record;
  const createdAtBarTime = Number(record.createdAtBarTime);
  const bars = record.trackingPolicy === "next_bar" && Number.isFinite(createdAtBarTime)
    ? klines15m.filter((item) => Number(item.time) > createdAtBarTime)
    : klines15m.filter((item) => Number(item.time) >= Number(record.createdAt));
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    const barsHeld = index + 1;
    const hitStop = record.direction === "long" ? bar.low <= record.stop : bar.high >= record.stop;
    const hitTp2 = record.direction === "long" ? bar.high >= record.tp2 : bar.low <= record.tp2;
    const hitTp1 = record.direction === "long" ? bar.high >= record.tp1 : bar.low <= record.tp1;
    if (hitStop && (hitTp1 || hitTp2)) {
      return { ...record, status: "CLOSED", outcome: "AMBIGUOUS", resolvedAt: bar.time, barsHeld };
    }
    if (hitTp2) return { ...record, status: "CLOSED", outcome: "TP2_HIT", resolvedAt: bar.time, barsHeld };
    if (hitTp1) return { ...record, status: "CLOSED", outcome: "TP1_HIT", resolvedAt: bar.time, barsHeld };
    if (hitStop) return { ...record, status: "CLOSED", outcome: "SL_HIT", resolvedAt: bar.time, barsHeld };
  }
  if (bars.length >= SIGNAL_EXPIRY_BARS) {
    const lastBar = bars.at(-1);
    return { ...record, status: "CLOSED", outcome: "EXPIRED", resolvedAt: lastBar?.time ?? Date.now(), barsHeld: bars.length };
  }
  return { ...record, barsHeld: bars.length };
}

async function updateOpenSignalRecords(env, symbol, klines15m) {
  if (!env.SIGNAL_KV) return [];
  const records = await recentSignalRecords(env);
  const updated = [];
  for (const record of records.filter((item) => item.symbol === symbol && (item.status === "OPEN" || item.result === "OPEN"))) {
    const next = resolveSignalRecord(record, klines15m);
    if (next !== record) {
      await writeSignalRecord(env, next);
      updated.push(next);
    }
  }
  return updated;
}

async function recordSignalIfEligible(env, analysis) {
  if (!env.SIGNAL_KV || !isValidBacktestSignal(analysis) || !hasValidTradePlan(analysis)) return null;
  const index = await ensureCompleteSignalIndex(env);
  const records = await recentSignalRecords(env);
  const matchingOpen = records.find((record) => (record.status === "OPEN" || record.result === "OPEN")
    && record.symbol === analysis.symbol
    && record.direction === analysis.direction
    && record.setupType === analysis.setupType);

  if (matchingOpen) {
    const currentLevel = matchingOpen.currentSignalLevel || matchingOpen.signalLevel;
    if (signalLevelRank(analysis.signalLevel) > signalLevelRank(currentLevel)) {
      const upgraded = {
        ...matchingOpen,
        initialSignalLevel: matchingOpen.initialSignalLevel || matchingOpen.signalLevel,
        currentSignalLevel: analysis.signalLevel,
        lastSeenScore: analysis.totalScore,
        warnings: Array.from(new Set([...(matchingOpen.warnings || []), ...(analysis.warnings || [])]))
      };
      await writeSignalRecord(env, upgraded);
      await rebuildSignalStats(env);
      return upgraded;
    }
    return null;
  }

  const record = buildSignalRecord(analysis);
  await writeSignalRecord(env, record);
  await writeSignalIndex(env, [record.id, ...index.filter((id) => id !== record.id)]);
  await rebuildSignalStats(env);
  return record;
}

function emptyBucketStats() {
  return { total: 0, wins: 0, losses: 0, winRate: null };
}

function addBucketResult(bucket, record) {
  bucket.total += 1;
  if (record.outcome === "TP1_HIT" || record.outcome === "TP2_HIT") bucket.wins += 1;
  if (record.outcome === "SL_HIT") bucket.losses += 1;
  const denominator = bucket.wins + bucket.losses;
  bucket.winRate = denominator ? bucket.wins / denominator * 100 : null;
}

function computeSignalStats(records) {
  const stats = {
    totalSignals: records.length,
    closedSignals: records.filter((item) => item.status !== "OPEN").length,
    openSignals: records.filter((item) => item.status === "OPEN").length,
    tp1Hits: records.filter((item) => item.outcome === "TP1_HIT").length,
    tp2Hits: records.filter((item) => item.outcome === "TP2_HIT").length,
    slHits: records.filter((item) => item.outcome === "SL_HIT").length,
    expired: records.filter((item) => item.outcome === "EXPIRED").length,
    ambiguous: records.filter((item) => item.outcome === "AMBIGUOUS").length,
    totalPnlR: 0,
    overallWinRate: null,
    overallWinRateIncludingExpired: null,
    byLevel: { "S+": emptyBucketStats(), S: emptyBucketStats(), A: emptyBucketStats(), B: emptyBucketStats(), C: emptyBucketStats() },
    byDirection: { long: emptyBucketStats(), short: emptyBucketStats() },
    bySetupType: { pullback: emptyBucketStats(), breakout: emptyBucketStats() },
    averageBarsHeld: null,
    maxConsecutiveSL: 0
  };

  const resolved = records.filter((item) => item.status !== "OPEN");
  const wins = stats.tp1Hits + stats.tp2Hits;
  const losses = stats.slHits;
  const expired = stats.expired;
  stats.totalPnlR = records.reduce((total, record) => {
    if (record.outcome === "TP2_HIT") return total + (Number(record.rrToTp2) || 2.0);
    if (record.outcome === "TP1_HIT") return total + (Number(record.rrToTp1) || 1.5);
    if (record.outcome === "SL_HIT") return total - 1;
    return total;
  }, 0);
  stats.overallWinRate = wins + losses ? wins / (wins + losses) * 100 : null;
  stats.overallWinRateIncludingExpired = wins + losses + expired ? wins / (wins + losses + expired) * 100 : null;
  const barsHeld = resolved.map((item) => Number(item.barsHeld)).filter(Number.isFinite);
  stats.averageBarsHeld = barsHeld.length ? average(barsHeld) : null;

  for (const record of records) {
    const initialLevel = record.initialSignalLevel || record.signalLevel || record.currentSignalLevel;
    if (stats.byLevel[initialLevel]) addBucketResult(stats.byLevel[initialLevel], record);
    if (stats.byDirection[record.direction]) addBucketResult(stats.byDirection[record.direction], record);
    if (stats.bySetupType[record.setupType]) addBucketResult(stats.bySetupType[record.setupType], record);
  }

  let streak = 0;
  for (const record of resolved.sort((a, b) => Number(a.resolvedAt || a.createdAt) - Number(b.resolvedAt || b.createdAt))) {
    if (record.outcome === "SL_HIT") {
      streak += 1;
      stats.maxConsecutiveSL = Math.max(stats.maxConsecutiveSL, streak);
    } else if (record.outcome === "TP1_HIT" || record.outcome === "TP2_HIT") {
      streak = 0;
    }
  }
  return stats;
}

async function rebuildSignalStats(env) {
  if (!env.SIGNAL_KV) return null;
  const records = await allSignalRecords(env);
  const stats = computeSignalStats(records);
  await env.SIGNAL_KV.put(SIGNAL_STATS_KEY, JSON.stringify(stats));
  return stats;
}

async function readCachedSignalStats(env) {
  if (!env.SIGNAL_KV) return computeSignalStats([]);
  const stats = await env.SIGNAL_KV.get(SIGNAL_STATS_KEY, { type: "json" }).catch(() => null);
  return stats && typeof stats === "object" ? stats : null;
}

async function handleSignalStats(env, requestUrl) {
  const requested = parsePagination(requestUrl);
  if (!env.SIGNAL_KV) {
    return json({
      stats: computeSignalStats([]),
      recentSignals: [],
      pagination: {
        page: 1,
        limit: requested.limit,
        total: 0,
        totalPages: 1,
        hasPrevious: false,
        hasNext: false
      }
    });
  }
  const index = await ensureCompleteSignalIndex(env);
  let stats = await readCachedSignalStats(env);
  if (!stats || Number(stats.totalSignals) !== index.length) {
    stats = await rebuildSignalStats(env);
  }
  const total = index.length;
  const totalPages = Math.max(1, Math.ceil(total / requested.limit));
  const page = Math.min(requested.page, totalPages);
  const offset = (page - 1) * requested.limit;
  const pageIds = index.slice(offset, offset + requested.limit);
  const recentSignals = await signalRecordsByIds(env, pageIds);
  return json({
    stats,
    recentSignals,
    pagination: {
      page,
      limit: requested.limit,
      total,
      totalPages,
      hasPrevious: page > 1,
      hasNext: page < totalPages
    }
  });
}

async function handleClearSignals(env, requestUrl, method) {
  if (method !== "GET") {
    const error = new Error("Method not allowed");
    error.status = 405;
    throw error;
  }
  if (requestUrl.searchParams.get("confirm") !== "YES") {
    return json({ ok: false, error: "Missing confirm=YES" }, 400);
  }
  if (!env.SIGNAL_KV) return json({ ok: true, deleted: 0 });
  if (typeof env.SIGNAL_KV.list !== "function" || typeof env.SIGNAL_KV.delete !== "function") {
    const error = new Error("SIGNAL_KV does not support list/delete");
    error.status = 500;
    throw error;
  }

  const keysToDelete = [];
  let cursor;
  do {
    const page = await env.SIGNAL_KV.list({
      prefix: "signal:",
      limit: 1000,
      ...(cursor ? { cursor } : {})
    });
    const keys = (page.keys || [])
      .map((item) => item.name)
      .filter((name) => String(name || "").startsWith("signal:"));
    keysToDelete.push(...keys);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);

  await Promise.all(keysToDelete.map((key) => env.SIGNAL_KV.delete(key)));
  return json({ ok: true, deleted: keysToDelete.length });
}

function setupTypeLabel(type) {
  if (type === "breakout") return "突破單";
  if (type === "pullback") return "回踩單";
  return "未確認";
}

function translateWarningText(text) {
  const value = String(text || "").trim();
  if (!value) return "";
  if (value === "chase risk, wait for better entry") return "追價風險，等待更好進場點";
  if (value === "setup not confirmed") return "型態未確認";
  if (value.startsWith("volume weak")) return value.replace("volume weak", "量能偏弱");
  if (value.startsWith("stop distance high")) return value.replace("stop distance high", "止損距離偏大");
  if (value.startsWith("MA30 deviation high")) return value.replace("MA30 deviation high", "偏離 MA30 過遠");
  return value
    .replace("chase risk", "追價風險")
    .replace("wait for better entry", "等待更好進場點")
    .replace("setup not confirmed", "型態未確認")
    .replace("volume weak", "量能偏弱")
    .replace("stop distance high", "止損距離偏大")
    .replace("MA30 deviation high", "偏離 MA30 過遠")
    .replace("RR below 1.2", "風報低於 1.2")
    .replace("RSI overheated", "RSI 過熱")
    .replace("RSI oversold", "RSI 過度超賣")
    .replace("ATR extremely high", "ATR 極端高波動")
    .replace("stop too wide", "止損距離過大")
    .replace("score below 60", "分數低於 60");
}

function warningReasonText(warnings) {
  const items = (Array.isArray(warnings) ? warnings : [])
    .map(translateWarningText)
    .filter(Boolean);
  return items.length ? items.join("、") : "-";
}

function signalTitleIcon(level) {
  if (level === "S+") return "🔥🔥🔥";
  if (level === "S") return "🔥🔥🔥";
  if (level === "A") return "🔥🔥";
  return "🟡";
}

function telegramText(analysis) {
  const level = analysis.signalLevel || "-";
  const directionText = analysis.direction === "short" ? "空單" : analysis.direction === "long" ? "多單" : "觀察";
  const typeText = setupTypeLabel(analysis.setupType);
  const rrTp1 = Number.isFinite(analysis.rrDisplay) ? number(analysis.rrDisplay, 1) + "R" : "-";
  const rrTp2 = Number.isFinite(analysis.rrStretch) ? number(analysis.rrStretch, 1) + "R" : "-";
  const scoreText = `等級：${level}\n總分：${analysis.totalScore ?? "-"} / 100\n市場：${analysis.marketScore ?? "-"} / 40\n動能：${analysis.momentumScore ?? "-"} / 30\n風報：${analysis.rrScore ?? "-"} / 30`;
  const priceBlock = `現價：${priceNumber(analysis.price)}\n進場：${analysis.entryZone}\n止損：${Number.isFinite(analysis.stop) ? priceNumber(analysis.stop) : "-"}\n止盈1：${Number.isFinite(analysis.tp1) ? priceNumber(analysis.tp1) : "-"}\n止盈2：${Number.isFinite(analysis.tp2) ? priceNumber(analysis.tp2) : "-"}`;

  if (level === "B") {
    return `${signalTitleIcon(level)} B級${directionText}｜${analysis.symbol}

型態：${typeText}
狀態：觀察，不建議追價

${priceBlock}

風報：
TP1：${rrTp1}
TP2：${rrTp2}

分數：
${scoreText}

提醒：
等回踩或收線確認。
原因：
${warningReasonText(analysis.warnings)}`;
  }

  const reminder = level === "S"
    ? "高品質訊號，仍需自行確認K線。"
    : "可觀察進場，不追價。";
  return `${signalTitleIcon(level)} ${level}級${directionText}｜${analysis.symbol}

型態：${typeText}
${priceBlock}

風報：
TP1：${rrTp1}
TP2：${rrTp2}

分數：
${scoreText}

提醒：
${reminder}`;
}
async function sendTelegram(text, env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok === false) throw new Error(payload?.description || `Telegram HTTP ${response.status}`);
}

async function scanSymbol(symbol) {
  const [klines4hResult, klines15mResult, priceResult] = await Promise.allSettled([
    fetchKlinesValue(symbol, "4h", 300),
    fetchKlinesValue(symbol, "15m", 300),
    fetchPriceValue(symbol)
  ]);

  const priceFailed = priceResult.status === "rejected";
  const klinesFailed = klines4hResult.status === "rejected" || klines15mResult.status === "rejected";
  if (priceFailed || klinesFailed) {
    console.log(`${symbol} fetch failed`);
    return { symbol, signalLevel: "ERROR", error: true };
  }

  const klines4h = klines4hResult.value;
  const klines15m = klines15mResult.value;
  const price = priceResult.value;
  const basic = basicFromKlines(symbol, price, klines4h, klines15m);
  const analysis = scoreAdvancedAnalysisV2(klines15m, basic);
  if (!analysis) {
    console.log(`${symbol} fetch failed`);
    return { symbol, signalLevel: "ERROR", error: true };
  }
  analysis.latestKlines15m = klines15m;
  return analysis;
}

async function runScheduledScan(env) {
  console.log("[scheduled] start");
  for (const symbol of SCAN_SYMBOLS) {
    try {
      const analysis = await scanSymbol(symbol);
      if (analysis.error) continue;
      const resolvedSignals = await updateOpenSignalRecords(env, symbol, analysis.latestKlines15m || []);
      if (resolvedSignals.length) await rebuildSignalStats(env);
      await recordSignalIfEligible(env, analysis);
      const decision = await shouldNotify(analysis, env);
      const sideText = analysis.direction === "long" ? "做多" : analysis.direction === "short" ? "做空" : "";
      const finalText = analysis.signalLevel === "D" ? "不交易" : `${analysis.signalLevel}級${sideText}`;
      console.log(`${symbol} ${finalText} 市場 ${analysis.marketScore}/40 動能 ${analysis.momentumScore}/30 風報 ${analysis.rrScore}/30 notify=${decision.notify ? "yes" : "no"} reason=${decision.reason}`);

      if (decision.notify) {
        try {
          await sendTelegram(telegramText(analysis), env);
          await rememberNotification(analysis, env, decision);
          console.log("Telegram sent");
        } catch (error) {
          console.log("Telegram failed");
        }
      }
    } catch (error) {
      console.log(`${symbol} fetch failed`);
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const requestUrl = new URL(request.url);
    try {
      if (requestUrl.pathname === "/price") return await handlePrice(requestUrl);
      if (requestUrl.pathname === "/klines") return await handleKlines(requestUrl);
      if (requestUrl.pathname === "/signals/stats") return await handleSignalStats(env, requestUrl);
      if (requestUrl.pathname === "/admin/clear-signals") return await handleClearSignals(env, requestUrl, request.method);

      return json({
        error: "Not found",
        routes: [
          "/price?symbol=BTC-USDT",
          "/klines?symbol=BTC-USDT&interval=15m&limit=200",
          "/signals/stats?page=1&limit=50",
          "/admin/clear-signals?confirm=YES"
        ]
      }, 404);
    } catch (error) {
      return json({ error: error.message }, Number(error.status) || 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledScan(env));
  }
};




