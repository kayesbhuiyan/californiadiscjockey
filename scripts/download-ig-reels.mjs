import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "..", "public", "media", "instagram");
fs.mkdirSync(outDir, { recursive: true });

const ids = ["DDljW__RMxM", "DBo55xjyjJx", "DCdycUZRtq3"];
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function stripRange(url) {
  const u = new URL(url);
  u.searchParams.delete("bytestart");
  u.searchParams.delete("byteend");
  return u.toString();
}

function pickBestMp4(names) {
  const cleaned = names.map(stripRange);
  const unique = [...new Set(cleaned)];
  // Prefer higher-quality m367 / larger bitrate tags when present.
  unique.sort((a, b) => {
    const score = (u) => {
      let s = 0;
      if (/\/m367\//.test(u)) s += 100;
      if (/\/m86\//.test(u)) s += 40;
      if (/audio/i.test(u)) s -= 200;
      const br = u.match(/ImJpdHJhdGUiOj(\d+)/);
      if (br) s += Number(br[1]) / 1e5;
      return s;
    };
    return score(b) - score(a);
  });
  return unique[0];
}

async function findVideoUrl(id) {
  const page = `https://www.instagram.com/reel/${id}/`;
  // Use embed + main page HTML isn't enough; hit the permalink HTML for resource hints
  // and also try the Graph-ish media endpoint used by embeds.
  const res = await fetch(page, {
    headers: {
      "user-agent": UA,
      accept: "text/html",
      "accept-language": "en-US,en;q=0.9",
    },
    redirect: "follow",
  });
  const html = await res.text();
  const urls = [...html.matchAll(/https:\\\/\\\/[^"'\\]+\.mp4[^"'\\]*/g)].map((m) =>
    m[0].replace(/\\\//g, "/").replace(/\\u0026/g, "&"),
  );
  if (urls.length) return pickBestMp4(urls);

  // Fallback: oEmbed may include thumbnail only; try media JSON via www
  const api = `https://www.instagram.com/api/v1/media/${id}/info/`;
  try {
    const apiRes = await fetch(api, {
      headers: {
        "user-agent": UA,
        accept: "*/*",
        "x-ig-app-id": "936619743392459",
      },
    });
    const text = await apiRes.text();
    const apiUrls = [...text.matchAll(/https:\\\/\\\/[^"'\\]+\.mp4[^"'\\]*/g)].map((m) =>
      m[0].replace(/\\\//g, "/").replace(/\\u0026/g, "&"),
    );
    if (apiUrls.length) return pickBestMp4(apiUrls);
    const plain = [...text.matchAll(/https:\/\/[^"'\s]+\.mp4[^"'\s]*/g)].map((m) => m[0]);
    if (plain.length) return pickBestMp4(plain);
  } catch {
    /* ignore */
  }
  return null;
}

async function download(id, url) {
  const out = path.join(outDir, `${id}.mp4`);
  console.log(`Downloading ${id}...`);
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      referer: "https://www.instagram.com/",
      origin: "https://www.instagram.com",
      accept: "*/*",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${id}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 50_000) throw new Error(`File too small (${buf.length}) for ${id}`);
  fs.writeFileSync(out, buf);
  console.log(`Wrote ${out} (${(buf.length / 1e6).toFixed(2)} MB)`);
  return out;
}

const seedUrls = process.argv.slice(2);
if (seedUrls.length) {
  // Optional: node download-ig-reels.mjs <id> <url>
  for (let i = 0; i < seedUrls.length; i += 2) {
    await download(seedUrls[i], stripRange(seedUrls[i + 1]));
  }
  process.exit(0);
}

for (const id of ids) {
  const url = await findVideoUrl(id);
  if (!url) {
    console.error(`No video URL for ${id}`);
    continue;
  }
  console.log(id, "=>", url.slice(0, 120) + "...");
  try {
    await download(id, url);
  } catch (e) {
    console.error(id, e.message || e);
  }
}
