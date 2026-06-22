import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const workerUrl = new URL("../cloudflare-worker/bingx-proxy.js", import.meta.url);
const workerSource = await fs.readFile(workerUrl, "utf8");
const instrumentedSource = workerSource
  .replace("export default {", "globalThis.workerDefault = {")
  .concat(`
globalThis.signalIndexTestHooks = {
  computeSignalStats,
  dynamicTradePlanMetrics,
  handleClearSignals,
  handleSignalStats,
  handleSignalSnapshots,
  rebuildSignalStats,
  recordSignalSnapshot,
  resolveSignalRecord,
  shouldPersistSignalRecordUpdate,
  scoreAdvancedAnalysisV2,
  updateOpenSignalRecords,
  recordSignalIfEligible
};
`);

const context = vm.createContext({
  console,
  fetch,
  Headers,
  Request,
  Response,
  URL
});
vm.runInContext(instrumentedSource, context, {
  filename: workerUrl.pathname
});

const {
  computeSignalStats,
  dynamicTradePlanMetrics,
  handleClearSignals,
  handleSignalStats,
  handleSignalSnapshots,
  rebuildSignalStats,
  recordSignalSnapshot,
  resolveSignalRecord,
  shouldPersistSignalRecordUpdate,
  scoreAdvancedAnalysisV2,
  updateOpenSignalRecords,
  recordSignalIfEligible
} = context.signalIndexTestHooks;

function signalRecord(index) {
  const createdAt = 1_750_000_000_000 + index;
  return {
    id: `BTC-USDT:long:A:pullback:${createdAt}`,
    createdAt,
    resolvedAt: createdAt + 1,
    symbol: "BTC-USDT",
    direction: "long",
    signalLevel: "A",
    setupType: "pullback",
    status: "CLOSED",
    outcome: "TP1_HIT",
    barsHeld: 1,
    rrToTp1: 1.5,
    rrToTp2: 2.0,
    rrToTp3: 2.5
  };
}

function statsCache(totalSignals) {
  return {
    totalSignals,
    closedSignals: totalSignals,
    openSignals: 0,
    tp1Hits: totalSignals,
    tp2Hits: 0,
    slHits: 0
  };
}

function createKv({
  records,
  indexIds = records.map((record) => record.id).reverse(),
  version = "2",
  stats = statsCache(records.length),
  extraEntries = []
}) {
  const values = new Map(records.map((record) => [
    `signal:${record.id}`,
    JSON.stringify(record)
  ]));
  values.set("signal:index", JSON.stringify(indexIds));
  if (version !== null) values.set("signal:index:version", version);
  if (stats !== null) values.set("signal:stats", JSON.stringify(stats));
  for (const [key, value] of extraEntries) values.set(key, value);

  const calls = { get: [], put: [], delete: [], list: [] };
  return {
    calls,
    values,
    async get(key, options) {
      calls.get.push(key);
      if (!values.has(key)) return null;
      const value = values.get(key);
      return options?.type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value) {
      calls.put.push(key);
      values.set(key, value);
    },
    async delete(key) {
      calls.delete.push(key);
      values.delete(key);
    },
    async list(options = {}) {
      calls.list.push(options);
      const keys = [...values.keys()]
        .filter((key) => key.startsWith(options.prefix || ""))
        .sort()
        .map((name) => ({ name }));
      const offset = Number(options.cursor || 0);
      const limit = Number(options.limit || keys.length || 1000);
      const pageKeys = keys.slice(offset, offset + limit);
      const nextOffset = offset + pageKeys.length;
      const listComplete = nextOffset >= keys.length;
      return {
        keys: pageKeys,
        list_complete: listComplete,
        cursor: listComplete ? undefined : String(nextOffset)
      };
    }
  };
}

function requestUrl(page = 2, limit = 50) {
  return new URL(`https://worker.example/signals/stats?page=${page}&limit=${limit}`);
}

function signalRecordGets(kv) {
  return kv.calls.get.filter((key) => (
    key.startsWith("signal:")
    && !["signal:index", "signal:index:version", "signal:stats"].includes(key)
  ));
}

const records = Array.from({ length: 500 }, (_, index) => signalRecord(index));

function assertNear(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} should be near ${expected}`);
}

function openRecord() {
  const record = {
    ...signalRecord(999),
    id: "BTC-USDT:long:B:pullback:1750000000999",
    signalLevel: "B",
    initialSignalLevel: "B",
    currentSignalLevel: "B",
    totalScore: 72,
    lastSeenScore: 72,
    setupType: "pullback",
    status: "OPEN",
    outcome: null,
    resolvedAt: null,
    createdAtBarTime: 1_750_000_000_999,
    entry: 100,
    stop: 98,
    tp1: 103,
    tp2: 104,
    tp3: 105,
    rrToTp1: 1.5,
    rrToTp2: 2.0,
    rrToTp3: 2.5,
    tp1Hit: false,
    tp2Hit: false,
    tp3Hit: false,
    maxReachedR: 0,
    finalR: null,
    warnings: ["initial warning"]
  };
  return record;
}

function upgradeAnalysis() {
  return {
    symbol: "BTC-USDT",
    direction: "long",
    signalLevel: "S",
    setupType: "pullback",
    totalScore: 94,
    trendScore: 40,
    structureScore: 40,
    momentumScore: 28,
    entryScore: 5,
    rrScore: 21,
    entryZone: 110,
    stop: 107,
    tp1: 114.5,
    tp2: 116,
    tp3: 117.5,
    rrToTp1: 1.5,
    rrToTp2: 2.0,
    rrToTp3: 2.5,
    rrDisplay: 1.5,
    rrStretch: 2.0,
    stopLossPercent: 2.73,
    maxStopLossPercent: 3,
    warnings: ["upgrade warning"],
    latestKlines15m: [{ time: 1_750_000_001_999 }]
  };
}

function earlyBreakoutKlines() {
  const closes = [];
  let close = 80;
  for (let index = 0; index < 205; index += 1) {
    close += 0.12;
    closes.push(close);
  }
  const changes = [1, -1, 1, 1, -1, 1, 1, 1, -1, 1, 1, -1, 1, 1, 1];
  for (const change of changes) {
    close += change * 0.45;
    closes.push(close);
  }
  closes.push(close + 0.2);
  return closes.map((value, index) => ({
    time: index,
    open: value - 0.1,
    high: value + 0.3,
    low: value - 0.3,
    close: value,
    volume: 100
  }));
}

function earlyBreakoutBasic() {
  return {
    symbol: "SOL-USDT",
    price: 110,
    ma4h: 111,
    ma4h200: 110.2,
    ma15m30: 108,
    ma15m30Prev: 107,
    ma5: 109,
    ma10: 104,
    prevClose: 107,
    prevMa10: 105,
    recentHigh: 120,
    recentLow: 108,
    previousRecentHigh: 130,
    previousRecentLow: 100,
    notNearHigh: true,
    notNearLow: true
  };
}

function provisionalEarlyBreakoutBasic() {
  return {
    symbol: "SOL-USDT",
    price: 109.8,
    ma4h: 110,
    ma4h200: 110,
    ma15m30: 108.8,
    ma15m30Prev: 108.8,
    ma5: 109.5,
    ma10: 107,
    prevClose: 108.5,
    prevMa10: 107.2,
    recentHigh: 120,
    recentLow: 108.6,
    previousRecentHigh: 130,
    previousRecentLow: 100,
    notNearHigh: true,
    notNearLow: true
  };
}

test("page 2 reads only 50 records and uses the 500-record cached totals", async () => {
  const kv = createKv({ records });
  const response = await handleSignalStats({ SIGNAL_KV: kv }, requestUrl());
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.recentSignals.length, 50);
  assert.equal(payload.pagination.page, 2);
  assert.equal(payload.pagination.total, 500);
  assert.equal(payload.stats.totalSignals, 500);
  assert.equal(signalRecordGets(kv).length, 50);
  assert.equal(kv.calls.list.length, 0);
  assert.deepEqual(kv.calls.put, []);
});

test("old 200-record index and stats migrate to the complete 500-record totals", async () => {
  const oldIndex = records.slice(-200).map((record) => record.id).reverse();
  const kv = createKv({
    records,
    indexIds: oldIndex,
    version: "1",
    stats: statsCache(200)
  });
  const response = await handleSignalStats({ SIGNAL_KV: kv }, requestUrl());
  const payload = await response.json();
  const savedStats = JSON.parse(kv.values.get("signal:stats"));
  const savedIndex = JSON.parse(kv.values.get("signal:index"));

  assert.equal(response.status, 200);
  assert.equal(payload.pagination.total, 500);
  assert.equal(payload.stats.totalSignals, 500);
  assert.equal(savedStats.totalSignals, 500);
  assert.equal(savedIndex.length, 500);
  assert.equal(kv.values.get("signal:index:version"), "2");
  assert.equal(kv.calls.list.length, 1);
  assert.equal(kv.calls.put.filter((key) => key === "signal:stats").length, 1);
});

test("complete index rebuild ignores signal snapshots", async () => {
  const kv = createKv({
    records: records.slice(0, 3),
    indexIds: [],
    version: "1",
    stats: statsCache(0),
    extraEntries: [
      ["signal:snapshots:index", JSON.stringify(["1750000000500:SOL-USDT:D:none"])],
      ["signal:snapshot:1750000000500:SOL-USDT:D:none", JSON.stringify({
        id: "1750000000500:SOL-USDT:D:none",
        symbol: "SOL-USDT",
        signalLevel: "D",
        setupType: "none"
      })]
    ]
  });
  const response = await handleSignalStats({ SIGNAL_KV: kv }, new URL("https://worker.example/signals/stats?page=1&limit=20"));
  const payload = await response.json();
  const savedIndex = JSON.parse(kv.values.get("signal:index"));
  const savedStats = JSON.parse(kv.values.get("signal:stats"));

  assert.equal(response.status, 200);
  assert.equal(payload.pagination.total, 3);
  assert.equal(payload.stats.totalSignals, 3);
  assert.equal(savedIndex.length, 3);
  assert.equal(savedIndex.some((id) => id.startsWith("snapshot:")), false);
  assert.equal(savedStats.totalSignals, 3);
});

test("missing stats cache is built automatically and returned normally", async () => {
  const kv = createKv({ records, stats: null });
  const response = await handleSignalStats({ SIGNAL_KV: kv }, requestUrl());
  const payload = await response.json();
  const savedStats = JSON.parse(kv.values.get("signal:stats"));

  assert.equal(response.status, 200);
  assert.equal(payload.pagination.total, 500);
  assert.equal(payload.stats.totalSignals, 500);
  assert.equal(savedStats.totalSignals, 500);
  assert.equal(kv.calls.list.length, 0);
  assert.equal(kv.calls.put.filter((key) => key === "signal:stats").length, 1);
});

test("mismatched cached totals are repaired even when the index version is current", async () => {
  const kv = createKv({ records, stats: statsCache(200) });
  const response = await handleSignalStats({ SIGNAL_KV: kv }, requestUrl());
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.pagination.total, 500);
  assert.equal(payload.stats.totalSignals, 500);
  assert.equal(kv.calls.list.length, 0);
  assert.equal(kv.calls.put.filter((key) => key === "signal:stats").length, 1);
});

test("OPEN record upgrade keeps initial level and original trade plan unchanged", async () => {
  const original = openRecord();
  const kv = createKv({ records: [original], stats: statsCache(1) });
  const result = await recordSignalIfEligible({ SIGNAL_KV: kv }, upgradeAnalysis());
  const saved = JSON.parse(kv.values.get(`signal:${original.id}`));

  assert.equal(result.initialSignalLevel, "B");
  assert.equal(result.currentSignalLevel, "S");
  assert.equal(result.signalLevel, "B");
  assert.equal(result.lastSeenScore, 94);
  assert.equal(saved.initialSignalLevel, "B");
  assert.equal(saved.currentSignalLevel, "S");
  assert.equal(saved.signalLevel, "B");
  assert.equal(saved.entry, original.entry);
  assert.equal(saved.stop, original.stop);
  assert.equal(saved.tp1, original.tp1);
  assert.equal(saved.tp2, original.tp2);
  assert.equal(saved.tp3, original.tp3);
  assert.equal(saved.createdAtBarTime, original.createdAtBarTime);
  assert.deepEqual(saved.warnings, ["initial warning", "upgrade warning"]);
});

test("recordSignalIfEligible can defer stats rebuild", async () => {
  const kv = createKv({ records: [], stats: statsCache(0) });
  const result = await recordSignalIfEligible({ SIGNAL_KV: kv }, upgradeAnalysis(), { rebuildStats: false });

  assert.ok(result);
  assert.equal(kv.calls.put.includes("signal:stats"), false);
  assert.equal(kv.calls.put.filter((key) => key.startsWith("signal:BTC-USDT")).length, 1);
  assert.equal(kv.calls.put.includes("signal:index"), true);
  assert.equal(kv.calls.put.includes("signal:index:version"), true);
});

test("recordSignalIfEligible defers stats rebuild on OPEN upgrade", async () => {
  const original = openRecord();
  const kv = createKv({ records: [original], stats: statsCache(1) });
  const result = await recordSignalIfEligible({ SIGNAL_KV: kv }, upgradeAnalysis(), { rebuildStats: false });

  assert.ok(result);
  assert.equal(result.currentSignalLevel, "S");
  assert.deepEqual(kv.calls.put, [`signal:${original.id}`]);
});

test("scheduled-style deferred recording rebuilds stats once for multiple new records", async () => {
  const kv = createKv({ records: [], stats: statsCache(0) });
  const first = upgradeAnalysis();
  const second = {
    ...upgradeAnalysis(),
    symbol: "ETH-USDT",
    setupType: "breakout"
  };

  await recordSignalIfEligible({ SIGNAL_KV: kv }, first, { rebuildStats: false });
  await recordSignalIfEligible({ SIGNAL_KV: kv }, second, { rebuildStats: false });
  assert.equal(kv.calls.put.filter((key) => key === "signal:stats").length, 0);

  await rebuildSignalStats({ SIGNAL_KV: kv });
  assert.equal(kv.calls.put.filter((key) => key === "signal:stats").length, 1);
});

test("byLevel stats bucket uses initialSignalLevel instead of current upgrade level", () => {
  const upgraded = {
    ...openRecord(),
    status: "CLOSED",
    outcome: "TP1_HIT",
    currentSignalLevel: "S",
    lastSeenScore: 94
  };
  const stats = computeSignalStats([upgraded]);

  assert.equal(stats.byLevel.B.total, 1);
  assert.equal(stats.byLevel.B.wins, 1);
  assert.equal(stats.byLevel.S.total, 0);
  assert.equal(stats.overallWinRate, 100);
  assert.equal(stats.overallWinRateIncludingExpired, 100);
});

test("TP2 is calculated at 2.0R while TP1 remains 1.5R", () => {
  const longPlan = dynamicTradePlanMetrics("long", {
    symbol: "BTC-USDT",
    price: 100,
    recentLow: 99,
    recentHigh: 105,
    ma15m30: 99,
    atr: 1
  });
  const shortPlan = dynamicTradePlanMetrics("short", {
    symbol: "BTC-USDT",
    price: 100,
    recentLow: 95,
    recentHigh: 101,
    ma15m30: 101,
    atr: 1
  });

  assert.equal(longPlan.rrToTp1, 1.5);
  assert.equal(longPlan.rrToTp2, 2.0);
  assert.equal(longPlan.rrToTp3, 2.5);
  assertNear((longPlan.tp1 - longPlan.entry) / longPlan.risk, 1.5);
  assertNear((longPlan.tp2 - longPlan.entry) / longPlan.risk, 2.0);
  assertNear((longPlan.tp3 - longPlan.entry) / longPlan.risk, 2.5);
  assert.equal(shortPlan.rrToTp1, 1.5);
  assert.equal(shortPlan.rrToTp2, 2.0);
  assert.equal(shortPlan.rrToTp3, 2.5);
  assertNear((shortPlan.entry - shortPlan.tp1) / shortPlan.risk, 1.5);
  assertNear((shortPlan.entry - shortPlan.tp2) / shortPlan.risk, 2.0);
  assertNear((shortPlan.entry - shortPlan.tp3) / shortPlan.risk, 2.5);
});

test("TP3 R multiple is configurable", () => {
  const plan = dynamicTradePlanMetrics("long", {
    symbol: "BTC-USDT",
    price: 100,
    recentLow: 99,
    recentHigh: 105,
    ma15m30: 99,
    atr: 1,
    tp3R: 3
  });

  assert.equal(plan.rrToTp1, 1.5);
  assert.equal(plan.rrToTp2, 2.0);
  assert.equal(plan.rrToTp3, 3);
  assertNear((plan.tp3 - plan.entry) / plan.risk, 3);
});

test("backtest keeps tracking after TP1 and TP2 and closes as TP3_HIT", () => {
  const record = openRecord();
  const result = resolveSignalRecord(record, [
    { time: record.createdAtBarTime, high: 100.5, low: 99.5, close: 100 },
    { time: record.createdAtBarTime + 1, high: 103.2, low: 100.5, close: 103 },
    { time: record.createdAtBarTime + 2, high: 104.2, low: 102.5, close: 104 },
    { time: record.createdAtBarTime + 3, high: 105.1, low: 103.5, close: 105 }
  ]);

  assert.equal(result.status, "CLOSED");
  assert.equal(result.outcome, "TP3_HIT");
  assert.equal(result.tp1Hit, true);
  assert.equal(result.tp2Hit, true);
  assert.equal(result.tp3Hit, true);
  assertNear(result.maxReachedR, 2.55);
  assert.equal(result.finalR, 2.5);
});

test("backtest counts stop first and does not count same-bar TP", () => {
  const record = openRecord();
  const result = resolveSignalRecord(record, [
    { time: record.createdAtBarTime + 1, high: 106, low: 97.9, close: 101 }
  ]);

  assert.equal(result.status, "CLOSED");
  assert.equal(result.outcome, "SL_HIT");
  assert.equal(result.tp1Hit, false);
  assert.equal(result.tp2Hit, false);
  assert.equal(result.tp3Hit, false);
  assert.equal(result.maxReachedR, 0);
  assert.equal(result.finalR, -1);
});

test("open signal progress without target hit does not write KV", async () => {
  const original = openRecord();
  const kv = createKv({ records: [original] });
  const updated = await updateOpenSignalRecords({ SIGNAL_KV: kv }, original.symbol, [
    { time: original.createdAtBarTime + 1, high: 102.5, low: 99.5, close: 101.5 }
  ]);
  const saved = JSON.parse(kv.values.get(`signal:${original.id}`));

  assert.equal(updated.length, 0);
  assert.equal(kv.calls.put.length, 0);
  assert.equal(saved.barsHeld, original.barsHeld);
  assert.equal(saved.maxReachedR, original.maxReachedR);
  assert.equal(shouldPersistSignalRecordUpdate(original, { ...original, barsHeld: 1, maxReachedR: 1.25 }), false);
});

test("open signal writes KV only when TP or closing event changes", async () => {
  const cases = [
    {
      name: "TP1",
      bars: (record) => [{ time: record.createdAtBarTime + 1, high: 103.1, low: 100, close: 102 }],
      expected: { status: "OPEN", tp1Hit: true }
    },
    {
      name: "TP2",
      bars: (record) => [{ time: record.createdAtBarTime + 1, high: 104.1, low: 100, close: 103 }],
      expected: { status: "OPEN", tp1Hit: true, tp2Hit: true }
    },
    {
      name: "TP3",
      bars: (record) => [{ time: record.createdAtBarTime + 1, high: 105.1, low: 100, close: 105 }],
      expected: { status: "CLOSED", outcome: "TP3_HIT", tp1Hit: true, tp2Hit: true, tp3Hit: true }
    },
    {
      name: "SL",
      bars: (record) => [{ time: record.createdAtBarTime + 1, high: 101, low: 97.9, close: 98 }],
      expected: { status: "CLOSED", outcome: "SL_HIT" }
    },
    {
      name: "EXPIRED",
      bars: (record) => Array.from({ length: 48 }, (_, index) => ({
        time: record.createdAtBarTime + index + 1,
        high: 102.5,
        low: 99.5,
        close: 100.5
      })),
      expected: { status: "CLOSED", outcome: "EXPIRED" }
    }
  ];

  for (const item of cases) {
    const original = openRecord();
    const kv = createKv({ records: [original] });
    const updated = await updateOpenSignalRecords({ SIGNAL_KV: kv }, original.symbol, item.bars(original));
    const saved = JSON.parse(kv.values.get(`signal:${original.id}`));

    assert.equal(updated.length, 1, item.name);
    assert.deepEqual(kv.calls.put, [`signal:${original.id}`], item.name);
    for (const [key, value] of Object.entries(item.expected)) {
      assert.equal(saved[key], value, `${item.name} ${key}`);
    }
  }
});

test("stats include TP3 reached rate, average max R, and final R total", () => {
  const tp3 = {
    ...signalRecord(800),
    status: "CLOSED",
    outcome: "TP3_HIT",
    tp1Hit: true,
    tp2Hit: true,
    tp3Hit: true,
    maxReachedR: 2.6,
    finalR: 2.5
  };
  const stopped = {
    ...signalRecord(801),
    status: "CLOSED",
    outcome: "SL_HIT",
    tp1Hit: false,
    tp2Hit: false,
    tp3Hit: false,
    maxReachedR: 0.4,
    finalR: -1
  };
  const stats = computeSignalStats([tp3, stopped]);

  assert.equal(stats.tp1Hits, 1);
  assert.equal(stats.tp2Hits, 1);
  assert.equal(stats.tp3Hits, 1);
  assert.equal(stats.tp3HitRate, 50);
  assertNear(stats.averageMaxR, 1.5);
  assertNear(stats.totalPnlR, 1.5);
});

test("SOL earlyBreakout produces at least a B long in aggressive mode", () => {
  const analysis = scoreAdvancedAnalysisV2(earlyBreakoutKlines(), earlyBreakoutBasic(), {
    entryMode: "aggressive",
    trendMode: "trend"
  });

  assert.equal(analysis.direction, "long");
  assert.equal(analysis.setupType, "earlyBreakout");
  assert.ok(["B", "A", "S", "S+"].includes(analysis.signalLevel));
  assert.equal(analysis.rsi >= 70 && analysis.rsi <= 78, true);
  assert.equal(analysis.volumeRatio >= 0.8, true);
  assert.deepEqual(Array.from(analysis.hardBlockReasons), []);
});

test("conservative mode does not enable earlyBreakout", () => {
  const analysis = scoreAdvancedAnalysisV2(earlyBreakoutKlines(), earlyBreakoutBasic(), {
    entryMode: "conservative",
    trendMode: "trend"
  });

  assert.notEqual(analysis.setupType, "earlyBreakout");
});

test("aggressive mode enables earlyBreakout", () => {
  const analysis = scoreAdvancedAnalysisV2(earlyBreakoutKlines(), earlyBreakoutBasic(), {
    entryMode: "aggressive",
    trendMode: "trend"
  });

  assert.equal(analysis.setupType, "earlyBreakout");
});

test("counter mode allows provisional long earlyBreakout when strict direction is unclear", () => {
  const analysis = scoreAdvancedAnalysisV2(earlyBreakoutKlines(), provisionalEarlyBreakoutBasic(), {
    entryMode: "aggressive",
    trendMode: "counter"
  });

  assert.equal(analysis.originalDirection, null);
  assert.equal(analysis.direction, "long");
  assert.equal(analysis.provisionalDirection, true);
  assert.equal(analysis.setupType, "earlyBreakout");
  assert.equal(analysis.signalLevel, "B");
  assert.equal(analysis.warnings.includes("早段方向，尚未完全確認"), true);
});

test("trend mode keeps strict direction and does not allow provisional earlyBreakout", () => {
  const analysis = scoreAdvancedAnalysisV2(earlyBreakoutKlines(), provisionalEarlyBreakoutBasic(), {
    entryMode: "aggressive",
    trendMode: "trend"
  });

  assert.equal(analysis.originalDirection, null);
  assert.equal(analysis.direction, null);
  assert.equal(analysis.provisionalDirection, false);
  assert.notEqual(analysis.setupType, "earlyBreakout");
  assert.equal(analysis.signalLevel, "D");
  assert.equal(analysis.hardBlockReasons.includes("direction unclear"), true);
});

test("expired records are counted in conservative win rate denominator", () => {
  const winner = { ...signalRecord(700), outcome: "TP1_HIT" };
  const loser = { ...signalRecord(701), outcome: "SL_HIT" };
  const expired = { ...signalRecord(702), outcome: "EXPIRED" };
  const stats = computeSignalStats([winner, loser, expired]);

  assert.equal(stats.expired, 1);
  assert.equal(stats.overallWinRate, 50);
  assertNear(stats.overallWinRateIncludingExpired, 100 / 3);
});

test("admin clear endpoint deletes every paginated signal key and keeps other KV keys", async () => {
  const manyRecords = Array.from({ length: 1205 }, (_, index) => signalRecord(index));
  const kv = createKv({
    records: manyRecords,
    extraEntries: [
      ["telegram:chat", "keep"],
      ["cooldown:BTC-USDT", "keep"],
      ["config", "keep"]
    ]
  });
  const response = await handleClearSignals(
    { SIGNAL_KV: kv },
    new URL("https://worker.example/admin/clear-signals?confirm=YES"),
    "GET"
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload, { ok: true, deleted: 1208 });
  assert.equal(kv.calls.list.length, 2);
  assert.equal(kv.calls.delete.length, 1208);
  assert.equal([...kv.values.keys()].some((key) => key.startsWith("signal:")), false);
  assert.equal(kv.values.get("telegram:chat"), "keep");
  assert.equal(kv.values.get("cooldown:BTC-USDT"), "keep");
  assert.equal(kv.values.get("config"), "keep");
});

test("admin clear endpoint requires confirm=YES before deleting", async () => {
  const kv = createKv({ records: [signalRecord(1)] });
  const response = await handleClearSignals(
    { SIGNAL_KV: kv },
    new URL("https://worker.example/admin/clear-signals"),
    "GET"
  );
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.ok, false);
  assert.equal(kv.calls.list.length, 0);
  assert.equal(kv.calls.delete.length, 0);
  assert.equal([...kv.values.keys()].some((key) => key.startsWith("signal:")), true);
});

function snapshotAnalysis() {
  return {
    symbol: "SOL-USDT",
    direction: null,
    setupType: "none",
    signalLevel: "D",
    totalScore: 20,
    marketScore: 10,
    momentumScore: 5,
    rrScore: 0,
    warnings: ["setup not confirmed"],
    hardBlockReasons: ["direction unclear"],
    volumeRatio: 0.4,
    rsi: 50,
    macd: { crossType: "golden" },
    ma200Distance: -0.2,
    price: 100,
    entryZone: 100,
    stop: 98,
    tp1: 103,
    tp2: 104,
    tp3: 105
  };
}

test("signal snapshots are disabled by default and do not write KV", async () => {
  const kv = createKv({ records: [] });
  const snapshot = await recordSignalSnapshot({ SIGNAL_KV: kv }, snapshotAnalysis());
  const response = await handleSignalSnapshots(
    { SIGNAL_KV: kv },
    new URL("https://worker.example/signals/snapshots")
  );
  const payload = await response.json();

  assert.equal(snapshot, null);
  assert.deepEqual(kv.calls.put, []);
  assert.deepEqual(payload, {
    snapshots: [],
    disabled: true,
    message: "Signal snapshots are disabled to reduce KV writes."
  });
});

test("snapshot is recorded even when signalLevel is D when explicitly enabled", async () => {
  const kv = createKv({ records: [] });
  const snapshot = await recordSignalSnapshot(
    { SIGNAL_KV: kv, ENABLE_SIGNAL_SNAPSHOTS: "true" },
    snapshotAnalysis()
  );
  const index = JSON.parse(kv.values.get("signal:snapshots:index"));
  const saved = JSON.parse(kv.values.get(`signal:snapshot:${snapshot.id}`));

  assert.equal(snapshot.signalLevel, "D");
  assert.equal(index.includes(snapshot.id), true);
  assert.equal(saved.symbol, "SOL-USDT");
  assert.equal(saved.signalLevel, "D");
  assert.deepEqual(kv.calls.put.sort(), [
    "signal:snapshot:" + snapshot.id,
    "signal:snapshots:index"
  ].sort());
});
