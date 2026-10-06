const express = require("express");

const controller = require("../controllers/customerController");

const authenticate = require("../middleware/authenticate");

const requirePermission = require("../middleware/requirePermission");

const { linkSourceLead } = require("../services/leadLinkService");

const router = express.Router();

/*
 * =========================================================
 * CUSTOMER ROUTES
 * =========================================================
 */

router.get(
  "/customers",
  authenticate,
  requirePermission("customers.read"),
  controller.getCustomers,
);

router.get(
  "/customers/:id/validate",
  authenticate,
  requirePermission("customers.read"),
  controller.validateCustomer,
);

router.get(
  "/customers/:id",
  authenticate,
  requirePermission("customers.read"),
  controller.getCustomer,
);

router.post(
  "/customers",
  authenticate,
  requirePermission("customers.create"),
  controller.createCustomer,
);

router.post(
  "/customers/from-lead",
  authenticate,
  requirePermission("customers.create"),
  controller.createCustomerFromLead,
);

/*
 * Record which lead a customer was won from (migration 017). Called by
 * lead-service when a lead is linked by hand, with the user's own token.
 */
router.put(
  "/customers/:id/source-lead",
  authenticate,
  requirePermission("customers.update"),
  async (req, res) => {
    const customerId = Number(req.params.id);
    const leadId = req.body?.leadId;

    if (!Number.isInteger(customerId) || customerId <= 0) {
      return res.status(400).json({ error: "Invalid customer ID" });
    }

    if (!Number.isInteger(leadId) || leadId <= 0) {
      return res.status(400).json({ error: "leadId must be a positive integer" });
    }

    try {
      return res.json(await linkSourceLead(req.auth, customerId, leadId));
    } catch (error) {
      if (!error.statusCode) console.error("[LeadLink]", error);

      return res.status(error.statusCode || 500).json({
        error: error.statusCode ? error.message : "The lead could not be linked",
      });
    }
  },
);

router.put(
  "/customers/:id",
  authenticate,
  requirePermission("customers.update"),
  controller.updateCustomer,
);

router.get(
  "/customers/:id/services",
  authenticate,
  requirePermission("customers.read"),
  controller.getCustomerServices,
);

router.put(
  "/customers/:id/services",
  authenticate,
  requirePermission("customers.update"),
  controller.updateCustomerServices,
);

router.delete(
  "/customers/:id",
  authenticate,
  requirePermission("customers.delete"),
  controller.deleteCustomer,
);

module.exports = router;
