const pool = require("../config/database");

async function getAllCustomers(search = "") {
  const q = search.trim();
  const searchValue = `%${q}%`;

  const result = await pool.query(
    `
    SELECT
      c.id,
      c.name,
      c.company,
      c.email,
      c.phone,
      c.segment,
      c.created_at,
      c.updated_at,

      COALESCE(
        JSON_AGG(
          DISTINCT JSONB_BUILD_OBJECT(
            'id', s.id,
            'name', s.name,
            'description', s.description,
            'category', s.category,
            'status', s.status
          )
        ) FILTER (WHERE s.id IS NOT NULL),
        '[]'::json
      ) AS services

    FROM customers c

    LEFT JOIN customer_services cs
      ON cs.customer_id = c.id

    LEFT JOIN services s
      ON s.id = cs.service_id

    WHERE
      $1 = ''
      OR c.name ILIKE $2
      OR c.company ILIKE $2
      OR c.email ILIKE $2
      OR c.phone ILIKE $2

    GROUP BY c.id
    ORDER BY c.id DESC
    `,
    [q, searchValue],
  );

  return result.rows;
}

async function getCustomerById(customerId) {
  const customerResult = await pool.query(
    `
    SELECT
      id,
      name,
      company,
      email,
      phone,
      segment,
      created_at,
      updated_at
    FROM customers
    WHERE id = $1
    `,
    [customerId],
  );

  if (customerResult.rows.length === 0) {
    return null;
  }

  const servicesResult = await pool.query(
    `
    SELECT
      s.id,
      s.name,
      s.description,
      s.category,
      s.status
    FROM services s
    INNER JOIN customer_services cs
      ON cs.service_id = s.id
    WHERE cs.customer_id = $1
    ORDER BY s.name
    `,
    [customerId],
  );

  return {
    ...customerResult.rows[0],
    services: servicesResult.rows,
  };
}

async function createCustomer(data) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const customerResult = await client.query(
      `
      INSERT INTO customers
      (
        name,
        company,
        email,
        phone,
        segment
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [
        data.name.trim(),
        data.company?.trim() || null,
        data.email?.trim() || null,
        data.phone?.trim() || null,
        data.segment || "Standard",
      ],
    );

    const customer = customerResult.rows[0];

    if (data.serviceIds.length > 0) {
      const servicesResult = await client.query(
        `
        SELECT id
        FROM services
        WHERE id = ANY($1::int[])
        `,
        [data.serviceIds],
      );

      if (servicesResult.rows.length !== data.serviceIds.length) {
        const error = new Error("One or more service IDs are invalid");

        error.statusCode = 400;

        throw error;
      }

      for (const serviceId of data.serviceIds) {
        await client.query(
          `
          INSERT INTO customer_services
          (
            customer_id,
            service_id
          )
          VALUES ($1, $2)
          `,
          [customer.id, serviceId],
        );
      }
    }

    await client.query("COMMIT");

    return {
      ...customer,
      serviceIds: data.serviceIds,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function updateCustomer(customerId, data) {
  const result = await pool.query(
    `
    UPDATE customers
    SET
      name = COALESCE($1, name),
      company = COALESCE($2, company),
      email = COALESCE($3, email),
      phone = COALESCE($4, phone),
      segment = COALESCE($5, segment),
      updated_at = NOW()
    WHERE id = $6
    RETURNING *
    `,
    [
      data.name?.trim() || null,
      data.company?.trim() || null,
      data.email?.trim() || null,
      data.phone?.trim() || null,
      data.segment || null,
      customerId,
    ],
  );

  return result.rows[0] || null;
}

async function getCustomerServices(customerId) {
  const customerResult = await pool.query(
    `
    SELECT id
    FROM customers
    WHERE id = $1
    `,
    [customerId],
  );

  if (customerResult.rows.length === 0) {
    return null;
  }

  const result = await pool.query(
    `
    SELECT
      s.id,
      s.name,
      s.description,
      s.category,
      s.status
    FROM services s
    INNER JOIN customer_services cs
      ON cs.service_id = s.id
    WHERE cs.customer_id = $1
    ORDER BY s.name
    `,
    [customerId],
  );

  return result.rows;
}

async function updateCustomerServices(customerId, serviceIds) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const customerResult = await client.query(
      `
      SELECT id
      FROM customers
      WHERE id = $1
      `,
      [customerId],
    );

    if (customerResult.rows.length === 0) {
      const error = new Error("Customer not found");
      error.statusCode = 404;
      throw error;
    }

    if (serviceIds.length > 0) {
      const servicesResult = await client.query(
        `
        SELECT id
        FROM services
        WHERE id = ANY($1::int[])
        `,
        [serviceIds],
      );

      if (servicesResult.rows.length !== serviceIds.length) {
        const error = new Error("One or more service IDs are invalid");

        error.statusCode = 400;

        throw error;
      }
    }

    await client.query(
      `
      DELETE FROM customer_services
      WHERE customer_id = $1
      `,
      [customerId],
    );

    for (const serviceId of serviceIds) {
      await client.query(
        `
        INSERT INTO customer_services
        (
          customer_id,
          service_id
        )
        VALUES ($1, $2)
        `,
        [customerId, serviceId],
      );
    }

    await client.query("COMMIT");

    return {
      customerId: Number(customerId),
      serviceIds,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function deleteCustomer(customerId) {
  const result = await pool.query(
    `
    DELETE FROM customers
    WHERE id = $1
    RETURNING id
    `,
    [customerId],
  );

  return result.rows[0] || null;
}

async function checkHealth() {
  await pool.query("SELECT 1");
}

module.exports = {
  getAllCustomers,
  getCustomerById,
  createCustomer,
  updateCustomer,
  getCustomerServices,
  updateCustomerServices,
  deleteCustomer,
  checkHealth,
};
