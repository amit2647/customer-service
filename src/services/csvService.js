const { parse } = require("csv-parse/sync");

const pool = require("../config/database");
const customerService = require("./customerService");
const profileService = require("./profileService");

/*
 * Clients as CSV (DATA-03–05, FIX-13).
 *
 * The columns follow the installed bundle: the core fields, the client
 * profile's fields, the client's identifiers, services (catalog keys,
 * separated by ";"), up to three people and one bank account.
 *
 * - Export masks bank account numbers, as the app does everywhere, and
 *   neutralises cells that a spreadsheet would run as a formula.
 * - Import parses real CSV (quoted fields may span lines), ignores lines
 *   starting with "//", maps columns by header name, and sends every row
 *   through the wizard's own validation and create path, each in its own
 *   transaction — so an import can never make a client the wizard would
 *   refuse. A duplicate PAN or CIN is skipped, not an error.
 */

const PEOPLE = 3;
const MAX_ROWS = 1000;
const BANK_COLUMNS = ["bank_name", "bank_branch", "bank_account_number", "bank_ifsc", "bank_account_type", "bank_holder"];

function httpError(statusCode, message, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (details) error.details = details;
  return error;
}

const clientFields = (bundle) => Object.keys(bundle.profiles?.client?.schema?.properties || {});
const personFields = (bundle) => Object.keys(bundle.profiles?.person?.schema?.properties || {});
const clientIdentifiers = (bundle) => (bundle.identifiers || []).filter((rule) => rule.appliesTo !== "person").map((rule) => rule.type);

function columnsFor(bundle) {
  const people = [];

  for (let n = 1; n <= PEOPLE; n += 1) {
    people.push(`person${n}_name`, `person${n}_role`, `person${n}_designation`, `person${n}_signatory`, ...personFields(bundle).map((field) => `person${n}_${field}`));
  }

  return ["name", "email", "phone", "address", "notes", ...clientFields(bundle), ...clientIdentifiers(bundle), "services", ...people, ...BANK_COLUMNS];
}

// A spreadsheet runs a cell starting with these as a formula.
function cell(value) {
  if (value === undefined || value === null) return "";

  let text = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;

  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const line = (values) => values.map(cell).join(",");

function template(bundle) {
  const columns = columnsFor(bundle);
  const roles = (bundle.peopleRoles || []).map((role) => role.key).join(", ");
  const constitution = bundle.profiles?.client?.schema?.properties?.constitution?.enum || [];

  return [
    "// Client import template. Lines starting with // are ignored; keep the header row as it is.",
    "// One client per row. Leave a column empty when it does not apply.",
    "// services: catalog keys separated by ; (e.g. gst_returns;itr). Options may be written as their key or their label.",
    ...(constitution.length ? [`// constitution: ${constitution.join(", ")}`] : []),
    ...(roles ? [`// person roles: ${roles}. personN_signatory: yes or no.`] : []),
    "// A PAN or CIN already held by a client is skipped.",
    line(columns),
  ].join("\r\n") + "\r\n";
}

async function exportCsv(organizationId, bundle) {
  const columns = columnsFor(bundle);
  const customers = (
    await pool.query(
      "SELECT id, name, email, phone, address, notes, attributes FROM customers WHERE organization_id = $1 AND archived_at IS NULL ORDER BY name, id",
      [organizationId],
    )
  ).rows;
  const ids = customers.map((customer) => customer.id);

  const identifiers = await profileService.identifiersFor(organizationId, ids);
  const services = await pool.query(
    `SELECT cs.customer_id, s.key FROM customer_services cs JOIN services s ON s.id = cs.service_id
     WHERE cs.customer_id = ANY($1::int[]) AND s.key IS NOT NULL ORDER BY s.key`,
    [ids],
  );
  const people = await pool.query(
    "SELECT customer_id, role, name, designation, attributes, is_signatory FROM customer_people WHERE customer_id = ANY($1::int[]) ORDER BY customer_id, position, id",
    [ids],
  );
  const banks = await pool.query(
    "SELECT customer_id, bank_name, branch, account_number, routing_code, account_type, holder_name FROM customer_bank_accounts WHERE customer_id = ANY($1::int[]) AND is_primary",
    [ids],
  );

  const group = (rows) => rows.reduce((map, row) => map.set(row.customer_id, [...(map.get(row.customer_id) || []), row]), new Map());
  const servicesOf = group(services.rows);
  const peopleOf = group(people.rows);
  const bankOf = new Map(banks.rows.map((row) => [row.customer_id, row]));

  const rows = customers.map((customer) => {
    const values = {
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      address: customer.address,
      notes: customer.notes,
      ...(customer.attributes || {}),
      ...(identifiers.get(customer.id) || {}),
      services: (servicesOf.get(customer.id) || []).map((row) => row.key).join(";"),
    };

    (peopleOf.get(customer.id) || []).slice(0, PEOPLE).forEach((person, index) => {
      const n = index + 1;
      Object.assign(values, {
        [`person${n}_name`]: person.name,
        [`person${n}_role`]: person.role,
        [`person${n}_designation`]: person.designation,
        [`person${n}_signatory`]: person.is_signatory ? "yes" : "",
      });
      for (const [field, value] of Object.entries(person.attributes || {})) values[`person${n}_${field}`] = value;
    });

    const bank = bankOf.get(customer.id);
    if (bank) {
      Object.assign(values, {
        bank_name: bank.bank_name,
        bank_branch: bank.branch,
        // Masked, as everywhere else: a CSV leaves the system.
        bank_account_number: profileService.mask(bank.account_number),
        bank_ifsc: bank.routing_code,
        bank_account_type: bank.account_type,
        bank_holder: bank.holder_name,
      });
    }

    return line(columns.map((column) => values[column]));
  });

  return [line(columns), ...rows].join("\r\n") + "\r\n";
}

// An option written as its key or its label (case-insensitive).
function option(value, keys, labels = []) {
  const wanted = String(value).trim().toLowerCase();
  const index = keys.findIndex((key, at) => String(key).toLowerCase() === wanted || String(labels[at] || "").toLowerCase() === wanted);
  return index >= 0 ? keys[index] : value;
}

function typed(value, definition = {}, ui = {}) {
  if (definition.enum) return option(value, definition.enum, ui["ui:enumNames"]);
  if (definition.type === "number" || definition.type === "integer") return Number(value);
  if (definition.type === "boolean") return ["yes", "true", "1", "y"].includes(String(value).trim().toLowerCase());
  return value;
}

const present = (value) => value !== undefined && value !== null && String(value).trim() !== "";

function rowToInput(bundle, row, serviceIdByKey) {
  const problems = {};
  const clientSchema = bundle.profiles?.client?.schema?.properties || {};
  const clientUi = bundle.profiles?.client?.ui || {};
  const personSchema = bundle.profiles?.person?.schema?.properties || {};
  const roles = bundle.peopleRoles || [];

  const attributes = {};
  for (const field of clientFields(bundle)) {
    if (present(row[field])) attributes[field] = typed(row[field].trim(), clientSchema[field], clientUi[field]);
  }

  const identifiers = {};
  for (const type of clientIdentifiers(bundle)) {
    if (present(row[type])) identifiers[type] = row[type].trim();
  }

  const serviceIds = [];
  for (const key of String(row.services || "").split(";").map((item) => item.trim()).filter(Boolean)) {
    if (serviceIdByKey.has(key)) serviceIds.push(serviceIdByKey.get(key));
    else problems.services = `Unknown service "${key}"`;
  }

  const people = [];
  for (let n = 1; n <= PEOPLE; n += 1) {
    if (!present(row[`person${n}_name`])) continue;

    const personAttributes = {};
    for (const field of personFields(bundle)) {
      if (present(row[`person${n}_${field}`])) personAttributes[field] = typed(row[`person${n}_${field}`].trim(), personSchema[field]);
    }

    people.push({
      role: option(row[`person${n}_role`] || roles[0]?.key || "", roles.map((role) => role.key), roles.map((role) => role.label)),
      name: row[`person${n}_name`].trim(),
      designation: row[`person${n}_designation`] || null,
      isSignatory: ["yes", "true", "1", "y"].includes(String(row[`person${n}_signatory`] || "").trim().toLowerCase()),
      attributes: personAttributes,
    });
  }

  const profile = { attributes, identifiers, people };
  if (present(row.address)) profile.address = row.address;
  if (present(row.notes)) profile.notes = row.notes;

  // A masked number (from an export) is not a number to save.
  const accountNumber = String(row.bank_account_number || "").trim();
  if (present(accountNumber) && !accountNumber.includes("•")) {
    profile.bankAccounts = [{
      bankName: row.bank_name, branch: row.bank_branch, accountNumber, routingCode: row.bank_ifsc, accountType: row.bank_account_type, holderName: row.bank_holder,
    }];
  }

  return { profile, serviceIds, problems };
}

function readRows(text) {
  const bytes = Buffer.from(String(text || ""));
  let records;

  try {
    records = parse(bytes, { bom: true, relax_column_count: true, skip_empty_lines: true, info: true, trim: false });
  } catch (error) {
    throw httpError(400, `This is not a readable CSV file: ${error.message}`);
  }

  // The line a record starts on, for the report. csv-parse's own info.lines
  // is the line it stopped on (and miscounts \r\n), so a quoted address
  // spanning lines would be reported where it ends.
  let end = 0;
  let line = 1;
  for (const entry of records) {
    while (end < bytes.length && (bytes[end] === 0x0a || bytes[end] === 0x0d)) {
      if (bytes[end] === 0x0a || bytes[end + 1] !== 0x0a) line += 1;
      end += 1;
    }
    entry.line = line;
    for (let at = end; at < entry.info.bytes && at < bytes.length; at += 1) {
      if (bytes[at] === 0x0a || (bytes[at] === 0x0d && bytes[at + 1] !== 0x0a)) line += 1;
    }
    end = entry.info.bytes;
  }

  const kept = records.filter(({ record }) => !String(record[0] || "").trim().startsWith("//"));
  if (kept.length === 0) throw httpError(400, "The file has no header row");

  const header = kept[0].record.map((name) => String(name).trim().toLowerCase());
  if (!header.includes("name")) throw httpError(400, 'The header row needs a "name" column');

  const rows = kept.slice(1).map(({ record, line }) => ({
    line,
    values: Object.fromEntries(header.map((name, index) => [name, record[index]])),
  }));

  if (rows.length > MAX_ROWS) throw httpError(400, `At most ${MAX_ROWS} clients per file`);

  return rows;
}

async function importCsv({ organizationId, userId }, bundle, text, token) {
  const rows = readRows(text);
  const services = await pool.query("SELECT id, key FROM services WHERE organization_id = $1 AND key IS NOT NULL", [organizationId]);
  const serviceIdByKey = new Map(services.rows.map((row) => [row.key, row.id]));

  const report = { added: [], skipped: [], errors: [] };

  for (const { line: lineNumber, values } of rows) {
    if (Object.values(values).every((value) => !present(value))) continue;

    const name = String(values.name || "").trim();
    const entry = { line: lineNumber, name: name || null };

    if (!name) {
      report.errors.push({ ...entry, error: "Name is required" });
      continue;
    }

    const { profile, serviceIds, problems } = rowToInput(bundle, values, serviceIdByKey);

    if (Object.keys(problems).length > 0) {
      report.errors.push({ ...entry, error: Object.values(problems).join("; "), details: problems });
      continue;
    }

    try {
      const checked = profileService.validateProfile(bundle, profile, { creating: true });
      const created = await customerService.createCustomer(
        { organizationId, ownerUserId: userId, name, email: values.email || null, phone: values.phone || null, serviceIds },
        token,
        { extend: (client, customer) => profileService.writeProfile(client, organizationId, customer.id, checked) },
      );
      report.added.push({ ...entry, id: created.id });
    } catch (error) {
      if (error.statusCode === 409) report.skipped.push({ ...entry, reason: error.message });
      else if (error.statusCode && error.statusCode < 500) report.errors.push({ ...entry, error: error.message, details: error.details });
      else throw error;
    }
  }

  await pool.query(
    `INSERT INTO audit_events (organization_id, actor_user_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, 'customers.imported', 'customer', 'import', $3)`,
    [organizationId, userId, { added: report.added.length, skipped: report.skipped.length, errors: report.errors.length }],
  );

  return { added: report.added.length, skipped: report.skipped, errors: report.errors, created: report.added };
}

module.exports = { columnsFor, template, exportCsv, importCsv, readRows, rowToInput, cell };
