const pool = require("../config/database");

/*
 * The customer's side of the lead ↔ customer link (migration 017). A lead
 * and the customer it became are one entity kept by two services:
 * lead-service records leads.converted_customer_id, and this records which
 * lead the customer was first won from.
 *
 * Linking is idempotent. A customer already won from another lead keeps that
 * one (several leads may convert into one customer); a lead that already
 * became a different customer is refused.
 */

function failure(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function linkSourceLead({ organizationId, userId, role }, customerId, leadId) {
  const values = [customerId, organizationId];
  let scope = "";

  // Sales representatives link only their own customers, as everywhere else.
  if (role === "SALES_REP") {
    values.push(userId);
    scope = ` AND owner_user_id = $${values.length}`;
  }

  const found = await pool.query(
    `SELECT id, name, source_lead_id FROM customers WHERE id = $1 AND organization_id = $2${scope}`,
    values,
  );
  const customer = found.rows[0];

  if (!customer) throw failure("Customer not found", 404);
  if (customer.source_lead_id !== null && customer.source_lead_id !== undefined) return customer;

  const taken = await pool.query(
    `SELECT id, name FROM customers WHERE organization_id = $1 AND source_lead_id = $2`,
    [organizationId, leadId],
  );

  if (taken.rows[0]) {
    throw failure(`That lead already became ${taken.rows[0].name}`, 409);
  }

  try {
    const updated = await pool.query(
      `
      UPDATE customers SET source_lead_id = $3, updated_at = NOW()
      WHERE id = $1 AND organization_id = $2 AND source_lead_id IS NULL
      RETURNING id, name, source_lead_id
      `,
      [customerId, organizationId, leadId],
    );

    // Someone linked it in between: theirs stands.
    return updated.rows[0] || (await pool.query(`SELECT id, name, source_lead_id FROM customers WHERE id = $1`, [customerId])).rows[0];
  } catch (error) {
    if (error.code === "23505") throw failure("That lead already became another customer", 409);
    throw error;
  }
}

module.exports = { linkSourceLead };
