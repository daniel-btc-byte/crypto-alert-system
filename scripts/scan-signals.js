const fs = require("node:fs");
const path = require("node:path");

const WORKER_BASE_URL = "https://bingx-proxy.danielfeng8.workers.dev";
const SYMBOLS = ["BTC-USDT", "ETH-USDT", "SOL-USDT", "XRP-USDT", "DOGE-USDT"];
const COOLDOWN_MINUTES = 30;
const STATE_FILE = path.join(process.cwd(), ".cache", "signal-cooldown.json");

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
  chaseBufferPercent: 0.3
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

function atrState(atr, price) {
  if (!Number.isFinite(atr) || !Number.isFinite(price) || price <= 0) {
    return { percent: null, status: "資料不足", low: false, high: false, normal: false };
  }
  const percent = (atr / price) * 100;
  if (percent < 0.12) return { percent, status: "波動不足，等待", low: true, high: false, normal: false };
  if (percent > 1.2) return { percent, status: "高波動，降低倉位", low: false, high: true, normal: false };
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
        : "動能減弱"
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

  return {
    symbol,
    price,
    ma4h: average(klines4h.slice(-30).map((item) => item.close)),
    ma4h200: average(klines4h.slice(-200).map((item) => item.close)),
    ma15m30: average(klines15m.slice(-30).map((item) => item.close)),
    ma5: average(klines15m.slice(-5).map((item) => item.close)),
    ma10: average(klines15m.slice(-10).map((item) => item.close)),
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
  return `${analysis.symbol}-${analysis.direction}-${analysis.signalLevel}`;
}

function shouldNotify(analysis, state) {
  if (!analysis.canNotify) return { notify: false, reason: analysis.notifyBlockedReason || "不符合通知條件" };
  const key = signalKey(analysis);
  const previous = state[key];
  const now = Date.now();
  if (!previous) return { notify: true, key, reason: "新 S/A/B 訊號" };
  const elapsedMinutes = (now - Number(previous.time || 0)) / 60000;
  if (elapsedMinutes >= COOLDOWN_MINUTES) return { notify: true, key, reason: "冷卻結束" };
  return { notify: false, key, reason: `30 分鐘冷卻中，剩餘 ${Math.ceil(COOLDOWN_MINUTES - elapsedMinutes)} 分鐘` };
}

function rememberNotification(analysis, state, decision) {
  if (!decision.key) return;
  state[decision.key] = {
    symbol: analysis.symbol,
    direction: analysis.direction,
    level: analysis.signalLevel,
    price: analysis.price,
    finalSignal: analysis.finalSignal,
    time: Date.now()
  };
}

function scoreAdvancedAnalysis(klines15m, basic) {
  if (klines15m.length < 220) return null;
  const closes = klines15m.map((item) => item.close);
  const volumes = klines15m.map((item) => item.volume).filter(Number.isFinite);
  if (volumes.length < 20) return null;

  const volumeRatio = volumes.at(-1) / average(volumes.slice(-20));
  const macd = buildMacdAnalysis(closes);
  const atr = atr14(klines15m);
  const rsi = rsi14(closes);
  if (![volumeRatio, atr].every(Number.isFinite) || !macd || !Number.isFinite(rsi)) return null;

  const atrInfo = atrState(atr, basic.price);
  const macdFresh = macd.crossAge !== null && macd.crossAge <= 8;
  const isBullEnvironment = basic.price > basic.ma4h && basic.price > basic.ma15m30;
  const isBearEnvironment = basic.price < basic.ma4h && basic.price < basic.ma15m30;
  const marketEnvironment = isBullEnvironment ? "bull" : isBearEnvironment ? "bear" : "mixed";
  const direction = isBullEnvironment ? "long" : isBearEnvironment ? "short" : null;

  const last8 = klines15m.slice(-8);
  const rangeHigh = Math.max(...last8.map((item) => item.high));
  const rangeLow = Math.min(...last8.map((item) => item.low));
  const rangeBase = average(last8.map((item) => item.close));
  const rangePercent = rangeBase > 0 ? ((rangeHigh - rangeLow) / rangeBase) * 100 : null;
  const breakoutThreshold = getBreakoutThreshold(basic.symbol);
  const longBreakout = Number.isFinite(basic.previousRecentHigh) && basic.price > basic.previousRecentHigh * (1 + breakoutThreshold);
  const shortBreakout = Number.isFinite(basic.previousRecentLow) && basic.price < basic.previousRecentLow * (1 - breakoutThreshold);
  const consolidationTooLong = last8.length >= 8 && Number.isFinite(rangePercent) && rangePercent < 0.45 && !(longBreakout || shortBreakout);
  const priceSlope = closes.length >= 6 && closes.at(-6) > 0 ? ((closes.at(-1) - closes.at(-6)) / closes.at(-6)) * 100 : 0;

  const plan = tradePlanMetrics(direction, { ...basic, atr });
  const ma30Limit = CONFIG.ma30MaxDeviationPercent[baseSymbol(basic.symbol)] ?? 2;
  const ma30Distance = Math.abs(basic.price - basic.ma15m30) / basic.price * 100;
  const ma30TooFar = Number.isFinite(ma30Distance) && ma30Distance > ma30Limit;
  const chaseRisk = direction === "long" ? !basic.notNearHigh : direction === "short" ? !basic.notNearLow : false;

  const context = { ...basic, macd, macdFresh, rsi, volumeRatio, atrInfo, priceSlope };
  const mScore = marketScore(direction, context);
  const moScore = momentumScore(direction, context);
  const trendAligned = direction === "long" ? marketEnvironment === "bull" : direction === "short" ? marketEnvironment === "bear" : false;
  const maStackAligned = direction === "long"
    ? basic.ma5 > basic.ma10 && basic.ma10 > basic.ma15m30
    : direction === "short"
      ? basic.ma5 < basic.ma10 && basic.ma10 < basic.ma15m30
      : false;
  const waitingPullback = direction === "long"
    ? basic.ma5 < basic.ma10 || macd.crossType === "death"
    : direction === "short"
      ? basic.ma5 > basic.ma10 || macd.crossType === "golden"
      : true;
  const hardBlocked = !direction
    || plan.stopLossTooSmall
    || ma30TooFar
    || chaseRisk
    || (Number.isFinite(plan.rr) && plan.rr < 0.8)
    || (direction === "long" && rsi > 88)
    || (direction === "short" && rsi < 12)
    || volumeRatio < 0.2;

  let signalLevel = "C";
  if (hardBlocked || consolidationTooLong || !Number.isFinite(plan.rr) || plan.rr < 1 || mScore < 65 || moScore < 20) {
    signalLevel = "D";
  } else if (
    trendAligned
    && maStackAligned
    && moScore >= 80
    && mScore >= 80
    && plan.rr >= 2.5
    && !chaseRisk
    && !waitingPullback
    && !atrInfo.low
    && !atrInfo.high
    && volumeRatio >= 0.8
  ) {
    signalLevel = "S";
  } else if (trendAligned && !waitingPullback && plan.rr >= 1.5 && mScore >= 80 && moScore >= 60) {
    signalLevel = "A";
  } else if (trendAligned && plan.rr >= 1.2 && mScore >= 75 && moScore >= 40) {
    signalLevel = "B";
  }

  const canNotify = ["S", "A", "B"].includes(signalLevel)
    && !chaseRisk
    && !plan.stopLossTooSmall
    && !ma30TooFar;
  const finalSignal = signalLevel === "S"
    ? "⭐ S級機會"
    : signalLevel === "A"
      ? direction === "long" ? "強烈做多" : "強烈做空"
      : signalLevel === "B"
        ? direction === "long" ? "做多｜可以做" : "做空｜可以做"
        : ma30TooFar
          ? "⚠ 偏離 MA30 過遠，等待回踩"
          : "不交易";

  const warnings = [];
  if (ma30TooFar) warnings.push(`偏離 MA30 過遠：目前 ${number(ma30Distance, 2)}% / 上限 ${number(ma30Limit, 2)}%`);
  if (chaseRisk) warnings.push("追價風險，不推播");
  if (plan.stopLossTooSmall) warnings.push(`結構太小：止損距離 ${number(plan.stopLossPercent, 2)}% < 最低 ${number(plan.minStopLossPercent, 2)}%`);
  if (volumeRatio < 0.8) warnings.push(`量能偏低：${number(volumeRatio, 2)}x`);
  if (atrInfo.high) warnings.push("ATR 高波動，降低倉位");
  if (atrInfo.low) warnings.push("ATR 波動不足");

  return {
    symbol: basic.symbol,
    direction,
    sideLabel: direction === "long" ? "做多" : direction === "short" ? "做空" : "觀察",
    finalSignal,
    signalLevel,
    canNotify,
    price: basic.price,
    entryZone: direction === "long"
      ? `${priceNumber(basic.price)} 附近，或回踩 15m MA10 ${priceNumber(basic.ma10)}`
      : direction === "short"
        ? `${priceNumber(basic.price)} 附近，或反彈 15m MA10 ${priceNumber(basic.ma10)}`
        : `${priceNumber(basic.price)} 附近`,
    stop: plan.stop,
    tp1: plan.tp1,
    tp2: plan.tp2,
    rr: plan.rr,
    marketScore: mScore,
    momentumScore: moScore,
    volumeRatio,
    atrPercent: atrInfo.percent,
    rsi,
    warnings,
    notifyBlockedReason: !canNotify ? (
      ma30TooFar ? "偏離 MA30 過遠"
        : plan.stopLossTooSmall ? "結構太小"
          : chaseRisk ? "追價風險"
            : `${signalLevel}級不推播`
    ) : ""
  };
}

function telegramText(analysis) {
  const icon = analysis.signalLevel === "S" ? "🔥🔥🔥" : analysis.signalLevel === "A" ? "🔥🔥" : "🟡";
  const bLevelNote = analysis.signalLevel === "B" ? "\n小倉觀察，不建議追價" : "";
  const compactSymbol = analysis.symbol.replace("-", "");
  return `${icon} ${analysis.signalLevel}級 ${compactSymbol} 可${analysis.sideLabel}

${analysis.finalSignal}${bLevelNote}

幣種：${analysis.symbol}
方向：${analysis.sideLabel}
現價：${priceNumber(analysis.price)}
建議進場區間：${analysis.entryZone}
止損：${Number.isFinite(analysis.stop) ? priceNumber(analysis.stop) : "-"}
TP1：${Number.isFinite(analysis.tp1) ? priceNumber(analysis.tp1) : "-"}
TP2：${Number.isFinite(analysis.tp2) ? priceNumber(analysis.tp2) : "-"}
RR：${Number.isFinite(analysis.rr) ? number(analysis.rr, 2) : "-"}
Market Score：${analysis.marketScore}/100
Momentum Score：${analysis.momentumScore}/100
RSI：${number(analysis.rsi, 1)}
Volume Ratio：${number(analysis.volumeRatio, 2)}x
ATR%：${number(analysis.atrPercent, 3)}%
主要理由：${analysis.warnings.length ? analysis.warnings.join("｜") : "S/A/B 條件符合，允許推播"}
時間：${new Date().toLocaleString("zh-TW", { hour12: false, timeZone: "Asia/Taipei" })}`;
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

async function scanSymbol(symbol) {
  const [klines4h, klines15m, price] = await Promise.all([
    fetchKlines(symbol, "4h", 300),
    fetchKlines(symbol, "15m", 300),
    fetchPrice(symbol)
  ]);
  const basic = basicFromKlines(symbol, price, klines4h, klines15m);
  const analysis = scoreAdvancedAnalysis(klines15m, basic);
  if (!analysis) throw new Error(`Unable to calculate analysis for ${symbol}`);
  return analysis;
}

async function main() {
  const state = loadState();
  const analyses = [];

  for (const symbol of SYMBOLS) {
    try {
      const analysis = await scanSymbol(symbol);
      analyses.push(analysis);
      const decision = shouldNotify(analysis, state);
      console.log(`[${symbol}] ${analysis.signalLevel} ${analysis.finalSignal} | Market ${analysis.marketScore} | Momentum ${analysis.momentumScore} | RR ${number(analysis.rr, 2)} | notify=${decision.notify ? "yes" : "no"} ${decision.reason}`);

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

  if (!analyses.some((item) => ["S", "A", "B"].includes(item.signalLevel))) {
    console.log("No S/A/B signal.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
