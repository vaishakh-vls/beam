// Parses currency queries ("10 usd", "$10 to eur", "5k inr in usd") and picks the home currency.

export interface CurrencyQuery {
  amount: number;
  from: string;
  /** Null when the query names no target, so the home currency is used. */
  to: string | null;
}

const ALIASES: Record<string, string> = {
  $: "USD",
  dollar: "USD",
  dollars: "USD",
  bucks: "USD",
  "₹": "INR",
  rs: "INR",
  rupee: "INR",
  rupees: "INR",
  "€": "EUR",
  euro: "EUR",
  euros: "EUR",
  "£": "GBP",
  pound: "GBP",
  pounds: "GBP",
  "¥": "JPY",
  yen: "JPY",
  yuan: "CNY",
  rmb: "CNY",
  dirham: "AED",
  dirhams: "AED",
  riyal: "SAR",
  riyals: "SAR",
};

/** ISO codes that are also everyday words; typed in lowercase they are not taken as currencies. */
const WORD_CODES = new Set(["all", "bam", "bob", "cup", "gel", "mad", "mop", "php", "sos", "top", "try"]);

const MULTIPLIERS: Record<string, number> = {
  k: 1e3,
  m: 1e6,
  mn: 1e6,
  bn: 1e9,
  lakh: 1e5,
  lakhs: 1e5,
  cr: 1e7,
  crore: 1e7,
  crores: 1e7,
};

// A currency token: a symbol or word, never digits, separators or arrows.
const TOKEN = String.raw`[^\d\s.,=>→-]+`;
const QUERY = new RegExp(
  String.raw`^(?<pre>${TOKEN}\.?)?\s*(?<amount>\d[\d,]*(?:\.\d+)?|\.\d+)\s*(?:(?<mult>k|mn|m|bn|lakhs?|cr|crores?)\b)?` +
    String.raw`\s*(?<from>${TOKEN}\.?)?\s*(?:(?:to|in|into)(?:\s+|$)|(?:=|->|→)\s*)?(?<to>${TOKEN})?$`,
  "i",
);

/** The ISO code a typed token names, or null. `isKnown` says whether a code has a rate. */
export function resolveCurrency(token: string, isKnown: (code: string) => boolean): string | null {
  const word = token.replace(/\.$/, "");
  const alias = ALIASES[word.toLowerCase()];
  if (alias) return alias;
  if (!/^[a-z]{3}$/i.test(word)) return null;
  if (WORD_CODES.has(word)) return null;
  const code = word.toUpperCase();
  return isKnown(code) ? code : null;
}

export function parseCurrencyQuery(query: string, isKnown: (code: string) => boolean): CurrencyQuery | null {
  const match = QUERY.exec(query.trim());
  if (!match?.groups) return null;
  const { pre, amount, mult, from, to } = match.groups;
  if (pre && from) return null;
  const source = pre ?? from;
  if (!source) return null;
  const fromCode = resolveCurrency(source, isKnown);
  if (!fromCode) return null;
  let toCode: string | null = null;
  if (to) {
    toCode = resolveCurrency(to, isKnown);
    if (!toCode) return null;
  }
  const value = Number(amount.replace(/,/g, "")) * (mult ? MULTIPLIERS[mult.toLowerCase()] : 1);
  if (!Number.isFinite(value)) return null;
  return { amount: value, from: fromCode, to: toCode };
}

const EURO = ["AT", "BE", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PT", "SI", "SK"];

const COUNTRY_CURRENCY: Record<string, string> = {
  ...Object.fromEntries(EURO.map((country) => [country, "EUR"])),
  AE: "AED", AR: "ARS", AU: "AUD", BD: "BDT", BH: "BHD", BR: "BRL", CA: "CAD", CH: "CHF",
  CL: "CLP", CN: "CNY", CO: "COP", CZ: "CZK", DK: "DKK", EG: "EGP", GB: "GBP", HK: "HKD",
  HU: "HUF", ID: "IDR", IL: "ILS", IN: "INR", JP: "JPY", KE: "KES", KR: "KRW", KW: "KWD",
  LK: "LKR", MX: "MXN", MY: "MYR", NG: "NGN", NO: "NOK", NP: "NPR", NZ: "NZD", OM: "OMR",
  PH: "PHP", PK: "PKR", PL: "PLN", QA: "QAR", RO: "RON", RU: "RUB", SA: "SAR", SE: "SEK",
  SG: "SGD", TH: "THB", TR: "TRY", TW: "TWD", UA: "UAH", US: "USD", VN: "VND", ZA: "ZAR",
};

export interface Region {
  /** IANA time zone, e.g. "Asia/Kolkata". */
  timezone?: string;
  /** zoneinfo's zone.tab, which maps time zones to countries. */
  zoneTab?: string;
  /** The locale variable, e.g. "en_IN.UTF-8". */
  lang?: string;
}

/**
 * The currency of the user's region. The time zone comes first because the
 * locale is often en_US whatever the country; then the locale's territory.
 */
export function regionCurrency({ timezone, zoneTab, lang }: Region): string {
  const zoneCountry = timezone && zoneTab
    ? zoneTab.split("\n").find((line) => line.split("\t")[2] === timezone)?.split("\t")[0]
    : undefined;
  const langCountry = lang?.match(/^[a-z]{2,3}_([A-Z]{2})/)?.[1];
  for (const country of [zoneCountry, langCountry]) {
    if (country && COUNTRY_CURRENCY[country]) return COUNTRY_CURRENCY[country];
  }
  return "USD";
}

/** Indian grouping (₹1,00,000) for rupees; standard grouping otherwise. */
export function formatMoney(value: number, currency: string): string {
  const digits = Math.abs(value) > 0 && Math.abs(value) < 1 ? 4 : 2;
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: digits,
    minimumFractionDigits: Math.min(2, digits),
  }).format(value);
}
