const { profiles, identifiers: identifierRules } = require("bundle-sdk");

const pool = require("../config/database");

/*
 * A client's profession profile, for organizations with a bundle installed:
 * bundle fields (attributes), identifiers (PAN, CIN…), people (directors,
 * partners, signatories) and bank accounts — plus lock, archive and purge.
 *
 * What a field means comes from the bundle (bundle-sdk validates it); this
 * module only stores what passed. Every query is scoped by organization.
 */

function httpError(statusCode, message, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (details) error.details = details;
  return error;
}

const blank = (value) => value === undefined || value === null || String(value).trim() === "";
const text = (value) => (blank(value) ? null : String(value).trim());

// Account numbers leave this service masked, always.
function mask(accountNumber) {
  const digits = String(accountNumber || "");
  return digits.length <= 4 ? "••••" : `•••• ${digits.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Validation — runs before any transaction opens
// ---------------------------------------------------------------------------

function validatePeople(bundle, people) {
  if (people === undefined) {
    return { people: undefined, errors: {} };
  }

  if (!Array.isArray(people)) {
    return { people: [], errors: { people: "people must be a list" } };
  }

  const roles = new Set((bundle.peopleRoles || []).map((role) => role.key));
  const schema = bundle.profiles?.person?.schema;
  const errors = {};
  const cleaned = [];

  // Rows without a name are dropped, as the wizard always did (WIZ-04).
  people
    .filter((person) => !blank(person?.name))
    .forEach((person, index) => {
      const at = `people[${index}]`;

      if (!roles.has(person.role)) {
        errors[`${at}.role`] = `${person.role || "(none)"} is not a role of this bundle`;
      }

      let attributes = {};

      if (schema) {
        const result = profiles.validate(schema, person.attributes || {});

        if (!result.valid) {
          for (const [field, message] of Object.entries(result.errors)) {
            errors[`${at}.${field}`] = message;
          }
        }

        attributes = result.value;
      }

      cleaned.push({
        role: person.role,
        name: text(person.name),
        designation: text(person.designation),
        attributes,
        isSignatory: Boolean(person.isSignatory),
        position: index,
      });
    });

  return { people: cleaned, errors };
}

function validateBankAccount(account, at = "bankAccount") {
  const errors = {};

  if (blank(account?.bankName)) errors[`${at}.bankName`] = "Bank is required";
  if (blank(account?.accountNumber)) errors[`${at}.accountNumber`] = "Account number is required";
  else if (!/^[0-9A-Za-z]{4,34}$/.test(String(account.accountNumber).replace(/\s/g, ""))) {
    errors[`${at}.accountNumber`] = "Account number is not valid";
  }

  return {
    errors,
    account: {
      bankName: text(account?.bankName),
      branch: text(account?.branch),
      accountNumber: String(account?.accountNumber || "").replace(/\s/g, ""),
      routingCode: text(account?.routingCode)?.toUpperCase() || null,
      accountType: text(account?.accountType),
      holderName: text(account?.holderName),
    },
  };
}

/*
 * Checks a profile against the bundle. `input` may hold any of address,
 * notes, attributes, identifiers, people and (on create) bankAccounts;
 * absent parts are left as they are.
 */
function validateProfile(bundle, input, { creating }) {
  const errors = {};
  const profile = {};

  if (input.address !== undefined) profile.address = text(input.address);
  if (input.notes !== undefined) profile.notes = text(input.notes);

  const schema = bundle.profiles?.client?.schema;
  const attributes = profiles.validate(schema || { type: "object" }, input.attributes || {});

  Object.assign(errors, attributes.errors);
  profile.attributes = attributes.value;
  profile.attributesVersion = bundle.profiles?.client?.version || null;

  const ids = identifierRules.check(bundle.identifiers || [], { attributes: attributes.value }, input.identifiers || {});

  for (const [field, message] of Object.entries(ids.errors)) {
    errors[`identifiers.${field}`] = message;
  }

  profile.identifiers = ids.values;
  profile.identifierTypes = new Map((bundle.identifiers || []).map((rule) => [rule.type, rule]));

  const people = validatePeople(bundle, input.people);

  Object.assign(errors, people.errors);
  profile.people = people.people;

  if (input.bankAccounts !== undefined) {
    if (!creating) {
      // On an existing client, accounts change through their own endpoints:
      // the client only ever sees masked numbers, which must not come back.
      errors.bankAccounts = "Bank accounts of an existing client are edited one by one";
    } else if (!Array.isArray(input.bankAccounts)) {
      errors.bankAccounts = "bankAccounts must be a list";
    } else {
      profile.bankAccounts = input.bankAccounts.map((account, index) => {
        const checked = validateBankAccount(account, `bankAccounts[${index}]`);
        Object.assign(errors, checked.errors);
        return checked.account;
      });
    }
  }

  if (Object.keys(errors).length > 0) {
    throw httpError(400, "Some client details need attention", errors);
  }

  return profile;
}

// ---------------------------------------------------------------------------
// Writing — inside the caller's transaction
// ---------------------------------------------------------------------------

// A duplicate identifier names the client that already holds it (WIZ-11) —
// archived ones included, so a PAN cannot be reused by archiving its client.
async function identifierConflict(client, organizationId, type, value, label) {
  const holder = await client.query(
    `SELECT c.id, c.name, c.archived_at FROM customer_identifiers i
     JOIN customers c ON c.id = i.customer_id
     WHERE i.organization_id = $1 AND i.type = $2 AND i.value = $3`,
    [organizationId, type, value],
  );
  const other = holder.rows[0];

  return httpError(409, `${label} ${value} already belongs to ${other ? `${other.archived_at ? "the archived client " : ""}${other.name}` : "another client"}`, {
    [`identifiers.${type}`]: "Already in use",
  });
}

async function writeProfile(client, organizationId, customerId, profile) {
  await client.query(
    `UPDATE customers
     SET address = COALESCE($1, address),
         notes = COALESCE($2, notes),
         attributes = $3, attributes_version = $4, updated_at = NOW()
     WHERE id = $5 AND organization_id = $6`,
    [profile.address ?? null, profile.notes ?? null, profile.attributes, profile.attributesVersion, customerId, organizationId],
  );

  await client.query("DELETE FROM customer_identifiers WHERE customer_id = $1", [customerId]);

  for (const [type, value] of Object.entries(profile.identifiers)) {
    const rule = profile.identifierTypes.get(type);

    await client.query("SAVEPOINT identifier");

    try {
      await client.query(
        `INSERT INTO customer_identifiers (organization_id, customer_id, type, value, is_unique)
         VALUES ($1, $2, $3, $4, $5)`,
        [organizationId, customerId, type, value, rule ? rule.unique : true],
      );
    } catch (error) {
      if (error.code === "23505") {
        await client.query("ROLLBACK TO SAVEPOINT identifier");
        throw await identifierConflict(client, organizationId, type, value, rule?.label || type);
      }

      throw error;
    }
  }

  if (profile.people !== undefined) {
    await client.query("DELETE FROM customer_people WHERE customer_id = $1", [customerId]);

    for (const person of profile.people) {
      await client.query(
        `INSERT INTO customer_people (organization_id, customer_id, role, name, designation, attributes, is_signatory, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [organizationId, customerId, person.role, person.name, person.designation, person.attributes, person.isSignatory, person.position],
      );
    }
  }

  // The first account becomes the primary one (WIZ-10).
  for (const [index, account] of (profile.bankAccounts || []).entries()) {
    await insertBankAccount(client, organizationId, customerId, account, index === 0);
  }
}

async function insertBankAccount(client, organizationId, customerId, account, isPrimary) {
  const created = await client.query(
    `INSERT INTO customer_bank_accounts
       (organization_id, customer_id, bank_name, branch, account_number, routing_code, account_type, holder_name, is_primary)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [organizationId, customerId, account.bankName, account.branch, account.accountNumber, account.routingCode, account.accountType, account.holderName, isPrimary],
  );

  return created.rows[0].id;
}

async function inTransaction(work) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function bankAccounts(organizationId, customerId) {
  const result = await pool.query(
    `SELECT id, bank_name, branch, account_number, routing_code, account_type, holder_name, is_primary
     FROM customer_bank_accounts WHERE customer_id = $1 AND organization_id = $2
     ORDER BY is_primary DESC, id`,
    [customerId, organizationId],
  );

  return result.rows.map(({ account_number: number, ...account }) => ({ ...account, account_number: mask(number) }));
}

/*
 * The profile parts of a client. `withPrivate` (profiles.read) adds people
 * and bank accounts; attributes and identifiers come with customers.read.
 */
async function readProfile(organizationId, customerId, { withPrivate }) {
  const ids = await pool.query(
    "SELECT type, value FROM customer_identifiers WHERE customer_id = $1 AND organization_id = $2",
    [customerId, organizationId],
  );

  const profile = { identifiers: Object.fromEntries(ids.rows.map((row) => [row.type, row.value])) };

  if (withPrivate) {
    const people = await pool.query(
      `SELECT id, role, name, designation, attributes, is_signatory FROM customer_people
       WHERE customer_id = $1 AND organization_id = $2 ORDER BY position, id`,
      [customerId, organizationId],
    );

    profile.people = people.rows;
    profile.bankAccounts = await bankAccounts(organizationId, customerId);
  }

  return profile;
}

// Identifiers of many clients at once, for the list (DASH-04).
async function identifiersFor(organizationId, customerIds) {
  if (customerIds.length === 0) {
    return new Map();
  }

  const result = await pool.query(
    "SELECT customer_id, type, value FROM customer_identifiers WHERE organization_id = $1 AND customer_id = ANY($2::int[])",
    [organizationId, customerIds],
  );

  const byCustomer = new Map();

  for (const row of result.rows) {
    if (!byCustomer.has(row.customer_id)) byCustomer.set(row.customer_id, {});
    byCustomer.get(row.customer_id)[row.type] = row.value;
  }

  return byCustomer;
}

// Who, if anyone, already holds an identifier — for the wizard's live check.
async function checkIdentifier(organizationId, type, value, excludeId) {
  const result = await pool.query(
    `SELECT c.id, c.name, c.archived_at FROM customer_identifiers i
     JOIN customers c ON c.id = i.customer_id
     WHERE i.organization_id = $1 AND i.type = $2 AND i.value = $3 AND i.is_unique
       AND ($4::int IS NULL OR c.id <> $4)`,
    [organizationId, type, identifierRules.normalise(value), excludeId || null],
  );

  const holder = result.rows[0];

  return holder
    ? { available: false, customer: { id: holder.id, name: holder.name, archived: Boolean(holder.archived_at) } }
    : { available: true };
}

// ---------------------------------------------------------------------------
// One-by-one changes (detail screen)
// ---------------------------------------------------------------------------

async function loadClient(organizationId, customerId) {
  const result = await pool.query(
    "SELECT id, name, locked_at, archived_at FROM customers WHERE id = $1 AND organization_id = $2",
    [customerId, organizationId],
  );

  if (!result.rows[0]) {
    throw httpError(404, "Customer not found");
  }

  return result.rows[0];
}

/*
 * Every profile write goes through here first: archived clients are
 * read-only, and a locked one needs profiles.lock (or a just-in-time grant
 * of it) to change (CD-03).
 */
async function assertWritable(organizationId, customerId, permissions) {
  const client = await loadClient(organizationId, customerId);

  if (client.archived_at) {
    throw httpError(409, "This client is archived — restore it to make changes");
  }

  if (client.locked_at && !permissions.includes("profiles.lock")) {
    throw httpError(423, "This client is locked — a person who can unlock clients must unlock it first");
  }

  return client;
}

async function audit(clientOrPool, { organizationId, userId, action, customerId, details = {} }) {
  await clientOrPool.query(
    `INSERT INTO audit_events (organization_id, actor_user_id, action, entity_type, entity_id, customer_id, details)
     VALUES ($1, $2, $3, 'customer', $4, $5, $6)`,
    // entity_id is text and customer_id an integer: one parameter cannot be both.
    [organizationId, userId, action, String(customerId), customerId, details],
  );
}

async function updateProfile(auth, bundle, customerId, input) {
  await assertWritable(auth.organizationId, customerId, auth.permissions);
  const profile = validateProfile(bundle, input, { creating: false });

  await inTransaction(async (client) => {
    if (input.core) {
      await client.query(
        `UPDATE customers SET name = COALESCE($1, name), company = $2, email = $3, phone = $4, updated_at = NOW()
         WHERE id = $5 AND organization_id = $6`,
        [text(input.core.name), text(input.core.company), text(input.core.email), text(input.core.phone), customerId, auth.organizationId],
      );
    }

    await writeProfile(client, auth.organizationId, customerId, profile);
  });
}

async function replacePeople(auth, bundle, customerId, people) {
  await assertWritable(auth.organizationId, customerId, auth.permissions);
  const checked = validatePeople(bundle, people);

  if (Object.keys(checked.errors).length > 0) {
    throw httpError(400, "Some people need attention", checked.errors);
  }

  await inTransaction(async (client) => {
    await client.query("DELETE FROM customer_people WHERE customer_id = $1", [customerId]);

    for (const person of checked.people) {
      await client.query(
        `INSERT INTO customer_people (organization_id, customer_id, role, name, designation, attributes, is_signatory, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [auth.organizationId, customerId, person.role, person.name, person.designation, person.attributes, person.isSignatory, person.position],
      );
    }
  });
}

async function addBankAccount(auth, customerId, input) {
  await assertWritable(auth.organizationId, customerId, auth.permissions);
  const { errors, account } = validateBankAccount(input);

  if (Object.keys(errors).length > 0) {
    throw httpError(400, "The bank account needs attention", errors);
  }

  return inTransaction(async (client) => {
    const existing = await client.query("SELECT count(*)::int AS n FROM customer_bank_accounts WHERE customer_id = $1", [customerId]);
    const id = await insertBankAccount(client, auth.organizationId, customerId, account, existing.rows[0].n === 0);
    return { id };
  });
}

async function updateBankAccount(auth, customerId, accountId, input) {
  await assertWritable(auth.organizationId, customerId, auth.permissions);

  // The number is optional here: the screen only knows the masked one.
  const { errors, account } = validateBankAccount({ ...input, accountNumber: input.accountNumber || "0000" });

  if (Object.keys(errors).length > 0) {
    throw httpError(400, "The bank account needs attention", errors);
  }

  const result = await pool.query(
    `UPDATE customer_bank_accounts
     SET bank_name = $1, branch = $2, routing_code = $3, account_type = $4, holder_name = $5,
         account_number = COALESCE($6, account_number), updated_at = NOW()
     WHERE id = $7 AND customer_id = $8 AND organization_id = $9
     RETURNING id`,
    [account.bankName, account.branch, account.routingCode, account.accountType, account.holderName,
      input.accountNumber ? account.accountNumber : null, accountId, customerId, auth.organizationId],
  );

  if (!result.rows[0]) throw httpError(404, "Bank account not found");
}

async function setPrimaryBankAccount(auth, customerId, accountId) {
  await assertWritable(auth.organizationId, customerId, auth.permissions);

  await inTransaction(async (client) => {
    const target = await client.query(
      "SELECT id FROM customer_bank_accounts WHERE id = $1 AND customer_id = $2 AND organization_id = $3",
      [accountId, customerId, auth.organizationId],
    );

    if (!target.rows[0]) throw httpError(404, "Bank account not found");

    // Clear first: the partial unique index allows one primary at a time.
    await client.query("UPDATE customer_bank_accounts SET is_primary = false WHERE customer_id = $1", [customerId]);
    await client.query("UPDATE customer_bank_accounts SET is_primary = true WHERE id = $1", [accountId]);
  });
}

// Removing the primary account promotes the next one (CD-11).
async function removeBankAccount(auth, customerId, accountId) {
  await assertWritable(auth.organizationId, customerId, auth.permissions);

  await inTransaction(async (client) => {
    const removed = await client.query(
      "DELETE FROM customer_bank_accounts WHERE id = $1 AND customer_id = $2 AND organization_id = $3 RETURNING is_primary",
      [accountId, customerId, auth.organizationId],
    );

    if (!removed.rows[0]) throw httpError(404, "Bank account not found");

    if (removed.rows[0].is_primary) {
      await client.query(
        `UPDATE customer_bank_accounts SET is_primary = true
         WHERE id = (SELECT id FROM customer_bank_accounts WHERE customer_id = $1 ORDER BY id LIMIT 1)`,
        [customerId],
      );
    }
  });
}

async function setLocked(auth, customerId, locked) {
  const client = await loadClient(auth.organizationId, customerId);

  if (client.archived_at) throw httpError(409, "This client is archived");

  await inTransaction(async (db) => {
    await db.query(
      "UPDATE customers SET locked_at = $1, locked_by = $2 WHERE id = $3 AND organization_id = $4",
      [locked ? new Date() : null, locked ? auth.userId : null, customerId, auth.organizationId],
    );
    await audit(db, { ...auth, action: locked ? "customer.locked" : "customer.unlocked", customerId });
  });
}

async function setArchived(auth, customerId, archived) {
  await loadClient(auth.organizationId, customerId);

  await inTransaction(async (db) => {
    await db.query(
      "UPDATE customers SET archived_at = $1, archived_by = $2, updated_at = NOW() WHERE id = $3 AND organization_id = $4",
      [archived ? new Date() : null, archived ? auth.userId : null, customerId, auth.organizationId],
    );
    await audit(db, { ...auth, action: archived ? "customer.archived" : "customer.restored", customerId });
  });
}

/*
 * Permanently deletes an archived client and everything recorded about them
 * (client-owned tables cascade). The audit row outlives it.
 */
async function purge(auth, customerId) {
  const client = await loadClient(auth.organizationId, customerId);

  if (!client.archived_at) {
    throw httpError(409, "Only an archived client can be deleted permanently — archive it first");
  }

  await inTransaction(async (db) => {
    await db.query("DELETE FROM customers WHERE id = $1 AND organization_id = $2", [customerId, auth.organizationId]);
    await audit(db, { ...auth, action: "customer.purged", customerId, details: { name: client.name } });
  });
}

module.exports = {
  validateProfile,
  writeProfile,
  readProfile,
  identifiersFor,
  checkIdentifier,
  updateProfile,
  replacePeople,
  bankAccounts,
  addBankAccount,
  updateBankAccount,
  setPrimaryBankAccount,
  removeBankAccount,
  setLocked,
  setArchived,
  purge,
  assertWritable,
  mask,
};
