import Database from "better-sqlite3";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const directories = [];
const entry = resolve("src/bin/local-prestart.mjs");
const indexName = "local_bb_turn_request_thread_request_sequence_idx";

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "bb-prestart-"));
  directories.push(directory);
  const file = join(directory, "test.sqlite");
  const fixtureScript = `import { createMigratedConnection } from './packages/db/src/testing.ts'; import { writeFileSync } from 'node:fs'; const db=createMigratedConnection(); writeFileSync(process.argv[1],db.$client.serialize()); db.$client.close();`;
  const generated = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", fixtureScript, file],
    { cwd: resolve("../.."), encoding: "utf8" },
  );
  if (generated.status !== 0) throw new Error(generated.stderr);
  return file;
}

it("creates the index outside the journal and reports an existing index on repeat", () => {
  const file = fixture();
  const db = new Database(file);
  const journal = db.prepare("SELECT * FROM __drizzle_migrations").all();
  for (const outcome of ["created", "present"]) {
    if (outcome === "present") db.exec("BEGIN IMMEDIATE");
    const run = spawnSync(process.execPath, [entry, file], {
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ outcome, code: "OK" });
    expect(run.stdout.trim().split("\n")).toHaveLength(1);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name=?").get(indexName),
    ).toBeDefined();
    expect(db.prepare("SELECT * FROM __drizzle_migrations").all()).toEqual(
      journal,
    );
    if (outcome === "present") db.exec("ROLLBACK");
  }
  db.close();
});

it("reports lock contention without creating an index", () => {
  const file = fixture();
  const db = new Database(file);
  db.exec("BEGIN IMMEDIATE");
  try {
    const run = spawnSync(process.execPath, [entry, file, "0"], {
      encoding: "utf8",
      timeout: 1_500,
    });
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(1);
    expect(JSON.parse(run.stdout)).toMatchObject({
      outcome: "failed",
      code: "SQLITE_BUSY",
    });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name=?").get(indexName),
    ).toBeUndefined();
  } finally {
    db.exec("ROLLBACK");
    db.close();
  }
});

it.each([
  { path: "missing", args: [] },
  { path: "relative", args: ["relative.sqlite"] },
])("reports INVALID_PATH for a $path database path", ({ args }) => {
  const run = spawnSync(process.execPath, [entry, ...args], {
    encoding: "utf8",
  });
  expect(run.status).toBe(1);
  expect(JSON.parse(run.stdout)).toMatchObject({
    outcome: "failed",
    code: "INVALID_PATH",
  });
});

it.each(["SIGTERM", "SIGKILL"])(
  "recovers a real database after %s interrupts index creation",
  async (signal) => {
    const file = fixture();
    const db = new Database(file);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = OFF");
    const insert = db.prepare(
      "INSERT INTO events(id,thread_id,scope_kind,sequence,type,data,created_at) VALUES(?, 'synthetic', 'thread', ?, 'client/turn/requested', ?, 0)",
    );
    db.transaction(() => {
      for (let i = 0; i < 100_000; i++)
        insert.run(
          String(i),
          i,
          JSON.stringify({
            requestId: `creq_${i}_${"x".repeat(2048)}`,
            text: "synthetic",
          }),
        );
    })();
    db.pragma("wal_checkpoint(TRUNCATE)");
    const child = spawn(process.execPath, [entry, file], { stdio: "ignore" });
    let killed = false;
    const exited = new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", () => resolveExit());
    });
    const deadline = Date.now() + 10_000;
    while (
      child.exitCode === null &&
      child.signalCode === null &&
      Date.now() < deadline
    ) {
      let size = 0;
      try {
        size = statSync(file + "-wal").size;
      } catch {}
      if (size > 32) {
        killed = child.kill(signal);
        break;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 2));
    }
    if (!killed) child.kill("SIGKILL");
    await exited;
    expect(killed).toBe(true);
    expect(child.signalCode).toBe(signal);
    db.close();
    const recovered = new Database(file);
    expect(recovered.prepare("PRAGMA integrity_check").pluck().get()).toBe(
      "ok",
    );
    expect(recovered.prepare("SELECT count(*) FROM events").pluck().get()).toBe(
      100_000,
    );
    expect(
      recovered
        .prepare("SELECT name FROM sqlite_master WHERE name=?")
        .get(indexName),
    ).toBeUndefined();
    recovered.close();
  },
  30_000,
);
