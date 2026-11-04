import assert from "node:assert/strict";
import { test } from "node:test";
import { formatMoney, parseCurrencyQuery, regionCurrency } from "../src/main/currency.ts";

const KNOWN = new Set(["USD", "INR", "EUR", "GBP", "AED", "JPY", "TOP", "ALL"]);
const known = (code: string) => KNOWN.has(code);
const parse = (query: string) => parseCurrencyQuery(query, known);

test("amount and currency, converted to the home currency", () => {
  assert.deepEqual(parse("10 usd"), { amount: 10, from: "USD", to: null });
  assert.deepEqual(parse("10USD"), { amount: 10, from: "USD", to: null });
  assert.deepEqual(parse("$10"), { amount: 10, from: "USD", to: null });
  assert.deepEqual(parse("₹1,500"), { amount: 1500, from: "INR", to: null });
  assert.deepEqual(parse("rs. 250"), { amount: 250, from: "INR", to: null });
  assert.deepEqual(parse("12.5 euros"), { amount: 12.5, from: "EUR", to: null });
});

test("explicit targets", () => {
  assert.deepEqual(parse("10 usd to eur"), { amount: 10, from: "USD", to: "EUR" });
  assert.deepEqual(parse("10 usd in gbp"), { amount: 10, from: "USD", to: "GBP" });
  assert.deepEqual(parse("10 usd inr"), { amount: 10, from: "USD", to: "INR" });
  assert.deepEqual(parse("£5 = $"), { amount: 5, from: "GBP", to: "USD" });
  assert.deepEqual(parse("10 usd in"), { amount: 10, from: "USD", to: null });
});

test("multipliers", () => {
  assert.equal(parse("5k usd")?.amount, 5000);
  assert.equal(parse("2 lakh inr")?.amount, 200000);
  assert.equal(parse("1.5 cr inr")?.amount, 15000000);
  assert.equal(parse("3m usd")?.amount, 3000000);
});

test("not currency queries", () => {
  assert.equal(parse("10 km to miles"), null);
  assert.equal(parse("2 + 2"), null);
  assert.equal(parse("usd"), null);
  assert.equal(parse("10"), null);
  assert.equal(parse("10 usd to xyz"), null);
  // ISO codes that are everyday words count only in capitals.
  assert.equal(parse("top 10"), null);
  assert.deepEqual(parse("10 TOP"), { amount: 10, from: "TOP", to: null });
});

test("home currency from the time zone first, then the locale", () => {
  const zoneTab = "IN\t+2232+08822\tAsia/Kolkata\nAE\t+2518+05518\tAsia/Dubai\n";
  assert.equal(regionCurrency({ timezone: "Asia/Kolkata", zoneTab, lang: "en_US.UTF-8" }), "INR");
  assert.equal(regionCurrency({ timezone: "Asia/Dubai", zoneTab }), "AED");
  assert.equal(regionCurrency({ timezone: "Etc/UTC", zoneTab, lang: "en_GB.UTF-8" }), "GBP");
  assert.equal(regionCurrency({ lang: "de_DE.UTF-8" }), "EUR");
  assert.equal(regionCurrency({}), "USD");
});

test("rupees use Indian digit grouping", () => {
  assert.equal(formatMoney(150000, "INR"), "₹1,50,000.00");
  assert.equal(formatMoney(150000, "USD"), "$150,000.00");
});
