import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chooseShareRendition,
  cleanGifUrl,
  errorForStatus,
  formatBytes,
  gifMarkdown,
  giphyRequestUrl,
  parseGiphyResponse,
  queryKey,
} from "../src/main/gifs.ts";

// A synthetic response shaped like GIPHY's search API.
const media = (id: string, file: string) => `https://media1.giphy.com/media/v1.Y2lkPWZha2U/${id}/${file}?cid=fake&ep=v1_gifs_search&rid=${file}&ct=g`;

const FIXTURE = {
  data: [
    {
      type: "gif",
      id: "abc123",
      url: "https://giphy.com/gifs/happy-dance-abc123",
      title: "  Happy   Dance GIF by Example  ",
      rating: "g",
      images: {
        original: { url: media("abc123", "giphy.gif"), width: "480", height: "270", size: "1234567" },
        downsized: { url: media("abc123", "giphy-downsized.gif"), width: "480", height: "270", size: "900000" },
        fixed_height: { url: media("abc123", "200.gif"), width: "356", height: "200", size: "400000" },
        fixed_height_small: { url: media("abc123", "100.gif"), width: "178", height: "100" },
        fixed_height_small_still: { url: media("abc123", "100_s.gif"), width: "178", height: "100" },
      },
    },
    {
      type: "gif",
      id: "big456",
      url: "https://giphy.com/gifs/big456",
      title: "",
      rating: "pg-13",
      images: {
        original: { url: media("big456", "giphy.gif"), width: "1000", height: "800", size: "14000000" },
        downsized: { url: media("big456", "giphy-downsized.gif"), width: "500", height: "400", size: "1900000" },
        fixed_height_still: { url: media("big456", "200_s.gif") },
      },
    },
    // Repeated GIF, a non-GIPHY host and a GIF without images are dropped.
    { id: "abc123", url: "https://giphy.com/gifs/abc123", images: { original: { url: media("abc123", "giphy.gif") } } },
    { id: "evil", url: "https://giphy.com/gifs/evil", images: { original: { url: "https://evil.example.com/x.gif" } } },
    { id: "bare", url: "https://giphy.com/gifs/bare", images: {} },
  ],
  pagination: { total_count: 2, count: 5, offset: 0 },
  meta: { status: 200, msg: "OK", response_id: "fake" },
};

test("request URLs: search with a query, trending without", () => {
  const search = new URL(giphyRequestUrl("KEY", " cat & dog "));
  assert.equal(search.origin + search.pathname, "https://api.giphy.com/v1/gifs/search");
  assert.equal(search.searchParams.get("api_key"), "KEY");
  assert.equal(search.searchParams.get("q"), "cat & dog");
  assert.equal(search.searchParams.get("limit"), "24");
  assert.equal(search.searchParams.get("rating"), "pg-13");
  const trending = new URL(giphyRequestUrl("KEY", "  "));
  assert.equal(trending.pathname, "/v1/gifs/trending");
  assert.equal(trending.searchParams.has("q"), false);
});

test("parses a response into GIFs", () => {
  const result = parseGiphyResponse(200, FIXTURE);
  assert.ok(result.ok);
  assert.equal(result.gifs.length, 2);
  const [small, big] = result.gifs;
  assert.deepEqual(small, {
    id: "abc123",
    title: "Happy Dance GIF by Example",
    pageUrl: "https://giphy.com/gifs/happy-dance-abc123",
    gifUrl: "https://media1.giphy.com/media/v1.Y2lkPWZha2U/abc123/giphy.gif",
    iconUrl: media("abc123", "100_s.gif"),
    previewUrl: media("abc123", "200.gif"),
    width: 480,
    height: 270,
    bytes: 1234567,
    rating: "g",
  });
  // Too big to unfurl quickly: the downsized copy is shared instead.
  assert.equal(big.gifUrl, "https://media1.giphy.com/media/v1.Y2lkPWZha2U/big456/giphy-downsized.gif");
  assert.equal(big.width, 500);
  assert.equal(big.title, "Untitled GIF");
  assert.equal(big.iconUrl, media("big456", "200_s.gif"));
  assert.equal(big.previewUrl, media("big456", "giphy-downsized.gif"));
});

test("share rendition: original unless it is large and a downsized copy exists", () => {
  const original = { url: media("x", "giphy.gif"), size: "9000000" };
  const downsized = { url: media("x", "giphy-downsized.gif"), size: "1000000" };
  assert.equal(chooseShareRendition({ original, downsized }), downsized);
  assert.equal(chooseShareRendition({ original }), original);
  assert.equal(chooseShareRendition({ original: { url: media("x", "giphy.gif") }, downsized })?.url, media("x", "giphy.gif"));
  assert.equal(chooseShareRendition({}), undefined);
});

test("errors by status", () => {
  assert.equal(errorForStatus(200), null);
  assert.equal(errorForStatus(401), "auth");
  assert.equal(errorForStatus(403), "auth");
  assert.equal(errorForStatus(429), "rate-limit");
  assert.equal(errorForStatus(500), "server");
  assert.deepEqual(parseGiphyResponse(401, { message: "No API key found in request" }), { ok: false, error: "auth", status: 401 });
  assert.deepEqual(parseGiphyResponse(429, null), { ok: false, error: "rate-limit", status: 429 });
  // GIPHY can also report a failure in meta.
  assert.deepEqual(parseGiphyResponse(200, { data: [], meta: { status: 403, msg: "Forbidden" } }), { ok: false, error: "auth", status: 403 });
  assert.deepEqual(parseGiphyResponse(200, { meta: { status: 200 } }), { ok: false, error: "bad-response", status: 200 });
  assert.deepEqual(parseGiphyResponse(200, { data: [] }), { ok: true, gifs: [] });
});

test("helpers", () => {
  assert.equal(cleanGifUrl("https://media.giphy.com/media/x/giphy.gif?cid=1#frag"), "https://media.giphy.com/media/x/giphy.gif");
  assert.equal(formatBytes(1_234_567), "1.2 MB");
  assert.equal(formatBytes(340_400), "340 KB");
  assert.equal(formatBytes(12), "1 KB");
  const result = parseGiphyResponse(200, FIXTURE);
  assert.ok(result.ok);
  assert.equal(gifMarkdown({ ...result.gifs[0], title: "[wow] cat" }), `![\\[wow\\] cat](${result.gifs[0].gifUrl})`);
  assert.equal(queryKey("  Happy   Cat "), "happy cat");
});
