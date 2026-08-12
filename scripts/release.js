// release.js — Version um eins erhöhen, packen, in releases/ ablegen.
//
// Jede an dich ausgelieferte Datei bekommt eine eigene Nummer, damit klar ist,
// welcher Stand gerade in Thunderbird steckt: 1.0.11, 1.0.12, …
// Aufruf: npm run release   (oder `node scripts/release.js 1.0.20`, um eine
// bestimmte Nummer zu setzen).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = resolve(root, "package.json");
const manifestPath = resolve(root, "manifest.json");

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

/** „1.0.11“ → „1.0.12“ */
function bump(version) {
  const parts = String(version).split(".").map((n) => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  parts[2] += 1;
  return parts.slice(0, 3).join(".");
}

const wanted = process.argv[2];
if (wanted && !/^\d+\.\d+\.\d+$/.test(wanted)) {
  console.error(`„${wanted}“ ist keine Versionsnummer der Form 1.0.11.`);
  process.exit(1);
}
const version = wanted || bump(pkg.version);

// Beide Dateien müssen dieselbe Nummer tragen — Thunderbird liest die aus dem
// Manifest, der Dateiname kommt aus package.json.
pkg.version = version;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
const manifest = readFileSync(manifestPath, "utf8");
writeFileSync(
  manifestPath,
  manifest.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`)
);

execFileSync(process.execPath, [resolve(root, "scripts/build.js")], {
  cwd: root,
  stdio: "inherit",
});

const name = `supadupa-mailcheck-${version}.xpi`;
mkdirSync(resolve(root, "releases"), { recursive: true });
copyFileSync(resolve(root, "dist", name), resolve(root, "releases", name));

// Die Download-Zeile im README zeigt immer auf den neuesten Stand.
const readmePath = resolve(root, "README.md");
const readme = readFileSync(readmePath, "utf8");
writeFileSync(
  readmePath,
  readme.replace(/releases\/supadupa-mailcheck-\d+\.\d+\.\d+\.xpi/g, `releases/${name}`)
);

console.log(`\nVersion ${version} liegt in releases/${name}.`);
