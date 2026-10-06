const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const csv = require("../src/services/csvService");

/*
 * Clients as CSV (DATA-03–05, FIX-13): the columns follow the bundle, cells
 * are escaped and never run as formulas, and import reads real CSV.
 */

const BUNDLE = {
  profiles: {
    client: {
      schema: { type: "object", properties: { constitution: { type: "string", enum: ["proprietorship", "pvt_ltd"] }, client_type: { type: "string", enum: ["regular", "one_time"] } } },
      ui: { constitution: { "ui:enumNames": ["Proprietorship", "Private Limited"] } },
    },
    person: { schema: { type: "object", properties: { din: { type: "string" } } } },
  },
  identifiers: [{ type: "pan" }, { type: "cin" }, { type: "din", appliesTo: "person" }],
  peopleRoles: [{ key: "director", label: "Director" }, { key: "partner", label: "Partner" }],
};

describe("columns and cells", () => {
  test("follow the bundle: profile fields, client identifiers, people and a bank account", () => {
    const columns = csv.columnsFor(BUNDLE);

    for (const column of ["name", "constitution", "client_type", "pan", "cin", "services", "person1_name", "person1_din", "person3_role", "bank_account_number"]) {
      assert.ok(columns.includes(column), column);
    }
    assert.equal(columns.includes("din"), false, "a person's identifier is not a client column");
  });

  test("are escaped, and a formula is never handed to a spreadsheet", () => {
    assert.equal(csv.cell('Rao, "Senior" & Co'), '"Rao, ""Senior"" & Co"');
    assert.equal(csv.cell("line 1\nline 2"), '"line 1\nline 2"');
    assert.equal(csv.cell("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"");
    assert.equal(csv.cell("+91 98765"), "'+91 98765");
    assert.equal(csv.cell(null), "");
  });

  test("the template carries // instructions and the header", () => {
    const lines = csv.template(BUNDLE).trim().split("\r\n");

    assert.ok(lines.slice(0, -1).every((line) => line.startsWith("//")));
    assert.equal(lines.at(-1), csv.columnsFor(BUNDLE).join(","));
  });
});

describe("reading", () => {
  test("ignores // lines and keeps quoted values across lines (FIX-13)", () => {
    const rows = csv.readRows('// instructions\r\nname,address,pan\r\n"Acme Pvt Ltd","12 MG Road\nPune",AAACA1234A\r\n');

    assert.equal(rows.length, 1);
    assert.equal(rows[0].values.address, "12 MG Road\nPune");
    assert.equal(rows[0].values.pan, "AAACA1234A");
  });

  test("reports the line a row starts on, across quoted line breaks, blank lines and any line ending", () => {
    const startLines = (text) => csv.readRows(text).map((row) => [row.values.name, row.line]);

    assert.deepEqual(startLines('// note\r\nname,address\r\n\r\n"Acme •","12 MG Road\r\nPune"\r\nBeta,x\r\nGamma,y'), [["Acme •", 4], ["Beta", 6], ["Gamma", 7]]);
    assert.deepEqual(startLines("\uFEFFname\nA\n\n\nB\n"), [["A", 2], ["B", 5]]);
    assert.deepEqual(startLines("name\rA\rB"), [["A", 2], ["B", 3]]);
  });

  test("needs a header with a name column", () => {
    assert.throws(() => csv.readRows("email\r\nx@y.z\r\n"), (error) => error.statusCode === 400 && /"name" column/.test(error.message));
    assert.throws(() => csv.readRows("// only comments\r\n"), (error) => error.statusCode === 400);
  });

  test("a row becomes the wizard's input: options by key or label, services by key", () => {
    const { profile, serviceIds, problems } = csv.rowToInput(
      BUNDLE,
      { name: "Acme", constitution: "Private Limited", pan: " AAACA1234A ", services: "gst_returns;itr", person1_name: "A. Rao", person1_role: "Director", person1_signatory: "yes", person1_din: "01234567", bank_account_number: "•••• 9012" },
      new Map([["gst_returns", 3], ["itr", 7]]),
    );

    assert.deepEqual(problems, {});
    assert.equal(profile.attributes.constitution, "pvt_ltd");
    assert.equal(profile.identifiers.pan, "AAACA1234A");
    assert.deepEqual(serviceIds, [3, 7]);
    assert.deepEqual(profile.people[0], { role: "director", name: "A. Rao", designation: null, isSignatory: true, attributes: { din: "01234567" } });
    assert.equal(profile.bankAccounts, undefined, "a masked number from an export is not saved");
  });

  test("an unknown service is reported, not guessed", () => {
    assert.match(csv.rowToInput(BUNDLE, { name: "Acme", services: "astrology" }, new Map()).problems.services, /Unknown service "astrology"/);
  });
});
