const express = require("express");

const authenticate = require("../middleware/authenticate");
const requirePermission = require("../middleware/requirePermission");
const requireBundle = require("../middleware/requireBundle");
const controller = require("../controllers/profileController");

const router = express.Router();

/*
 * A client's profession profile — only for organizations with a bundle.
 * Declared before /customers/:id so the fixed paths match first.
 */
const bundled = (permission) => [authenticate, requirePermission(permission), requireBundle];

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
