import type { Database } from "bun:sqlite";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { files } from "./archive";
import { dashboardProblem } from "./auth";
import { sanitize } from "./telemetry/events";

export type FrictionEntry = {
  time: number;
  source: "friction" | "sandpaper";
  key: string;
  expected: string;
  actual: string;
};
export function frictionTables(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS friction_file(path TEXT PRIMARY KEY,signature TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS friction_event(id TEXT PRIMARY KEY,time INTEGER NOT NULL,source TEXT NOT NULL,issueKey TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS friction_time ON friction_event(time);
  `);
}
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/\bevent\s+[a-f0-9]{16,}\.?/g, "")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/g, "<id>")
    .replace(/\b[0-9a-f]{32,}\b/g, "<id>")
    .replace(/(?:~\/|\/(?:home|Users|tmp|var)\/)[^\s`"']+/g, "<path>")
    .replace(/\s+/g, " ")
    .trim();
}
export function parseFriction(markdown: string): FrictionEntry[] {
  const entries: FrictionEntry[] = [];
  const pattern =
    /^##\s+(\d{4}-\d\d-\d\dT[^\s]+)[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/gm;
  for (const match of markdown.replaceAll("\r\n", "\n").matchAll(pattern)) {
    const time = Date.parse(match[1]!);
    const section = (name: string) => {
      const raw =
        new RegExp(
          `^### ${name}\\s*\\n([\\s\\S]*?)(?=^### |$(?![\\s\\S]))`,
          "m",
        ).exec(match[2]!)?.[1] || "";
      return raw
        .replace(/^ {4}/gm, "")
        .split(/\n\s*Historical import\./)[0]!
        .trim();
    };
    const expected = String(sanitize(section("Expected"))),
      actual = String(sanitize(section("Actual")));
    if (!Number.isFinite(time) || !expected || !actual) continue;
    const source = /^Automatic observation:/i.test(actual)
      ? "sandpaper"
      : "friction";
    entries.push({
      time,
      source,
      key: Bun.hash(`${normalize(expected)}\n${normalize(actual)}`).toString(
        16,
      ),
      expected,
      actual,
    });
  }
  return entries;
}
export function ingestFriction(db: Database, paths: string) {
  for (const configured of paths.split(":").filter(Boolean)) {
    try {
      const path = resolve(configured),
        stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      const selected = stat.isDirectory()
        ? files(path).filter((p) => p.endsWith(".md"))
        : [path];
      for (const file of selected) {
        const content = readFileSync(file, "utf8"),
          signature = Bun.hash(content).toString();
        const previous = db
          .query<{ signature: string }, [string]>(
            "SELECT signature FROM friction_file WHERE path=?",
          )
          .get(file);
        if (previous?.signature === signature) continue;
        db.transaction(() => {
          const occurrences = new Map<string, number>();
          for (const entry of parseFriction(content)) {
            const fingerprint = JSON.stringify([
              entry.time,
              entry.source,
              entry.expected,
              entry.actual,
            ]);
            const ordinal = occurrences.get(fingerprint) || 0;
            occurrences.set(fingerprint, ordinal + 1);
            const id = Bun.hash(`${file}\n${fingerprint}\n${ordinal}`).toString(
              16,
            );
            db.query(
              "INSERT OR IGNORE INTO friction_event VALUES(?,?,?,?,?)",
            ).run(
              id,
              entry.time,
              entry.source,
              entry.key,
              JSON.stringify(entry),
            );
          }
          db.query("INSERT OR REPLACE INTO friction_file VALUES(?,?)").run(
            file,
            signature,
          );
        })();
      }
    } catch {
      dashboardProblem(db, "other", "friction_read_failed");
    }
  }
}
