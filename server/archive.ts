import { Database, constants } from "bun:sqlite";
import { readdirSync, realpathSync, readFileSync, lstatSync } from "node:fs";
import { resolve, join, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { json, string, array, object, timestamp } from "./model";

export function inside(root: string, path: string): string {
  const base = realpathSync(root);
  const target = realpathSync(resolve(base, path));
  const rel = relative(base, target);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel))
    throw new Error("Archive pointer escapes root");
  return target;
}
export function immutable(path: string): Database {
  return new Database(
    `${pathToFileURL(path).href}?immutable=1&mode=ro`,
    constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
  );
}
export function files(root: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...files(path));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}
export function snapshots(root: string) {
  const result: {
    host: string;
    path: string;
    time: number;
    manifest: string;
  }[] = [];
  for (const host of readdirSync(root, { withFileTypes: true })) {
    if (!host.isDirectory()) continue;
    for (const snap of readdirSync(join(root, host.name), {
      withFileTypes: true,
    })) {
      if (!snap.isDirectory()) continue;
      const path = join(host.name, snap.name);
      const manifestPath = join(root, path, "manifest.json");
      try {
        if (!lstatSync(manifestPath).isFile()) continue;
      } catch {
        continue;
      }
      const raw = readFileSync(manifestPath, "utf8");
      const manifest = json(raw);
      if (
        !string(manifest.completed_at) ||
        !Array.isArray(manifest.sources) ||
        !timestamp(manifest.completed_at)
      )
        throw new Error(`Invalid manifest: ${path}`);
      for (const source of array(manifest.sources)) {
        const s = object(source);
        if (
          !string(s.path) ||
          !["missing", "collected"].includes(string(s.status))
        )
          throw new Error(`Invalid manifest source: ${path}`);
      }
      result.push({
        host: host.name,
        path,
        time: timestamp(manifest.completed_at),
        manifest: Bun.hash(raw).toString(),
      });
    }
  }
  return result.sort((a, b) => a.time - b.time || a.path.localeCompare(b.path));
}
// Byte offsets remain correct for Unicode and CRLF, including a final line without a newline.
export function* lines(path: string) {
  // ponytail: one rollout in memory; stream lines if archives contain very large files.
  const buffer = readFileSync(path);
  for (let offset = 0; offset < buffer.length;) {
    const newline = buffer.indexOf(10, offset);
    const end = newline < 0 ? buffer.length : newline;
    const raw = buffer.toString("utf8", offset, end);
    if (raw.trim()) {
      try {
        yield { value: json(raw), offset, length: end - offset };
      } catch (error) {
        throw new Error(`Invalid JSONL at ${path}:${offset}`, { cause: error });
      }
    }
    offset = end + 1;
  }
}
