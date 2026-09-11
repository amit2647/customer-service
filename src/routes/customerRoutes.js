const express = require("express");

const controller = require("../controllers/customerController");

const router = express.Router();

router.get("/health", controller.health);

router.get("/customers", controller.getCustomers);

router.get("/customers/:id", controller.getCustomer);

router.post("/customers", controller.createCustomer);

router.put("/customers/:id", controller.updateCustomer);

router.get("/customers/:id/services", controller.getCustomerServices);

router.put("/customers/:id/services", controller.updateCustomerServices);

router.delete("/customers/:id", controller.deleteCustomer);

module.exports = router;
