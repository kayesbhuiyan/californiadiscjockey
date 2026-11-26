import fs from "fs";
import path from "path";

const WP = "http://127.0.0.1/californiadiscjockey/wp-content/uploads/";
const SITE = path.join(process.cwd(), "html-site");
const MEDIA = path.join(process.cwd(), "public", "media");

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.html?$/i.test(ent.name)) out.push(p);
  }
  return out;
}

const files = new Set();
for (const htmlFile of walk(SITE)) {
  const html = fs.readFileSync(htmlFile, "utf8");
  for (const m of html.matchAll(
    /(?:\.\.\/)+wp-content\/uploads\/(\d{4}\/\d{2}\/[^"'?\s<>]+)|\/wp-content\/uploads\/(\d{4}\/\d{2}\/[^"'?\s<>]+)|\/media\/(\d{4}\/\d{2}\/[^"'?\s<>]+)/gi,
  )) {
    const rel = (m[1] || m[2] || m[3] || "").replace(/&amp;/g, "&").split("#")[0].split("?")[0];
    if (rel && !rel.includes("..")) files.add(rel);
  }
}

const list = [...files];
let downloaded = 0;
let exists = 0;
let missing = 0;
console.log(`Found ${list.length} media refs`);

for (let i = 0; i < list.length; i++) {
  const rel = list[i];
  process.stdout.write(`\r[${i + 1}/${list.length}] ${rel.slice(0, 70).padEnd(70)}`);
  const dest = path.join(MEDIA, rel);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    exists++;
    continue;
  }
  try {
    const res = await fetch(WP + rel);
    if (!res.ok) {
      missing++;
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    downloaded++;
  } catch {
    missing++;
  }
}

console.log("\n", { total: list.length, exists, downloaded, missing });
fs.writeFileSync(
  "scripts/sync-missing-media-report.json",
  JSON.stringify({ total: list.length, exists, downloaded, missing }, null, 2),
);
