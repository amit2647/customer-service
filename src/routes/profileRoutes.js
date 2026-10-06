const express = require("express");

const authenticate = require("../middleware/authenticate");
const requirePermission = require("../middleware/requirePermission");
const requireBundle = require("../middleware/requireBundle");
const controller = require("../controllers/profileController");
const csv = require("../services/csvService");

const router = express.Router();

/*
 * A client's profession profile — only for organizations with a bundle.
 * Declared before /customers/:id so the fixed paths match first.
 */
const bundled = (permission) => [authenticate, requirePermission(permission), requireBundle];

// Clients as CSV (DATA-03–05): the template, an export (bank numbers masked)
// and an import that goes through the wizard's own checks, row by row.
const csvRoute = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (error) {
    if (!error.statusCode) console.error("[CSV]", error);
    res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : "The CSV request failed",
      ...(error.details ? { details: error.details } : {}),
    });
  }
};

const sendCsv = (res, name, body) =>
  res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" }).send(body);

router.get("/customers/import-template.csv", ...bundled("customers.read"), csvRoute((req, res) => sendCsv(res, "client-import-template.csv", csv.template(req.bundle))));

router.get("/customers/export.csv", ...bundled("customers.read"), csvRoute(async (req, res) => {
  sendCsv(res, `clients-${new Date().toISOString().slice(0, 10)}.csv`, await csv.exportCsv(req.auth.organizationId, req.bundle));
}));

router.post(
  "/customers/import",
  authenticate,
  requirePermission("customers.create"),
  requirePermission("profiles.update"),
  requireBundle,
  express.text({ type: ["text/csv", "text/plain", "application/csv"], limit: "2mb" }),
  csvRoute(async (req, res) => {
    if (typeof req.body !== "string") {
      return res.status(400).json({ error: "Send the file as text/csv" });
    }

    const token = req.headers.authorization.split(" ")[1];
    return res.json(await csv.importCsv(req.auth, req.bundle, req.body, token));
  }),
);

// Is this PAN/CIN already held by another client? (WIZ-11, live in the wizard)
router.get("/customers/identifiers/check", ...bundled("customers.read"), controller.checkIdentifier);

router.put("/customers/:id/people", ...bundled("profiles.update"), controller.replacePeople);

router.get("/customers/:id/bank-accounts", ...bundled("profiles.read"), controller.listBankAccounts);
router.post("/customers/:id/bank-accounts", ...bundled("profiles.update"), controller.addBankAccount);
router.put("/customers/:id/bank-accounts/:accountId", ...bundled("profiles.update"), controller.updateBankAccount);
router.post("/customers/:id/bank-accounts/:accountId/primary", ...bundled("profiles.update"), controller.setPrimaryBankAccount);
router.delete("/customers/:id/bank-accounts/:accountId", ...bundled("profiles.update"), controller.removeBankAccount);

router.post("/customers/:id/lock", ...bundled("profiles.lock"), controller.lock);
router.delete("/customers/:id/lock", ...bundled("profiles.lock"), controller.unlock);

router.post("/customers/:id/archive", ...bundled("customers.delete"), controller.archive);
router.post("/customers/:id/restore", ...bundled("customers.delete"), controller.restore);

// Permanent: archived clients only, settings-level permission.
router.delete("/customers/:id/purge", ...bundled("customers.purge"), controller.purge);

module.exports = router;
