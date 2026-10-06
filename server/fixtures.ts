import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { array, json, object, number, string, timestamp } from "./model";
import { appendEvent } from "./telemetry/events";
import { parseAuthFiles, storeAuthFiles } from "./auth";
import { ingestFriction } from "./friction";

// Only the marked synthetic archive opts into fixture event ingestion.
export function seedFixtures(db: Database, root: string) {
  const path = join(root, ".dashboard-fixtures.json");
  if (!existsSync(join(root, ".synthetic-fixtures")) || !existsSync(path))
    return;
  const raw = readFileSync(path, "utf8"),
    signature = Bun.hash(raw).toString();
  if (
    db
      .query<{ value: string }, []>(
        "SELECT value FROM setting WHERE key='dashboardFixtures'",
      )
      .get()?.value === signature
  )
    return;
  const fixture = json(raw);
  db.transaction(() => {
    for (const value of array(fixture.usage))
      appendEvent(
        db,
        "usage",
        JSON.stringify(value),
        timestamp(object(value).timestamp) + number(object(value).latency_ms),
      );
    for (const value of array(fixture.errors))
      appendEvent(db, "errors", JSON.stringify(value));
    for (const value of array(fixture.authResponses))
      storeAuthFiles(
        db,
        parseAuthFiles(value),
        timestamp(object(value).observed_at) || Date.now(),
      );
    ingestFriction(db, join(root, string(fixture.friction)));
    db.query(
      "INSERT OR REPLACE INTO setting VALUES('dashboardFixtures',?)",
    ).run(signature);
  }).immediate();
}
