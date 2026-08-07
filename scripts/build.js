// build.js — packt die Erweiterung als .xpi (= ZIP). Ohne Abhängigkeiten:
// benutzt das System-`zip`. Ergebnis: dist/supadupa-mailcheck-<version>.xpi

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const outDir = resolve(root, "dist");
const out = resolve(outDir, `supadupa-mailcheck-${version}.xpi`);

mkdirSync(outDir, { recursive: true });
rmSync(out, { force: true });

const include = ["manifest.json", "background.js", "lib", "ui", "icons"];
try {
  execFileSync("zip", ["-r", "-9", "-X", out, ...include], { cwd: root, stdio: "inherit" });
} catch (e) {
  console.error("`zip` nicht verfügbar — alternativ den Ordner selbst als ZIP packen.");
  process.exit(1);
}
console.log(`\nFertig: ${out}`);
