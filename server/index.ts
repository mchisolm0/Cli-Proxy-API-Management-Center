import { lstatSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { files, snapshots } from "./archive";
import { openIndex, type SessionRow } from "./db";
import { codex, claude, opencode, t3, codexMetadata } from "./parsers";
import { string, type Parsed, type Session, type Link } from "./model";
import { dashboardProblem, managementKey } from './auth';

export const archiveRoot = () =>
  resolve(process.env.ARCHIVE_ROOT || "./fixtures/archive");
export const indexPath = () =>
  resolve(process.env.INDEX_PATH || "./data/index.sqlite");
type Cache = { parsed: Parsed; metadata: Record<string, unknown>[] };
const CACHE_PREFIX = 'r3:';

export function buildIndex(
  root: string,
  destination: string,
  loadKey = managementKey,
  clientKeys: string[] = []
) {
  root = realpathSync(root);
  const db = openIndex(destination);
  const stats = {
    snapshots: 0,
    skippedSnapshots: 0,
    parsedFiles: 0,
    skippedFiles: 0,
  };
  try {
    let key = '';
    try {
      key = loadKey();
    } catch {
      if (!db.query("SELECT 1 FROM dashboard_event WHERE code='redaction_key_unavailable'").get())
        dashboardProblem(db, 'auth', 'redaction_key_unavailable');
    }
    const secrets = [key, ...clientKeys];
    const previous = db
      .query<{ value: string }, [string]>(
        "SELECT value FROM setting WHERE key=?",
      )
      .get("archiveRoot");
    if (previous && previous.value !== root)
      throw new Error(
        "INDEX_PATH belongs to a different archive root; use a new index path",
      );
    db.query("INSERT OR IGNORE INTO setting VALUES('archiveRoot',?)").run(root);
    for (const snap of snapshots(root)) {
      const nativeFiles = files(join(root, snap.path)).filter((p) => {
        const rel = relative(join(root, snap.path), p);
        return /^(\.codex\/(sessions|archived_sessions)\/.*\.jsonl|\.claude\/projects\/.*\.jsonl|\.codex\/state_[^/]+\.sqlite|\.local\/share\/opencode\/opencode\.db|\.t3\/userdata\/state\.sqlite)$/.test(
          rel,
        );
      });
      const sources = nativeFiles.map((path) => {
        const st = lstatSync(path, { bigint: true });
        const file = relative(join(root, snap.path), path);
        return {
          path,
          file,
          // No dev/ino: CIFS mounts report unstable inode numbers for hard
          // links, which made every run reparse unchanged snapshots.
          signature: `${CACHE_PREFIX}${snap.host}/${file}:${st.size}:${st.mtimeNs}`,
        };
      });
      const signature = Bun.hash(
        sources.map((s) => s.signature).join("\n"),
      ).toString();
      const previous = db
        .query<{ manifest: string; signature: string }, [string]>(
          "SELECT manifest,signature FROM snapshot WHERE path=?",
        )
        .get(snap.path);
      if (
        previous?.manifest === snap.manifest &&
        previous.signature === signature
      ) {
        stats.skippedSnapshots++;
        stats.skippedFiles += sources.length;
        continue;
      }
      const cacheRows: [string, string][] = [];
      const sessions: Session[] = [],
        links: Parsed["links"] = [],
        metadata: Record<string, unknown>[] = [];
      for (const source of sources) {
        const cached = db
          .query<{ payload: string }, [string]>(
            "SELECT payload FROM file_cache WHERE signature=?",
          )
          .get(source.signature);
        let result: Cache;
        if (cached) {
          // Only this process writes cache payloads. Native JSON is validated in parsers.
          result = JSON.parse(cached.payload) as Cache;
          stats.skippedFiles++;
        } else {
          const { path, file } = source;
          const parsed = file.startsWith(".claude/")
            ? claude(path, file, secrets)
            : file.endsWith("opencode.db")
              ? opencode(path, file, secrets)
              : file.endsWith("state.sqlite")
                ? t3(path, file, secrets)
                : file.endsWith(".jsonl")
                  ? codex(path, file, secrets)
                  : { sessions: [], links: [] };
          result = {
            parsed,
            metadata: file.startsWith(".codex/state_")
              ? codexMetadata(path, secrets)
              : [],
          };
          cacheRows.push([source.signature, JSON.stringify(result)]);
          stats.parsedFiles++;
        }
        sessions.push(...result.parsed.sessions);
        links.push(...result.parsed.links);
        metadata.push(...result.metadata);
      }
      const titles = new Map(metadata.map((m) => [string(m.id), m]));
      for (const s of sessions) {
        if (s.client !== "codex") continue;
        const m = titles.get(s.nativeId);
        if (m) {
          s.title = string(m.title) || string(m.name) || s.title;
          s.model ||= string(m.model);
          s.branch ||= string(m.git_branch);
        }
      }
      db.transaction(() => {
        for (const row of cacheRows)
          db.query("INSERT OR REPLACE INTO file_cache VALUES(?,?)").run(...row);
        const known = new Set(
          db
            .query<{ client: string; nativeId: string }, [string]>(
              "SELECT client,nativeId FROM session WHERE host=?",
            )
            .all(snap.host)
            .map((s) => `${s.client}:${s.nativeId}`),
        );
        for (const s of sessions)
          if (s.client !== "t3") known.add(`${s.client}:${s.nativeId}`);
        for (const link of links) {
          db.query(
            `INSERT INTO native_overlay(host,client,nativeId,title,branch,threadId,snapshotTime) VALUES(?,?,?,?,?,?,?)
            ON CONFLICT(host,client,nativeId) DO UPDATE SET title=excluded.title,branch=excluded.branch,threadId=excluded.threadId,snapshotTime=excluded.snapshotTime
            WHERE excluded.snapshotTime>=native_overlay.snapshotTime`,
          ).run(
            snap.host,
            link.client,
            link.nativeId,
            link.title,
            link.branch,
            link.threadId,
            snap.time,
          );
        }
        const linked = new Set<string>();
        // Overlay freshness is independent of the native file's last-seen snapshot.
        for (const link of db
          .query<Link, [string]>(
            "SELECT client,nativeId,title,branch,threadId FROM native_overlay WHERE host=?",
          )
          .all(snap.host)) {
          if (!known.has(`${link.client}:${link.nativeId}`)) continue;
          linked.add(link.threadId);
          const target = sessions.find(
            (s) => s.client === link.client && s.nativeId === link.nativeId,
          );
          if (target) {
            target.title = link.title || target.title;
            target.branch = link.branch || target.branch;
            target.t3ThreadId = link.threadId;
          } else
            db.query(
              "UPDATE session SET title=CASE WHEN ?='' THEN title ELSE ? END,branch=CASE WHEN ?='' THEN branch ELSE ? END,t3ThreadId=? WHERE host=? AND client=? AND nativeId=?",
            ).run(
              link.title,
              link.title,
              link.branch,
              link.branch,
              link.threadId,
              snap.host,
              link.client,
              link.nativeId,
            );
          db.query(
            "DELETE FROM session WHERE host=? AND client='t3' AND nativeId=?",
          ).run(snap.host, link.threadId);
        }
        for (const s of sessions) {
          if (s.client === "t3" && linked.has(s.nativeId)) continue;
          const old = db
            .query<SessionRow, [string, string, string]>(
              "SELECT * FROM session WHERE host=? AND client=? AND nativeId=?",
            )
            .get(snap.host, s.client, s.nativeId);
          if (old && old.snapshotTime > snap.time) continue;
          const row = db
            .query<{ id: number }, Record<string, string | number>>(
              `
            INSERT INTO session(host,client,nativeId,title,cwd,repo,branch,model,provider,started,updated,tokens,parentId,kind,t3ThreadId,snapshot,snapshotTime,itemCount)
            VALUES($host,$client,$nativeId,$title,$cwd,$repo,$branch,$model,$provider,$started,$updated,$tokens,$parentId,$kind,$t3ThreadId,$snapshot,$snapshotTime,$itemCount)
            ON CONFLICT(host,client,nativeId) DO UPDATE SET title=excluded.title,cwd=excluded.cwd,repo=excluded.repo,branch=excluded.branch,model=excluded.model,provider=excluded.provider,started=excluded.started,updated=excluded.updated,tokens=excluded.tokens,parentId=excluded.parentId,kind=excluded.kind,t3ThreadId=excluded.t3ThreadId,snapshot=excluded.snapshot,snapshotTime=excluded.snapshotTime,itemCount=excluded.itemCount RETURNING id
          `,
            )
            .get({
              host: snap.host,
              client: s.client,
              nativeId: s.nativeId,
              title: s.title,
              cwd: s.cwd,
              repo: s.repo,
              branch: s.branch,
              model: s.model,
              provider: s.provider,
              started: s.started,
              updated: s.updated,
              tokens: s.tokens,
              parentId: s.parentId,
              kind: s.kind,
              t3ThreadId: s.t3ThreadId,
              snapshot: snap.path,
              snapshotTime: snap.time,
              itemCount: s.items.length,
            });
          if (!row) throw new Error("Session insert failed");
          db.query("DELETE FROM item WHERE sessionId=?").run(row.id);
          s.items.forEach((i, seq) =>
            db
              .query(
                "INSERT INTO item(sessionId,seq,time,role,tool,callId,body,bodyLength,pointer) VALUES(?,?,?,?,?,?,?,?,?)",
              )
              .run(
                row.id,
                seq,
                i.time,
                i.role,
                i.tool,
                i.callId,
                i.body,
                i.bodyLength,
                JSON.stringify({
                  ...i.pointer,
                  file: join(snap.path, i.pointer.file),
                }),
              ),
          );
        }
        db.query("INSERT OR REPLACE INTO snapshot VALUES(?,?,?)").run(
          snap.path,
          snap.manifest,
          signature,
        );
      }).immediate();
      stats.snapshots++;
    }
    // Run the migration cleanup only after the entire archive indexed successfully.
    const cachePrefix = db
      .query<{ value: string }, []>("SELECT value FROM setting WHERE key='cachePrefix'")
      .get()?.value;
    if (cachePrefix !== CACHE_PREFIX) {
      db.transaction(() => {
        db.query('DELETE FROM file_cache WHERE signature NOT LIKE ?').run(`${CACHE_PREFIX}%`);
        db.query("INSERT OR REPLACE INTO setting VALUES('cachePrefix',?)").run(CACHE_PREFIX);
      }).immediate();
    }
    return stats;
  } finally {
    db.close();
  }
}
if (import.meta.main) {
  // The parent owns management polling and its ban backoff. Children never authenticate.
  const input: unknown =
    process.env.CPA_INDEX_KEYS_STDIN === '1' ? JSON.parse(await Bun.stdin.text()) : [];
  if (!Array.isArray(input) || !input.every((key): key is string => typeof key === 'string'))
    throw new Error('Invalid indexer redaction keys');
  console.log(buildIndex(archiveRoot(), indexPath(), managementKey, input));
}
