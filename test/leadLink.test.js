const { test, before, after, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");

/*
 * The customer's side of the lead ↔ customer link (migration 017): a retried
 * conversion finds the customer it already made, and linking by hand is
 * idempotent, refuses a lead that became someone else, and stays in the
 * caller's organization. The database is an in-memory stand-in.
 */

process.env.JWT_SECRET = "unit-test-secret";
process.env.JWT_ISSUER = "unit-test-issuer";

let customers;
let nextId;

function query(text, params = []) {
  const sql = text.replace(/\s+/g, " ").trim();
  if (/access_grants/.test(sql) || /^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };

  if (/^SELECT \* FROM customers WHERE organization_id = \$1 AND source_lead_id = \$2/.test(sql)) {
    return { rows: customers.filter((row) => row.organization_id === params[0] && row.source_lead_id === params[1]) };
  }

  if (/^SELECT id, name FROM customers WHERE organization_id = \$1 AND source_lead_id = \$2/.test(sql)) {
    return { rows: customers.filter((row) => row.organization_id === params[0] && row.source_lead_id === params[1]) };
  }

  if (/^SELECT id, name, source_lead_id FROM customers WHERE id = \$1 AND organization_id = \$2/.test(sql)) {
    return { rows: customers.filter((row) => row.id === params[0] && row.organization_id === params[1] && (params[2] === undefined || row.owner_user_id === params[2])) };
  }

  if (/^SELECT .* FROM customers WHERE organization_id = \$1 AND LOWER\(email\)/.test(sql)) {
    return { rows: customers.filter((row) => row.organization_id === params[0] && row.email?.toLowerCase() === params[1].toLowerCase()) };
  }

  if (/^INSERT INTO customers/.test(sql)) {
    const row = { id: nextId++, organization_id: params[0], owner_user_id: params[1], name: params[2], email: params[4], notes: params[7], source_lead_id: params[8] };
    customers.push(row);
    return { rows: [row] };
  }

  if (/SET source_lead_id = COALESCE\(source_lead_id, \$3\)/.test(sql)) {
    const row = customers.find((item) => item.id === params[0] && item.organization_id === params[1]);
    row.source_lead_id = row.source_lead_id ?? params[2];
    if (!row.notes) row.notes = params[3];
    return { rows: [row] };
  }

  if (/^UPDATE customers SET source_lead_id = \$3/.test(sql)) {
    const row = customers.find((item) => item.id === params[0] && item.organization_id === params[1] && item.source_lead_id == null);
    if (row) row.source_lead_id = params[2];
    return { rows: row ? [row] : [] };
  }

  throw new Error(`Unexpected SQL: ${sql}`);
}

const pool = require("../src/config/database");

pool.query = async (text, params) => query(text, params);
pool.connect = async () => ({ query: async (text, params) => query(text, params), release() {} });

const { createCustomerFromLead } = require("../src/services/customerService");
const app = require("../src/app");

beforeEach(() => {
  nextId = 10;
  customers = [{ id: 1, organization_id: 3, owner_user_id: 7, name: "Existing Ltd", email: "owner@existing.example", notes: null, source_lead_id: null }];
});

test("converting a lead records it on the new customer, with its notes", async () => {
  const customer = await createCustomerFromLead({ organizationId: 3, ownerUserId: 7, name: "Rao & Co", leadId: 40, notes: "Met at the GST seminar" });

  assert.equal(customer.source_lead_id, 40);
  assert.equal(customer.notes, "Met at the GST seminar");
});

test("a retried conversion finds the customer it already made", async () => {
  const first = await createCustomerFromLead({ organizationId: 3, ownerUserId: 7, name: "Rao & Co", leadId: 40 });
  const again = await createCustomerFromLead({ organizationId: 3, ownerUserId: 7, name: "Rao & Co", leadId: 40 });

  assert.equal(again.id, first.id);
  assert.equal(customers.length, 2);
});

test("converting into an existing customer by email links it, keeping its own notes", async () => {
  customers[0].notes = "Long-standing client";

  const customer = await createCustomerFromLead({ organizationId: 3, ownerUserId: 7, name: "Existing", email: "OWNER@existing.example", leadId: 41, notes: "New enquiry" });

  assert.equal(customer.id, 1);
  assert.equal(customer.source_lead_id, 41);
  assert.equal(customer.notes, "Long-standing client");
});

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

const link = (customerId, body, permissions = ["customers.update"], organizationId = 3) =>
  fetch(`${base}/customers/${customerId}/source-lead`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt.sign({ sub: 7, organizationId, role: "X", permissions }, process.env.JWT_SECRET, { issuer: process.env.JWT_ISSUER })}`,
    },
    body: JSON.stringify(body),
  });

test("linking by hand needs customers.update and a lead id", async () => {
  assert.equal((await link(1, { leadId: 5 }, ["customers.read"])).status, 403);
  assert.equal((await link(1, { leadId: "5" })).status, 400);
});

test("linking by hand is idempotent and keeps a customer's first lead", async () => {
  const first = await link(1, { leadId: 5 });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).source_lead_id, 5);

  const second = await link(1, { leadId: 6 });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).source_lead_id, 5);
});

test("a lead that already became another customer is refused", async () => {
  customers.push({ id: 2, organization_id: 3, name: "Other Ltd", source_lead_id: 9 });

  const response = await link(1, { leadId: 9 });

  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /Other Ltd/);
});

test("a customer of another organization is not found", async () => {
  assert.equal((await link(1, { leadId: 5 }, ["customers.update"], 4)).status, 404);
});
