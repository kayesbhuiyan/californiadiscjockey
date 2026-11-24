import fs from "fs";
import path from "path";

const root = path.join(process.cwd(), "html-site");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function moveDir(fromRel, toRel) {
  const from = path.join(root, fromRel);
  const to = path.join(root, toRel);
  if (!fs.existsSync(from)) {
    console.log("skip missing", fromRel);
    return;
  }
  ensureDir(path.dirname(to));
  if (fs.existsSync(to)) {
    console.log("target exists, merging", toRel);
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      const dest = path.join(to, entry.name);
      if (entry.isDirectory()) {
        fs.cpSync(src, dest, { recursive: true });
      } else {
        ensureDir(path.dirname(dest));
        fs.copyFileSync(src, dest);
      }
    }
    fs.rmSync(from, { recursive: true, force: true });
  } else {
    fs.renameSync(from, to);
  }
  console.log("moved", fromRel, "->", toRel);
}

function removeRel(rel) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) return;
  fs.rmSync(full, { recursive: true, force: true });
  console.log("removed", rel);
}

ensureDir(path.join(root, "assets"));

// Pull Elementor design assets out of uploads before the media move.
moveDir("wp-content/uploads/elementor", "assets/layout");
moveDir("wp-content/uploads", "media");
moveDir("wp-content/themes/tortuga", "assets/site");
moveDir("wp-content/plugins/simple-image-slider", "assets/slider");
moveDir("wp-content/plugins/dropdown-menu-widget", "assets/nav");
moveDir("wp-content/fonts", "assets/fonts");

// Drop unused WordPress trees.
for (const rel of [
  "wp-content",
  "wp-includes",
  "wp-admin",
  "wp-json",
  "xmlrpc.html",
  "xmlrpc.php",
]) {
  removeRel(rel);
}

console.log("done");
