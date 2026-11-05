import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONVERSIONS,
  conversionsFor,
  ffmpegArgs,
  fileKind,
  fileUriToPath,
  formatElapsed,
  formatSize,
  freePath,
  imageArgs,
  isNoop,
  largestFrame,
  libreOfficeArgs,
  libreOfficeOutput,
  outputExt,
  outputPath,
  parseCopiedFiles,
  parseDuration,
  pdfPagesArgs,
  progressSeconds,
  toolError,
  typeLabel,
  type Conversion,
  type FileKind,
} from "../src/main/convert.ts";

function conversion(kind: FileKind, id: string): Conversion {
  const found = CONVERSIONS.find((c) => c.kind === kind && c.id === id);
  assert.ok(found, `${kind}:${id}`);
  return found;
}

const none = () => false;

test("fileKind goes by extension, any case", () => {
  assert.equal(fileKind("/a/photo.PNG"), "image");
  assert.equal(fileKind("/a/IMG_0001.heic"), "image");
  assert.equal(fileKind("/a/logo.svg"), "image");
  assert.equal(fileKind("/a/clip.MOV"), "video");
  assert.equal(fileKind("/a/song.opus"), "audio");
  assert.equal(fileKind("/a/report.docx"), "document");
  assert.equal(fileKind("/a/notes.txt"), "document");
  assert.equal(fileKind("/a/scan.pdf"), "pdf");
  assert.equal(fileKind("/a/archive.zip"), null);
  assert.equal(fileKind("/a/Makefile"), null);
  assert.equal(fileKind("/a/.png"), null);
});

test("ids are unique within a kind", () => {
  const keys = CONVERSIONS.map((c) => `${c.kind}:${c.id}`);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(conversionsFor("pdf").map((c) => c.id), ["png-pages"]);
});

test("a format change to the file's own format is skipped, including other spellings", () => {
  assert.equal(isNoop("/a/photo.png", conversion("image", "png")), true);
  assert.equal(isNoop("/a/photo.jpeg", conversion("image", "jpg")), true);
  assert.equal(isNoop("/a/scan.TIF", conversion("image", "tiff")), true);
  assert.equal(isNoop("/a/photo.png", conversion("image", "jpg")), false);
  // Operations with a suffix always run.
  assert.equal(isNoop("/a/photo.jpg", conversion("image", "compress")), false);
  assert.equal(isNoop("/a/clip.mp4", conversion("video", "compress")), false);
  assert.equal(isNoop("/a/clip.m4v", conversion("video", "mp4")), false);
});

test("output goes next to the source with the new extension", () => {
  assert.equal(outputPath("/home/me/Pictures/photo.jpg", conversion("image", "png"), none), "/home/me/Pictures/photo.png");
  assert.equal(outputPath("/home/me/My Files/a b.mov", conversion("video", "mp4"), none), "/home/me/My Files/a b.mp4");
  assert.equal(outputPath("/a/clip.mkv", conversion("video", "mp3"), none), "/a/clip.mp3");
  assert.equal(outputPath("/a/report.docx", conversion("document", "pdf"), none), "/a/report.pdf");
});

test("taken names get a number instead of being overwritten", () => {
  const taken = new Set(["/a/photo.png", "/a/photo (1).png"]);
  assert.equal(outputPath("/a/photo.jpg", conversion("image", "png"), (p) => taken.has(p)), "/a/photo (2).png");
  assert.equal(freePath("/a", "x", ".gif", (p) => p === "/a/x.gif"), "/a/x (1).gif");
});

test("same-format operations add a suffix and keep the format where it can be written", () => {
  assert.equal(outputPath("/a/photo.jpg", conversion("image", "compress"), none), "/a/photo-small.jpg");
  assert.equal(outputPath("/a/photo.png", conversion("image", "compress"), none), "/a/photo-small.jpg");
  assert.equal(outputPath("/a/photo.JPEG", conversion("image", "half"), none), "/a/photo-half.jpeg");
  assert.equal(outputPath("/a/photo.webp", conversion("image", "fit-1920"), none), "/a/photo-1920.webp");
  assert.equal(outputPath("/a/IMG_1.heic", conversion("image", "half"), none), "/a/IMG_1-half.png");
  assert.equal(outputPath("/a/logo.svg", conversion("image", "fit-1920"), none), "/a/logo-1920.png");
  assert.equal(outputPath("/a/clip.mp4", conversion("video", "compress"), none), "/a/clip-small.mp4");
  const taken = (p: string) => p === "/a/photo-small.jpg";
  assert.equal(outputPath("/a/photo.jpg", conversion("image", "compress"), taken), "/a/photo-small (1).jpg");
});

test("PDF pages go to a folder named after the PDF", () => {
  const pages = conversion("pdf", "png-pages");
  assert.equal(outputExt("/a/report.pdf", pages), "");
  assert.equal(outputPath("/a/report.pdf", pages, none), "/a/report");
  assert.equal(outputPath("/a/report.pdf", pages, (p) => p === "/a/report"), "/a/report (1)");
  assert.deepEqual(pdfPagesArgs("/a/report.pdf", "/a/report (1)"), ["-png", "-r", "150", "/a/report.pdf", "/a/report (1)/report"]);
});

test("PNG to JPEG flattens onto white at quality 90 and keeps one frame", () => {
  assert.deepEqual(imageArgs(conversion("image", "jpg"), "/a/my photo.png", "/t/output.jpg"), [
    "/a/my photo.png",
    "(", "-clone", "0", ")", "-delete", "0--2",
    "-auto-orient",
    "-background", "white", "-alpha", "remove", "-alpha", "off",
    "-quality", "90",
    "JPEG:/t/output.jpg",
  ]);
});

test("image arguments for compress, resize, ICO, animation and SVG", () => {
  const compress = imageArgs(conversion("image", "compress"), "/a/p.png", "/t/o.jpg");
  assert.ok(compress.includes("-strip"));
  assert.deepEqual(compress.slice(-3), ["-quality", "75", "JPEG:/t/o.jpg"]);

  const fit = imageArgs(conversion("image", "fit-1920"), "/a/p.heic", "/t/o.png");
  assert.deepEqual(fit.slice(-3), ["-resize", "1920x1920>", "PNG:/t/o.png"]);

  const ico = imageArgs(conversion("image", "ico"), "/a/logo.png", "/t/o.ico");
  assert.ok(ico.includes("icon:auto-resize=256,128,64,48,32,16"));
  assert.equal(ico.at(-1), "ICO:/t/o.ico");

  // An .ico source converts its largest frame.
  assert.deepEqual(imageArgs(conversion("image", "png"), "/a/f.ico", "/t/o.png", 2).slice(1, 7), ["(", "-clone", "2", ")", "-delete", "0--2"]);

  // GIF and WebP keep every frame of an animation.
  const webp = imageArgs(conversion("image", "webp"), "/a/anim.gif", "/t/o.webp");
  assert.deepEqual(webp, ["/a/anim.gif", "-coalesce", "-auto-orient", "-quality", "90", "WEBP:/t/o.webp"]);

  assert.deepEqual(imageArgs(conversion("image", "png"), "/a/logo.svg", "/t/o.png").slice(0, 3), ["-background", "none", "/a/logo.svg"]);
  assert.equal(imageArgs(conversion("image", "bmp"), "/a/p.png", "/t/o.bmp").at(-1), "BMP3:/t/o.bmp");
});

test("largestFrame picks the biggest size from identify output", () => {
  assert.equal(largestFrame("0 16 16\n1 64 64\n2 32 32\n"), 1);
  assert.equal(largestFrame("0 256 256\n1 16 16\n"), 0);
  assert.equal(largestFrame(""), 0);
});

test("ffmpeg arguments for MP4, GIF and audio", () => {
  const mp4 = ffmpegArgs(conversion("video", "mp4"), "/a/clip.mov", "/t/output.mp4");
  assert.deepEqual(mp4.slice(0, 10), ["-hide_banner", "-nostdin", "-loglevel", "error", "-progress", "pipe:1", "-nostats", "-n", "-i", "/a/clip.mov"]);
  for (const part of ["libx264", "yuv420p", "aac", "+faststart", "0:V:0", "0:a:0?"]) assert.ok(mp4.includes(part), part);
  assert.equal(mp4[mp4.indexOf("-crf") + 1], "23");
  assert.equal(mp4.at(-1), "/t/output.mp4");

  const small = ffmpegArgs(conversion("video", "compress"), "/a/clip.mp4", "/t/o.mp4");
  assert.equal(small[small.indexOf("-crf") + 1], "28");

  const gif = ffmpegArgs(conversion("video", "gif"), "/a/clip.mp4", "/t/o.gif");
  const filter = gif[gif.indexOf("-vf") + 1];
  assert.match(filter, /^fps=12,scale='min\(640,iw\)':-1/);
  assert.match(filter, /palettegen.*paletteuse/);
  assert.ok(gif.includes("-an"));

  const mp3 = ffmpegArgs(conversion("video", "mp3"), "/a/clip.mp4", "/t/o.mp3");
  assert.deepEqual(mp3.slice(10), ["-map", "0:a:0", "-c:a", "libmp3lame", "-q:a", "2", "/t/o.mp3"]);

  assert.deepEqual(ffmpegArgs(conversion("audio", "flac"), "/a/s.wav", "/t/o.flac").slice(10), ["-map", "0:a:0", "-c:a", "flac", "/t/o.flac"]);
  assert.throws(() => ffmpegArgs(conversion("image", "png"), "/a/p.jpg", "/t/o.png"));
});

test("LibreOffice gets its own profile as a file URL", () => {
  const args = libreOfficeArgs("/a/My Report.docx", "/a/.beam-convert-x", "/tmp/beam-libreoffice-1 2");
  assert.equal(args[0], "-env:UserInstallation=file:///tmp/beam-libreoffice-1%202");
  assert.deepEqual(args.slice(-5), ["--convert-to", "pdf", "--outdir", "/a/.beam-convert-x", "/a/My Report.docx"]);
  assert.equal(libreOfficeOutput("/a/My Report.docx", "/o"), "/o/My Report.pdf");
});

test("copied files from Nautilus: copy and cut", () => {
  assert.deepEqual(parseCopiedFiles("copy\nfile:///home/me/Pictures/a.png\nfile:///home/me/Pictures/b.jpg"), {
    paths: ["/home/me/Pictures/a.png", "/home/me/Pictures/b.jpg"],
    cut: false,
  });
  assert.deepEqual(parseCopiedFiles("cut\nfile:///home/me/clip.mp4\n"), { paths: ["/home/me/clip.mp4"], cut: true });
});

test("copied files: percent-encoding, spaces and non-ASCII names", () => {
  const text = "copy\nfile:///home/me/My%20Photos/caf%C3%A9%20%2350%25.png\nfile:///home/me/%E5%86%99%E7%9C%9F.heic";
  assert.deepEqual(parseCopiedFiles(text).paths, ["/home/me/My Photos/café #50%.png", "/home/me/写真.heic"]);
});

test("text/uri-list: CRLF, comments, other schemes and duplicates", () => {
  const text = "# from Files\r\nfile:///a/one.png\r\nsftp://host/b.png\r\nfile://localhost/a/two%20x.png\r\nfile:///a/one.png\r\n";
  assert.deepEqual(parseCopiedFiles(text), { paths: ["/a/one.png", "/a/two x.png"], cut: false });
  assert.deepEqual(parseCopiedFiles(""), { paths: [], cut: false });
  assert.deepEqual(parseCopiedFiles("just some copied text").paths, []);
});

test("old Nautilus plain-text clipboard format", () => {
  const text = "x-special/nautilus-clipboard\ncut\nfile:///a/b.png\n";
  assert.deepEqual(parseCopiedFiles(text), { paths: ["/a/b.png"], cut: true });
});

test("fileUriToPath rejects remote hosts and broken escapes", () => {
  assert.equal(fileUriToPath("file://server/share/a.png"), null);
  assert.equal(fileUriToPath("file:///a/%E0%A4%A.png"), null);
  assert.equal(fileUriToPath("/a/b.png"), null);
  assert.equal(fileUriToPath("FILE:///a/b.png"), "/a/b.png");
});

test("ffmpeg progress and duration", () => {
  const progress = "out_time_us=N/A\nprogress=continue\nout_time_us=1500000\nout_time_ms=1500000\nprogress=continue\nout_time_us=2979025\nprogress=end\n";
  assert.equal(progressSeconds(progress), 2.979025);
  assert.equal(progressSeconds("progress=continue\n"), null);
  assert.equal(parseDuration("3.000000\n"), 3);
  assert.equal(parseDuration("N/A\n"), null);
});

test("tool errors keep the useful line", () => {
  assert.equal(
    toolError(
      "convert-im6.q16: unable to open image `/a/x.png': No such file or directory @ error/blob.c/OpenBlob/2964.\n" +
        "convert-im6.q16: no images defined `PNG:/t/o.png' @ error/convert.c/ConvertImageCommand/3234.\n",
    ),
    "unable to open image `/a/x.png': No such file or directory",
  );
  assert.equal(
    toolError(
      "[out#0/mp3 @ 0x6472248a22c0] Output file does not contain any stream\nError opening output file /t/o.mp3.\nError opening output files: Invalid argument\n",
    ),
    "Output file does not contain any stream",
  );
  assert.equal(
    toolError(
      "Stream map '0:a:0' matches no streams.\nTo ignore this, add a trailing '?' to the map.\n" +
        "Failed to set value '0:a:0' for option 'map': Invalid argument\nError parsing options for output file /t/o.mp3.\n",
    ),
    "The file has no sound",
  );
  assert.equal(toolError(""), "");
});

test("sizes, labels and elapsed time", () => {
  assert.equal(formatSize(512), "512 bytes");
  assert.equal(formatSize(2_100_000), "2.1 MB");
  assert.equal(formatSize(45_000), "45 kB");
  assert.equal(typeLabel("/a/b.PNG"), "PNG Image");
  assert.equal(typeLabel("/a/b.mkv"), "MKV Video");
  assert.equal(typeLabel("/a/b.flac"), "FLAC Audio");
  assert.equal(typeLabel("/a/b.pdf"), "PDF");
  assert.equal(typeLabel("/a/b.zip"), "ZIP File");
  assert.equal(formatElapsed(42_000), "0:42");
  assert.equal(formatElapsed(3_723_000), "1:02:03");
});

test("only animations keep their frames; an .ico going to GIF keeps one size", () => {
  assert.ok(imageArgs(conversion("image", "gif"), "/a/f.ico", "/t/o.gif", 1).includes("-clone"));
  assert.ok(imageArgs(conversion("image", "half"), "/a/anim.gif", "/t/o.gif").includes("-coalesce"));
  assert.ok(!imageArgs(conversion("image", "webp"), "/a/p.png", "/t/o.webp").includes("-coalesce"));
});
