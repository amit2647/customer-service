const profileService = require("../services/profileService");

/*
 * Routes for a client's profession profile (see profileService). All of
 * them sit behind requireBundle.
 */

function id(value, label = "id") {
  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    const error = new Error(`Invalid ${label}`);
    error.statusCode = 400;
    throw error;
  }

  return number;
}

const auth = (req) => ({
  organizationId: req.auth.organizationId,
  userId: req.auth.userId,
  permissions: req.auth.permissions,
});

function respond(handler) {
  return async (req, res) => {
    try {
      const result = await handler(req, res);

      if (!res.headersSent) {
        res.json(result ?? { ok: true });
      }
    } catch (error) {
      if (!error.statusCode) {
        console.error("[Profile]", error);
      }

      res.status(error.statusCode || 500).json({
        error: error.statusCode ? error.message : "The client could not be updated",
        ...(error.details ? { details: error.details } : {}),
      });
    }
  };
}

module.exports = {
  checkIdentifier: respond((req) => {
    if (!req.query.type || !req.query.value) {
      const error = new Error("type and value are required");
      error.statusCode = 400;
      throw error;
    }

    return profileService.checkIdentifier(req.auth.organizationId, String(req.query.type), String(req.query.value), req.query.exclude ? id(req.query.exclude, "exclude") : null);
  }),

  replacePeople: respond(async (req) => {
    await profileService.replacePeople(auth(req), req.bundle, id(req.params.id), req.body?.people);
  }),

  listBankAccounts: respond((req) => profileService.bankAccounts(req.auth.organizationId, id(req.params.id))),

  addBankAccount: respond(async (req, res) => {
    res.status(201);
    return profileService.addBankAccount(auth(req), id(req.params.id), req.body || {});
  }),

  updateBankAccount: respond((req) => profileService.updateBankAccount(auth(req), id(req.params.id), id(req.params.accountId, "account id"), req.body || {})),

  setPrimaryBankAccount: respond((req) => profileService.setPrimaryBankAccount(auth(req), id(req.params.id), id(req.params.accountId, "account id"))),

  removeBankAccount: respond((req) => profileService.removeBankAccount(auth(req), id(req.params.id), id(req.params.accountId, "account id"))),

  lock: respond((req) => profileService.setLocked(auth(req), id(req.params.id), true)),
  unlock: respond((req) => profileService.setLocked(auth(req), id(req.params.id), false)),

  archive: respond((req) => profileService.setArchived(auth(req), id(req.params.id), true)),
  restore: respond((req) => profileService.setArchived(auth(req), id(req.params.id), false)),

  purge: respond((req) => profileService.purge(auth(req), id(req.params.id))),
};
