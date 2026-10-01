/**
 * `localModels` decides what the node offers. A managed pull names its model
 * there — and must never quietly withdraw what was already on offer, nor offer
 * a model nobody chose. Plus the price lookup's one promise: an unreachable
 * server reads "unknown", never "priced".
 */

import { describe, expect, test } from "bun:test";
import { addAdvertised, removeAdvertised, parseList, livePrices, sellState, priceText, snapshotAdvertising } from "../src/local/sell.js";

const OLLAMA = "http://127.0.0.1:11434";

describe("addAdvertised", () => {
  test("an explicit list gains the model once", () => {
    const pre = { enabled: true, endpoint: OLLAMA, declared: ["a", "b"], discovered: null };
    expect(addAdvertised("b", pre, OLLAMA).value).toBe("a,b");
    expect(addAdvertised("c", pre, OLLAMA).value).toBe("a,b,c");
  });

  test("a blank list that was advertising this endpoint is seeded with what it listed", () => {
    const pre = { enabled: true, endpoint: OLLAMA, declared: [], discovered: ["llama3:latest", "x/y:latest"] };
    const r = addAdvertised("x/y", pre, OLLAMA);
    expect(r.value).toBe("llama3:latest,x/y");
    expect(r.seeded).toEqual(["llama3:latest"]);
  });

  test("nothing is seeded when lending was off, or pointed elsewhere", () => {
    const off = { enabled: false, endpoint: OLLAMA, declared: [], discovered: null };
    expect(addAdvertised("m", off, OLLAMA)).toEqual({ value: "m", seeded: [] });
    const other = { enabled: true, endpoint: "http://127.0.0.1:1234", declared: [], discovered: ["lmstudio-model"] };
    expect(addAdvertised("m", other, OLLAMA)).toEqual({ value: "m", seeded: [] });
  });
});

describe("removeAdvertised / parseList", () => {
  test("drops the id and its :latest spelling", () => {
    expect(removeAdvertised("m", { localModels: "a,m,m:latest" })).toEqual({ value: "a", changed: true });
    expect(removeAdvertised("z", { localModels: "a" })).toEqual({ value: "a", changed: false });
  });

  test("parseList trims and drops blanks", () => {
    expect(parseList(" a, b,,c ")).toEqual(["a", "b", "c"]);
    expect(parseList("")).toEqual([]);
  });
});

describe("snapshotAdvertising", () => {
  test("asks the endpoint only when the list is blank and lending is on", async () => {
    let asked = 0;
    const discover = async () => { asked++; return ["x:latest"]; };
    expect((await snapshotAdvertising({ localEnabled: true, localEndpoint: OLLAMA, localModels: "" }, discover)).discovered).toEqual(["x:latest"]);
    expect((await snapshotAdvertising({ localEnabled: true, localEndpoint: OLLAMA, localModels: "a" }, discover)).discovered).toBeNull();
    expect((await snapshotAdvertising({ localEnabled: false, localEndpoint: OLLAMA, localModels: "" }, discover)).discovered).toBeNull();
    expect(asked).toBe(1);
  });
});

describe("livePrices", () => {
  const config = { serverUrl: "https://example.invalid" };

  test("maps the server's rows by id", async () => {
    const call = async ({ ids }) => ({ models: ids.map((id) => ({ id, priced: id === "p", inPerMtok: 0.05, outPerMtok: 0.08, source: "catalogue" })) });
    const live = await livePrices(["p", "u"], config, { call });
    expect(live.available).toBe(true);
    expect(sellState("p", live)).toBe("priced");
    expect(sellState("u", live)).toBe("unpriced");
    expect(sellState("other", live)).toBe("unknown");
    expect(priceText(live.prices.get("p"))).toBe("$0.05 / $0.08");
  });

  test("asks in batches of 50", async () => {
    const sizes = [];
    const call = async ({ ids }) => { sizes.push(ids.length); return { models: [] }; };
    await livePrices(Array.from({ length: 120 }, (_, i) => `m${i}`), config, { call });
    expect(sizes).toEqual([50, 50, 20]);
  });

  test("an older server (404) or no network is unknown, never priced", async () => {
    const notFound = await livePrices(["p"], config, { call: async () => { const e = new Error("nf"); e.status = 404; throw e; } });
    expect(notFound.available).toBe(false);
    expect(notFound.reason).toMatch(/does not answer price checks/);
    expect(sellState("p", notFound)).toBe("unknown");
    const down = await livePrices(["p"], config, { call: async () => { throw new Error("ECONNREFUSED"); } });
    expect(sellState("p", down)).toBe("unknown");
  });
});
