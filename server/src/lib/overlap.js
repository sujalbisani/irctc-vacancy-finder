/** Build station-code -> route-order-index map from an ordered list of station codes. */
function buildRouteIndex(routeCodes) {
  const idx = new Map();
  routeCodes.forEach((code, i) => {
    if (!idx.has(code)) idx.set(code, i);
  });
  return idx;
}

/**
 * True if a berth vacant from `vacantFromCode` to `vacantToCode` fully covers
 * the user's requested journey from `userFromCode` to `userToCode`, given the
 * train's station order.
 */
function journeyIsCovered(routeIndex, vacantFromCode, vacantToCode, userFromCode, userToCode) {
  const vf = routeIndex.get(vacantFromCode);
  const vt = routeIndex.get(vacantToCode);
  const uf = routeIndex.get(userFromCode);
  const ut = routeIndex.get(userToCode);
  if ([vf, vt, uf, ut].some((v) => v === undefined)) return false;
  if (uf >= ut) return false;
  return vf <= uf && vt >= ut;
}

module.exports = { buildRouteIndex, journeyIsCovered };
