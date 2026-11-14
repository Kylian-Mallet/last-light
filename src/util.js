// Small helpers shared by several modules.

/** An angle brought into [-π, π]. */
export function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/**
 * Weld a mesh's vertices by position (seam duplicates share an id): returns the welded id
 * of every vertex and the number of distinct positions. `scale` sets the tolerance
 * (positions are rounded to 1 / scale).
 */
export function weldPositions(pos, scale = 1e4) {
  const key = new Map();
  const weld = new Int32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const k = `${Math.round(pos.getX(i) * scale)},${Math.round(pos.getY(i) * scale)},${Math.round(pos.getZ(i) * scale)}`;
    let id = key.get(k);
    if (id === undefined) { id = key.size; key.set(k, id); }
    weld[i] = id;
  }
  return { weld, count: key.size };
}
