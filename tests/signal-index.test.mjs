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
  handleSignalStats
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

const { handleSignalStats } = context.signalIndexTestHooks;

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
    rrToTp2: 2.5
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
  stats = statsCache(records.length)
}) {
  const values = new Map(records.map((record) => [
    `signal:${record.id}`,
    JSON.stringify(record)
  ]));
  values.set("signal:index", JSON.stringify(indexIds));
  if (version !== null) values.set("signal:index:version", version);
  if (stats !== null) values.set("signal:stats", JSON.stringify(stats));

  const calls = { get: [], put: [], list: [] };
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
    async list(options = {}) {
      calls.list.push(options);
      const keys = [...values.keys()]
        .filter((key) => key.startsWith(options.prefix || ""))
        .sort()
        .map((name) => ({ name }));
      return { keys, list_complete: true };
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
