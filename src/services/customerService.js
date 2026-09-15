const pool = require("../config/database");

const SERVICE_SERVICE_URL =
  process.env.SERVICE_SERVICE_URL || "http://service-service:4003";

/*
 * =========================================================
 * SERVICE SERVICE CLIENT
 * =========================================================
 *
 * Customer Service does NOT directly query the services
 * table.
 *
 * Service Service is the logical owner of the service
 * catalog.
 *
 * Customer Service owns:
 *
 *     customers
 *     customer_services
 *
 * and stores service IDs as relationships.
 *
 * Service details are retrieved through Service Service.
 * =========================================================
 */

/*
 * =========================================================
 * GET SERVICES FROM SERVICE SERVICE
 * =========================================================
 *
 * Used when READING existing customer/service relationships.
 *
 * Both Active and Inactive services are allowed.
 *
 * This is important because an existing customer may still
 * reference a service that has subsequently been
 * deactivated.
 * =========================================================
 */

async function getServicesFromServiceService(serviceIds, authorizationToken) {
  if (!Array.isArray(serviceIds) || serviceIds.length === 0) {
    return [];
  }

  /*
   * Normalize and remove duplicate service IDs.
   */

  const uniqueServiceIds = [
    ...new Set(
      serviceIds
        .map((serviceId) => Number(serviceId))
        .filter((serviceId) => Number.isInteger(serviceId)),
    ),
  ];

  const services = [];

  /*
   * Service Service exposes:
   *
   * GET /services/:id
   *
   * This endpoint intentionally returns both Active and
   * Inactive services.
   */

  for (const serviceId of uniqueServiceIds) {
    const response = await fetch(
      `${SERVICE_SERVICE_URL}/services/${serviceId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${authorizationToken}`,
        },
      },
    );

    let responseBody = {};

    try {
      responseBody = await response.json();
    } catch (error) {
      responseBody = {};
    }

    /*
     * Service does not exist.
     */

    if (response.status === 404) {
      const error = new Error(`Service ${serviceId} not found`);

      error.statusCode = 400;

      throw error;
    }

    /*
     * Other Service Service error.
     */

    if (!response.ok) {
      const error = new Error(
        responseBody.error ||
          responseBody.message ||
          "Service Service request failed",
      );

      error.statusCode = response.status;

      throw error;
    }

    /*
     * Support both response shapes:
     *
     * {
     *   service: {...}
     * }
     *
     * and:
     *
     * {...}
     */

    const service = responseBody.service || responseBody;

    services.push(service);
  }

  return services;
}

/*
 * =========================================================
 * VALIDATE ACTIVE SERVICES
 * =========================================================
 *
 * Used when a USER is creating or updating a customer
 * ↔ service relationship.
 *
 * Inactive services cannot be newly assigned.
 *
 * Service Service remains authoritative for the service
 * lifecycle and status.
 * =========================================================
 */

async function validateActiveServices(serviceIds, authorizationToken) {
  if (!Array.isArray(serviceIds) || serviceIds.length === 0) {
    return [];
  }

  /*
   * Normalize and remove duplicate service IDs.
   */

  const uniqueServiceIds = [
    ...new Set(
      serviceIds
        .map((serviceId) => Number(serviceId))
        .filter((serviceId) => Number.isInteger(serviceId)),
    ),
  ];

  /*
   * Resolve services through Service Service.
   *
   * getServicesFromServiceService() handles:
   *
   *   - missing services
   *   - authorization
   *   - service-service errors
   */

  const services = await getServicesFromServiceService(
    uniqueServiceIds,
    authorizationToken,
  );

  /*
   * A service must be Active to be newly assigned.
   */

  for (const service of services) {
    if (service.status !== "Active") {
      const error = new Error(`Service ${service.id} is inactive`);

      error.statusCode = 409;

      throw error;
    }
  }

  return services;
}

/*
 * =========================================================
 * HEALTH
 * =========================================================
 */

async function checkHealth() {
  await pool.query("SELECT 1");
}

/*
 * =========================================================
 * GET ALL CUSTOMERS
 * =========================================================
 *
 * Tenant isolation:
 *
 * Every query is restricted to organizationId.
 *
 * Sales Representatives additionally see only customers
 * assigned to themselves.
 *
 * IMPORTANT:
 *
 * This query does NOT JOIN the services table.
 *
 * It only retrieves service IDs from customer_services.
 *
 * Service details are retrieved through Service Service.
 * =========================================================
 */

async function getAllCustomers(
  organizationId,
  userId,
  role,
  search = "",
  authorizationToken,
) {
  const q = search.trim();

  const searchValue = `%${q}%`;

  const values = [organizationId];

  let query = `
    SELECT
      c.id,
      c.organization_id,
      c.owner_user_id,
      c.name,
      c.company,
      c.email,
      c.phone,
      c.segment,
      c.created_at,
      c.updated_at,

      COALESCE(
        ARRAY_AGG(DISTINCT cs.service_id)
          FILTER (
            WHERE cs.service_id IS NOT NULL
          ),
        '{}'
      ) AS service_ids

    FROM customers c

    LEFT JOIN customer_services cs
      ON cs.customer_id = c.id

    WHERE c.organization_id = $1
  `;

  /*
   * Sales Representatives can only see
   * their own assigned customers.
   */

  if (role === "SALES_REP") {
    values.push(userId);

    query += `
      AND c.owner_user_id = $${values.length}
    `;
  }

  /*
   * Search.
   */

  if (q) {
    values.push(searchValue);

    query += `
      AND (
        c.name ILIKE $${values.length}
        OR c.company ILIKE $${values.length}
        OR c.email ILIKE $${values.length}
        OR c.phone ILIKE $${values.length}
      )
    `;
  }

  query += `
    GROUP BY c.id
    ORDER BY c.id DESC
  `;

  const result = await pool.query(query, values);

  /*
   * Collect every service ID across all customers.
   *
   * This avoids making duplicate Service Service calls
   * when several customers use the same service.
   */

  const allServiceIds = [
    ...new Set(
      result.rows.flatMap((customer) =>
        Array.isArray(customer.service_ids)
          ? customer.service_ids.map(Number)
          : [],
      ),
    ),
  ];

  /*
   * Retrieve service details from Service Service.
   *
   * Existing relationships to inactive services are allowed.
   */

  const services = await getServicesFromServiceService(
    allServiceIds,
    authorizationToken,
  );

  /*
   * Create:
   *
   * service ID → service object
   */

  const serviceMap = new Map(
    services.map((service) => [Number(service.id), service]),
  );

  /*
   * Restore the API response shape expected by the frontend.
   */

  return result.rows.map((customer) => {
    const serviceIds = Array.isArray(customer.service_ids)
      ? customer.service_ids.map(Number)
      : [];

    const customerServices = serviceIds
      .map((serviceId) => serviceMap.get(serviceId))
      .filter(Boolean)
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));

    const { service_ids, ...customerData } = customer;

    return {
      ...customerData,
      services: customerServices,
    };
  });
}

/*
 * =========================================================
 * CHECK CUSTOMER EXISTS / ACCESSIBLE
 * =========================================================
 *
 * Used by other services that need to validate a customer
 * without retrieving the complete customer record.
 *
 * Tenant isolation is enforced through organizationId.
 *
 * Sales Representatives can only validate their own
 * customers.
 * =========================================================
 */

async function customerExists(customerId, organizationId, userId, role) {
  const values = [customerId, organizationId];

  let query = `
    SELECT id
    FROM customers
    WHERE id = $1
      AND organization_id = $2
  `;

  if (role === "SALES_REP") {
    values.push(userId);

    query += `
      AND owner_user_id = $${values.length}
    `;
  }

  const result = await pool.query(query, values);

  return result.rows.length > 0;
}

/*
 * =========================================================
 * GET CUSTOMER BY ID
 * =========================================================
 */

async function getCustomerById(
  customerId,
  organizationId,
  userId,
  role,
  authorizationToken,
) {
  const values = [customerId, organizationId];

  let query = `
    SELECT
      id,
      organization_id,
      owner_user_id,
      name,
      company,
      email,
      phone,
      segment,
      created_at,
      updated_at
    FROM customers
    WHERE id = $1
      AND organization_id = $2
  `;

  /*
   * Sales Representatives can only access
   * their own customers.
   */

  if (role === "SALES_REP") {
    values.push(userId);

    query += `
      AND owner_user_id = $${values.length}
    `;
  }

  const customerResult = await pool.query(query, values);

  if (customerResult.rows.length === 0) {
    return null;
  }

  const services = await getCustomerServices(
    customerId,
    organizationId,
    userId,
    role,
    authorizationToken,
  );

  return {
    ...customerResult.rows[0],
    services,
  };
}

/*
 * =========================================================
 * CREATE CUSTOMER
 * =========================================================
 *
 * Service IDs are validated through Service Service.
 *
 * IMPORTANT:
 *
 * Only Active services may be newly assigned.
 *
 * Customer Service owns:
 *
 *     customers
 *     customer_services
 * =========================================================
 */

async function createCustomer(data, authorizationToken) {
  /*
   * Normalize service IDs.
   */

  const serviceIds = Array.isArray(data.serviceIds)
    ? [
        ...new Set(
          data.serviceIds
            .map((serviceId) => Number(serviceId))
            .filter((serviceId) => Number.isInteger(serviceId)),
        ),
      ]
    : [];

  /*
   * New customer relationships may only use Active
   * services.
   *
   * Perform the cross-service validation BEFORE opening
   * the database transaction.
   */

  await validateActiveServices(serviceIds, authorizationToken);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /*
     * Create customer.
     */

    const customerResult = await client.query(
      `
      INSERT INTO customers
      (
        organization_id,
        owner_user_id,
        name,
        company,
        email,
        phone,
        segment
      )
      VALUES
      ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
      `,
      [
        data.organizationId,
        data.ownerUserId,
        data.name.trim(),
        data.company?.trim() || null,
        data.email?.trim() || null,
        data.phone?.trim() || null,
        data.segment || "Standard",
      ],
    );

    const customer = customerResult.rows[0];

    /*
     * Create customer ↔ service mappings.
     *
     * Customer Service owns this relationship.
     */

    for (const serviceId of serviceIds) {
      await client.query(
        `
        INSERT INTO customer_services
        (
          customer_id,
          service_id
        )
        VALUES
        ($1, $2)
        `,
        [customer.id, serviceId],
      );
    }

    await client.query("COMMIT");

    return {
      ...customer,
      serviceIds,
    };
  } catch (error) {
    await client.query("ROLLBACK");

    throw error;
  } finally {
    client.release();
  }
}

/*
 * =========================================================
 * CREATE CUSTOMER FROM LEAD
 * =========================================================
 *
 * Called by Lead Service during lead conversion.
 *
 * Customer Service owns:
 *
 *   - customer creation
 *   - customer lookup
 *   - customer_services
 *
 * This operation is logically idempotent by email within
 * an organization.
 *
 * IMPORTANT:
 *
 * We intentionally DO NOT require services to be Active
 * here.
 *
 * A lead may have been created while a service was Active.
 * That service may subsequently have been deactivated.
 *
 * Converting the lead should preserve the existing
 * historical service relationship.
 * =========================================================
 */

async function createCustomerFromLead(data, authorizationToken) {
  /*
   * Normalize service IDs.
   */

  const serviceIds = Array.isArray(data.serviceIds)
    ? [
        ...new Set(
          data.serviceIds
            .map((serviceId) => Number(serviceId))
            .filter((serviceId) => Number.isInteger(serviceId)),
        ),
      ]
    : [];

  /*
   * Resolve services through Service Service.
   *
   * This validates that the services exist in the
   * organization but intentionally permits Inactive
   * services because these are existing lead relationships.
   */

  await getServicesFromServiceService(serviceIds, authorizationToken);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    let customer = null;

    /*
     * =======================================================
     * FIND EXISTING CUSTOMER
     * =======================================================
     *
     * Email uniqueness is scoped to the organization.
     */

    if (data.email) {
      const existingCustomerResult = await client.query(
        `
        SELECT
          id,
          organization_id,
          owner_user_id,
          name,
          company,
          email,
          phone,
          segment,
          created_at,
          updated_at
        FROM customers
        WHERE organization_id = $1
          AND LOWER(email) = LOWER($2)
        LIMIT 1
        `,
        [data.organizationId, data.email.trim()],
      );

      if (existingCustomerResult.rows.length > 0) {
        customer = existingCustomerResult.rows[0];

        console.log(`[CONVERT] Existing customer found id=${customer.id}`);
      }
    }

    /*
     * =======================================================
     * CREATE CUSTOMER
     * =======================================================
     */

    if (!customer) {
      const customerResult = await client.query(
        `
        INSERT INTO customers
        (
          organization_id,
          owner_user_id,
          name,
          company,
          email,
          phone,
          segment
        )
        VALUES
        ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
        `,
        [
          data.organizationId,
          data.ownerUserId,
          data.name.trim(),
          data.company?.trim() || null,
          data.email?.trim() || null,
          data.phone?.trim() || null,
          data.segment || "Standard",
        ],
      );

      customer = customerResult.rows[0];

      console.log(`[CONVERT] Created customer id=${customer.id}`);
    }

    /*
     * =======================================================
     * CREATE CUSTOMER ↔ SERVICE MAPPINGS
     * =======================================================
     *
     * Existing lead relationships are preserved.
     *
     * ON CONFLICT DO NOTHING prevents duplicate mappings
     * when converting into an existing customer.
     */

    for (const serviceId of serviceIds) {
      await client.query(
        `
        INSERT INTO customer_services
        (
          customer_id,
          service_id
        )
        VALUES
        ($1, $2)
        ON CONFLICT
        (
          customer_id,
          service_id
        )
        DO NOTHING
        `,
        [customer.id, serviceId],
      );
    }

    await client.query("COMMIT");

    /*
     * Retrieve service details after the transaction.
     *
     * Inactive services are allowed here.
     */

    const services = await getServicesFromServiceService(
      serviceIds,
      authorizationToken,
    );

    return {
      ...customer,
      services,
    };
  } catch (error) {
    await client.query("ROLLBACK");

    throw error;
  } finally {
    client.release();
  }
}

/*
 * =========================================================
 * UPDATE CUSTOMER
 * =========================================================
 */

async function updateCustomer(customerId, organizationId, userId, role, data) {
  const values = [
    data.name?.trim() || null,
    data.company?.trim() || null,
    data.email?.trim() || null,
    data.phone?.trim() || null,
    data.segment || null,
    customerId,
    organizationId,
  ];

  let query = `
    UPDATE customers

    SET
      name = COALESCE($1, name),
      company = COALESCE($2, company),
      email = COALESCE($3, email),
      phone = COALESCE($4, phone),
      segment = COALESCE($5, segment),
      updated_at = NOW()

    WHERE id = $6
      AND organization_id = $7
  `;

  /*
   * Sales Representatives can only update
   * their own customers.
   */

  if (role === "SALES_REP") {
    values.push(userId);

    query += `
      AND owner_user_id = $${values.length}
    `;
  }

  query += `
    RETURNING *
  `;

  const result = await pool.query(query, values);

  return result.rows[0] || null;
}

/*
 * =========================================================
 * GET CUSTOMER SERVICES
 * =========================================================
 *
 * Customer Service reads only:
 *
 *     customer_services.service_id
 *
 * Service details are retrieved through Service Service.
 *
 * Existing relationships to Inactive services remain
 * readable.
 * =========================================================
 */

async function getCustomerServices(
  customerId,
  organizationId,
  userId,
  role,
  authorizationToken,
) {
  const customerValues = [customerId, organizationId];

  let customerQuery = `
    SELECT id
    FROM customers
    WHERE id = $1
      AND organization_id = $2
  `;

  /*
   * Sales Representatives can only access
   * services belonging to their own customers.
   */

  if (role === "SALES_REP") {
    customerValues.push(userId);

    customerQuery += `
      AND owner_user_id = $${customerValues.length}
    `;
  }

  const customerResult = await pool.query(customerQuery, customerValues);

  if (customerResult.rows.length === 0) {
    return null;
  }

  /*
   * Retrieve service IDs from the local relationship.
   */

  const result = await pool.query(
    `
    SELECT
      service_id
    FROM customer_services
    WHERE customer_id = $1
    ORDER BY service_id
    `,
    [customerId],
  );

  const serviceIds = result.rows.map((row) => Number(row.service_id));

  /*
   * Retrieve actual service objects from Service Service.
   *
   * Active + Inactive are allowed.
   */

  const services = await getServicesFromServiceService(
    serviceIds,
    authorizationToken,
  );

  /*
   * Preserve alphabetical ordering.
   */

  return services.sort((a, b) =>
    String(a.name || "").localeCompare(String(b.name || "")),
  );
}

/*
 * =========================================================
 * UPDATE CUSTOMER SERVICES
 * =========================================================
 *
 * Customer Service manages the relationship.
 *
 * Service Service validates that every newly assigned
 * service is Active.
 * =========================================================
 */

async function updateCustomerServices(
  customerId,
  organizationId,
  userId,
  role,
  serviceIds,
  authorizationToken,
) {
  /*
   * Normalize service IDs.
   */

  const normalizedServiceIds = Array.isArray(serviceIds)
    ? [
        ...new Set(
          serviceIds
            .map((serviceId) => Number(serviceId))
            .filter((serviceId) => Number.isInteger(serviceId)),
        ),
      ]
    : [];

  /*
   * Only Active services can be assigned.
   *
   * Validation occurs BEFORE the database transaction.
   */

  await validateActiveServices(normalizedServiceIds, authorizationToken);

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    /*
     * Verify customer belongs to the authenticated
     * organization.
     */

    const customerValues = [customerId, organizationId];

    let customerQuery = `
      SELECT id
      FROM customers
      WHERE id = $1
        AND organization_id = $2
    `;

    /*
     * Sales Representatives can only modify
     * their own customers.
     */

    if (role === "SALES_REP") {
      customerValues.push(userId);

      customerQuery += `
        AND owner_user_id = $${customerValues.length}
      `;
    }

    const customerResult = await client.query(customerQuery, customerValues);

    if (customerResult.rows.length === 0) {
      const error = new Error("Customer not found");

      error.statusCode = 404;

      throw error;
    }

    /*
     * Remove existing mappings.
     */

    await client.query(
      `
      DELETE FROM customer_services
      WHERE customer_id = $1
      `,
      [customerId],
    );

    /*
     * Add new mappings.
     */

    for (const serviceId of normalizedServiceIds) {
      await client.query(
        `
        INSERT INTO customer_services
        (
          customer_id,
          service_id
        )
        VALUES
        ($1, $2)
        `,
        [customerId, serviceId],
      );
    }

    await client.query("COMMIT");

    return {
      customerId: Number(customerId),
      serviceIds: normalizedServiceIds,
    };
  } catch (error) {
    await client.query("ROLLBACK");

    throw error;
  } finally {
    client.release();
  }
}

/*
 * =========================================================
 * DELETE CUSTOMER
 * =========================================================
 */

async function deleteCustomer(customerId, organizationId, userId, role) {
  const values = [customerId, organizationId];

  let query = `
    DELETE FROM customers
    WHERE id = $1
      AND organization_id = $2
  `;

  /*
   * Sales Representatives can only delete
   * their own customers.
   */

  if (role === "SALES_REP") {
    values.push(userId);

    query += `
      AND owner_user_id = $${values.length}
    `;
  }

  query += `
    RETURNING id
  `;

  const result = await pool.query(query, values);

  return result.rows[0] || null;
}

/*
 * =========================================================
 * EXPORTS
 * =========================================================
 */

module.exports = {
  checkHealth,
  getAllCustomers,
  customerExists,
  getCustomerById,
  createCustomer,
  createCustomerFromLead,
  updateCustomer,
  getCustomerServices,
  updateCustomerServices,
  deleteCustomer,
};
