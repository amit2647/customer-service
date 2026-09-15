const express = require("express");

const controller = require("../controllers/customerController");

const authenticate = require("../middleware/authenticate");

const requirePermission = require("../middleware/requirePermission");

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
