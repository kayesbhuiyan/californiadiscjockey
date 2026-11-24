import { createReadStream, readFileSync } from "fs";
import { Readable } from "stream";
import {
  canonicalPathForFile,
  contentTypeFor,
  isTextAsset,
  renderRobots,
  renderSitemap,
  resolveRequest,
  rewriteAssetText,
  renderPageCss,
  rewriteHtml,
} from "@/lib/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ path?: string[] }> };

function textResponse(body: string, contentType: string, status = 200) {
  const cacheable = /css|javascript|font|image/.test(contentType);
  return new Response(body, {
    status,
    headers: {
      "content-type": contentType,
      "cache-control": contentType.includes("text/html")
        ? "public, max-age=0, must-revalidate"
        : cacheable
          ? "public, max-age=31536000, immutable"
          : "public, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}

function notFound() {
  const html = `<!DOCTYPE html>
<html lang="en-US">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Page not found &#8211; California disc jockey</title>
</head>
<body style="margin:0;background:#fff;color:#303030;font-family:Arial,Helvetica,sans-serif;">
<header style="background:#069;color:#fff;padding:24px 20px;">
<p style="margin:0;font-size:28px;letter-spacing:.04em;text-transform:uppercase;">California disc jockey</p>
</header>
<main style="max-width:760px;margin:0 auto;padding:40px 20px;">
<h1 style="color:#20a0cf;font-weight:400;text-transform:uppercase;">Page not found</h1>
<p>That page is not on this site.</p>
<p><a href="/" style="color:#20a0cf;">Back to the homepage</a></p>
</main>
</body>
</html>`;
  return textResponse(html, "text/html; charset=utf-8", 404);
}

async function serve(request: Request) {
  const url = new URL(request.url);
  if (url.pathname === "/_css") {
    const page = url.searchParams.get("p") || "/";
    const kind = url.searchParams.get("k") === "defer" ? "defer" : "block";
    const css = renderPageCss(page, kind);
    if (css == null) return notFound();
    return textResponse(css, "text/css; charset=utf-8");
  }

  const resolved = resolveRequest(url.pathname);
  if (!resolved) return notFound();

  if (resolved.type === "redirect") {
    const target = new URL(resolved.to + url.search, url);
    return Response.redirect(target, 301);
  }

  if (resolved.type === "sitemap") {
    return textResponse(renderSitemap(), "application/xml; charset=utf-8");
  }

  if (resolved.type === "robots") {
    return textResponse(renderRobots(), "text/plain; charset=utf-8");
  }

  if (resolved.type === "page") {
    const raw = readFileSync(resolved.file, "utf8");
    const html = rewriteHtml(raw, resolved.canonicalPath, resolved.forceNoindex);
    return textResponse(html, contentTypeFor(resolved.file, html));
  }

  const assetUrl = canonicalPathForFile(resolved.file);
  if (assetUrl.toLowerCase().endsWith(".html")) {
    const raw = readFileSync(resolved.file, "utf8");
    const html = rewriteHtml(raw, assetUrl, true);
    return textResponse(html, contentTypeFor(resolved.file, html));
  }

  if (isTextAsset(resolved.file)) {
    const raw = readFileSync(resolved.file, "utf8");
    const rewritten = rewriteAssetText(raw, assetUrl);
    return textResponse(rewritten, contentTypeFor(resolved.file, rewritten));
  }

  const stream = Readable.toWeb(createReadStream(resolved.file)) as ReadableStream;
  return new Response(stream, {
    headers: {
      "content-type": contentTypeFor(resolved.file),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function GET(request: Request, _context: Context) {
  return serve(request);
}

export async function HEAD(request: Request, _context: Context) {
  const response = await serve(request);
  return new Response(null, { status: response.status, headers: response.headers });
}
