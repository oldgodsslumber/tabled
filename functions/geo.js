/* Tabled — geohash helpers, server side.
 *
 * MIRROR of ../js/geo.js. It is duplicated rather than imported because
 * `firebase deploy` only uploads the contents of functions/ — a require() that
 * reaches up into the repo works locally and then fails in production, which is
 * the worst possible place to discover it.
 *
 * Only encode() and jitter() are needed here; the query-bounds and distance
 * halves stay client-side. If you change the encoding in either file, change it
 * in both — a mismatch would put listings in geohash cells the client never
 * queries, and they'd simply never appear in distance search with no error
 * anywhere to explain why.
 */

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

function encode(lat, lng, precision = 9) {
  const latRange = [-90, 90];
  const lngRange = [-180, 180];
  let hash = '', bits = 0, bit = 0, even = true;

  while (hash.length < precision) {
    if (even) {
      const mid = (lngRange[0] + lngRange[1]) / 2;
      if (lng > mid) { bits = (bits << 1) + 1; lngRange[0] = mid; }
      else { bits = (bits << 1); lngRange[1] = mid; }
    } else {
      const mid = (latRange[0] + latRange[1]) / 2;
      if (lat > mid) { bits = (bits << 1) + 1; latRange[0] = mid; }
      else { bits = (bits << 1); latRange[1] = mid; }
    }
    even = !even;
    if (++bit === 5) { hash += BASE32.charAt(bits); bits = 0; bit = 0; }
  }
  return hash;
}

/* Uniform over a disc — sqrt() on the radius keeps the distribution even by
 * area instead of clustering near the true point, which would make the real
 * location recoverable by averaging repeated samples.
 *
 * Applied exactly once, at save time, and stored. Never re-rolled on read. */
function jitter(lat, lng, radiusMi) {
  const r = radiusMi * Math.sqrt(Math.random());
  const theta = Math.random() * 2 * Math.PI;
  const dLat = (r / 69.0) * Math.cos(theta);
  const lngMi = 69.0 * Math.cos(lat * Math.PI / 180);
  const dLng = lngMi > 0.001 ? (r / lngMi) * Math.sin(theta) : 0;
  return { lat: lat + dLat, lng: lng + dLng };
}

module.exports = { encode, jitter };
