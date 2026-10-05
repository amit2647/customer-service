const { describe, test, before, after, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");

/*
 * A client's profession profile. The bundle is the CA shape in miniature;
 * the database is an in-memory stand-in; bundle-service is a fake answering
 * GET /bundles/installed.
 */

process.env.JWT_SECRET = "unit-test-secret";
process.env.JWT_ISSUER = "unit-test-issuer";
process.env.BUNDLE_SERVICE_URL = "http://bundle-service.test";

const BUNDLE = {
  key: "ca-practice",
  profiles: {
    client: {
      version: 2,
      schema: {
        type: "object",
        properties: {
          constitution: { type: "string", title: "Constitution", enum: ["proprietorship", "pvt_ltd", "trust"] },
          trust_reg_no: { type: "string", title: "Trust registration number" },
        },
        required: ["constitution"],
        allOf: [{ if: { required: ["constitution"], properties: { constitution: { const: "trust" } } }, then: { required: ["trust_reg_no"] } }],
      },
    },
    person: { version: 1, schema: { type: "object", properties: { din: { type: "string", pattern: "^[0-9]{8}$" } } } },
  },
  identifiers: [
    { type: "pan", label: "PAN", pattern: "^[A-Z]{5}[0-9]{4}[A-Z]$", unique: true },
    { type: "cin", label: "CIN", unique: true, shownWhen: { in: [{ var: "client.attributes.constitution" }, ["pvt_ltd"]] }, requiredWhen: { in: [{ var: "client.attributes.constitution" }, ["pvt_ltd"]] } },
  ],
  peopleRoles: [{ key: "director", label: "Director" }],
};

let installed;
let statements;
let customerRow;
let identifierTaken;

const realFetch = global.fetch;

global.fetch = async (url, options) => {
  if (String(url).startsWith("http://bundle-service.test")) {
    return new Response(JSON.stringify({ bundle: installed }), { status: 200 });
  }

  return realFetch(url, options);
};

function query(text, params = []) {
  const sql = text.replace(/\s+/g, " ").trim();
  statements.push({ sql, params });

  if (/access_grants/.test(sql)) return { rows: [] };
  if (/^SELECT id, name, locked_at, archived_at FROM customers/.test(sql)) return { rows: customerRow ? [customerRow] : [] };
  if (/^INSERT INTO customer_identifiers/.test(sql) && identifierTaken === params[2]) {
    const error = new Error("duplicate key");
    error.code = "23505";
    throw error;
  }
  if (/FROM customer_identifiers i JOIN customers c/.test(sql)) return { rows: [{ id: 9, name: "Acme Pvt Ltd", archived_at: "2026-09-01" }] };
  if (/^INSERT INTO customer_bank_accounts/.test(sql)) return { rows: [{ id: statements.length }] };
  return { rows: [], rowCount: 1 };
}

const pool = require("../src/config/database");

pool.query = async (text, params) => query(text, params);
pool.connect = async () => ({ query: async (text, params) => query(text, params), release() {} });

const profileService = require("../src/services/profileService");
const { forget } = require("../src/services/bundleContext");

beforeEach(() => {
  installed = BUNDLE;
  statements = [];
  customerRow = { id: 5, name: "Client", locked_at: null, archived_at: null };
  identifierTaken = null;
  forget(3);
});

after(() => {
  global.fetch = realFetch;
});

describe("validateProfile", () => {
  test("a company without its CIN is refused, with the reason per field (WIZ-03)", () => {
    assert.throws(
      () => profileService.validateProfile(BUNDLE, { attributes: { constitution: "pvt_ltd" }, identifiers: { pan: "aaaca1234a" } }, { creating: true }),
      (error) => error.statusCode === 400 && error.details["identifiers.cin"] === "CIN is required",
    );
  });

  test("bundle fields are checked against the schema", () => {
    assert.throws(
      () => profileService.validateProfile(BUNDLE, { attributes: { constitution: "trust" } }, { creating: true }),
      (error) => error.details.trust_reg_no === "Trust registration number is required",
    );
  });

  test("people need a role of the bundle; nameless rows are dropped (WIZ-04)", () => {
    const ok = profileService.validateProfile(
      BUNDLE,
      { attributes: { constitution: "proprietorship" }, people: [{ role: "director", name: "A. Rao", attributes: { din: "01234567" } }, { role: "director", name: " " }] },
      { creating: true },
    );

    assert.equal(ok.people.length, 1);

    assert.throws(
      () => profileService.validateProfile(BUNDLE, { attributes: { constitution: "proprietorship" }, people: [{ role: "chairman", name: "X" }] }, { creating: true }),
      (error) => /not a role/.test(error.details["people[0].role"]),
    );
  });

  test("an existing client's bank accounts cannot be resent — the screen only ever had masked numbers", () => {
    assert.throws(
      () => profileService.validateProfile(BUNDLE, { attributes: { constitution: "proprietorship" }, bankAccounts: [] }, { creating: false }),
      (error) => /edited one by one/.test(error.details.bankAccounts),
    );
  });
});

describe("writing and reading", () => {
  test("a duplicate PAN names the client holding it, archived included (WIZ-11)", async () => {
    const profile = profileService.validateProfile(BUNDLE, { attributes: { constitution: "proprietorship" }, identifiers: { pan: "AAACA1234A" } }, { creating: true });

    identifierTaken = "pan";

    await assert.rejects(
      profileService.writeProfile({ query: async (t, p) => query(t, p) }, 3, 5, profile),
      (error) => error.statusCode === 409 && error.message === "PAN AAACA1234A already belongs to the archived client Acme Pvt Ltd",
    );
  });

  test("the first bank account of a new client becomes primary (WIZ-10)", async () => {
    const profile = profileService.validateProfile(
      BUNDLE,
      { attributes: { constitution: "proprietorship" }, bankAccounts: [{ bankName: "SBI", accountNumber: "1234 5678 9012" }, { bankName: "HDFC", accountNumber: "99887766" }] },
      { creating: true },
    );

    await profileService.writeProfile({ query: async (t, p) => query(t, p) }, 3, 5, profile);

    const inserts = statements.filter((s) => /^INSERT INTO customer_bank_accounts/.test(s.sql));

    assert.deepEqual(inserts.map((s) => [s.params[4], s.params[8]]), [["123456789012", true], ["99887766", false]]);
  });

  test("account numbers leave the service masked", () => {
    assert.equal(profileService.mask("123456789012"), "•••• 9012");
    assert.equal(profileService.mask("12"), "••••");
  });
});

describe("protection", () => {
  test("an archived client is read-only", async () => {
    customerRow.archived_at = "2026-10-01";

    await assert.rejects(profileService.assertWritable(3, 5, ["profiles.update"]), (error) => error.statusCode === 409);
  });

  test("a locked client needs profiles.lock (CD-03)", async () => {
    customerRow.locked_at = "2026-10-01";

    await assert.rejects(profileService.assertWritable(3, 5, ["profiles.update"]), (error) => error.statusCode === 423);
    await profileService.assertWritable(3, 5, ["profiles.update", "profiles.lock"]);
  });

  test("only an archived client can be purged", async () => {
    await assert.rejects(profileService.purge({ organizationId: 3, userId: 1, permissions: [] }, 5), (error) => error.statusCode === 409);

    customerRow.archived_at = "2026-10-01";
    await profileService.purge({ organizationId: 3, userId: 1, permissions: [] }, 5);

    assert.ok(statements.some((s) => /^DELETE FROM customers/.test(s.sql)));
    assert.ok(statements.some((s) => /^INSERT INTO audit_events/.test(s.sql) && s.params[2] === "customer.purged" && s.params[3] === "5" && s.params[4] === 5));
  });
});

describe("routes", () => {
  const app = require("../src/app");
  let server;
  let base;

  before(async () => {
    mock.method(console, "log", () => {});
    mock.method(console, "error", () => {});
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server.close());

  const call = (method, path, permissions) =>
    realFetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${jwt.sign({ sub: 1, organizationId: 3, role: "X", permissions }, process.env.JWT_SECRET, { issuer: process.env.JWT_ISSUER })}` },
    });

  test("answer 'not enabled' for an organization without a bundle", async () => {
    installed = null;

    const response = await call("POST", "/customers/5/lock", ["profiles.lock"]);

    assert.equal(response.status, 404);
    assert.match((await response.json()).error, /no profession bundle/);
  });

  test("keep their permissions", async () => {
    assert.equal((await call("POST", "/customers/5/lock", ["customers.update"])).status, 403);
    assert.equal((await call("DELETE", "/customers/5/purge", ["customers.delete"])).status, 403);
    assert.equal((await call("GET", "/customers/5/bank-accounts", ["customers.read"])).status, 403);
  });

  test("lock a client with a bundle installed", async () => {
    const response = await call("POST", "/customers/5/lock", ["profiles.lock"]);

    assert.equal(response.status, 200);
    assert.ok(statements.some((s) => /^UPDATE customers SET locked_at/.test(s.sql)));
  });
});
