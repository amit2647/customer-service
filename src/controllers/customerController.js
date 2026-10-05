const profileService = require("../services/profileService");
const { installedBundle } = require("../services/bundleContext");
const customerService = require("../services/customerService");
const { notifyAutomation } = require("../services/automationNotifier");
const { normalizeServiceIds } = require("../utils/serviceIds");

/*
 * =========================================================
 * HEALTH
 * =========================================================
 */

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

/*
 * =========================================================
 * AUTHORIZATION TOKEN
 * =========================================================
 *
 * Extract:
 *
 *     Authorization: Bearer <JWT>
 *
 * The JWT is forwarded to Service Service whenever
 * Customer Service needs to retrieve or validate services.
 * =========================================================
 */

function getAuthorizationToken(req) {
  const authorization = req.headers.authorization;

  if (!authorization) {
    const error = new Error("Authentication required");

    error.statusCode = 401;

    throw error;
  }

  const parts = authorization.split(" ");

  if (parts.length !== 2 || parts[0] !== "Bearer" || !parts[1]) {
    const error = new Error("Invalid authorization header");

    error.statusCode = 401;

    throw error;
  }

  return parts[1];
}

/*
 * =========================================================
 * GET ALL CUSTOMERS
 * =========================================================
 */

async function getCustomers(req, res) {
  try {
    const q = req.query.q || "";

    /*
     * JWT is required because Customer Service retrieves
     * service details through Service Service.
     */

    const token = getAuthorizationToken(req);

    const customers = await customerService.getAllCustomers(
      req.auth.organizationId,
      req.auth.userId,
      req.auth.role,
      q,
      token,
      { includeArchived: req.query.archived === "true" },
    );

    // Identifiers for the list's PAN/CIN column (DASH-04); none without a bundle.
    const identifiers = await profileService.identifiersFor(
      req.auth.organizationId,
      customers.map((customer) => customer.id),
    );

    res.json(customers.map((customer) => ({ ...customer, identifiers: identifiers.get(customer.id) || {} })));
  } catch (error) {
    console.error("[ERROR] Error fetching customers:", error);

    res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : "Failed to fetch customers",
    });
  }
}

/*
 * =========================================================
 * VALIDATE CUSTOMER
 * =========================================================
 *
 * Used by other services to verify that a customer exists
 * and belongs to the authenticated organization.
 *
 * Only validation information is returned.
 * =========================================================
 */

async function validateCustomer(req, res) {
  try {
    const exists = await customerService.customerExists(
      req.params.id,
      req.auth.organizationId,
      req.auth.userId,
      req.auth.role,
    );

    if (!exists) {
      return res.status(404).json({
        valid: false,
        error: "Customer not found",
      });
    }

    return res.json({
      valid: true,
      customerId: Number(req.params.id),
      organizationId: req.auth.organizationId,
    });
  } catch (error) {
    console.error("[ERROR] Error validating customer:", error);

    return res.status(error.statusCode || 500).json({
      valid: false,
      error: error.statusCode ? error.message : "Failed to validate customer",
    });
  }
}

/*
 * =========================================================
 * GET CUSTOMER
 * =========================================================
 */

async function getCustomer(req, res) {
  try {
    /*
     * JWT is forwarded to Service Service.
     */

    const token = getAuthorizationToken(req);

    const customer = await customerService.getCustomerById(
      req.params.id,
      req.auth.organizationId,
      req.auth.userId,
      req.auth.role,
      token,
    );

    if (!customer) {
      return res.status(404).json({
        error: "Customer not found",
      });
    }

    // Identifiers come with the client; people and bank accounts only to
    // those who may read a client's private details.
    const profile = await profileService.readProfile(req.auth.organizationId, customer.id, {
      withPrivate: req.auth.permissions.includes("profiles.read"),
    });

    res.json({ ...customer, ...profile });
  } catch (error) {
    console.error("[ERROR] Error fetching customer:", error);

    res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : "Failed to fetch customer",
    });
  }
}

/*
 * =========================================================
 * CREATE CUSTOMER
 * =========================================================
 */

async function createCustomer(req, res) {
  try {
    const {
      name,
      company,
      email,
      phone,
      segment = "Standard",
      serviceIds = [],
      profile,
    } = req.body;

    /*
     * Validate name.
     */

    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({
        error: "Name is required",
      });
    }

    /*
     * Normalize service IDs.
     *
     * This validates the request format.
     *
     * Actual service existence is validated by
     * Customer Service through Service Service.
     */

    const normalizedServiceIds = normalizeServiceIds(serviceIds);

    if (normalizedServiceIds === null) {
      return res.status(400).json({
        error: "serviceIds must be an array of positive integers",
      });
    }

    /*
     * Extract JWT.
     */

    const token = getAuthorizationToken(req);

    /*
     * A profession profile (the client wizard) is checked against the
     * organization's bundle first, then saved inside the same transaction
     * as the client itself.
     */
    let extend;

    if (profile !== undefined) {
      if (!req.auth.permissions.includes("profiles.update")) {
        return res.status(403).json({ error: "Insufficient permissions", requiredPermission: "profiles.update" });
      }

      const bundle = await installedBundle(req.auth.organizationId, token);

      if (!bundle) {
        return res.status(400).json({ error: "A client profile needs a profession bundle installed" });
      }

      const checked = profileService.validateProfile(bundle, profile || {}, { creating: true });

      extend = (client, created) => profileService.writeProfile(client, req.auth.organizationId, created.id, checked);
    }

    /*
     * IMPORTANT:
     *
     * organizationId and ownerUserId come from
     * authenticated JWT context.
     *
     * They are never accepted from req.body.
     */

    const customer = await customerService.createCustomer(
      {
        organizationId: req.auth.organizationId,

        ownerUserId: req.auth.userId,

        name,
        company,
        email,
        phone,
        segment,

        serviceIds: normalizedServiceIds,
      },
      token,
      { extend },
    );

    // Not awaited: see lead-service. Conversion raises lead.converted instead,
    // so a converted lead does not also fire customer.created.
    notifyAutomation({
      event: "customer.created",
      dedupeKey: `customer.created:${customer.id}`,
      payload: { customer, userId: req.auth.userId },
      authorizationToken: token,
    });

    res.status(201).json(customer);
  } catch (error) {
    console.error("[ERROR] Error creating customer:", error);

    res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : "Failed to create customer",
      ...(error.details ? { details: error.details } : {}),
    });
  }
}

/*
 * =========================================================
 * UPDATE CUSTOMER
 * =========================================================
 */

async function updateCustomer(req, res) {
  try {
    const { name, company, email, phone, segment, profile } = req.body;

    /*
     * Archived and locked clients are protected for every write (both only
     * ever exist in organizations with a bundle).
     */
    await profileService.assertWritable(req.auth.organizationId, Number(req.params.id), req.auth.permissions);

    if (profile !== undefined) {
      if (!req.auth.permissions.includes("profiles.update")) {
        return res.status(403).json({ error: "Insufficient permissions", requiredPermission: "profiles.update" });
      }

      const bundle = await installedBundle(req.auth.organizationId, getAuthorizationToken(req));

      if (!bundle) {
        return res.status(400).json({ error: "A client profile needs a profession bundle installed" });
      }

      await profileService.updateProfile(
        { organizationId: req.auth.organizationId, userId: req.auth.userId, permissions: req.auth.permissions },
        bundle,
        Number(req.params.id),
        { ...profile, core: { name, company, email, phone } },
      );
    }

    /*
     * Validate name if supplied.
     */

    if (name !== undefined && (typeof name !== "string" || !name.trim())) {
      return res.status(400).json({
        error: "Name cannot be empty",
      });
    }

    const customer = await customerService.updateCustomer(
      req.params.id,

      req.auth.organizationId,

      req.auth.userId,

      req.auth.role,

      {
        name,
        company,
        email,
        phone,
        segment,
      },
    );

    if (!customer) {
      return res.status(404).json({
        error: "Customer not found",
      });
    }

    res.json(customer);
  } catch (error) {
    console.error("[ERROR] Error updating customer:", error);

    res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : "Failed to update customer",
      ...(error.details ? { details: error.details } : {}),
    });
  }
}

/*
 * =========================================================
 * GET CUSTOMER SERVICES
 * =========================================================
 */

async function getCustomerServices(req, res) {
  try {
    /*
     * Extract JWT for Service Service.
     */

    const token = getAuthorizationToken(req);

    const services = await customerService.getCustomerServices(
      req.params.id,

      req.auth.organizationId,

      req.auth.userId,

      req.auth.role,

      token,
    );

    /*
     * null means the customer does not exist or is not
     * accessible to the authenticated user.
     */

    if (services === null) {
      return res.status(404).json({
        error: "Customer not found",
      });
    }

    res.json(services);
  } catch (error) {
    console.error("[ERROR] Error fetching customer services:", error);

    res.status(error.statusCode || 500).json({
      error: error.statusCode
        ? error.message
        : "Failed to fetch customer services",
    });
  }
}

/*
 * =========================================================
 * CREATE CUSTOMER FROM LEAD
 * =========================================================
 *
 * Called by Lead Service during lead conversion.
 *
 * Customer Service owns customer creation and
 * customer_services mappings.
 * =========================================================
 */

async function createCustomerFromLead(req, res) {
  try {
    const { name, company, email, phone, serviceIds = [] } = req.body;

    /*
     * Validate name.
     */

    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({
        error: "Name is required",
      });
    }

    /*
     * Normalize service IDs.
     */

    const normalizedServiceIds = normalizeServiceIds(serviceIds);

    if (normalizedServiceIds === null) {
      return res.status(400).json({
        error: "serviceIds must be an array of positive integers",
      });
    }

    /*
     * Extract JWT.
     *
     * Lead Service forwarded the authenticated user's
     * JWT when calling this endpoint.
     */

    const token = getAuthorizationToken(req);

    /*
     * organizationId and ownerUserId are derived
     * from the JWT.
     */

    const customer = await customerService.createCustomerFromLead(
      {
        organizationId: req.auth.organizationId,

        ownerUserId: req.auth.userId,

        name,
        company,
        email,
        phone,

        serviceIds: normalizedServiceIds,
      },
      token,
    );

    res.status(201).json({
      message: "Customer created from lead successfully",

      customer,
    });
  } catch (error) {
    console.error("[ERROR] Error creating customer from lead:", error);

    res.status(error.statusCode || 500).json({
      error: error.statusCode
        ? error.message
        : "Failed to create customer from lead",
    });
  }
}

/*
 * =========================================================
 * UPDATE CUSTOMER SERVICES
 * =========================================================
 */

async function updateCustomerServices(req, res) {
  try {
    /*
     * Normalize service IDs.
     */

    const normalizedServiceIds = normalizeServiceIds(req.body.serviceIds ?? []);

    if (normalizedServiceIds === null) {
      return res.status(400).json({
        error: "serviceIds must be an array of positive integers",
      });
    }

    /*
     * Extract JWT for Service Service validation.
     */

    const token = getAuthorizationToken(req);

    const result = await customerService.updateCustomerServices(
      req.params.id,

      req.auth.organizationId,

      req.auth.userId,

      req.auth.role,

      normalizedServiceIds,

      token,
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

/*
 * =========================================================
 * DELETE CUSTOMER
 * =========================================================
 */

async function deleteCustomer(req, res) {
  try {
    /*
     * With a profession bundle, delete archives: the client disappears from
     * every list but its records are kept, and only an archived client can
     * be purged. Without one, delete works as it always has.
     */
    const bundle = await installedBundle(req.auth.organizationId, getAuthorizationToken(req));

    if (bundle) {
      await profileService.setArchived(
        { organizationId: req.auth.organizationId, userId: req.auth.userId, permissions: req.auth.permissions },
        Number(req.params.id),
        true,
      );

      return res.json({ message: "Customer archived", id: Number(req.params.id), archived: true });
    }

    const customer = await customerService.deleteCustomer(
      req.params.id,

      req.auth.organizationId,

      req.auth.userId,

      req.auth.role,
    );

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

    res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : "Failed to delete customer",
    });
  }
}

/*
 * =========================================================
 * EXPORTS
 * =========================================================
 */

module.exports = {
  health,
  getCustomers,
  validateCustomer,
  getCustomer,
  createCustomer,
  createCustomerFromLead,
  updateCustomer,
  getCustomerServices,
  updateCustomerServices,
  deleteCustomer,
};
