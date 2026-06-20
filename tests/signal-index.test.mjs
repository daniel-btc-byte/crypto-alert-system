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
    rrToTp2: 2.0
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
    rrToTp1: 1.5,
    rrToTp2: 2.0,
    rrDisplay: 1.5,
    rrStretch: 2.0,
    stopLossPercent: 2.73,
    maxStopLossPercent: 3,
    warnings: ["upgrade warning"],
    latestKlines15m: [{ time: 1_750_000_001_999 }]
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
  assert.equal(saved.createdAtBarTime, original.createdAtBarTime);
  assert.deepEqual(saved.warnings, ["initial warning", "upgrade warning"]);
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
  assertNear((longPlan.tp1 - longPlan.entry) / longPlan.risk, 1.5);
  assertNear((longPlan.tp2 - longPlan.entry) / longPlan.risk, 2.0);
  assert.equal(shortPlan.rrToTp1, 1.5);
  assert.equal(shortPlan.rrToTp2, 2.0);
  assertNear((shortPlan.entry - shortPlan.tp1) / shortPlan.risk, 1.5);
  assertNear((shortPlan.entry - shortPlan.tp2) / shortPlan.risk, 2.0);
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
