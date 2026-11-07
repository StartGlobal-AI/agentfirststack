import { describe, expect, it } from "vitest";
import * as engine from "../../src/do/engine";
import * as payments from "../../src/do/payments";
import { NOW, pay, settings } from "./fixtures";
import { memoryDb } from "./sqlite";

describe("test payments are test data", () => {
  it("a livemode: false payment is stored with debug = 1, and the migration marks ones stored before", () => {
    const db = memoryDb();
    engine.configure(db, settings());
    payments.ingestPayments(db, [pay({ external_id: "test1", amount: 204, livemode: false, ts: NOW - 1000 })], NOW);
    payments.ingestPayments(db, [pay({ external_id: "live1", amount: 49, ts: NOW - 500 })], NOW);
    const debugOf = (ext: string) =>
      db.all("SELECT e.debug FROM payments p JOIN events e ON e.id = p.event_rowid WHERE p.external_id = ?", [ext])[0]?.debug;
    expect(debugOf("test1")).toBe(1);
    expect(debugOf("live1")).toBe(0);
    // as an older release stored it: an ordinary event
    db.run("UPDATE events SET debug = 0 WHERE id = (SELECT event_rowid FROM payments WHERE external_id = 'test1')");
    db.run("UPDATE meta SET value = '14' WHERE key = 'schema_version'");
    engine.migrate(db);
    expect(debugOf("test1")).toBe(1);
    expect(debugOf("live1")).toBe(0);
    expect(engine.schemaVersion(db)).toBe(engine.SCHEMA_VERSION);
  });
});
