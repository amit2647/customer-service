const pool = require("../config/database");

async function initializeDatabase() {
  console.log("[DB] Initializing customer database...");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL,
      owner_user_id INTEGER,
      name VARCHAR(150) NOT NULL,
      company VARCHAR(150),
      email VARCHAR(255),
      phone VARCHAR(50),
      segment VARCHAR(50) NOT NULL DEFAULT 'Standard',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT customers_organization_fk
        FOREIGN KEY (organization_id)
        REFERENCES organizations(id)
        ON DELETE CASCADE
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_customers_organization_id
    ON customers(organization_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_customers_owner_user_id
    ON customers(owner_user_id)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_services (
      customer_id INTEGER NOT NULL,
      service_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      PRIMARY KEY (customer_id, service_id),

      CONSTRAINT fk_customer_services_customer
        FOREIGN KEY (customer_id)
        REFERENCES customers(id)
        ON DELETE CASCADE
    );
  `);

  console.log("[DB] Customer database tables ready");
}

module.exports = {
  initializeDatabase,
};
