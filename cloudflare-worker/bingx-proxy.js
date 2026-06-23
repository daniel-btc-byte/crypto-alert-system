const BINGX_BASE = "https://open-api.bingx.com/openApi/swap/v2/quote";
const ALLOWED_SYMBOLS = new Set(["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "DOGE-USDT"]);
const SCAN_SYMBOLS = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "DOGE-USDT"];
const ALLOWED_INTERVALS = new Set(["15m", "4h"]);
const COOLDOWN_MINUTES = 30;
const SIGNAL_INDEX_KEY = "signal:index";
const SIGNAL_INDEX_VERSION_KEY = "signal:index:version";
const SIGNAL_INDEX_VERSION = "2";
const SIGNAL_STATS_KEY = "signal:stats";
const SIGNAL_SNAPSHOT_INDEX_KEY = "signal:snapshots:index";
const SIGNAL_SNAPSHOT_LIMIT = 1000;
const SIGNAL_SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SIGNAL_EXPIRY_BARS = 48;
const STRATEGY_VERSION = "tp1-effective-v1";
const BACKTEST_EXIT_MODE = "TP1_EFFECTIVE";
const MIN_TP1_DISTANCE_PCT = 0.5;

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
  chaseBufferPercent: 0.3,
  tp3R: 2.5
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

function tp1DistancePct(entry, tp1) {
  const entryPrice = Number(entry);
  const targetPrice = Number(tp1);
  if (!Number.isFinite(entryPrice) || !Number.isFinite(targetPrice) || entryPrice <= 0) return null;
  return Math.abs(targetPrice - entryPrice) / entryPrice * 100;
}

function isTp1TooClose(entry, tp1) {
  const distancePct = tp1DistancePct(entry, tp1);
  return Number.isFinite(distancePct) && distancePct < MIN_TP1_DISTANCE_PCT;
}

function isFormalSignalLevel(level) {
  return ["S+", "S", "A"].includes(String(level || "").toUpperCase());
}

function isBObserveSignal(analysisOrRecord) {
  const level = String(analysisOrRecord?.signalLevel || analysisOrRecord?.currentSignalLevel || "").toUpperCase();
  return level === "B";
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

function strategyModes(options = {}) {
  const tp3R = Number(options.tp3R);
  return {
    entryMode: options.entryMode === "conservative" ? "conservative" : "aggressive",
    trendMode: options.trendMode === "counter" ? "counter" : "trend",
    tp3R: Number.isFinite(tp3R) && tp3R > 0 ? tp3R : CONFIG.tp3R
  };
}

function dynamicTradePlanMetrics(side, basic) {
  const rrToTp1 = 1.5;
  const rrToTp2 = 2.0;
  const rrToTp3 = Number.isFinite(Number(basic.tp3R)) && Number(basic.tp3R) > 0 ? Number(basic.tp3R) : CONFIG.tp3R;
  if (!side || !Number.isFinite(basic.price)) return { rr: null, rrToTp1: null, rrToTp2: null, rrToTp3, rrDisplay: null, rrStretch: null };
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
    const tp3 = entry + risk * rrToTp3;
    const stopLossPercent = stopLossDistancePercent(entry, stop);
    const rr = risk > 0 ? rrToTp1 : null;
    return { entry, stop, tp1, tp2, tp3, rr, rrToTp1, rrToTp2, rrToTp3, rrDisplay: rrToTp1, rrStretch: rrToTp2, risk, stopLossPercent, minStopLossPercent, maxStopLossPercent, stopLossTooSmall: false, stopLossTooLarge: Number.isFinite(stopLossPercent) && stopLossPercent > maxStopLossPercent };
  }
  structureStop = Math.max(
    Number.isFinite(basic.recentHigh) ? basic.recentHigh : entry,
    Number.isFinite(basic.ma15m30) ? basic.ma15m30 : entry
  ) * 1.001;
  const stop = Math.max(structureStop, entry + minRisk);
  const risk = stop - entry;
  const tp1 = entry - risk * rrToTp1;
  const tp2 = entry - risk * rrToTp2;
  const tp3 = entry - risk * rrToTp3;
  const stopLossPercent = stopLossDistancePercent(entry, stop);
  const rr = risk > 0 ? rrToTp1 : null;
  return { entry, stop, tp1, tp2, tp3, rr, rrToTp1, rrToTp2, rrToTp3, rrDisplay: rrToTp1, rrStretch: rrToTp2, risk, stopLossPercent, minStopLossPercent, maxStopLossPercent, stopLossTooSmall: false, stopLossTooLarge: Number.isFinite(stopLossPercent) && stopLossPercent > maxStopLossPercent };
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

function scoreAdvancedAnalysisV2(klines15m, basic, options = {}) {
  if (klines15m.length < 220) return null;
  const modes = strategyModes(options);
  const closedKlines15m = klines15m.length > 60 ? klines15m.slice(0, -1) : klines15m;
  const formingCandle = klines15m.length > closedKlines15m.length ? klines15m.at(-1) : null;
  const closes = closedKlines15m.map((item) => item.close);
  const volumes = closedKlines15m.map((item) => item.volume).filter(Number.isFinite);
  if (volumes.length < 20) return null;

  const volumeRatio = volumes.at(-1) / average(volumes.slice(-20));
  const averageVolume = average(volumes.slice(-21, -1));
  const currentVolume = volumes.at(-1);
  const currentFormingVolume = Number(formingCandle?.volume);
  const currentFormingVolumeRatio = Number.isFinite(currentFormingVolume) ? currentFormingVolume / average(volumes.slice(-20)) : null;
  const macd = buildMacdAnalysis(closes);
  const atr = atr14(closedKlines15m);
  const adx = adx14(closedKlines15m);
  const rsi = rsi14(closes);
  if (![volumeRatio, atr].every(Number.isFinite) || !macd || !Number.isFinite(rsi)) return null;

  const atrInfo = atrState(atr, basic.price);
  const env = trendEnvironmentV2(basic);
  const originalDirection = env.direction;
  let direction = originalDirection;
  let provisionalDirection = false;
  const ma30Limit = CONFIG.ma30MaxDeviationPercent[baseSymbol(basic.symbol)] ?? 2;
  const ma30Distance = Math.abs(basic.price - basic.ma15m30) / basic.price * 100;
  const ma30TooFar = Number.isFinite(ma30Distance) && ma30Distance > ma30Limit;
  let setup = setupContextV2(direction, { ...basic, atr }, macd, rsi, volumeRatio, atrInfo, ma30TooFar);
  const earlyBreakoutVolumeRatio = Math.max(volumeRatio, Number(currentFormingVolumeRatio) || 0);
  const earlyBreakoutFormingVolumeOnly = volumeRatio < 0.8 && earlyBreakoutVolumeRatio >= 0.6;
  const provisionalLongPlan = dynamicTradePlanMetrics("long", { ...basic, atr, tp3R: modes.tp3R });
  const provisionalLong = basic.price > basic.ma15m30
    && basic.ma5 > basic.ma10
    && (macd.histogramGrowing || macd.histogramNearBullFlip || macd.crossType === "golden")
    && rsi >= 55
    && rsi <= 78
    && basic.price >= basic.ma4h200 * 0.997
    && (volumeRatio >= 0.8 || earlyBreakoutFormingVolumeOnly)
    && Number.isFinite(provisionalLongPlan.stopLossPercent)
    && provisionalLongPlan.stopLossPercent <= provisionalLongPlan.maxStopLossPercent;
  const provisionalShortPlan = dynamicTradePlanMetrics("short", { ...basic, atr, tp3R: modes.tp3R });
  const provisionalShort = basic.price < basic.ma15m30
    && basic.ma5 < basic.ma10
    && (macd.histogramFalling || macd.histogramNearBearFlip || macd.crossType === "death")
    && rsi >= 22
    && rsi <= 45
    && basic.price <= basic.ma4h200 * 1.003
    && (volumeRatio >= 0.8 || earlyBreakoutFormingVolumeOnly)
    && Number.isFinite(provisionalShortPlan.stopLossPercent)
    && provisionalShortPlan.stopLossPercent <= provisionalShortPlan.maxStopLossPercent;
  if (!direction && modes.trendMode === "counter" && provisionalLong) {
    direction = "long";
    provisionalDirection = true;
    setup = setupContextV2(direction, { ...basic, atr }, macd, rsi, volumeRatio, atrInfo, ma30TooFar);
  } else if (!direction && modes.trendMode === "counter" && provisionalShort) {
    direction = "short";
    provisionalDirection = true;
    setup = setupContextV2(direction, { ...basic, atr }, macd, rsi, volumeRatio, atrInfo, ma30TooFar);
  }
  const chaseRisk = direction === "long" ? !basic.notNearHigh : direction === "short" ? !basic.notNearLow : false;
  const plan = direction === "long" && provisionalLong ? provisionalLongPlan : direction === "short" && provisionalShort ? provisionalShortPlan : dynamicTradePlanMetrics(direction, { ...basic, atr, tp3R: modes.tp3R });
  const longEarlyBreakout = modes.entryMode === "aggressive"
    && direction === "long"
    && provisionalLong;
  if (!setup.breakoutValid && !setup.pullbackValid && longEarlyBreakout) {
    setup.setupType = "earlyBreakout";
    setup.earlyBreakoutValid = true;
    setup.formingVolumeOnly = earlyBreakoutFormingVolumeOnly;
  }
  const isLong = direction === "long";

  let marketScore = 0;
  let entryScore = 0;
  if (direction) {
    if (isLong ? basic.price > basic.ma4h200 : basic.price < basic.ma4h200) marketScore += 10;
    if (isLong ? basic.ma4h > basic.ma4h200 : basic.ma4h < basic.ma4h200) marketScore += 8;
    if (isLong ? basic.ma15m30 > basic.ma15m30Prev : basic.ma15m30 < basic.ma15m30Prev) marketScore += 7;
    if (isLong ? basic.ma5 > basic.ma10 : basic.ma5 < basic.ma10) marketScore += 5;
    if (isLong ? basic.price > basic.ma10 : basic.price < basic.ma10) marketScore += 5;
    if (setup.breakoutValid || setup.pullbackValid || setup.earlyBreakoutValid) {
      marketScore += 5;
      entryScore = 5;
    }
  }
  marketScore = clampScore(marketScore, 40);
  let momentum = 0;
  if (direction) {
    if (setup.macdDirectional) momentum += 9;
    if (setup.histogramStrength) momentum += 7;
    if (setup.earlyBreakoutValid ? rsi >= 55 && rsi <= 78 : isLong ? rsi >= 45 && rsi <= 72 : rsi >= 28 && rsi <= 55) momentum += 5;
    if (volumeRatio >= 0.8) momentum += 5;
    else if (setup.earlyBreakoutValid && earlyBreakoutFormingVolumeOnly) momentum += 3;
    if ((setup.setupType === "breakout" && volumeRatio >= 1.2) || setup.earlyBreakoutValid) momentum += 4;
  }
  momentum = clampScore(momentum, 30);
  const gradingRr = Number.isFinite(plan.rrStretch) ? plan.rrStretch : plan.rrDisplay;
  const rrPart = Math.min(rrScoreFromRatio(gradingRr), riskQualityScore(plan.stopLossPercent, plan.maxStopLossPercent));
  const hardBlockReasons = [];
  if (!direction) hardBlockReasons.push("direction unclear");
  if (!Number.isFinite(plan.stopLossPercent)) hardBlockReasons.push("stop distance unavailable");
  if (Number.isFinite(gradingRr) && gradingRr < 1.2) hardBlockReasons.push("RR below 1.2");
  if ((setup.earlyBreakoutValid ? earlyBreakoutVolumeRatio : volumeRatio) < 0.25) hardBlockReasons.push("volume too low");
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
  const counterTrend = modes.trendMode !== "counter" && !direction && (env.bullScore >= 2 || env.bearScore >= 2);
  let signalLevel = "D";
  const sGate = marketScore >= 35 && momentum >= 24 && rrPart >= 20;
  if (!hardBlocked && totalScore >= 95 && sGate) signalLevel = "S+";
  else if (!hardBlocked && totalScore >= 90 && sGate) signalLevel = "S";
  else if (!hardBlocked && totalScore >= 80) signalLevel = "A";
  else if (!hardBlocked && totalScore >= 70 && !counterTrend) signalLevel = "B";
  else if (!hardBlocked && totalScore >= 60 && !counterTrend) signalLevel = "C";
  if (setup.earlyBreakoutValid && setup.formingVolumeOnly) signalLevel = capSignalLevel(signalLevel, "B");
  if (provisionalDirection) signalLevel = capSignalLevel(signalLevel, "B");
  if (!hardBlocked && Number.isFinite(gradingRr)) {
    if (gradingRr < 1.2) signalLevel = "D";
    else if (gradingRr < 1.5) signalLevel = capSignalLevel(signalLevel, "C");
    else if (gradingRr < 1.8) signalLevel = capSignalLevel(signalLevel, "B");
  }

  const warnings = [];
  if (ma30TooFar) warnings.push(`MA30 deviation high ${number(ma30Distance, 2)}%`);
  if (chaseRisk && !["breakout", "earlyBreakout"].includes(setup.setupType)) warnings.push("chase risk, wait for better entry");
  if (plan.stopLossTooLarge) warnings.push(`stop distance high ${number(plan.stopLossPercent, 2)}%`);
  if (setup.setupType === "none") warnings.push("setup not confirmed");
  if (volumeRatio < 0.8 && !setup.earlyBreakoutValid) warnings.push(`volume weak ${number(volumeRatio, 2)}x`);
  if (setup.earlyBreakoutValid && setup.formingVolumeOnly) warnings.push(`forming candle volume early warning ${number(earlyBreakoutVolumeRatio, 2)}x`);
  if (provisionalDirection) warnings.push("早段方向，尚未完全確認");
  warnings.push(...penaltyWarnings);
  const tp1DistancePercent = tp1DistancePct(plan.entry ?? basic.price, plan.tp1);
  const tp1TooClose = isTp1TooClose(plan.entry ?? basic.price, plan.tp1);
  const bObserveOnly = signalLevel === "B";
  const nonTradeReasons = hardBlockReasons.length ? [...hardBlockReasons] : signalLevel === "D" ? ["score below 60"] : [];
  if (bObserveOnly) nonTradeReasons.push("B_OBSERVE_ONLY");
  if (tp1TooClose) nonTradeReasons.push("TP1_TOO_CLOSE");
  const notifyEligible = isFormalSignalLevel(signalLevel);
  const canNotify = notifyEligible && !tp1TooClose;
  const finalSignal = bObserveOnly
    ? "觀察：B級觀察訊號，暫不列入正式訊號"
    : tp1TooClose ? "觀察：TP1距離進場太近，暫不列入正式訊號" : signalLevel === "D" ? "不建議" : `${signalLevel}級${direction === "long" ? "做多" : "做空"}`;

  return {
    symbol: basic.symbol,
    direction,
    originalDirection,
    provisionalDirection,
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
    currentFormingVolume,
    currentFormingVolumeRatio,
    gradingRr,
    strategyVersion: STRATEGY_VERSION,
    backtestExitMode: BACKTEST_EXIT_MODE,
    tp1DistancePercent,
    tp1TooClose,
    bObserveOnly,
    canNotify,
    price: basic.price,
    entryZone: priceNumber(plan.entry ?? basic.price),
    stop: plan.stop,
    tp1: plan.tp1,
    tp2: plan.tp2,
    tp3: plan.tp3,
    rr: plan.rr,
    rrToTp1: plan.rrToTp1,
    rrToTp2: plan.rrToTp2,
    rrToTp3: plan.rrToTp3,
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
    ma200Distance: Number.isFinite(basic.ma4h200) && basic.ma4h200 > 0 ? (basic.price - basic.ma4h200) / basic.ma4h200 * 100 : null,
    ma30TooFar,
    entryMode: modes.entryMode,
    trendMode: modes.trendMode,
    chaseRisk,
    stopLossPercent: plan.stopLossPercent,
    maxStopLossPercent: plan.maxStopLossPercent,
    notifyBlockedReason: !canNotify ? (bObserveOnly ? "B_OBSERVE_ONLY" : tp1TooClose ? "TP1 distance too close" : `${signalLevel}級不推播`) : ""
  };
}

function scoreAdvancedAnalysis(klines15m, basic, options = {}) {
  return scoreAdvancedAnalysisV2(klines15m, basic, options);
}
function signalKey(analysis) {
  return analysis.symbol;
}

async function shouldNotify(analysis, env) {
  if (!isFormalSignalLevel(analysis?.signalLevel)) return { notify: false, reason: isBObserveSignal(analysis) ? "B_OBSERVE_ONLY" : "非正式等級不推播" };
  if (analysis.tp1TooClose) return { notify: false, reason: "TP1_TOO_CLOSE" };
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
  return isFormalSignalLevel(analysis.signalLevel) || isBObserveSignal(analysis);
}

function hasValidTradePlan(analysis) {
  return ["long", "short"].includes(analysis.direction)
    && ["pullback", "breakout", "earlyBreakout"].includes(analysis.setupType)
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

function signalSnapshotId(analysis, createdAt = Date.now()) {
  return `${createdAt}:${analysis.symbol}:${analysis.setupType || "none"}:${analysis.signalLevel || "D"}`;
}

function buildSignalSnapshot(analysis, createdAt = Date.now()) {
  return {
    id: signalSnapshotId(analysis, createdAt),
    createdAt,
    symbol: analysis.symbol,
    direction: analysis.direction || null,
    provisionalDirection: Boolean(analysis.provisionalDirection),
    setupType: analysis.setupType || "none",
    signalLevel: analysis.signalLevel || "D",
    totalScore: analysis.totalScore ?? null,
    marketScore: analysis.marketScore ?? analysis.trendScore ?? null,
    momentumScore: analysis.momentumScore ?? null,
    rrScore: analysis.rrScore ?? null,
    warnings: Array.isArray(analysis.warnings) ? analysis.warnings : [],
    hardBlockReasons: Array.isArray(analysis.hardBlockReasons) ? analysis.hardBlockReasons : [],
    volumeRatio: analysis.volumeRatio ?? null,
    rsi: analysis.rsi ?? null,
    macd: analysis.macd ?? null,
    ma200Distance: analysis.ma200Distance ?? null,
    price: analysis.price ?? null,
    entry: Number(analysis.entryZone),
    stop: analysis.stop ?? null,
    tp1: analysis.tp1 ?? null,
    tp2: analysis.tp2 ?? null,
    tp3: analysis.tp3 ?? null
  };
}

function signalSnapshotsEnabled(env) {
  return String(env?.ENABLE_SIGNAL_SNAPSHOTS || "").toLowerCase() === "true";
}

async function readSignalSnapshotIndex(env) {
  if (!env.SIGNAL_KV) return [];
  const index = await env.SIGNAL_KV.get(SIGNAL_SNAPSHOT_INDEX_KEY, { type: "json" }).catch(() => null);
  return Array.isArray(index) ? index : [];
}

async function writeSignalSnapshotIndex(env, index) {
  if (!env.SIGNAL_KV) return;
  await env.SIGNAL_KV.put(SIGNAL_SNAPSHOT_INDEX_KEY, JSON.stringify(index.slice(0, SIGNAL_SNAPSHOT_LIMIT)));
}

async function readSignalSnapshot(env, id) {
  if (!env.SIGNAL_KV || !id) return null;
  return await env.SIGNAL_KV.get(`signal:snapshot:${id}`, { type: "json" }).catch(() => null);
}

async function recordSignalSnapshot(env, analysis) {
  if (!env.SIGNAL_KV || !signalSnapshotsEnabled(env) || !analysis || analysis.error) return null;
  const now = Date.now();
  const snapshot = buildSignalSnapshot(analysis, now);
  const cutoff = now - SIGNAL_SNAPSHOT_RETENTION_MS;
  const index = await readSignalSnapshotIndex(env);
  const kept = [];
  for (const id of [snapshot.id, ...index.filter((item) => item !== snapshot.id)]) {
    const createdAt = Number(String(id).split(":")[0]);
    if (Number.isFinite(createdAt) && createdAt >= cutoff) kept.push(id);
    if (kept.length >= SIGNAL_SNAPSHOT_LIMIT) break;
  }
  await Promise.all([
    env.SIGNAL_KV.put(`signal:snapshot:${snapshot.id}`, JSON.stringify(snapshot), { expirationTtl: Math.ceil(SIGNAL_SNAPSHOT_RETENTION_MS / 1000) }),
    writeSignalSnapshotIndex(env, kept)
  ]);
  return snapshot;
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
      .filter((name) => name !== SIGNAL_INDEX_KEY
        && name !== SIGNAL_INDEX_VERSION_KEY
        && name !== SIGNAL_STATS_KEY
        && name !== SIGNAL_SNAPSHOT_INDEX_KEY
        && !name.startsWith("signal:snapshot:"))
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
  const tp1TooClose = isTp1TooClose(analysis.entryZone, analysis.tp1);
  const bObserveOnly = isBObserveSignal(analysis);
  const excludedFromStats = tp1TooClose || bObserveOnly;
  const excludeReason = bObserveOnly ? "B_OBSERVE_ONLY" : tp1TooClose ? "TP1_TOO_CLOSE" : "";
  return {
    id,
    createdAt,
    createdAtBarTime: Number.isFinite(Number(latestBar?.time)) ? Number(latestBar.time) : null,
    trackingPolicy: "next_bar",
    strategyVersion: STRATEGY_VERSION,
    backtestExitMode: BACKTEST_EXIT_MODE,
    symbol: analysis.symbol,
    direction: analysis.direction,
    provisionalDirection: Boolean(analysis.provisionalDirection),
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
    tp3: analysis.tp3,
    rrToTp1: analysis.rrToTp1,
    rrToTp2: analysis.rrToTp2,
    rrToTp3: analysis.rrToTp3,
    tp1DistancePercent: tp1DistancePct(analysis.entryZone, analysis.tp1),
    excludedFromStats,
    excludeReason,
    bObserveOnly,
    stopLossPercent: analysis.stopLossPercent,
    maxStopLossPercent: analysis.maxStopLossPercent,
    tp1Hit: false,
    tp2Hit: false,
    tp3Hit: false,
    maxReachedR: 0,
    finalR: null,
    status: excludedFromStats ? "FILTERED" : "OPEN",
    outcome: excludeReason || null,
    resolvedAt: excludedFromStats ? createdAt : null,
    barsHeld: 0,
    warnings: excludedFromStats
      ? Array.from(new Set([...(Array.isArray(analysis.warnings) ? analysis.warnings : []), bObserveOnly ? "B級觀察訊號，未列入正式統計" : "TP1距離進場太近，未列入正式統計"]))
      : Array.isArray(analysis.warnings) ? analysis.warnings : []
  };
}

function targetHit(record, bar, targetPrice) {
  if (!Number.isFinite(Number(targetPrice))) return false;
  return record.direction === "long" ? bar.high >= Number(targetPrice) : bar.low <= Number(targetPrice);
}

function recordRisk(record) {
  const entry = Number(record.entry);
  const stop = Number(record.stop);
  const risk = Math.abs(entry - stop);
  return Number.isFinite(risk) && risk > 0 ? risk : null;
}

function favorableR(record, bar) {
  const risk = recordRisk(record);
  const entry = Number(record.entry);
  if (!Number.isFinite(risk) || !Number.isFinite(entry)) return null;
  const favorablePrice = record.direction === "long" ? Number(bar.high) : Number(bar.low);
  if (!Number.isFinite(favorablePrice)) return null;
  return record.direction === "long" ? (favorablePrice - entry) / risk : (entry - favorablePrice) / risk;
}

function closeR(record, price) {
  const risk = recordRisk(record);
  const entry = Number(record.entry);
  const exitPrice = Number(price);
  if (!Number.isFinite(risk) || !Number.isFinite(entry) || !Number.isFinite(exitPrice)) return null;
  return record.direction === "long" ? (exitPrice - entry) / risk : (entry - exitPrice) / risk;
}

function outcomeR(record, outcome, fallbackPrice = null) {
  if (outcome === "SL_HIT") return -1;
  if (outcome === "TP1_HIT") return 1.5;
  if (outcome === "TP2_HIT") return Number(record.rrToTp2) || 2.0;
  if (outcome === "TP3_HIT") return Number(record.rrToTp3) || CONFIG.tp3R;
  if (outcome === "EXPIRED" || outcome === "TIMEOUT") return Number.isFinite(Number(fallbackPrice)) ? closeR(record, fallbackPrice) : 0;
  return Number.isFinite(Number(record.finalR)) ? Number(record.finalR) : null;
}

function resolveSignalRecord(record, klines15m) {
  if (!record || (record.status !== "OPEN" && record.result !== "OPEN")) return record;
  if (record.strategyVersion !== STRATEGY_VERSION) return record;
  if (!isFormalSignalLevel(record.initialSignalLevel || record.signalLevel || record.currentSignalLevel)) {
    return {
      ...record,
      status: "FILTERED",
      outcome: isBObserveSignal(record) ? "B_OBSERVE_ONLY" : "OBSERVE_ONLY",
      excludedFromStats: true,
      excludeReason: isBObserveSignal(record) ? "B_OBSERVE_ONLY" : "OBSERVE_ONLY",
      resolvedAt: Date.now(),
      finalR: null,
      warnings: Array.from(new Set([...(Array.isArray(record.warnings) ? record.warnings : []), isBObserveSignal(record) ? "B級觀察訊號，未列入正式統計" : "觀察訊號，未列入正式統計"]))
    };
  }
  const createdAtBarTime = Number(record.createdAtBarTime);
  const bars = record.trackingPolicy === "next_bar" && Number.isFinite(createdAtBarTime)
    ? klines15m.filter((item) => Number(item.time) > createdAtBarTime)
    : klines15m.filter((item) => Number(item.time) >= Number(record.createdAt));
  let state = {
    ...record,
    tp1Hit: Boolean(record.tp1Hit || record.outcome === "TP1_HIT" || record.outcome === "TP2_HIT" || record.outcome === "TP3_HIT"),
    tp2Hit: Boolean(record.tp2Hit || record.outcome === "TP2_HIT" || record.outcome === "TP3_HIT"),
    tp3Hit: Boolean(record.tp3Hit || record.outcome === "TP3_HIT"),
    maxReachedR: Number.isFinite(Number(record.maxReachedR)) ? Number(record.maxReachedR) : 0
  };
  const finish = (outcome, bar, barsHeld) => ({
    ...state,
    status: "CLOSED",
    outcome,
    resolvedAt: bar?.time ?? Date.now(),
    barsHeld,
    finalR: outcomeR(state, outcome, bar?.close)
  });
  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    const barsHeld = index + 1;
    const hitStop = record.direction === "long" ? bar.low <= record.stop : bar.high >= record.stop;
    if (hitStop) return finish("SL_HIT", bar, barsHeld);
    const hitTp1 = targetHit(record, bar, record.tp1);

    state = {
      ...state,
      barsHeld,
      tp1Hit: state.tp1Hit || hitTp1,
      tp2Hit: state.tp2Hit || targetHit(record, bar, record.tp2),
      tp3Hit: state.tp3Hit || targetHit(record, bar, record.tp3)
    };
    const reachedR = favorableR(record, bar);
    if (Number.isFinite(reachedR)) state.maxReachedR = Math.max(Number(state.maxReachedR) || 0, reachedR);
    if (hitTp1) return finish("TP1_HIT", bar, barsHeld);
  }
  if (bars.length >= SIGNAL_EXPIRY_BARS) {
    const lastBar = bars.at(-1);
    return finish("EXPIRED", lastBar, bars.length);
  }
  return { ...state, barsHeld: bars.length };
}

function shouldPersistSignalRecordUpdate(previous, next) {
  if (!previous || !next) return false;

  const previousStatus = previous.status || previous.result || "OPEN";
  const nextStatus = next.status || next.result || "OPEN";

  if (previousStatus !== nextStatus) return true;
  if ((previous.outcome || null) !== (next.outcome || null)) return true;

  if (Boolean(previous.tp1Hit) !== Boolean(next.tp1Hit)) return true;
  if (Boolean(previous.tp2Hit) !== Boolean(next.tp2Hit)) return true;
  if (Boolean(previous.tp3Hit) !== Boolean(next.tp3Hit)) return true;

  const previousFinalR = Number(previous.finalR);
  const nextFinalR = Number(next.finalR);
  if (Number.isFinite(nextFinalR) && previousFinalR !== nextFinalR) return true;

  return false;
}

async function updateOpenSignalRecords(env, symbol, klines15m) {
  if (!env.SIGNAL_KV) return [];
  const records = await recentSignalRecords(env);
  const updated = [];
  for (const record of records.filter((item) => item.symbol === symbol && (item.status === "OPEN" || item.result === "OPEN"))) {
    const next = resolveSignalRecord(record, klines15m);
    if (shouldPersistSignalRecordUpdate(record, next)) {
      await writeSignalRecord(env, next);
      updated.push(next);
    }
  }
  return updated;
}

async function recordSignalIfEligible(env, analysis, options = {}) {
  if (!env.SIGNAL_KV || !isValidBacktestSignal(analysis) || !hasValidTradePlan(analysis)) return null;
  const shouldRebuildStats = options.rebuildStats !== false;
  const index = await ensureCompleteSignalIndex(env);
  const records = await recentSignalRecords(env);
  const signalIsTp1TooClose = isTp1TooClose(analysis.entryZone, analysis.tp1);
  const signalIsBObserve = isBObserveSignal(analysis);
  const filteredOutcome = signalIsBObserve ? "B_OBSERVE_ONLY" : signalIsTp1TooClose ? "TP1_TOO_CLOSE" : "";
  if (filteredOutcome) {
    const latestBar = Array.isArray(analysis.latestKlines15m) ? analysis.latestKlines15m.at(-1) : null;
    const createdAtBarTime = Number.isFinite(Number(latestBar?.time)) ? Number(latestBar.time) : null;
    const matchingFiltered = records.find((record) => record.strategyVersion === STRATEGY_VERSION
      && record.outcome === filteredOutcome
      && record.symbol === analysis.symbol
      && record.direction === analysis.direction
      && record.setupType === analysis.setupType
      && Number(record.createdAtBarTime) === createdAtBarTime);
    if (matchingFiltered) return null;
  }
  const matchingOpen = records.find((record) => (record.status === "OPEN" || record.result === "OPEN")
    && record.strategyVersion === STRATEGY_VERSION
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
      if (shouldRebuildStats) await rebuildSignalStats(env);
      return upgraded;
    }
    return null;
  }

  const record = buildSignalRecord(analysis);
  await writeSignalRecord(env, record);
  await writeSignalIndex(env, [record.id, ...index.filter((id) => id !== record.id)]);
  if (shouldRebuildStats) await rebuildSignalStats(env);
  return record;
}

function emptyBucketStats() {
  return { total: 0, wins: 0, losses: 0, winRate: null };
}

function addBucketResult(bucket, record) {
  bucket.total += 1;
  if (record.outcome === "TP1_HIT") bucket.wins += 1;
  if (record.outcome === "SL_HIT") bucket.losses += 1;
  const denominator = bucket.wins + bucket.losses;
  bucket.winRate = denominator ? bucket.wins / denominator * 100 : null;
}

function recordTargetReached(record, level) {
  const outcome = record.outcome;
  if (level === 1) return Boolean(record.tp1Hit || outcome === "TP1_HIT" || outcome === "TP2_HIT" || outcome === "TP3_HIT");
  if (level === 2) return Boolean(record.tp2Hit || outcome === "TP2_HIT" || outcome === "TP3_HIT");
  if (level === 3) return Boolean(record.tp3Hit || outcome === "TP3_HIT");
  return false;
}

function recordFinalR(record) {
  if (Number.isFinite(Number(record.finalR))) return Number(record.finalR);
  return outcomeR(record, record.outcome);
}

function isCurrentStrategyRecord(record) {
  return record?.strategyVersion === STRATEGY_VERSION;
}

function isFilteredSignalRecord(record) {
  const outcome = String(record?.outcome || "").toUpperCase();
  const status = String(record?.status || record?.result || "").toUpperCase();
  return Boolean(record?.excludedFromStats)
    || outcome === "TP1_TOO_CLOSE"
    || outcome === "B_OBSERVE_ONLY"
    || outcome === "OBSERVE_ONLY"
    || outcome === "FILTERED"
    || outcome === "SKIPPED"
    || status === "FILTERED"
    || status === "SKIPPED";
}

function isFormalSignalRecord(record) {
  const status = String(record?.status || record?.result || "").toUpperCase();
  const outcome = String(record?.outcome || "").toUpperCase();
  const formalOutcome = !outcome || status === "OPEN" || outcome === "TP1_HIT" || outcome === "SL_HIT" || outcome === "EXPIRED" || outcome === "TIMEOUT";
  return isCurrentStrategyRecord(record)
    && isFormalSignalLevel(record?.initialSignalLevel || record?.signalLevel || record?.currentSignalLevel)
    && formalOutcome
    && !isFilteredSignalRecord(record);
}

function computeSignalStats(records) {
  const rawRecords = Array.isArray(records) ? records : [];
  const currentRecords = rawRecords.filter(isCurrentStrategyRecord);
  const recordsForStats = currentRecords.filter(isFormalSignalRecord);
  const closedRecords = recordsForStats.filter((item) => item.status !== "OPEN");
  const stats = {
    strategyVersion: STRATEGY_VERSION,
    backtestExitMode: BACKTEST_EXIT_MODE,
    rawSignals: rawRecords.length,
    currentStrategySignals: currentRecords.length,
    filteredSignals: currentRecords.length - recordsForStats.length,
    filteredTp1TooClose: currentRecords.filter((item) => item.outcome === "TP1_TOO_CLOSE").length,
    filteredBObserve: currentRecords.filter((item) => item.outcome === "B_OBSERVE_ONLY").length,
    totalSignals: recordsForStats.length,
    closedSignals: closedRecords.length,
    openSignals: recordsForStats.filter((item) => item.status === "OPEN").length,
    tp1Hits: recordsForStats.filter((item) => recordTargetReached(item, 1)).length,
    tp2Hits: recordsForStats.filter((item) => recordTargetReached(item, 2)).length,
    tp3Hits: recordsForStats.filter((item) => recordTargetReached(item, 3)).length,
    slHits: recordsForStats.filter((item) => item.outcome === "SL_HIT").length,
    expired: recordsForStats.filter((item) => item.outcome === "EXPIRED" || item.outcome === "TIMEOUT").length,
    ambiguous: recordsForStats.filter((item) => item.outcome === "AMBIGUOUS").length,
    tp3HitRate: null,
    averageMaxR: null,
    totalPnlR: 0,
    overallWinRate: null,
    overallWinRateIncludingExpired: null,
    byLevel: { "S+": emptyBucketStats(), S: emptyBucketStats(), A: emptyBucketStats(), B: emptyBucketStats(), C: emptyBucketStats() },
    byDirection: { long: emptyBucketStats(), short: emptyBucketStats() },
    bySetupType: { pullback: emptyBucketStats(), breakout: emptyBucketStats(), earlyBreakout: emptyBucketStats() },
    averageBarsHeld: null,
    maxConsecutiveSL: 0
  };

  const resolved = closedRecords;
  const wins = resolved.filter((item) => item.outcome === "TP1_HIT").length;
  const losses = stats.slHits;
  const expired = stats.expired;
  stats.totalPnlR = recordsForStats.reduce((total, record) => {
    const finalR = recordFinalR(record);
    return Number.isFinite(finalR) ? total + finalR : total;
  }, 0);
  stats.tp3HitRate = stats.closedSignals ? stats.tp3Hits / stats.closedSignals * 100 : null;
  stats.overallWinRate = wins + losses ? wins / (wins + losses) * 100 : null;
  stats.overallWinRateIncludingExpired = wins + losses + expired ? wins / (wins + losses + expired) * 100 : null;
  const barsHeld = resolved.map((item) => Number(item.barsHeld)).filter(Number.isFinite);
  stats.averageBarsHeld = barsHeld.length ? average(barsHeld) : null;
  const maxReachedValues = recordsForStats.map((item) => Number(item.maxReachedR)).filter(Number.isFinite);
  stats.averageMaxR = maxReachedValues.length ? average(maxReachedValues) : null;

  for (const record of recordsForStats) {
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
    } else if (record.outcome === "TP1_HIT") {
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
  if (!stats || stats.strategyVersion !== STRATEGY_VERSION || Number(stats.rawSignals) !== index.length) {
    stats = await rebuildSignalStats(env);
  }
  const allIndexRecordsAreCurrent = Number(stats.currentStrategySignals) === index.length;
  let total = allIndexRecordsAreCurrent ? index.length : 0;
  let displayRecords = null;
  if (!allIndexRecordsAreCurrent) {
    const allRecords = await signalRecordsByIds(env, index);
    displayRecords = allRecords.filter(isCurrentStrategyRecord);
    total = displayRecords.length;
  }
  const totalPages = Math.max(1, Math.ceil(total / requested.limit));
  const page = Math.min(requested.page, totalPages);
  const offset = (page - 1) * requested.limit;
  const recentSignals = displayRecords
    ? displayRecords.slice(offset, offset + requested.limit)
    : await signalRecordsByIds(env, index.slice(offset, offset + requested.limit));
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

async function handleSignalSnapshots(env, requestUrl) {
  if (!signalSnapshotsEnabled(env)) {
    return json({
      snapshots: [],
      disabled: true,
      message: "Signal snapshots are disabled to reduce KV writes."
    });
  }
  if (!env.SIGNAL_KV) return json({ snapshots: [] });
  const symbol = String(requestUrl.searchParams.get("symbol") || "").trim().toUpperCase();
  const setupType = String(requestUrl.searchParams.get("setupType") || "").trim();
  const signalLevel = String(requestUrl.searchParams.get("signalLevel") || "").trim().toUpperCase();
  const hardBlockReason = String(requestUrl.searchParams.get("hardBlockReason") || "").trim().toLowerCase();
  const from = Number(requestUrl.searchParams.get("from") || 0);
  const to = Number(requestUrl.searchParams.get("to") || Number.MAX_SAFE_INTEGER);
  const limit = Math.min(Math.max(Number(requestUrl.searchParams.get("limit") || 100), 1), 500);
  const index = await readSignalSnapshotIndex(env);
  const snapshots = [];
  for (const id of index) {
    const snapshot = await readSignalSnapshot(env, id);
    if (!snapshot) continue;
    if (symbol && snapshot.symbol !== symbol) continue;
    if (setupType && snapshot.setupType !== setupType) continue;
    if (signalLevel && snapshot.signalLevel !== signalLevel) continue;
    if (Number.isFinite(from) && Number(snapshot.createdAt) < from) continue;
    if (Number.isFinite(to) && Number(snapshot.createdAt) > to) continue;
    if (hardBlockReason && !(snapshot.hardBlockReasons || []).some((item) => String(item).toLowerCase().includes(hardBlockReason))) continue;
    snapshots.push(snapshot);
    if (snapshots.length >= limit) break;
  }
  return json({ snapshots });
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
  if (type === "earlyBreakout") return "早段突破";
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
    .replace("early direction, not fully confirmed", "早段方向，尚未完全確認")
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
  const rrTp1 = Number.isFinite(analysis.rrToTp1) ? "+" + number(analysis.rrToTp1, 1) + "R" : Number.isFinite(analysis.rrDisplay) ? "+" + number(analysis.rrDisplay, 1) + "R" : "-";
  const rrTp2 = Number.isFinite(analysis.rrStretch) ? number(analysis.rrStretch, 1) + "R" : "-";
  const rrTp3 = Number.isFinite(analysis.rrToTp3) ? number(analysis.rrToTp3, 1) + "R" : "-";
  const tp1Distance = Number.isFinite(analysis.tp1DistancePercent)
    ? number(analysis.tp1DistancePercent, 2) + "%"
    : Number.isFinite(Number(analysis.entryZone)) && Number.isFinite(Number(analysis.tp1)) ? number(tp1DistancePct(analysis.entryZone, analysis.tp1), 2) + "%" : "-";
  const directionNote = analysis.provisionalDirection ? "\n方向狀態：早段方向，尚未完全確認" : "";
  const scoreText = `等級：${level}\n總分：${analysis.totalScore ?? "-"} / 100\n市場：${analysis.marketScore ?? "-"} / 40\n動能：${analysis.momentumScore ?? "-"} / 30\n風報：${analysis.rrScore ?? "-"} / 30`;
  const priceBlock = `現價：${priceNumber(analysis.price)}\n進場：${analysis.entryZone}\n止損：${Number.isFinite(analysis.stop) ? priceNumber(analysis.stop) : "-"}\n主要止盈：${Number.isFinite(analysis.tp1) ? priceNumber(analysis.tp1) : "-"}\n參考TP2：${Number.isFinite(analysis.tp2) ? priceNumber(analysis.tp2) : "-"}\n參考TP3：${Number.isFinite(analysis.tp3) ? priceNumber(analysis.tp3) : "-"}`;

  if (level === "B") {
    const earlyBreakoutNote = analysis.setupType === "earlyBreakout"
      ? "\n早段多頭，需控倉，不追高。"
      : "";
    return `${signalTitleIcon(level)} B級${directionText}｜${analysis.symbol}

型態：${typeText}
${directionNote}
狀態：觀察，不建議追價${earlyBreakoutNote}

${priceBlock}

風報：
TP1 R倍數：${rrTp1}
TP1距離進場：${tp1Distance}
參考TP2：${rrTp2}
參考TP3：${rrTp3}

目前策略以 TP1 為正式出場目標，TP2 / TP3 僅供參考。

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
${directionNote}
${priceBlock}

風報：
TP1 R倍數：${rrTp1}
TP1距離進場：${tp1Distance}
參考TP2：${rrTp2}
參考TP3：${rrTp3}

目前策略以 TP1 為正式出場目標，TP2 / TP3 僅供參考。

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

function strategyOptionsFromEnv(env = {}) {
  return strategyModes({
    entryMode: env.ENTRY_MODE,
    trendMode: env.TREND_MODE,
    tp3R: env.TP3_R
  });
}

async function scanSymbol(symbol, env = {}) {
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
  const analysis = scoreAdvancedAnalysisV2(klines15m, basic, strategyOptionsFromEnv(env));
  if (!analysis) {
    console.log(`${symbol} fetch failed`);
    return { symbol, signalLevel: "ERROR", error: true };
  }
  analysis.latestKlines15m = klines15m;
  return analysis;
}

async function runScheduledScan(env) {
  console.log("[scheduled] start");
  let statsDirty = false;
  for (const symbol of SCAN_SYMBOLS) {
    try {
      const analysis = await scanSymbol(symbol, env);
      if (analysis.error) continue;
      if (signalSnapshotsEnabled(env)) {
        await recordSignalSnapshot(env, analysis);
      }
      const resolvedSignals = await updateOpenSignalRecords(env, symbol, analysis.latestKlines15m || []);
      if (resolvedSignals.length) statsDirty = true;
      const recordedSignal = await recordSignalIfEligible(env, analysis, { rebuildStats: false });
      if (recordedSignal) statsDirty = true;
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
  if (statsDirty) await rebuildSignalStats(env);
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
      if (requestUrl.pathname === "/signals/snapshots") return await handleSignalSnapshots(env, requestUrl);
      if (requestUrl.pathname === "/admin/clear-signals") return await handleClearSignals(env, requestUrl, request.method);

      return json({
        error: "Not found",
        routes: [
          "/price?symbol=BTC-USDT",
          "/klines?symbol=BTC-USDT&interval=15m&limit=200",
          "/signals/stats?page=1&limit=50",
          "/signals/snapshots?symbol=SOL-USDT&limit=100",
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




