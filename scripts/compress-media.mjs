/**
 * Lossless-ish recompress of large photos under public/media.
 * Caps long edge at 1920px, JPEG/WebP quality ~78. Skips tiny files and GIFs.
 */
import fs from "fs";
import path from "path";
import sharp from "sharp";

const ROOT = path.join(process.cwd(), "public", "media");
const MIN_BYTES = 350_000;
const MAX_EDGE = 1920;
const JPEG_QUALITY = 78;
const WEBP_QUALITY = 76;

let scanned = 0;
let rewritten = 0;
let saved = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (!/\.(jpe?g|png|webp)$/i.test(ext)) continue;
    const stat = fs.statSync(full);
    scanned += 1;
    if (stat.size < MIN_BYTES) continue;
    compress(full, ext, stat.size).catch((err) => {
      console.error("skip", full, err.message);
    });
  }
}

async function compress(file, ext, before) {
  const image = sharp(file, { failOn: "none" }).rotate();
  const meta = await image.metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  let pipeline = image;
  if (width > MAX_EDGE || height > MAX_EDGE) {
    pipeline = pipeline.resize({
      width: width >= height ? MAX_EDGE : undefined,
      height: height > width ? MAX_EDGE : undefined,
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  const tmp = file + ".cdjtmp";
  if (ext === ".png") {
    await pipeline.png({ compressionLevel: 9, palette: true, quality: 80 }).toFile(tmp);
  } else if (ext === ".webp") {
    await pipeline.webp({ quality: WEBP_QUALITY }).toFile(tmp);
  } else {
    await pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toFile(tmp);
  }

  const after = fs.statSync(tmp).size;
  if (after < before * 0.97) {
    fs.renameSync(tmp, file);
    rewritten += 1;
    saved += before - after;
    console.log(
      `ok ${path.relative(ROOT, file)} ${(before / 1e6).toFixed(2)}MB → ${(after / 1e6).toFixed(2)}MB`,
    );
  } else {
    fs.unlinkSync(tmp);
  }
}

async function main() {
  if (!fs.existsSync(ROOT)) {
    console.error("missing", ROOT);
    process.exit(1);
  }
  const jobs = [];
  function collect(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        collect(full);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!/\.(jpe?g|png|webp)$/i.test(ext)) continue;
      const stat = fs.statSync(full);
      scanned += 1;
      if (stat.size < MIN_BYTES) continue;
      jobs.push(compress(full, ext, stat.size));
    }
  }
  collect(ROOT);
  const batch = 4;
  for (let i = 0; i < jobs.length; i += batch) {
    await Promise.all(jobs.slice(i, i + batch));
  }
  console.log(
    `done scanned=${scanned} rewritten=${rewritten} saved=${(saved / 1e6).toFixed(1)}MB`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
