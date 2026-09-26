const { test } = require("node:test");
const assert = require("node:assert/strict");

const { normalizeServiceIds } = require("../src/utils/serviceIds");

/*
 * Service ids arrive from the client and are written into a join table, so
 * anything that is not a list of positive integers must be refused outright
 * rather than partly accepted.
 */

test("accepts positive integers, including numeric strings", () => {
  assert.deepEqual(normalizeServiceIds([1, "2", 3]), [1, 2, 3]);
});

test("removes duplicates", () => {
  assert.deepEqual(normalizeServiceIds([4, 4, "4", 5]), [4, 5]);
});

test("accepts an empty list, which clears the services", () => {
  assert.deepEqual(normalizeServiceIds([]), []);
});

test("refuses the whole list if any entry is invalid", () => {
  for (const bad of [[1, 0], [1, -2], [1, 2.5], [1, "abc"], [1, null]]) {
    assert.equal(normalizeServiceIds(bad), null, JSON.stringify(bad));
  }
});

test("refuses anything that is not a list", () => {
  for (const bad of [undefined, null, "1,2", 3, { 0: 1 }]) {
    assert.equal(normalizeServiceIds(bad), null, String(bad));
  }
});
