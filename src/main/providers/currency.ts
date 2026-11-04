import fs from "node:fs";
import { config } from "../config";
import { formatMoney, parseCurrencyQuery, regionCurrency } from "../currency";
import type { Entry } from "../entry";
import { JsonStore } from "../store";
import { copyText, pasteText, pasteVerb } from "../system";

// Free, keyless and updated daily; rates are per 1 USD.
const RATES_URL = "https://open.er-api.com/v6/latest/USD";
const REFRESH_AFTER_MS = 6 * 60 * 60 * 1000;
const ZONE_TAB = "/usr/share/zoneinfo/zone.tab";

interface Rates {
  /** When the provider published these rates (ms). */
  published: number;
  /** When Beam fetched them (ms). */
  fetched: number;
  rates: Record<string, number>;
}

let store: JsonStore<Rates> | null = null;
let fetching = false;
let home: string | null = null;

function rates(): JsonStore<Rates> {
  store ??= new JsonStore<Rates>("currency-rates.json", () => ({ published: 0, fetched: 0, rates: {} }));
  return store;
}

/** The configured currency, or the region's when config says "auto". */
export function homeCurrency(): string {
  const configured = config().currency?.trim().toUpperCase();
  if (configured && configured !== "AUTO") return configured;
  if (!home) {
    let zoneTab: string | undefined;
    try {
      zoneTab = fs.readFileSync(ZONE_TAB, "utf8");
    } catch {
      zoneTab = undefined;
    }
    home = regionCurrency({
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      zoneTab,
      lang: process.env.LC_MONETARY || process.env.LANG,
    });
  }
  return home;
}

/** Fetches fresh rates when the saved ones are older than six hours. */
export async function refreshRates(): Promise<void> {
  if (fetching || Date.now() - rates().data.fetched < REFRESH_AFTER_MS) return;
  fetching = true;
  try {
    const response = await fetch(RATES_URL, { signal: AbortSignal.timeout(10_000) });
    const body = (await response.json()) as { result?: string; time_last_update_unix?: number; rates?: Record<string, number> };
    if (body.result !== "success" || !body.rates || typeof body.rates.USD !== "number") {
      throw new Error(`unexpected response from ${RATES_URL}`);
    }
    rates().data = {
      published: (body.time_last_update_unix ?? 0) * 1000 || Date.now(),
      fetched: Date.now(),
      rates: body.rates,
    };
    rates().save();
  } catch (error) {
    // Offline or the service is down: keep the last saved rates.
    console.error("beam: could not fetch exchange rates:", error);
  } finally {
    fetching = false;
  }
}

export function currencyEntry(query: string, hide: () => void): Entry | null {
  const table = rates().data.rates;
  const parsed = parseCurrencyQuery(query, (code) => code in table);
  if (!parsed) return null;
  void refreshRates();
  const local = homeCurrency();
  const to = parsed.to ?? (parsed.from === local ? (local === "USD" ? "EUR" : "USD") : local);
  if (!(parsed.from in table) || !(to in table) || parsed.from === to) return null;

  const rate = table[to] / table[parsed.from];
  const value = parsed.amount * rate;
  const answer = formatMoney(value, to);
  const plain = value.toFixed(Math.abs(value) < 1 ? 4 : 2);
  const date = new Date(rates().data.published).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return {
    id: "currency",
    title: answer,
    subtitle: `${formatMoney(parsed.amount, parsed.from)} ${parsed.from} → ${to}  ·  1 ${parsed.from} = ${formatMoney(rate, to)}  ·  rates of ${date}`,
    icon: "💱",
    accessory: "Currency",
    actions: [
      {
        id: "copy",
        title: "Copy Answer",
        shortcut: "↵",
        run: () => {
          copyText(plain);
          return { type: "hide" };
        },
      },
      {
        id: "paste",
        title: `${pasteVerb()} Answer`,
        shortcut: "Ctrl+↵",
        run: async () => {
          await pasteText(plain, hide);
          return { type: "hide" };
        },
      },
      {
        id: "copy-formatted",
        title: "Copy with Currency Sign",
        shortcut: "Ctrl+Shift+C",
        run: () => {
          copyText(answer);
          return { type: "hide" };
        },
      },
    ],
  };
}
