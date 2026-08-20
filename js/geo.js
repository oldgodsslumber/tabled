/* Tabled — geohashing and distance.
 *
 * Firestore has no "find within N miles" query. The standard workaround (the
 * geofire pattern) is:
 *
 *   1. Store a geohash string alongside the GeoPoint.
 *   2. Pick a geohash precision whose cells are at least as wide as the search
 *      radius, then take the cell containing the center plus its 8 neighbors.
 *   3. Issue one range query per cell (>= prefix, <= prefix + '~'), because a
 *      geohash prefix range is exactly "everything inside that cell".
 *   4. Union the results and filter precisely with haversine on the client —
 *      the cells are square and the search area is a circle, so step 3 always
 *      over-returns.
 *
 * The 9-cell approach matters: a naive single-prefix query silently misses
 * anyone just across a cell boundary, which is invisible in testing (results
 * look plausible) and wrong in production.
 *
 * This file is loaded by BOTH the browser and functions/index.js, so it must
 * stay dependency-free and must not touch `window` at module top level.
 */
(function (root) {

  var BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

  var NEIGHBORS = {
    n: { even: 'p0r21436x8zb9dcf5h7kjnmqesgutwvy', odd: 'bc01fg45238967deuvhjyznpkmstqrwx' },
    s: { even: '14365h7k9dcfesgujnmqp0r2twvyx8zb', odd: '238967debc01fg45kmstqrwxuvhjyznp' },
    e: { even: 'bc01fg45238967deuvhjyznpkmstqrwx', odd: 'p0r21436x8zb9dcf5h7kjnmqesgutwvy' },
    w: { even: '238967debc01fg45kmstqrwxuvhjyznp', odd: '14365h7k9dcfesgujnmqp0r2twvyx8zb' }
  };

  var BORDERS = {
    n: { even: 'prxz',     odd: 'bcfguvyz' },
    s: { even: '028b',     odd: '0145hjnp' },
    e: { even: 'bcfguvyz', odd: 'prxz' },
    w: { even: '0145hjnp', odd: '028b' }
  };

  var EARTH_MI = 3958.8;

  /* Approximate width of a geohash cell, in miles, at each precision. Latitude
   * cells are exact; longitude cells narrow toward the poles, so these are the
   * *worst case* (equatorial) widths — which is the safe direction to err, since
   * overestimating cell size only means we query fewer, larger cells. */
  var CELL_MI = [
    5000,     /* 1 */
    1250,     /* 2 */
    156,      /* 3 */
    39,       /* 4 */
    4.9,      /* 5 */
    1.2,      /* 6 */
    0.15,     /* 7 */
    0.038,    /* 8 */
    0.0048    /* 9 */
  ];

  function encode(lat, lng, precision) {
    precision = precision || 9;
    var latRange = [-90, 90], lngRange = [-180, 180];
    var hash = '', bits = 0, bit = 0, even = true;

    while (hash.length < precision) {
      if (even) {
        var lngMid = (lngRange[0] + lngRange[1]) / 2;
        if (lng > lngMid) { bits = (bits << 1) + 1; lngRange[0] = lngMid; }
        else              { bits = (bits << 1);     lngRange[1] = lngMid; }
      } else {
        var latMid = (latRange[0] + latRange[1]) / 2;
        if (lat > latMid) { bits = (bits << 1) + 1; latRange[0] = latMid; }
        else              { bits = (bits << 1);     latRange[1] = latMid; }
      }
      even = !even;
      if (++bit === 5) {
        hash += BASE32.charAt(bits);
        bits = 0; bit = 0;
      }
    }
    return hash;
  }

  /* One step in a compass direction from `hash`, at the same precision. */
  function neighbor(hash, dir) {
    hash = hash.toLowerCase();
    var last = hash.charAt(hash.length - 1);
    var parent = hash.slice(0, -1);
    var type = (hash.length % 2) ? 'even' : 'odd';

    /* Stepping off the edge of the parent cell means the parent moves too —
     * recursion handles the carry, exactly like incrementing 199 to 200. */
    if (BORDERS[dir][type].indexOf(last) !== -1 && parent !== '') {
      parent = neighbor(parent, dir);
    }
    return parent + BASE32.charAt(NEIGHBORS[dir][type].indexOf(last));
  }

  /* The smallest precision whose cells are still at least as wide as `radiusMi`.
   * Larger cells → fewer, coarser queries → more client-side filtering; smaller
   * cells would need more than 9 of them to cover the circle. */
  function precisionFor(radiusMi) {
    for (var p = CELL_MI.length; p >= 1; p--) {
      if (CELL_MI[p - 1] >= radiusMi) return p;
    }
    return 1;
  }

  /* The 3x3 block of geohash prefixes covering a circle, as Firestore range
   * bounds. '~' sorts after every base32 character, so [prefix, prefix + '~']
   * is a closed range over exactly that cell's contents.
   *
   * Returns up to 9 { start, end } pairs — one query each. */
  function queryBounds(lat, lng, radiusMi) {
    var p = precisionFor(radiusMi);
    var center = encode(lat, lng, p);
    var cells = [center];

    var n = neighbor(center, 'n'), s = neighbor(center, 's');
    cells.push(n, s,
      neighbor(center, 'e'), neighbor(center, 'w'),
      neighbor(n, 'e'), neighbor(n, 'w'),
      neighbor(s, 'e'), neighbor(s, 'w'));

    var seen = {}, bounds = [];
    cells.forEach(function (c) {
      if (seen[c]) return;
      seen[c] = 1;
      bounds.push({ start: c, end: c + '~' });
    });
    return bounds;
  }

  function toRad(d) { return d * Math.PI / 180; }

  function distanceMi(lat1, lng1, lat2, lng2) {
    var dLat = toRad(lat2 - lat1);
    var dLng = toRad(lng2 - lng1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return EARTH_MI * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /* Displacement for the privacy fuzz. Uniform over a disc of `radiusMi` —
   * sqrt() on the radius is what keeps it uniform by area rather than clumping
   * results toward the center, which would make the true point guessable by
   * averaging repeated observations.
   *
   * This runs SERVER-SIDE only (functions/index.js), once, at save time. Fuzzing
   * on every read would let anyone average the jitter away and recover the real
   * coordinate; fuzzing once and storing the result is what actually protects it.
   */
  function jitter(lat, lng, radiusMi, rand) {
    rand = rand || Math.random;
    var r = radiusMi * Math.sqrt(rand());
    var theta = rand() * 2 * Math.PI;
    var dLat = (r / 69.0) * Math.cos(theta);
    var lngMi = 69.0 * Math.cos(toRad(lat));
    var dLng = lngMi > 0.001 ? (r / lngMi) * Math.sin(theta) : 0;
    return { lat: lat + dLat, lng: lng + dLng };
  }

  /* Rounded, deliberately vague — "about 8 miles away", never "8.31 miles". The
   * point is fuzzed anyway; showing decimals implies a precision we don't have
   * and shouldn't suggest. */
  function describeDistance(mi) {
    if (mi === null || mi === undefined || isNaN(mi)) return '';
    if (mi < 1) return 'under a mile away';
    if (mi < 10) return 'about ' + Math.round(mi) + ' mi away';
    return Math.round(mi / 5) * 5 + '+ mi away';
  }

  var Geo = {
    encode: encode,
    neighbor: neighbor,
    precisionFor: precisionFor,
    queryBounds: queryBounds,
    distanceMi: distanceMi,
    jitter: jitter,
    describeDistance: describeDistance
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Geo;
  else root.Geo = Geo;

})(typeof self !== 'undefined' ? self : this);
