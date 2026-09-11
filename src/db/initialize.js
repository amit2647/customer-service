const pool = require("../config/database");

async function initializeDatabase() {
  console.log("[DB] Initializing customer database...");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      company VARCHAR(150),
      email VARCHAR(255),
      phone VARCHAR(50),
      segment VARCHAR(50) NOT NULL DEFAULT 'Standard',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
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
        ON DELETE CASCADE,

      CONSTRAINT fk_customer_services_service
        FOREIGN KEY (service_id)
        REFERENCES services(id)
        ON DELETE CASCADE
    );
  `);

  console.log("[DB] Customer database tables ready");
}

module.exports = {
  initializeDatabase,
};
