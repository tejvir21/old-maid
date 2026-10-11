// Fails the build if the PWA output can't launch offline. Run after `vite build`.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, not URL.pathname: on Windows a path containing a space would arrive
// percent-encoded and every existence check below would fail against the real dist folder.
const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const problems = [];
const need = (cond, msg) => { if (!cond) problems.push(msg); };
const pngSize = (f) => { const b = readFileSync(f); return b.readUInt32BE(16) + "x" + b.readUInt32BE(20); };

need(existsSync(join(dist, "sw.js")), "sw.js missing");
need(existsSync(join(dist, "manifest.webmanifest")), "manifest.webmanifest missing");
need(existsSync(join(dist, "index.html")), "index.html missing");
if (problems.length) { console.error("PWA verification FAILED:\n - " + problems.join("\n - ")); process.exit(1); }

const manifest = JSON.parse(readFileSync(join(dist, "manifest.webmanifest"), "utf8"));
need(manifest.name === "Old Maid", "manifest.name");
need(manifest.display === "standalone", "manifest.display must be standalone");
need(manifest.start_url === "/", "manifest.start_url");
need(!!manifest.theme_color && !!manifest.background_color, "manifest colors");
const icons = manifest.icons ?? [];
for (const [size, purpose] of [["192x192", "any"], ["512x512", "any"], ["512x512", "maskable"]]) {
  const i = icons.find((x) => x.sizes === size && x.purpose === purpose);
  need(!!i, `manifest icon ${size} ${purpose} missing`);
  if (i) {
    const f = join(dist, i.src);
    need(existsSync(f), `icon file ${i.src} missing`);
    if (existsSync(f)) need(pngSize(f) === size, `icon ${i.src} is ${pngSize(f)}, expected ${size}`);
  }
}

const html = readFileSync(join(dist, "index.html"), "utf8");
need(/rel="manifest"/.test(html), "index.html must link the manifest");
need(/name="theme-color"/.test(html), "index.html theme-color");

const sw = readFileSync(join(dist, "sw.js"), "utf8");
const m = sw.match(/precacheAndRoute\(\s*(\[[\s\S]*?\])\s*,/);
need(!!m, "precache manifest not found in sw.js");
const entries = m ? [...m[1].matchAll(/url:\s*"([^"]+)"/g)].map((x) => x[1]) : [];
const has = (re) => entries.some((e) => re.test(e));
need(has(/^index\.html$/), "index.html not precached");
need(has(/\.js$/), "no JS precached");
need(has(/\.css$/), "no CSS precached");
need(has(/\.woff2$/), "no web fonts precached (they would be missing offline)");
need(has(/icon-192\.png$/), "icons not precached");
need(/NavigationRoute/.test(sw) && /index\.html/.test(sw), "navigation fallback to index.html missing");
need(/denylist/.test(sw) && /\\\/api\\\//.test(sw), "API requests must be excluded from the navigation fallback");
need(!/registerRoute\([^)]*api/.test(sw), "API routes must not be cached by the service worker");

// Every asset the HTML references must be precached, otherwise the shell breaks offline.
for (const ref of [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g)].map((x) => x[1])) {
  need(entries.includes(ref), `HTML references /${ref} but it is not precached`);
}
const total = entries.length;
const bytes = (() => { let n = 0; const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : (n += statSync(p).size); } }; walk(dist); return n; })();

if (problems.length) { console.error("PWA verification FAILED:\n - " + problems.join("\n - ")); process.exit(1); }
console.log(`PWA verification OK: ${total} precached files, manifest valid, icons valid, fallback + API exclusion present (${(bytes / 1024).toFixed(0)} KiB dist)`);
