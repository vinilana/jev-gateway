import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Identify runtime artifacts independently of the package version or installation path. */
export function readBuildId(directory = fileURLToPath(new URL(".", import.meta.url))): string {
  const files = readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(?:js|ts|json|html)$/.test(entry.name))
    .map(entry => relative(directory, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();
  const hash = createHash("sha256");
  for (const file of files) {
    const contents = readFileSync(join(directory, file));
    // Include names and byte lengths so file boundaries cannot produce the same hash input.
    hash.update(`${file}\0${contents.length}\0`);
    hash.update(contents);
  }
  return `sha256:${hash.digest("hex")}`;
}
