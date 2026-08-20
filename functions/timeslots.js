/* Tabled -- slot generation, server side.
 *
 * MIRROR of ../js/timeslots.js, copied rather than imported because
 * `firebase deploy` only uploads the contents of functions/ -- a require()
 * reaching up into the repo works locally and fails in production.
 *
 * The bookSlot callable re-derives every instant the client sends rather than
 * trusting it, so if these two files ever diverge the symptom is slots the
 * server rejects for no reason the user can see. Change one, change both.
 */
(function (root) {

  var SLOT_MINUTES = 30;
  var DAYS_AHEAD = 14;

  /* ---- Timezone primitives ------------------------------------------------ */

  /* How far `tz` is from UTC at this instant, in ms. Derived by asking Intl to
   * format the instant in that zone, then reading the result back as if it were
   * UTC — the difference is the offset. This is the standard way to do it
   * without shipping a tz database, and it handles DST because Intl does. */
  function tzOffsetMs(date, tz) {
    var dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    var p = {};
    dtf.formatToParts(date).forEach(function (part) { p[part.type] = part.value; });
    /* Intl renders midnight as hour 24 in some engines. */
    var hour = p.hour === '24' ? 0 : Number(p.hour);
    var asIfUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day),
      hour, Number(p.minute), Number(p.second));
    return asIfUtc - date.getTime();
  }

  /* Wall-clock date + time in `tz` -> the UTC instant it refers to.
   *
   * Two passes, because the offset depends on the instant we're trying to find:
   * the first guess uses the offset at the naive UTC interpretation, the second
   * corrects it. That matters on DST boundaries, where a naive single pass can
   * land an hour out. */
  function zonedToUtc(dateStr, timeStr, tz) {
    var d = String(dateStr).split('-').map(Number);
    var t = String(timeStr).split(':').map(Number);
    var naive = Date.UTC(d[0], d[1] - 1, d[2], t[0], t[1] || 0);

    var offset = tzOffsetMs(new Date(naive), tz);
    var firstPass = naive - offset;
    offset = tzOffsetMs(new Date(firstPass), tz);
    return naive - offset;
  }

  /* The calendar date in `tz` at a given instant, as 'YYYY-MM-DD'. */
  function dateStrIn(ms, tz) {
    var dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
    });
    /* en-CA formats as YYYY-MM-DD, which is what we want to store. */
    return dtf.format(new Date(ms));
  }

  /* Day of week for a 'YYYY-MM-DD' string. Pure calendar math — no timezone
   * involved, because a date string already names one specific day. */
  function dayOfWeek(dateStr) {
    var d = String(dateStr).split('-').map(Number);
    return new Date(Date.UTC(d[0], d[1] - 1, d[2])).getUTCDay();
  }

  /* ---- Time helpers ------------------------------------------------------- */

  function toMinutes(hhmm) {
    var t = String(hhmm).split(':').map(Number);
    return t[0] * 60 + (t[1] || 0);
  }
  function toHHMM(mins) {
    var h = Math.floor(mins / 60), m = mins % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  /* Deterministic slot ID. THIS is the exclusivity mechanism: a second attempt
   * to create the same ID simply fails, so no locking or transaction is needed
   * to prevent double-booking. Keyed on the seller, not the listing, so the
   * same person can't be booked twice at once across two different listings.
   *
   * CONSTRUCT ONLY — never split this back apart. Firebase Auth UIDs are
   * alphanumeric so the underscore separator is unambiguous in production, but
   * that is a property of the UID format, not something this string guarantees.
   * The demo backend's ids (`demo_theo`) already contain underscores, and
   * parsing one yields a nonsense date that fails validation for a reason that
   * points nowhere near the real cause. Carry date and startTime as their own
   * fields — every caller already has them. */
  function slotId(sellerId, dateStr, startTime) {
    return sellerId + '_' + dateStr + '_' + startTime;
  }

  /* Does this slot fall inside the seller's standing availability? */
  function withinWindows(windows, dateStr, startTime, slotMinutes) {
    var dow = dayOfWeek(dateStr);
    var start = toMinutes(startTime);
    var end = start + (slotMinutes || SLOT_MINUTES);
    return (windows || []).some(function (w) {
      return Number(w.dayOfWeek) === dow &&
        start >= toMinutes(w.startTime) &&
        end <= toMinutes(w.endTime);
    });
  }

  /* ---- Slot generation ---------------------------------------------------- */

  /* Every open increment across the next DAYS_AHEAD days.
   *
   * opts: { fromMs, days, slotMinutes, taken (array of slot ids), sellerId,
   *         eventStart, eventEnd }
   *
   * `eventStart`/`eventEnd` constrain generation to a convention window (M9).
   * The point of an event listing is meeting at the con, not at the seller's
   * house next Tuesday — so when they're set, the standing weekly schedule is
   * intersected with them rather than used as-is.
   */
  function generateSlots(windows, tz, opts) {
    opts = opts || {};
    if (!windows || !windows.length || !tz) return [];

    var slotMinutes = opts.slotMinutes || SLOT_MINUTES;
    var days = opts.days || DAYS_AHEAD;
    var fromMs = opts.fromMs || Date.now();
    var sellerId = opts.sellerId || '';
    var taken = {};
    (opts.taken || []).forEach(function (id) { taken[id] = true; });

    var out = [];
    for (var i = 0; i < days; i++) {
      var dateStr = dateStrIn(fromMs + i * 86400000, tz);
      var dow = dayOfWeek(dateStr);

      windows.forEach(function (w) {
        if (Number(w.dayOfWeek) !== dow) return;
        var wStart = toMinutes(w.startTime);
        var wEnd = toMinutes(w.endTime);

        for (var m = wStart; m + slotMinutes <= wEnd; m += slotMinutes) {
          var startTime = toHHMM(m);
          var startsAtMs = zonedToUtc(dateStr, startTime, tz);

          /* Past slots are not offers. */
          if (startsAtMs <= fromMs) continue;
          if (opts.eventStart && startsAtMs < opts.eventStart) continue;
          if (opts.eventEnd && startsAtMs > opts.eventEnd) continue;

          var id = slotId(sellerId, dateStr, startTime);
          if (taken[id]) continue;

          out.push({
            id: id,
            date: dateStr,
            startTime: startTime,
            endTime: toHHMM(m + slotMinutes),
            startsAtMs: startsAtMs,
            endsAtMs: startsAtMs + slotMinutes * 60000
          });
        }
      });
    }
    return out.sort(function (a, b) { return a.startsAtMs - b.startsAtMs; });
  }

  /* Group slots by their calendar day, for rendering. Returns
   * [{ date, label, slots: [...] }] in chronological order. */
  function groupByDay(slots, tz) {
    var byDate = {}, order = [];
    slots.forEach(function (s) {
      if (!byDate[s.date]) { byDate[s.date] = []; order.push(s.date); }
      byDate[s.date].push(s);
    });
    return order.map(function (date) {
      return { date: date, label: dayLabel(byDate[date][0].startsAtMs, tz), slots: byDate[date] };
    });
  }

  function dayLabel(ms, tz) {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: tz, weekday: 'short', month: 'short', day: 'numeric'
    }).format(new Date(ms));
  }

  /* Rendered in the VIEWER's zone, not the seller's — the buyer needs to know
   * when to leave their own house. The seller's zone only decides which
   * instants the slots are. */
  function localTimeLabel(ms) {
    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric', minute: '2-digit'
    }).format(new Date(ms));
  }

  function currentZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
    } catch (e) {
      return 'America/New_York';
    }
  }

  /* Do two zones show the same wall-clock time right now? Used to decide
   * whether to warn a buyer that the seller is in a different timezone —
   * showing "(their 2pm)" on every slot when both are Eastern is noise. */
  function sameOffset(tzA, tzB, atMs) {
    if (!tzA || !tzB || tzA === tzB) return true;
    var d = new Date(atMs || Date.now());
    return tzOffsetMs(d, tzA) === tzOffsetMs(d, tzB);
  }

  var TimeSlots = {
    SLOT_MINUTES: SLOT_MINUTES,
    DAYS_AHEAD: DAYS_AHEAD,
    tzOffsetMs: tzOffsetMs,
    zonedToUtc: zonedToUtc,
    dateStrIn: dateStrIn,
    dayOfWeek: dayOfWeek,
    toMinutes: toMinutes,
    toHHMM: toHHMM,
    slotId: slotId,
    withinWindows: withinWindows,
    generateSlots: generateSlots,
    groupByDay: groupByDay,
    dayLabel: dayLabel,
    localTimeLabel: localTimeLabel,
    currentZone: currentZone,
    sameOffset: sameOffset
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = TimeSlots;
  else root.TimeSlots = TimeSlots;

})(typeof self !== 'undefined' ? self : this);
