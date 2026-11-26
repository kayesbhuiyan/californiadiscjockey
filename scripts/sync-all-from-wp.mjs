/**
 * Sync all local WP pages into html-site mirrors (+ download missing media).
 * WP: http://localhost/californiadiscjockey
 */
import fs from "fs";
import path from "path";

const WP_BASE = "http://127.0.0.1/californiadiscjockey";
const SITE_ROOT = path.join(process.cwd(), "html-site");
const MEDIA_ROOT = path.join(process.cwd(), "public", "media");
const REPORT = "scripts/sync-all-from-wp-report.json";
const PRIOR_AUDIT = "scripts/wp-next-parity-report.json";

async function fetchText(url, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    return { ok: res.ok, status: res.status, text: await res.text(), url: res.url };
  } catch (e) {
    return { ok: false, status: 0, text: "", error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

function normalizePath(pathname) {
  let p = pathname.replace(/^\/californiadiscjockey/i, "");
  if (!p.endsWith("/")) p += "/";
  return p || "/";
}

async function listWpPaths() {
  const paths = new Set(["/"]);

  // Prefer prior audit inventory when present (reliable local list).
  if (fs.existsSync(PRIOR_AUDIT)) {
    try {
      const prior = JSON.parse(fs.readFileSync(PRIOR_AUDIT, "utf8"));
      for (const row of prior.all || []) {
        if (row?.path) paths.add(normalizePath(row.path));
      }
    } catch {}
  }

  for (const sm of [
    `${WP_BASE}/page-sitemap.xml`,
    `${WP_BASE}/post-sitemap.xml`,
    `${WP_BASE}/wp-sitemap-posts-page-1.xml`,
    `${WP_BASE}/wp-sitemap-posts-post-1.xml`,
  ]) {
    const r = await fetchText(sm, 45000);
    if (!r.ok) continue;
    for (const m of r.text.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)) {
      try {
        paths.add(normalizePath(new URL(m[1].trim()).pathname));
      } catch {}
    }
  }
  for (const type of ["pages", "posts"]) {
    for (let page = 1; page <= 50; page++) {
      const r = await fetchText(
        `${WP_BASE}/wp-json/wp/v2/${type}?per_page=100&page=${page}&_fields=link,status`,
        45000,
      );
      if (!r.ok) break;
      let rows = [];
      try {
        rows = JSON.parse(r.text);
      } catch {
        break;
      }
      if (!Array.isArray(rows) || !rows.length) break;
      for (const row of rows) {
        try {
          paths.add(normalizePath(new URL(row.link).pathname));
        } catch {}
      }
      if (rows.length < 100) break;
    }
  }
  return [...paths].sort();
}

function depthPrefix(pagePath) {
  // / -> "" ; /foo/ -> "../" ; /a/b/ -> "../../"
  const parts = pagePath.split("/").filter(Boolean);
  return parts.length ? "../".repeat(parts.length) : "";
}

function rewriteWpHtml(html, pagePath) {
  const prefix = depthPrefix(pagePath);
  const up = prefix || "./";
  let out = html;
  out = out
    .replace(/https?:\/\/localhost\/californiadiscjockey\/wp-content\/uploads\//gi, `${up}wp-content/uploads/`)
    .replace(/https?:\/\/(?:www\.)?californiadiscjockey\.com\/wp-content\/uploads\//gi, `${up}wp-content/uploads/`)
    .replace(/https?:\/\/localhost\/californiadiscjockey\//gi, up)
    .replace(/https?:\/\/(?:www\.)?californiadiscjockey\.com\//gi, up)
    // Drop WP admin / emoji / generator noise that can break mirrors
    .replace(/<link[^>]+wp-json[^>]*>/gi, "")
    .replace(/<script[^>]+wp-emoji-release[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<script[^>]+id="wp-emoji-settings"[\s\S]*?<\/script>/gi, "");
  return out;
}

function extractEntry(html) {
  const re =
    /(<div\b[^>]*\bentry-content\b[^>]*>)([\s\S]*?)(<\/div>\s*<!--\s*\.entry-content\s*-->|<\/div>\s*(?=<\/article>))/i;
  const m = html.match(re);
  if (!m) return null;
  return { open: m[1], body: m[2], close: m[3], full: m[0] };
}

function mirrorFileFor(pagePath) {
  if (pagePath === "/") return path.join(SITE_ROOT, "index.html");
  return path.join(SITE_ROOT, ...pagePath.split("/").filter(Boolean), "index.html");
}

function collectUploadPaths(html) {
  const files = new Set();
  for (const m of html.matchAll(
    /(?:\.\.\/)+wp-content\/uploads\/(\d{4}\/\d{2}\/[^"'?\s]+)|\/wp-content\/uploads\/(\d{4}\/\d{2}\/[^"'?\s]+)|\/media\/(\d{4}\/\d{2}\/[^"'?\s]+)/gi,
  )) {
    const rel = (m[1] || m[2] || m[3] || "").replace(/&amp;/g, "&").split("?")[0];
    if (rel) files.add(rel);
  }
  return [...files];
}

async function ensureMedia(rel) {
  const dest = path.join(MEDIA_ROOT, rel);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return { rel, status: "exists" };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const url = `http://127.0.0.1/californiadiscjockey/wp-content/uploads/${rel}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return { rel, status: "missing_remote", code: res.status };
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(dest, buf);
    return { rel, status: "downloaded", bytes: buf.length };
  } catch (e) {
    return { rel, status: "error", error: String(e?.message || e) };
  }
}

function patchHeadMeta(mirrorHtml, wpHtml) {
  let out = mirrorHtml;
  const title = wpHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (title) out = out.replace(/<title[^>]*>[\s\S]*?<\/title>/i, `<title>${title}</title>`);
  const desc = wpHtml.match(/<meta\b[^>]*name=["']description["'][^>]*>/i)?.[0];
  if (desc) {
    if (/name=["']description["']/i.test(out)) {
      out = out.replace(/<meta\b[^>]*name=["']description["'][^>]*>/i, desc);
    }
  }
  return out;
}

const paths = await listWpPaths();
console.log(`Syncing ${paths.length} WP paths…`);

const summary = {
  total: paths.length,
  updated: 0,
  created: 0,
  skipped: 0,
  errors: [],
  mediaDownloaded: 0,
  mediaMissing: 0,
};
const mediaSeen = new Set();
const CONCURRENCY = 2;
let idx = 0;
const FORCE = process.argv.includes("--force");
const ONLY_MISSING = process.argv.includes("--missing-only");

async function worker() {
  while (idx < paths.length) {
    const i = idx++;
    const pagePath = paths[i];
    process.stdout.write(`\r[${i + 1}/${paths.length}] ${pagePath.slice(0, 70).padEnd(70)}`);

    const file = mirrorFileFor(pagePath);
    if (ONLY_MISSING && fs.existsSync(file)) {
      summary.skipped++;
      continue;
    }
    // Resume-friendly: skip mirrors touched in the last 3 hours unless --force.
    if (!FORCE && !ONLY_MISSING && fs.existsSync(file)) {
      const ageMs = Date.now() - fs.statSync(file).mtimeMs;
      if (ageMs < 3 * 60 * 60 * 1000) {
        summary.skipped++;
        continue;
      }
    }

    const wpUrl = pagePath === "/" ? `${WP_BASE}/` : `${WP_BASE}${pagePath}`;
    const wp = await fetchText(wpUrl, 30000);
    if (!wp.ok) {
      summary.errors.push({ path: pagePath, error: wp.error || `status ${wp.status}` });
      summary.skipped++;
      continue;
    }

    const rewrittenFull = rewriteWpHtml(wp.text, pagePath);
    const wpEntry = extractEntry(wp.text);

    try {
      if (fs.existsSync(file)) {
        let mirror = fs.readFileSync(file, "utf8");
        const mirEntry = extractEntry(mirror);
        if (wpEntry && mirEntry) {
          let body = rewriteWpHtml(wpEntry.body, pagePath);
          mirror = mirror.replace(mirEntry.full, `${mirEntry.open}${body}</div><!-- .entry-content -->`);
          mirror = patchHeadMeta(mirror, rewrittenFull);
          fs.writeFileSync(file, mirror);
          summary.updated++;
          for (const rel of collectUploadPaths(body)) mediaSeen.add(rel);
        } else {
          // No entry-content match — replace whole file with rewritten WP HTML
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, rewrittenFull);
          summary.updated++;
          for (const rel of collectUploadPaths(rewrittenFull)) mediaSeen.add(rel);
        }
      } else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, rewrittenFull);
        summary.created++;
        for (const rel of collectUploadPaths(rewrittenFull)) mediaSeen.add(rel);
      }
    } catch (e) {
      summary.errors.push({ path: pagePath, error: String(e?.message || e) });
      summary.skipped++;
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
if (!process.argv.includes("--skip-media")) {
  console.log("\nDownloading media…");
  const mediaList = [...mediaSeen];
  for (let i = 0; i < mediaList.length; i++) {
    const rel = mediaList[i];
    process.stdout.write(`\r[media ${i + 1}/${mediaList.length}] ${rel.slice(0, 60).padEnd(60)}`);
    const r = await ensureMedia(rel);
    if (r.status === "downloaded") summary.mediaDownloaded++;
    if (r.status === "missing_remote" || r.status === "error") summary.mediaMissing++;
  }
} else {
  summary.mediaQueued = mediaSeen.size;
  console.log(`\nSkipped media download (${mediaSeen.size} referenced).`);
}

console.log("\nDone.");
fs.writeFileSync(REPORT, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`Wrote ${REPORT}`);
