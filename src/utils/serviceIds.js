function normalizeServiceIds(serviceIds) {
  if (!Array.isArray(serviceIds)) {
    return null;
  }

  const normalized = [];

  for (const serviceId of serviceIds) {
    const id = Number(serviceId);

    if (!Number.isInteger(id) || id <= 0) {
      return null;
    }

    normalized.push(id);
  }

  return [...new Set(normalized)];
}

module.exports = {
  normalizeServiceIds,
};
