const customerService = require("../services/customerService");
const { normalizeServiceIds } = require("../utils/serviceIds");

async function health(req, res) {
  try {
    await customerService.checkHealth();

    console.log("[HEALTH] Customer service healthy");

    res.json({
      service: "customer-service",
      status: "ok",
      database: "postgresql",
    });
  } catch (error) {
    console.error("[ERROR] Customer service health check failed:", error);

    res.status(500).json({
      service: "customer-service",
      status: "error",
    });
  }
}

async function getCustomers(req, res) {
  try {
    const q = req.query.q || "";

    const customers = await customerService.getAllCustomers(q);

    res.json(customers);
  } catch (error) {
    console.error("[ERROR] Error fetching customers:", error);

    res.status(500).json({
      error: "Failed to fetch customers",
    });
  }
}

async function getCustomer(req, res) {
  try {
    const customer = await customerService.getCustomerById(req.params.id);

    if (!customer) {
      return res.status(404).json({
        error: "Customer not found",
      });
    }

    res.json(customer);
  } catch (error) {
    console.error("[ERROR] Error fetching customer:", error);

    res.status(500).json({
      error: "Failed to fetch customer",
    });
  }
}

async function createCustomer(req, res) {
  try {
    const {
      name,
      company,
      email,
      phone,
      segment = "Standard",
      serviceIds = [],
    } = req.body;

    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({
        error: "Name is required",
      });
    }

    const normalizedServiceIds = normalizeServiceIds(serviceIds);

    if (normalizedServiceIds === null) {
      return res.status(400).json({
        error: "serviceIds must be an array of positive integers",
      });
    }

    const customer = await customerService.createCustomer({
      name,
      company,
      email,
      phone,
      segment,
      serviceIds: normalizedServiceIds,
    });

    res.status(201).json(customer);
  } catch (error) {
    console.error("[ERROR] Error creating customer:", error);

    res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : "Failed to create customer",
    });
  }
}

async function updateCustomer(req, res) {
  try {
    const { name, company, email, phone, segment } = req.body;

    if (name !== undefined && (typeof name !== "string" || !name.trim())) {
      return res.status(400).json({
        error: "Name cannot be empty",
      });
    }

    const customer = await customerService.updateCustomer(req.params.id, {
      name,
      company,
      email,
      phone,
      segment,
    });

    if (!customer) {
      return res.status(404).json({
        error: "Customer not found",
      });
    }

    res.json(customer);
  } catch (error) {
    console.error("[ERROR] Error updating customer:", error);

    res.status(500).json({
      error: "Failed to update customer",
    });
  }
}

async function getCustomerServices(req, res) {
  try {
    const services = await customerService.getCustomerServices(req.params.id);

    if (services === null) {
      return res.status(404).json({
        error: "Customer not found",
      });
    }

    res.json(services);
  } catch (error) {
    console.error("[ERROR] Error fetching customer services:", error);

    res.status(500).json({
      error: "Failed to fetch customer services",
    });
  }
}

async function updateCustomerServices(req, res) {
  try {
    const normalizedServiceIds = normalizeServiceIds(req.body.serviceIds ?? []);

    if (normalizedServiceIds === null) {
      return res.status(400).json({
        error: "serviceIds must be an array of positive integers",
      });
    }

    const result = await customerService.updateCustomerServices(
      req.params.id,
      normalizedServiceIds,
    );

    res.json(result);
  } catch (error) {
    console.error("[ERROR] Error updating customer services:", error);

    res.status(error.statusCode || 500).json({
      error: error.statusCode
        ? error.message
        : "Failed to update customer services",
    });
  }
}

async function deleteCustomer(req, res) {
  try {
    const customer = await customerService.deleteCustomer(req.params.id);

    if (!customer) {
      return res.status(404).json({
        error: "Customer not found",
      });
    }

    res.json({
      message: "Customer deleted",
      id: customer.id,
    });
  } catch (error) {
    console.error("[ERROR] Error deleting customer:", error);

    res.status(500).json({
      error: "Failed to delete customer",
    });
  }
}

module.exports = {
  health,
  getCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  getCustomerServices,
  updateCustomerServices,
  deleteCustomer,
};
