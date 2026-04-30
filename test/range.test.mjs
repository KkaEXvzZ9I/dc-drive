import test from "node:test";
import assert from "node:assert/strict";
import { parseRange, sanitizeChannelName, sanitizeFileName } from "../src/util.mjs";

test("parseRange handles explicit ranges", () => {
  assert.deepEqual(parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=100-", 1000), { start: 100, end: 999 });
});

test("parseRange handles suffix ranges", () => {
  assert.deepEqual(parseRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange("bytes=-2000", 1000), { start: 0, end: 999 });
});

test("parseRange rejects invalid ranges", () => {
  assert.equal(parseRange(null, 1000), null);
  assert.deepEqual(parseRange("items=0-1", 1000), { unsatisfiable: true });
  assert.deepEqual(parseRange("bytes=100-10", 1000), { unsatisfiable: true });
  assert.deepEqual(parseRange("bytes=1000-1001", 1000), { unsatisfiable: true });
});

test("sanitizers keep names Discord-safe", () => {
  assert.equal(sanitizeFileName("../bad:name?.txt"), ".._bad_name_.txt");
  assert.equal(sanitizeChannelName("User Name", "1234567890"), "drive-user-name-567890");
});
