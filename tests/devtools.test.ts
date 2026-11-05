import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyze,
  caseConversions,
  checkJson,
  decodeBase64Text,
  durationText,
  expiryPhrase,
  expiryText,
  extractToken,
  formatBase,
  formatJson,
  formatLocal,
  formatShort,
  generatePassword,
  generators,
  hashes,
  inlineEpoch,
  isoLocal,
  jwtReport,
  parseJwt,
  parseNumberInput,
  parseTimeInput,
  relativeTime,
  splitWords,
  textStats,
  urlParams,
  uuidInfo,
  uuidV7,
  type Jwt,
} from "../src/main/devtools.ts";

// Dates are shown in local time; pin it to IST so the expected strings hold anywhere.
process.env.TZ = "Asia/Kolkata";

/** Wed 4 Nov 2026, 16:17:00 IST. */
const NOW = Date.UTC(2026, 10, 4, 10, 47, 0);
const SECONDS = NOW / 1000;

const b64url = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

function makeToken(payload: unknown, header: unknown = { alg: "HS256", typ: "JWT" }, signature = "c2lnbmF0dXJl"): string {
  return `${b64url(header)}.${b64url(payload)}.${signature}`;
}

const CLAIMS = {
  iss: "https://login.example.com/v2.0",
  sub: "user-42",
  aud: ["api://beam", "web"],
  scp: "read write",
  email: "jane@example.com",
  iat: SECONDS - 1800,
  exp: SECONDS + 2 * 3600 + 13 * 60,
};
const TOKEN = makeToken(CLAIMS);

function asJwt(value: ReturnType<typeof parseJwt>): Jwt {
  assert.ok(value && !("error" in value), `expected a JWT, got ${JSON.stringify(value)}`);
  return value;
}

test("tokens are found raw, after Bearer, or in an Authorization header", () => {
  assert.equal(extractToken(TOKEN), TOKEN);
  assert.equal(extractToken(`Bearer ${TOKEN}`), TOKEN);
  assert.equal(extractToken(`  authorization:   bearer ${TOKEN}\n`), TOKEN);
  assert.equal(extractToken(`"Authorization: Bearer ${TOKEN}"`), TOKEN);
  for (const input of [TOKEN, `Bearer ${TOKEN}`, `Authorization: Bearer ${TOKEN}`]) {
    const jwt = asJwt(parseJwt(input));
    assert.equal(jwt.token, TOKEN);
    assert.deepEqual(jwt.header, { alg: "HS256", typ: "JWT" });
    assert.deepEqual(jwt.claims, CLAIMS);
    assert.equal(jwt.signature, "c2lnbmF0dXJl");
    assert.equal(jwt.encrypted, false);
  }
});

test("JWT parts decode with or without Base64 padding", () => {
  // {"a":1} is 7 bytes, so its Base64 needs one "=" of padding.
  const padded = `${b64url({ alg: "none" })}=.${b64url({ a: 1 })}=.`;
  const jwt = asJwt(parseJwt(padded));
  assert.deepEqual(jwt.claims, { a: 1 });
  assert.equal(jwt.signature, "");
  assert.match(jwtReport(jwt, NOW), /None: the token is unsigned/);
});

test("non-JSON payloads and encrypted tokens are handled", () => {
  const text = asJwt(parseJwt(makeToken("just some text")));
  assert.equal(text.claims, null);
  assert.equal(text.payloadText, "just some text");
  assert.equal(expiryText(text.claims, NOW), "No expiry: the payload is not readable");

  const jwe = asJwt(parseJwt(`${b64url({ alg: "RSA-OAEP", enc: "A256GCM" })}.a2V5.aXY.Y2lwaGVy.dGFn`));
  assert.equal(jwe.encrypted, true);
  assert.equal(jwe.claims, null);
  const [group] = analyze(jwe.token, NOW);
  assert.equal(group.title, "Encrypted JWT (JWE)");
  assert.ok(group.results.some((r) => r.label === "Payload" && /can only be read with the recipient's key/.test(r.value)));
  assert.ok(!group.extras?.some((e) => e.id === "copy-payload"));
});

test("broken tokens say what is wrong; other dotted text is not a token", () => {
  const twoParts = parseJwt(`${TOKEN.split(".")[0]}.${TOKEN.split(".")[1]}`);
  assert.ok(twoParts && "error" in twoParts);
  assert.match(twoParts.error, /3 parts .* This one has 2/);
  const badHeader = parseJwt("eyJhbGciOiJIUzI1.eyJzdWIiOiIxIn0.sig");
  assert.ok(badHeader && "error" in badHeader);
  assert.match(badHeader.error, /header is not Base64URL-encoded JSON/);
  assert.equal(parseJwt("www.example.com"), null);
  assert.equal(parseJwt("hello"), null);
  assert.equal(parseJwt("1.2.3"), null);
  assert.equal(parseJwt('{"a": 1}'), null);
  const [group] = analyze("eyJhbGciOiJIUzI1.eyJzdWIiOiIxIn0.sig", NOW);
  assert.equal(group.results[0].error, true);
});

test("expiry reads as a relative and a local time", () => {
  assert.equal(expiryText(CLAIMS, NOW), "Expires in 2h 13m · Wed 4 Nov, 18:30");
  assert.equal(expiryPhrase(CLAIMS, NOW), "expires in 2h 13m");
  const expired = { exp: SECONDS - 3 * 86400 };
  assert.equal(expiryText(expired, NOW), "Expired 3 days ago · Sun 1 Nov, 16:17");
  assert.equal(expiryPhrase(expired, NOW), "expired 3 days ago");
  assert.equal(expiryText({ exp: String(SECONDS + 60) }, NOW), "Expires in 1m · Wed 4 Nov, 16:18");
  assert.equal(expiryText({ sub: "x" }, NOW), "No expiry: the token has no exp claim");
  assert.equal(expiryPhrase({ sub: "x" }, NOW), "no expiry");
  assert.equal(expiryText({ exp: "soon" }, NOW), 'Unreadable expiry: "soon"');
  // Another year shows the year.
  assert.equal(expiryText({ exp: Date.UTC(2025, 0, 1, 0, 0) / 1000 }, NOW), "Expired 22 months ago · Wed 1 Jan 2025, 05:30");
});

test("the JWT view leads with claims and says the signature is unverified", () => {
  const [group, hashGroup] = analyze(`Bearer ${TOKEN}`, NOW);
  assert.equal(group.kind, "jwt");
  assert.equal(group.secret, true);
  assert.match(group.title, /signature not verified/);
  assert.deepEqual(
    group.results.map((r) => r.id),
    ["jwt:claims", "jwt:expiry", "jwt:iat", "jwt:payload", "jwt:header", "jwt:signature"],
  );
  assert.equal(group.results[0].title, "HS256 · jane@example.com · login.example.com");
  assert.equal(group.results[1].value, "Expires in 2h 13m · Wed 4 Nov, 18:30");
  assert.equal(group.results[2].value, "Issued 30m ago · Wed 4 Nov, 15:47");
  assert.equal(group.results[3].value, JSON.stringify(CLAIMS, null, 2));
  assert.deepEqual(
    group.extras?.map((e) => [e.title, e.shortcut]),
    [
      ["Copy Payload JSON", "Ctrl+Shift+C"],
      ["Copy Token", "Ctrl+Shift+T"],
      ["Copy Authorization Header", "Ctrl+Shift+A"],
    ],
  );
  assert.equal(group.extras?.[1].text, TOKEN);
  assert.equal(group.extras?.[2].text, `Authorization: Bearer ${TOKEN}`);
  // Hashes cover the token, not the "Bearer " in front of it.
  assert.equal(hashGroup.title, "Hashes of the token");

  const report = jwtReport(asJwt(parseJwt(TOKEN)), NOW);
  assert.match(report, /^JWT · expires in 2h 13m/);
  assert.match(report, /Audience +api:\/\/beam, web/);
  assert.match(report, /Scope +read write/);
  assert.match(report, /Expires +Wed 4 Nov 2026, 18:30:00 IST \(in 2h 13m\)/);
  assert.match(report, /Lifetime +2h 43m/);
  assert.match(report, /signature is not verified/);
});

test("durations and relative times", () => {
  assert.equal(durationText(45_000), "45s");
  assert.equal(durationText(13 * 60_000), "13m");
  assert.equal(durationText(2 * 3600_000), "2h");
  assert.equal(durationText((2 * 60 + 13) * 60_000), "2h 13m");
  assert.equal(durationText(28 * 3600_000), "1 day 4h");
  assert.equal(durationText(3 * 86400_000), "3 days");
  assert.equal(durationText(150 * 86400_000), "5 months");
  assert.equal(durationText(60 * 86400_000), "2 months");
  assert.equal(durationText(730 * 86400_000), "2 years");
  assert.equal(durationText(800 * 86400_000), "2 years");
  assert.equal(relativeTime(NOW + 90_000, NOW), "in 1m");
  assert.equal(relativeTime(NOW - 90_000, NOW), "1m ago");
  assert.equal(relativeTime(NOW + 400, NOW), "just now");
});

test("JSON errors give a line and column", () => {
  const cases: Array<[string, string, number, number]> = [
    ['{\n  "a": 1\n  "b": 2\n}', "Expected ',' or '}' after the property value", 3, 3],
    ['{"a":1,}', "Trailing comma before }", 1, 8],
    ["[1,2,,3]", "Expected a value before ','", 1, 6],
    ["{'a':1}", "Property names need double quotes", 1, 2],
    ['{"a":1', "Unexpected end of input", 1, 7],
    ['{"a": "x', "Unterminated string", 1, 7],
    ['{"a": tru}', 'Unexpected character "t"', 1, 7],
    ['{"a": 1} x', "Unexpected text after the JSON value", 1, 10],
    ['["a\\q"]', "Invalid escape \\q", 1, 4],
  ];
  for (const [text, message, line, column] of cases) {
    const check = checkJson(text);
    assert.ok(!check.ok, text);
    assert.deepEqual({ message: check.message, line: check.line, column: check.column }, { message, line, column }, text);
  }
  const [group] = analyze('{\n  "a": 1\n  "b": 2\n}', NOW);
  assert.equal(group.results[0].id, "json:error");
  assert.equal(group.results[0].title, "Expected ',' or '}' after the property value · line 3, column 3");
  assert.match(group.results[0].preview ?? "", /  "b": 2\n  \^/);
});

test("JSON formats, minifies, sorts and escapes without changing numbers", () => {
  const text = '{"id": 12345678901234567890, "price": 1.50, "b": [1, 2], "a": {"z": 1, "y": null}}';
  const [group] = analyze(text, NOW);
  assert.equal(group.title, "JSON · 4 keys");
  const byId = new Map(group.results.map((r) => [r.id, r.value]));
  assert.equal(byId.get("json:minified"), '{"id":12345678901234567890,"price":1.50,"b":[1,2],"a":{"z":1,"y":null}}');
  assert.match(byId.get("json:formatted") ?? "", /^{\n  "id": 12345678901234567890,\n  "price": 1.50,/);
  assert.equal(
    byId.get("json:sorted"),
    '{\n  "a": {\n    "y": null,\n    "z": 1\n  },\n  "b": [\n    1,\n    2\n  ],\n  "id": 12345678901234567890,\n  "price": 1.50\n}',
  );
  assert.equal(byId.get("json:escaped"), JSON.stringify(byId.get("json:minified")));

  const formatted = formatJson('"{\\"a\\":[1,2]}"');
  assert.ok(formatted.ok);
  assert.equal(formatted.text, '{\n  "a": [\n    1,\n    2\n  ]\n}');
  assert.equal(formatted.shape, "1 key");
  assert.equal(formatJson("[1,").ok, false);
});

test("timestamps, dates and now", () => {
  assert.deepEqual(parseTimeInput("1793790000", NOW), { ms: 1793790000000, source: "seconds" });
  assert.deepEqual(parseTimeInput("1793790000123", NOW), { ms: 1793790000123, source: "milliseconds" });
  assert.deepEqual(parseTimeInput("1793790000123456", NOW), { ms: 1793790000123, source: "microseconds" });
  assert.deepEqual(parseTimeInput("1793790000123456789", NOW), { ms: 1793790000123, source: "nanoseconds" });
  assert.deepEqual(parseTimeInput(" NOW ", NOW), { ms: NOW, source: "now" });
  assert.equal(parseTimeInput("2026-11-04T18:30:00+05:30", NOW)?.ms, Date.UTC(2026, 10, 4, 13, 0));
  assert.equal(parseTimeInput("2026-11-04T13:00:00.250Z", NOW)?.ms, Date.UTC(2026, 10, 4, 13, 0, 0, 250));
  // Without an offset, dates are local, date-only ones included.
  assert.equal(parseTimeInput("2026-11-04", NOW)?.ms, Date.UTC(2026, 10, 3, 18, 30));
  assert.equal(parseTimeInput("2026-11-04 18:30", NOW)?.ms, Date.UTC(2026, 10, 4, 13, 0));
  assert.equal(parseTimeInput("Wed, 04 Nov 2026 13:00:00 GMT", NOW)?.ms, Date.UTC(2026, 10, 4, 13, 0));
  assert.equal(parseTimeInput("Wed Nov 04 2026 18:30:00 GMT+0530 (India Standard Time)", NOW)?.ms, Date.UTC(2026, 10, 4, 13, 0));
  assert.equal(parseTimeInput("2026-02-30", NOW), null);
  assert.equal(parseTimeInput("May the force 2026", NOW), null);
  assert.equal(parseTimeInput("12345", NOW), null);

  assert.equal(formatLocal(1793790000000), "Wed 4 Nov 2026, 16:30:00 IST");
  assert.equal(formatShort(1793790000000, NOW), "Wed 4 Nov, 16:30");
  assert.equal(isoLocal(1793790000123), "2026-11-04T16:30:00.123+05:30");

  const [time, number] = analyze("1793790000", NOW);
  assert.equal(time.title, "Timestamp (seconds)");
  assert.deepEqual(
    time.results.map((r) => [r.label, r.value]),
    [
      ["Local Time", "Wed 4 Nov 2026, 16:30:00 IST"],
      ["Relative", "in 13m"],
      ["UTC", "Wed, 04 Nov 2026 11:00:00 GMT"],
      ["ISO 8601 (UTC)", "2026-11-04T11:00:00.000Z"],
      ["ISO 8601 (Local)", "2026-11-04T16:30:00+05:30"],
      ["Unix Milliseconds", "1793790000000"],
    ],
  );
  assert.equal(number.kind, "number");
  assert.ok(!analyze("1793790000", NOW).some((g) => g.kind === "encode"));
  const [now] = analyze("now", NOW);
  assert.deepEqual(now.results.slice(0, 2).map((r) => r.value), [String(SECONDS), String(NOW)]);
});

test("only plausible epochs show in the main search", () => {
  assert.equal(inlineEpoch("1793790000"), 1793790000000);
  assert.equal(inlineEpoch("1793790000123"), 1793790000123);
  assert.equal(inlineEpoch("9876543210"), null); // a mobile number, year 2282
  assert.equal(inlineEpoch("0123456789"), null);
  assert.equal(inlineEpoch("179379000"), null);
  assert.equal(inlineEpoch("17937900001"), null);
  assert.equal(inlineEpoch("1793790000.5"), null);
});

test("number bases", () => {
  assert.deepEqual(parseNumberInput("255"), { value: 255n, base: 10 });
  assert.deepEqual(parseNumberInput("0xFF"), { value: 255n, base: 16 });
  assert.deepEqual(parseNumberInput("0b1010"), { value: 10n, base: 2 });
  assert.deepEqual(parseNumberInput("0o17"), { value: 15n, base: 8 });
  assert.deepEqual(parseNumberInput("-42"), { value: -42n, base: 10 });
  assert.deepEqual(parseNumberInput("1_000_000"), { value: 1000000n, base: 10 });
  assert.equal(parseNumberInput("0x"), null);
  assert.equal(parseNumberInput("12ab"), null);
  assert.equal(parseNumberInput("1.5"), null);
  assert.equal(formatBase(-255n, 16), "-0xff");
  assert.equal(formatBase(10n, 2), "0b1010");
  const big = parseNumberInput("0xffffffffffffffffff");
  assert.equal(big && formatBase(big.value, 10), "4722366482869645213695");
  const [group] = analyze("0xff", NOW);
  assert.deepEqual(group.results.map((r) => [r.label, r.value]), [["Decimal", "255"], ["Binary", "0b11111111"], ["Octal", "0o377"]]);
});

test("Base64 is decoded only when it holds text", () => {
  assert.deepEqual(decodeBase64Text("aGVsbG8gd29ybGQ="), { text: "hello world", urlSafe: false });
  assert.deepEqual(decodeBase64Text("aGVsbG8gd29ybGQ"), { text: "hello world", urlSafe: false });
  assert.deepEqual(decodeBase64Text("eyJ1c2VyIjoiamFuZSJ9"), { text: '{"user":"jane"}', urlSafe: false });
  assert.deepEqual(decodeBase64Text(Buffer.from("ü?>ü?>").toString("base64url")), { text: "ü?>ü?>", urlSafe: true });
  assert.deepEqual(decodeBase64Text("aGVsbG8g\nd29ybGQ=\n"), { text: "hello world", urlSafe: false });
  for (const notBase64 of ["password", "username", "12345678", "deadbeefcafe", "hello world", "abc", "getUserById"]) {
    assert.equal(decodeBase64Text(notBase64), null, notBase64);
  }
  // A SHA-256 is valid Base64 but decodes to bytes, not text.
  assert.equal(decodeBase64Text(hashes("x")[2].value), null);
  const groups = analyze("aGVsbG8gd29ybGQsIHRoaXMgaXMgQmVhbQ==", NOW);
  assert.equal(groups[0].results[0].value, "hello world, this is Beam");
  assert.ok(!groups.some((g) => g.kind === "case"));
});

test("text is encoded both ways", () => {
  const encode = analyze("a/b c", NOW).find((g) => g.kind === "encode");
  assert.deepEqual(encode?.results.map((r) => [r.label, r.value]), [
    ["Base64", "YS9iIGM="],
    ["Base64URL", "YS9iIGM"],
    ["URL Encoded", "a%2Fb%20c"],
  ]);
  const decode = analyze("a%2Fb%20c", NOW).find((g) => g.kind === "encode");
  assert.equal(decode?.results[0].label, "URL Decoded");
  assert.equal(decode?.results[0].value, "a/b c");
});

test("case conversions", () => {
  assert.deepEqual(splitWords("XMLHttpRequest"), ["XML", "Http", "Request"]);
  assert.deepEqual(splitWords("user_id-v2 name.first"), ["user", "id", "v2", "name", "first"]);
  assert.deepEqual(splitWords("utf8String"), ["utf8", "String"]);
  const conversions = Object.fromEntries(caseConversions("hello world").map((c) => [c.label, c.value]));
  assert.deepEqual(conversions, {
    camelCase: "helloWorld",
    PascalCase: "HelloWorld",
    snake_case: "hello_world",
    CONSTANT_CASE: "HELLO_WORLD",
    "kebab-case": "hello-world",
    "Title Case": "Hello World",
    "UPPER CASE": "HELLO WORLD",
  });
  // The input's own style is left out.
  const fromCamel = caseConversions("getUserById").map((c) => c.value);
  assert.ok(!fromCamel.includes("getUserById"));
  assert.ok(fromCamel.includes("get_user_by_id"));
  assert.ok(fromCamel.includes("GetUserById"));
  assert.ok(analyze("getUserById", NOW).some((g) => g.kind === "case"));
  assert.ok(!analyze("line one\nline two", NOW).some((g) => g.kind === "case"));
  assert.ok(!analyze("x".repeat(101), NOW).some((g) => g.kind === "case"));
});

test("URL query parameters", () => {
  assert.deepEqual(urlParams("https://x.example/p?a=1&b=hello%20world&a=2&q=a+b"), [
    { key: "a", value: "1" },
    { key: "b", value: "hello world" },
    { key: "a", value: "2" },
    { key: "q", value: "a b" },
  ]);
  assert.deepEqual(urlParams("?code=abc&state=xyz"), [
    { key: "code", value: "abc" },
    { key: "state", value: "xyz" },
  ]);
  assert.deepEqual(urlParams("https://x.example/"), []);
  assert.equal(urlParams("hello world"), null);
  assert.equal(urlParams("a=1"), null);

  const url = "https://app.example.com/cb?state=xyz&redirect_uri=https%3A%2F%2Fexample.com%2Fhome#access_token=abc&expires_in=3600";
  const [group] = analyze(url, NOW);
  assert.equal(group.title, "URL");
  const byId = new Map(group.results.map((r) => [r.id, r]));
  assert.equal(byId.get("url:decoded")?.value, "https://app.example.com/cb?state=xyz&redirect_uri=https://example.com/home#access_token=abc&expires_in=3600");
  assert.equal(byId.get("url:host")?.value, "app.example.com");
  assert.equal(byId.get("url:param:1")?.title, "redirect_uri = https://example.com/home");
  assert.equal(byId.get("url:param:1")?.value, "https://example.com/home");
  assert.equal(byId.get("url:fragment:0")?.secret, true);
  assert.equal(byId.get("url:fragment:1")?.secret, false);
  assert.deepEqual(JSON.parse(byId.get("url:params-json")?.value ?? ""), {
    state: "xyz",
    redirect_uri: "https://example.com/home",
    access_token: "abc",
    expires_in: "3600",
  });
  // The URL group already decodes, so the text group does not repeat it.
  assert.ok(!analyze(url, NOW).find((g) => g.kind === "encode")?.results.some((r) => r.id === "encode:url-decoded"));
});

test("UUID versions, variants and creation times", () => {
  const v4 = uuidInfo("550E8400-E29B-41D4-A716-446655440000");
  assert.equal(v4?.uuid, "550e8400-e29b-41d4-a716-446655440000");
  assert.equal(v4?.version, 4);
  assert.equal(v4?.variant, "RFC 9562 (RFC 4122)");
  assert.equal(v4?.createdMs, null);
  // The examples from RFC 9562 all encode 2022-02-22 19:22:22 UTC.
  const created = Date.UTC(2022, 1, 22, 19, 22, 22);
  assert.equal(uuidInfo("C232AB00-9414-11EC-B3C8-9F6BDECED846")?.createdMs, created);
  assert.equal(uuidInfo("1EC9414C-232A-6B00-B3C8-9F6BDECED846")?.createdMs, created);
  assert.equal(uuidInfo("017F22E2-79B0-7CC3-98C4-DC0C0C07398F")?.createdMs, created);
  assert.equal(uuidInfo("{00000000-0000-0000-0000-000000000000}")?.versionName, "Nil UUID");
  assert.equal(uuidInfo("urn:uuid:550e8400-e29b-41d4-a716-446655440000")?.version, 4);
  assert.equal(uuidInfo("550e8400e29b41d4a716446655440000"), null);
  const [group] = analyze("550E8400-E29B-41D4-A716-446655440000", NOW);
  assert.equal(group.results[0].title, "UUID v4 · random · RFC 9562 (RFC 4122) variant");
  assert.deepEqual(group.results.slice(1).map((r) => r.label), ["Lowercase", "Without Dashes"]);
});

test("generated UUIDs, passwords and secrets", () => {
  assert.equal(uuidV7(Date.UTC(2022, 1, 22, 19, 22, 22), new Uint8Array(10)), "017f22e2-79b0-7000-8000-000000000000");
  const v7 = uuidV7(NOW);
  assert.equal(uuidInfo(v7)?.version, 7);
  assert.equal(uuidInfo(v7)?.createdMs, NOW);
  for (let i = 0; i < 50; i++) {
    const password = generatePassword();
    assert.equal(password.length, 20);
    assert.match(password, /[A-Z]/);
    assert.match(password, /[a-z]/);
    assert.match(password, /[0-9]/);
    assert.match(password, /[^A-Za-z0-9]/);
    assert.doesNotMatch(password, /[0O1lI"'`\\$ ]/);
  }
  const all = generators(NOW);
  assert.deepEqual(all.map((r) => r.id), [
    "gen:uuid4", "gen:uuid7", "gen:password", "gen:secret-hex", "gen:secret-base64", "gen:unix", "gen:unix-ms", "gen:iso",
  ]);
  const byId = new Map(all.map((r) => [r.id, r]));
  assert.match(byId.get("gen:secret-hex")?.value ?? "", /^[0-9a-f]{64}$/);
  assert.equal(Buffer.from(byId.get("gen:secret-base64")?.value ?? "", "base64").toString("hex"), byId.get("gen:secret-hex")?.value);
  assert.equal(byId.get("gen:password")?.secret, true);
  assert.equal(byId.get("gen:uuid4")?.secret, undefined);
  assert.equal(byId.get("gen:unix")?.value, String(SECONDS));
  assert.deepEqual(generators(NOW, "uuid").map((r) => r.id), ["gen:uuid4", "gen:uuid7"]);
  assert.deepEqual(generators(NOW, "pass").map((r) => r.id), ["gen:password"]);
  assert.deepEqual(generators(NOW, "uu"), []);
  assert.deepEqual(generators(NOW, "hello"), []);
});

test("hashes and text stats", () => {
  assert.deepEqual(hashes("hello").map((h) => h.value.slice(0, 16)), [
    "5d41402abc4b2a76",
    "aaf4c61ddcc5e8a2",
    "2cf24dba5fb0a30e",
    "9b71d224bd62f378",
  ]);
  assert.deepEqual(textStats("héllo 👍\nworld\n"), { characters: 14, words: 3, lines: 2, bytes: 18 });
  assert.deepEqual(textStats(""), { characters: 0, words: 0, lines: 0, bytes: 0 });
  const groups = analyze("hello\n", NOW);
  assert.equal(groups.find((g) => g.kind === "hash")?.title, "Hashes · includes surrounding whitespace");
  assert.equal(groups.at(-1)?.results[0].value, "6 characters · 1 word · 1 line · 6 bytes");
  assert.deepEqual(analyze("   ", NOW), []);
});
