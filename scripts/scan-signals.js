const fs = require("node:fs");
const path = require("node:path");

const WORKER_BASE_URL = "https://bingx-proxy.danielfeng8.workers.dev";
const SYMBOLS = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "DOGE-USDT"];
const COOLDOWN_MINUTES = 30;
const STATE_FILE = path.join(process.cwd(), ".cache", "signal-cooldown.json");
const SIGNAL_RECORDS_FILE = path.join(process.cwd(), ".cache", "signal-records.json");
const SIGNAL_SNAPSHOTS_FILE = path.join(process.cwd(), ".cache", "signal-snapshots.json");
const SIGNAL_SNAPSHOT_LIMIT = 1000;
const SIGNAL_SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
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
  chaseBufferPercent: 0.3,
  tp3R: 2.5
};

function baseSymbol(symbol) {
  return String(symbol || "").split("-")[0].toUpperCase();
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

function normalizeKline(item) {
  return {
    time: Number(item.time),
    open: Number(item.open),
    high: Number(item.high),
    low: Number(item.low),
    close: Number(item.close),
    volume: Number(item.volume)
  };
}

function extractKlines(payload) {
  const raw = Array.isArray(payload) ? payload : payload && payload.data;
  if (!Array.isArray(raw)) throw new Error("Worker kline response did not contain data array");

  const candles = raw.map(normalizeKline)
    .filter((item) => [item.time, item.open, item.high, item.low, item.close].every(Number.isFinite))
    .sort((a, b) => a.time - b.time);

  if (!candles.length) throw new Error("Worker kline response did not contain usable candles");
  return candles;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function fetchKlines(symbol, interval, limit = 300) {
  const url = new URL("/klines", WORKER_BASE_URL);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", String(limit));
  return extractKlines(await fetchJson(url.toString()));
}

async function fetchPrice(symbol) {
  const url = new URL("/price", WORKER_BASE_URL);
  url.searchParams.set("symbol", symbol);
  const payload = await fetchJson(url.toString());
  const price = Number(payload.price ?? payload.data?.price);
  if (!Number.isFinite(price)) throw new Error(`Worker price response did not contain price for ${symbol}`);
  return price;
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

function signalLevelRank(level) {
  return { D: 0, C: 1, B: 2, A: 3, S: 4, "S+": 5 }[level] ?? 0;
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
  const nonTradeReasons = hardBlockReasons.length ? [...hardBlockReasons] : signalLevel === "D" ? ["score below 60"] : [];
  const canNotify = ["S+", "S", "A"].includes(signalLevel) || (signalLevel === "B" && totalScore >= 70 && gradingRr >= 1.2);
  const finalSignal = signalLevel === "D" ? "不建議" : `${signalLevel}級${direction === "long" ? "做多" : "做空"}`;
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
    notifyBlockedReason: !canNotify ? (signalLevel === "B" ? "B score/RR below notify threshold" : `${signalLevel}級不推播`) : ""
  };
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function signalKey(analysis) {
  return analysis.symbol;
}

function shouldNotify(analysis, state) {
  if (!analysis.canNotify) return { notify: false, reason: analysis.notifyBlockedReason || "不符合推播條件" };
  const key = signalKey(analysis);
  const previous = state[key];
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

function rememberNotification(analysis, state, decision) {
  if (!decision.key) return;
  const notifyTime = Date.now();
  state[decision.key] = {
    symbol: analysis.symbol,
    direction: analysis.direction,
    level: analysis.signalLevel,
    lastNotifyLevel: analysis.signalLevel,
    price: analysis.price,
    finalSignal: analysis.finalSignal,
    time: notifyTime,
    lastNotifyTime: notifyTime
  };
}

function loadSignalRecords() {
  try {
    const payload = JSON.parse(fs.readFileSync(SIGNAL_RECORDS_FILE, "utf8"));
    return Array.isArray(payload.records) ? payload.records : [];
  } catch {
    return [];
  }
}

function saveSignalRecords(records) {
  fs.mkdirSync(path.dirname(SIGNAL_RECORDS_FILE), { recursive: true });
  const sorted = records.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  fs.writeFileSync(SIGNAL_RECORDS_FILE, JSON.stringify({ records: sorted, stats: computeSignalStats(sorted) }, null, 2));
}

function loadSignalSnapshots() {
  try {
    const payload = JSON.parse(fs.readFileSync(SIGNAL_SNAPSHOTS_FILE, "utf8"));
    return Array.isArray(payload.snapshots) ? payload.snapshots : [];
  } catch {
    return [];
  }
}

function buildSignalSnapshot(analysis, createdAt = Date.now()) {
  return {
    id: `${createdAt}:${analysis.symbol}:${analysis.setupType || "none"}:${analysis.signalLevel || "D"}`,
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

function saveSignalSnapshot(analysis) {
  if (!analysis || analysis.error) return null;
  const now = Date.now();
  const cutoff = now - SIGNAL_SNAPSHOT_RETENTION_MS;
  const snapshot = buildSignalSnapshot(analysis, now);
  const snapshots = [snapshot, ...loadSignalSnapshots()]
    .filter((item) => Number(item.createdAt) >= cutoff)
    .slice(0, SIGNAL_SNAPSHOT_LIMIT);
  fs.mkdirSync(path.dirname(SIGNAL_SNAPSHOTS_FILE), { recursive: true });
  fs.writeFileSync(SIGNAL_SNAPSHOTS_FILE, JSON.stringify({ snapshots }, null, 2));
  return snapshot;
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
    && ["pullback", "breakout", "earlyBreakout"].includes(analysis.setupType)
    && [analysis.entryZone, analysis.stop, analysis.tp1, analysis.tp2].every((value) => Number.isFinite(Number(value)));
}

function buildSignalRecord(analysis) {
  const createdAt = Date.now();
  const latestBar = Array.isArray(analysis.latestKlines15m) ? analysis.latestKlines15m.at(-1) : null;
  return {
    id: signalRecordId(analysis, createdAt),
    createdAt,
    createdAtBarTime: Number.isFinite(Number(latestBar?.time)) ? Number(latestBar.time) : null,
    trackingPolicy: "next_bar",
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
    stopLossPercent: analysis.stopLossPercent,
    maxStopLossPercent: analysis.maxStopLossPercent,
    tp1Hit: false,
    tp2Hit: false,
    tp3Hit: false,
    maxReachedR: 0,
    finalR: null,
    status: "OPEN",
    outcome: null,
    resolvedAt: null,
    barsHeld: 0,
    warnings: Array.isArray(analysis.warnings) ? analysis.warnings : []
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
  if (outcome === "TP1_HIT") return Number(record.rrToTp1) || 1.5;
  if (outcome === "TP2_HIT") return Number(record.rrToTp2) || 2.0;
  if (outcome === "TP3_HIT") return Number(record.rrToTp3) || CONFIG.tp3R;
  if (outcome === "EXPIRED") return Number.isFinite(Number(fallbackPrice)) ? closeR(record, fallbackPrice) : 0;
  return Number.isFinite(Number(record.finalR)) ? Number(record.finalR) : null;
}

function resolveSignalRecord(record, klines15m) {
  if (!record || (record.status !== "OPEN" && record.result !== "OPEN")) return record;
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

    state = {
      ...state,
      barsHeld,
      tp1Hit: state.tp1Hit || targetHit(record, bar, record.tp1),
      tp2Hit: state.tp2Hit || targetHit(record, bar, record.tp2),
      tp3Hit: state.tp3Hit || targetHit(record, bar, record.tp3)
    };
    const reachedR = favorableR(record, bar);
    if (Number.isFinite(reachedR)) state.maxReachedR = Math.max(Number(state.maxReachedR) || 0, reachedR);
    if (state.tp3Hit) return finish("TP3_HIT", bar, barsHeld);
  }
  if (bars.length >= SIGNAL_EXPIRY_BARS) {
    const lastBar = bars.at(-1);
    if (state.tp2Hit) return finish("TP2_HIT", lastBar, bars.length);
    if (state.tp1Hit) return finish("TP1_HIT", lastBar, bars.length);
    return finish("EXPIRED", lastBar, bars.length);
  }
  return { ...state, barsHeld: bars.length };
}

function updateOpenSignalRecords(records, symbol, klines15m) {
  return records.map((record) => record.symbol === symbol && (record.status === "OPEN" || record.result === "OPEN")
    ? resolveSignalRecord(record, klines15m)
    : record);
}

function recordSignalIfEligible(records, analysis) {
  if (!isValidBacktestSignal(analysis) || !hasValidTradePlan(analysis)) return records;
  const matchingOpenIndex = records.findIndex((record) => (record.status === "OPEN" || record.result === "OPEN")
    && record.symbol === analysis.symbol
    && record.direction === analysis.direction
    && record.setupType === analysis.setupType);
  if (matchingOpenIndex >= 0) {
    const current = records[matchingOpenIndex];
    const currentLevel = current.currentSignalLevel || current.signalLevel;
    if (signalLevelRank(analysis.signalLevel) > signalLevelRank(currentLevel)) {
      records[matchingOpenIndex] = {
        ...current,
        initialSignalLevel: current.initialSignalLevel || current.signalLevel,
        currentSignalLevel: analysis.signalLevel,
        lastSeenScore: analysis.totalScore,
        warnings: Array.from(new Set([...(current.warnings || []), ...(analysis.warnings || [])]))
      };
    }
    return records;
  }
  return [buildSignalRecord(analysis), ...records];
}

function emptyBucketStats() {
  return { total: 0, wins: 0, losses: 0, winRate: null };
}

function addBucketResult(bucket, record) {
  bucket.total += 1;
  if (record.outcome === "TP1_HIT" || record.outcome === "TP2_HIT" || record.outcome === "TP3_HIT") bucket.wins += 1;
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

function computeSignalStats(records) {
  const closedRecords = records.filter((item) => item.status !== "OPEN");
  const stats = {
    totalSignals: records.length,
    closedSignals: closedRecords.length,
    openSignals: records.filter((item) => item.status === "OPEN").length,
    tp1Hits: records.filter((item) => recordTargetReached(item, 1)).length,
    tp2Hits: records.filter((item) => recordTargetReached(item, 2)).length,
    tp3Hits: records.filter((item) => recordTargetReached(item, 3)).length,
    slHits: records.filter((item) => item.outcome === "SL_HIT").length,
    expired: records.filter((item) => item.outcome === "EXPIRED").length,
    ambiguous: records.filter((item) => item.outcome === "AMBIGUOUS").length,
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
  const wins = closedRecords.filter((item) => item.outcome === "TP1_HIT" || item.outcome === "TP2_HIT" || item.outcome === "TP3_HIT").length;
  const losses = stats.slHits;
  const expired = stats.expired;
  stats.totalPnlR = records.reduce((total, record) => {
    const finalR = recordFinalR(record);
    return Number.isFinite(finalR) ? total + finalR : total;
  }, 0);
  stats.tp3HitRate = stats.closedSignals ? stats.tp3Hits / stats.closedSignals * 100 : null;
  stats.overallWinRate = wins + losses ? wins / (wins + losses) * 100 : null;
  stats.overallWinRateIncludingExpired = wins + losses + expired ? wins / (wins + losses + expired) * 100 : null;
  const resolved = closedRecords;
  const barsHeld = resolved.map((item) => Number(item.barsHeld)).filter(Number.isFinite);
  stats.averageBarsHeld = barsHeld.length ? average(barsHeld) : null;
  const maxReachedValues = records.map((item) => Number(item.maxReachedR)).filter(Number.isFinite);
  stats.averageMaxR = maxReachedValues.length ? average(maxReachedValues) : null;
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
    } else if (record.outcome === "TP1_HIT" || record.outcome === "TP2_HIT" || record.outcome === "TP3_HIT") {
      streak = 0;
    }
  }
  return stats;
}

function scoreAdvancedAnalysis(klines15m, basic, options = {}) {
  return scoreAdvancedAnalysisV2(klines15m, basic, options);
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
  const rrTp1 = Number.isFinite(analysis.rrDisplay) ? number(analysis.rrDisplay, 1) + "R" : "-";
  const rrTp2 = Number.isFinite(analysis.rrStretch) ? number(analysis.rrStretch, 1) + "R" : "-";
  const rrTp3 = Number.isFinite(analysis.rrToTp3) ? number(analysis.rrToTp3, 1) + "R" : "-";
  const directionNote = analysis.provisionalDirection ? "\n方向狀態：早段方向，尚未完全確認" : "";
  const scoreText = `等級：${level}\n總分：${analysis.totalScore ?? "-"} / 100\n市場：${analysis.marketScore ?? "-"} / 40\n動能：${analysis.momentumScore ?? "-"} / 30\n風報：${analysis.rrScore ?? "-"} / 30`;
  const priceBlock = `現價：${priceNumber(analysis.price)}\n進場：${analysis.entryZone}\n止損：${Number.isFinite(analysis.stop) ? priceNumber(analysis.stop) : "-"}\n止盈1：${Number.isFinite(analysis.tp1) ? priceNumber(analysis.tp1) : "-"}\n止盈2：${Number.isFinite(analysis.tp2) ? priceNumber(analysis.tp2) : "-"}\n止盈3：${Number.isFinite(analysis.tp3) ? priceNumber(analysis.tp3) : "-"}`;

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
TP1：${rrTp1}
TP2：${rrTp2}
TP3：${rrTp3}

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
TP1：${rrTp1}
TP2：${rrTp2}
TP3：${rrTp3}

分數：
${scoreText}

提醒：
${reminder}`;
}
async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok === false) throw new Error(payload?.description || `Telegram HTTP ${response.status}`);
}

function strategyOptionsFromEnv() {
  return strategyModes({
    entryMode: process.env.ENTRY_MODE,
    trendMode: process.env.TREND_MODE,
    tp3R: process.env.TP3_R
  });
}

async function scanSymbol(symbol) {
  const [klines4h, klines15m, price] = await Promise.all([
    fetchKlines(symbol, "4h", 300),
    fetchKlines(symbol, "15m", 300),
    fetchPrice(symbol)
  ]);
  const basic = basicFromKlines(symbol, price, klines4h, klines15m);
  const analysis = scoreAdvancedAnalysisV2(klines15m, basic, strategyOptionsFromEnv());
  if (!analysis) throw new Error(`Unable to calculate analysis for ${symbol}`);
  analysis.latestKlines15m = klines15m;
  return analysis;
}

async function main() {
  const state = loadState();
  let signalRecords = loadSignalRecords();
  const analyses = [];

  for (const symbol of SYMBOLS) {
    try {
      const analysis = await scanSymbol(symbol);
      analyses.push(analysis);
      saveSignalSnapshot(analysis);
      signalRecords = updateOpenSignalRecords(signalRecords, symbol, analysis.latestKlines15m || []);
      signalRecords = recordSignalIfEligible(signalRecords, analysis);
      const decision = shouldNotify(analysis, state);
      console.log(`[${symbol}] ${analysis.signalLevel} ${analysis.finalSignal} | Market ${analysis.marketScore}/40 | Momentum ${analysis.momentumScore}/30 | RRScore ${analysis.rrScore}/30 | notify=${decision.notify ? "yes" : "no"} ${decision.reason}`);

      if (decision.notify) {
        await sendTelegram(telegramText(analysis));
        rememberNotification(analysis, state, decision);
        console.log(`[${symbol}] Telegram sent`);
      }
    } catch (error) {
      console.error(`[${symbol}] ${error.message}`);
    }
  }

  saveState(state);
  saveSignalRecords(signalRecords);

  if (!analyses.some((item) => ["S", "A", "B"].includes(item.signalLevel))) {
    console.log("No S/A/B signal.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});




