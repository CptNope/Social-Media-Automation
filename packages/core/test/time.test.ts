import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addDays, isCalendarDate, localDate, zonedToUtc } from "../src/index.ts";

describe("time zones", () => {
  it("converts New York wall-clock time to UTC across DST", () => {
    assert.equal(zonedToUtc("2026-07-01", "09:30", "America/New_York").toISOString(), "2026-07-01T13:30:00.000Z"); // EDT
    assert.equal(zonedToUtc("2026-12-01", "09:30", "America/New_York").toISOString(), "2026-12-01T14:30:00.000Z"); // EST
    assert.equal(zonedToUtc("2026-11-01", "12:00", "America/New_York").toISOString(), "2026-11-01T17:00:00.000Z"); // day DST ends
  });
  it("round-trips local dates", () => {
    assert.equal(localDate(zonedToUtc("2026-11-02", "23:30", "America/New_York"), "America/New_York"), "2026-11-02");
    assert.equal(addDays("2026-12-30", 3), "2027-01-02");
    assert.equal(isCalendarDate("2026-02-29"), false);
    assert.throws(() => zonedToUtc("2026-11-02", "24:00", "America/New_York"));
  });
});
