const props = PropertiesService.getScriptProperties();

type BookingPeriod = 'day' | 'week' | 'month' | 'quarter' | 'year';

interface EventType {
  id: string;
  name: string;
  duration: number;
  selectable: boolean;
  description?: string;
  WORKDAYS?: number[];
  WORKHOURS?: { start: number; end: number };
  MAX_DAYS_IN_ADVANCE?: number;
  MIN_DAYS_IN_ADVANCE?: number;
  CALENDARS?: string[];
  schedulingStrategy?: 'collective' | 'round_robin';
  // Max bookings limit (undefined/0 = no limit). Active only when maxBookings > 0
  // and maxBookingsPeriod is set. Applies to the whole event type (aggregate).
  maxBookings?: number;
  maxBookingsPeriod?: BookingPeriod;
  // Guest permissions
  guestsCanModify?: boolean;
  guestsCanInviteOthers?: boolean;
  guestsCanSeeOtherGuests?: boolean;
  // Meeting visibility
  visibility?: 'default' | 'public' | 'private';
}

// Read a JSON script property defensively. Script properties are hand-editable
// and can hold corrupt or wrong-shaped JSON, and CONFIG below is built once at
// module load — so a bare JSON.parse that throws takes down *every* entry point,
// including setConfig. That leaves the app unrepairable from its own UI and only
// fixable from the Apps Script editor. Fall back to the default whenever the
// value is missing, unparseable, or the wrong shape.
function parseProp<T>(name: string, isValid: (value: any) => boolean, fallback: () => T): T {
  const raw = props.getProperty(name);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (isValid(parsed)) return parsed as T;
    } catch (e) {
      // fall through to the default
    }
  }
  return fallback();
}

const CONFIG = {
  TIME_ZONE: props.getProperty('TIME_ZONE') || "America/New_York",
  WORKDAYS: parseProp('WORKDAYS', (v) => Array.isArray(v), () => [1, 2, 3, 4, 5]),
  WORKHOURS: parseProp(
    'WORKHOURS',
    (v) => !!v && typeof v.start === 'number' && typeof v.end === 'number',
    () => ({ start: 9, end: 16 })
  ),
  MAX_DAYS_IN_ADVANCE: parseInt(props.getProperty('MAX_DAYS_IN_ADVANCE') || "28", 10),
  MIN_DAYS_IN_ADVANCE: parseInt(props.getProperty('MIN_DAYS_IN_ADVANCE') || "0", 10),
  // An empty list is treated as unusable too: every caller falls back to
  // CONFIG.EVENT_TYPES[0], which would be undefined.
  EVENT_TYPES: parseProp<EventType[]>(
    'EVENT_TYPES',
    (v) => Array.isArray(v) && v.length > 0,
    () => {
      // Migration from legacy TIMESLOT_DURATION
      const legacyDuration = parseInt(props.getProperty('TIMESLOT_DURATION') || "30", 10);
      return [{
        id: "default",
        name: "Appointment",
        duration: legacyDuration,
        selectable: true
      }];
    }
  ),
  CALENDARS: parseProp('CALENDARS', (v) => Array.isArray(v), () => ["primary"]),
  schedulingStrategy: (props.getProperty('schedulingStrategy') || 'collective') as 'collective' | 'round_robin'
};

function isOwner(): boolean {
  try {
    const effectiveUser = Session.getEffectiveUser().getEmail();
    const activeUser = Session.getActiveUser().getEmail();
    // In "Execute as: Me" mode, activeUser is empty unless the user has authorized the script.
    // If they are the owner, they definitely have.
    return effectiveUser === activeUser && effectiveUser !== "";
  } catch (e) {
    return false;
  }
}

// Whitelisted per-event fields that are safe to expose to anonymous visitors.
// Every other EventType field is internal and must never reach the public
// config: CALENDARS overrides (teammate email addresses), scheduling policy
// (schedulingStrategy, maxBookings/maxBookingsPeriod), guest permissions, and
// visibility. Building a fresh object (whitelist) rather than deleting known
// keys means a newly-added EventType field can't silently leak in the future.
function toPublicEventType(et: EventType) {
  return {
    id: et.id,
    name: et.name,
    duration: et.duration,
    selectable: et.selectable,
    description: et.description,
  };
}

function getConfig() {
  const config = {
    TIME_ZONE: CONFIG.TIME_ZONE,
    WORKDAYS: CONFIG.WORKDAYS,
    WORKHOURS: CONFIG.WORKHOURS,
    MAX_DAYS_IN_ADVANCE: CONFIG.MAX_DAYS_IN_ADVANCE,
    MIN_DAYS_IN_ADVANCE: CONFIG.MIN_DAYS_IN_ADVANCE,
    EVENT_TYPES: CONFIG.EVENT_TYPES,
    CALENDARS: CONFIG.CALENDARS,
    schedulingStrategy: CONFIG.schedulingStrategy,
  };

  if (!isOwner()) {
    // Public projection for anonymous visitors. Returning EVENT_TYPES verbatim
    // leaked per-event CALENDARS (teammate emails) and internal scheduling
    // policy, so project each event type to its public fields and drop the
    // owner-only top-level policy (CALENDARS, schedulingStrategy).
    return {
      TIME_ZONE: config.TIME_ZONE,
      WORKDAYS: config.WORKDAYS,
      WORKHOURS: config.WORKHOURS,
      MAX_DAYS_IN_ADVANCE: config.MAX_DAYS_IN_ADVANCE,
      MIN_DAYS_IN_ADVANCE: config.MIN_DAYS_IN_ADVANCE,
      EVENT_TYPES: config.EVENT_TYPES.map(toPublicEventType),
      CALENDARS: [],
    };
  }

  return config;
}

function setConfig(newConfig: Partial<typeof CONFIG>) {
  if (!isOwner()) {
    throw new Error("Unauthorized: Only the script owner can update configuration.");
  }

  // Reject an empty calendar list. With no calendars there is nothing to check
  // for conflicts, so availability fails *open* (a collective strategy compares
  // 0 free === 0 queried and offers every work-hour slot) and every booking then
  // targets an undefined calendar. `[]` is truthy, so the setters below would
  // otherwise store it happily and report success.
  if (newConfig.CALENDARS && newConfig.CALENDARS.length === 0) {
    throw new Error("At least one monitored calendar is required.");
  }
  // Likewise an empty work-day list: it stores fine ([] is truthy, and the
  // loader keeps the "[]" string over its default), then every slot fails the
  // work-day filter and the picker is silently empty forever.
  if (newConfig.WORKDAYS && newConfig.WORKDAYS.length === 0) {
    throw new Error("At least one available day is required.");
  }
  if (newConfig.EVENT_TYPES) {
    for (const et of newConfig.EVENT_TYPES) {
      // undefined = inherit the global list; [] = the same fail-open trap.
      if (et.CALENDARS && et.CALENDARS.length === 0) {
        throw new Error(
          `Event type "${et.name}" must monitor at least one calendar, or reset it to use the global setting.`
        );
      }
      if (et.WORKDAYS && et.WORKDAYS.length === 0) {
        throw new Error(
          `Event type "${et.name}" must have at least one available day, or reset it to use the global setting.`
        );
      }
    }
  }

  if (newConfig.TIME_ZONE) props.setProperty('TIME_ZONE', newConfig.TIME_ZONE);
  if (newConfig.WORKDAYS) props.setProperty('WORKDAYS', JSON.stringify(newConfig.WORKDAYS));
  if (newConfig.WORKHOURS) props.setProperty('WORKHOURS', JSON.stringify(newConfig.WORKHOURS));
  if (newConfig.MAX_DAYS_IN_ADVANCE !== undefined) props.setProperty('MAX_DAYS_IN_ADVANCE', newConfig.MAX_DAYS_IN_ADVANCE.toString());
  if (newConfig.MIN_DAYS_IN_ADVANCE !== undefined) props.setProperty('MIN_DAYS_IN_ADVANCE', newConfig.MIN_DAYS_IN_ADVANCE.toString());
  if (newConfig.EVENT_TYPES) props.setProperty('EVENT_TYPES', JSON.stringify(newConfig.EVENT_TYPES));
  if (newConfig.CALENDARS) props.setProperty('CALENDARS', JSON.stringify(newConfig.CALENDARS));
  if (newConfig.schedulingStrategy) props.setProperty('schedulingStrategy', newConfig.schedulingStrategy);

  return { success: true };
}

function listCalendars() {
  if (!isOwner()) {
    throw new Error("Unauthorized: Only the script owner can list calendars.");
  }
  const calendars = CalendarApp.getAllCalendars();
  return calendars.map(cal => ({
    id: cal.getId(),
    name: cal.getName(),
  }));
}

function getScriptUrl(): string {
  return ScriptApp.getService().getUrl();
}

function doGet(): GoogleAppsScript.HTML.HtmlOutput {
  return HtmlService.createHtmlOutputFromFile("dist/index")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

const VALID_BOOKING_PERIODS: BookingPeriod[] = ['day', 'week', 'month', 'quarter', 'year'];

// Returns true when the event type has an active max-bookings limit.
function hasBookingLimit(eventType: EventType): boolean {
  return typeof eventType.maxBookings === 'number'
    && eventType.maxBookings > 0
    && VALID_BOOKING_PERIODS.indexOf(eventType.maxBookingsPeriod as BookingPeriod) >= 0;
}

// How far the count window must reach back from "now" to cover the *start* of
// the current period (which for longer periods began well before now), sized
// generously per period so the current bucket is never undercounted.
function periodPaddingMs(period: BookingPeriod): number {
  const DAY = 24 * 60 * 60 * 1000;
  switch (period) {
    case 'day': return 2 * DAY;
    case 'week': return 9 * DAY;
    case 'month': return 40 * DAY;
    case 'quarter': return 100 * DAY;
    case 'year': return 375 * DAY;
  }
}

// Bucket key for a date within the configured time zone. Bookings sharing a key
// fall in the same limit period. Weeks start on Sunday; quarters and years are
// calendar-based (Q1 = Jan–Mar, etc.).
function periodKey(date: Date, period: BookingPeriod, tz: string): string {
  if (period === 'year') {
    return Utilities.formatDate(date, tz, "yyyy");
  }
  if (period === 'quarter') {
    const [yy, mm] = Utilities.formatDate(date, tz, "yyyy-MM").split("-").map(Number);
    return yy + "-Q" + (Math.floor((mm - 1) / 3) + 1);
  }
  if (period === 'month') {
    return Utilities.formatDate(date, tz, "yyyy-MM");
  }
  if (period === 'day') {
    return Utilities.formatDate(date, tz, "yyyy-MM-dd");
  }
  // week: key by the date of the preceding Sunday (in tz). Do the subtraction as
  // whole-day calendar arithmetic in UTC — subtracting raw milliseconds off the
  // original timestamp and re-formatting in tz can land on the wrong day across
  // a DST transition within the week.
  const dow = parseInt(Utilities.formatDate(date, tz, "u"), 10) % 7; // u: 1=Mon..7=Sun -> 0=Sun
  const [y, m, d] = Utilities.formatDate(date, tz, "yyyy-MM-dd").split("-").map(Number);
  const weekStart = new Date(Date.UTC(y, m - 1, d));
  weekStart.setUTCDate(weekStart.getUTCDate() - dow);
  return Utilities.formatDate(weekStart, "UTC", "yyyy-MM-dd");
}

// Counts existing bookings of an event type per period bucket across the given
// calendars. Each booking is tagged (private extended property) on exactly one
// calendar (organizer/target copy), so summing across calendars does not double
// count and yields the aggregate for the whole event type.
//
// A calendar whose access was revoked (or that was deleted) makes Events.list
// throw, which would take the whole caller down. Record it in `failedCalendars`
// and carry on instead. Note this is NOT freebusy's fail-closed situation: an
// unreadable calendar here means the result is an *undercount*, which is
// fail-OPEN for the limit — so a caller that enforces the limit must treat a
// non-empty `failedCalendars` as "cannot verify", not as "no bookings".
function countBookingsByPeriod(
  calendarIds: string[],
  eventTypeId: string,
  timeMin: Date,
  timeMax: Date,
  period: BookingPeriod,
  tz: string
): { counts: Record<string, number>; failedCalendars: string[] } {
  const counts: Record<string, number> = {};
  const failedCalendars: string[] = [];
  calendarIds.forEach((calId) => {
    try {
      let pageToken: string | undefined = undefined;
      do {
        const resp: any = Calendar.Events!.list(calId, {
          privateExtendedProperty: 'somedayEventTypeId=' + eventTypeId,
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          singleEvents: true,
          showDeleted: false,
          maxResults: 2500,
          pageToken,
        });
        (resp.items || []).forEach((ev: any) => {
          // Don't let cancelled bookings consume limit slots.
          if (ev.status === 'cancelled') return;
          const startStr = ev.start && (ev.start.dateTime || ev.start.date);
          if (!startStr) return;
          const key = periodKey(new Date(startStr), period, tz);
          counts[key] = (counts[key] || 0) + 1;
        });
        pageToken = resp.nextPageToken;
      } while (pageToken);
    } catch (e) {
      // Revoked access, deleted calendar, transient API failure. Anything this
      // calendar contributed is now unknown (and may be partial if it failed
      // mid-paging), so the caller decides what an unverifiable count means.
      failedCalendars.push(calId);
    }
  });
  return { counts, failedCalendars };
}

// Utilities.formatDate crosses the JS<->Java bridge and dominates availability
// generation: isSlotWithinWindow resolves three tz instants per slot (dayAnchor,
// dayClose, windowEnd) and each did two formatDate calls, so a 90-day window of
// 15-minute slots (~2,500 slots) cost thousands of round-trips.
//
// Both lookups are *pure* functions of their inputs, so memoize them rather than
// hoisting the loop-invariant parts out of isSlotWithinWindow — that would mean
// splitting it, and it has to stay the single shared filter bookTimeslot
// re-validates against. One implementation, no drift.
//
// Caches live for one execution (Apps Script re-evaluates globals per run) and
// are keyed on everything the result depends on, so they can't go stale.
const localDateCache: Record<string, string> = {};
const tzInstantCache: Record<string, number> = {};

// UTC instant of `hour:00` local time in `tz`, `days` whole calendar days after
// `from`'s local date. Reading the zone offset *at the target date/hour* (not at
// `from`) keeps it correct across DST transitions.
function tzHourPlusDays(from: Date, tz: string, days: number, hour: number): Date {
  // dayAnchor and dayClose resolve the same slot, and windowEnd re-resolves the
  // loop-invariant `now`, so this lookup repeats constantly.
  const fromKey = tz + "|" + from.getTime();
  let localDate = localDateCache[fromKey];
  if (localDate === undefined) {
    localDate = Utilities.formatDate(from, tz, "yyyy-MM-dd");
    localDateCache[fromKey] = localDate;
  }
  const [y, m, d] = localDate.split("-").map(Number);

  // Local wall-clock time of the target date/hour, first read as if it were UTC.
  // This value *is* the (y-m-d, hour) key: every slot on a given day resolves to
  // the same handful of them (workHours.start, workHours.end, midnight).
  const wallAsUTC = Date.UTC(y, m - 1, d + days, hour);
  const targetKey = tz + "|" + wallAsUTC;
  const cached = tzInstantCache[targetKey];
  if (cached !== undefined) return new Date(cached);

  // Shift by the zone's offset at that instant to get the true UTC instant. "Z"
  // yields an RFC-822 offset like "-0400"; local = UTC + offset, so the UTC
  // instant of the local wall time is wallAsUTC - offset.
  const offset = Utilities.formatDate(new Date(wallAsUTC), tz, "Z");
  const sign = offset.charAt(0) === '-' ? -1 : 1;
  const offsetMin = sign * (parseInt(offset.slice(1, 3), 10) * 60 + parseInt(offset.slice(3, 5), 10));
  const resolved = wallAsUTC - offsetMin * 60000;
  tzInstantCache[targetKey] = resolved;
  return new Date(resolved);
}

// UTC instant of midnight in `tz`, `days` whole calendar days after `from`.
// Used for the minimum-notice boundary so "N days out" is measured as N local
// days (midnight in the configured time zone), not from UTC midnight — which
// for a non-UTC zone would let same-evening slots slip past the cutoff.
function tzMidnightPlusDays(from: Date, tz: string, days: number): Date {
  return tzHourPlusDays(from, tz, days, 0);
}

// Per-slot window checks shared by fetchAvailability (which builds the grid) and
// bookTimeslot (which re-validates an incoming slot). Covers grid alignment,
// past-time, max-days-in-advance, work hours, and work days — every per-slot
// filter that does not depend on calendar freebusy or the max-bookings count.
// Keeping this in one place means the anonymously-callable bookTimeslot cannot
// drift out of sync with what the availability builder allows. `now` is the
// reference instant both callers pass so their notions of "now"/window end match.
function isSlotWithinWindow(startTime: Date, eventType: EventType, now: Date): boolean {
  const timeZone = CONFIG.TIME_ZONE;
  const workDays = eventType.WORKDAYS ?? CONFIG.WORKDAYS;
  const workHours = eventType.WORKHOURS ?? CONFIG.WORKHOURS;
  const daysInAdvance = eventType.MAX_DAYS_IN_ADVANCE ?? CONFIG.MAX_DAYS_IN_ADVANCE;
  const durationMs = eventType.duration * 60000;
  const t = startTime.getTime();

  // Past-time: not before now.
  if (t < now.getTime()) return false;
  // Grid alignment: each local day's slots are anchored to workHours.start (not
  // the UTC epoch), so boundaries line up with the start of the work window for
  // any duration or zone offset. Reject slots that fall between the grid points.
  const dayAnchor = tzHourPlusDays(startTime, timeZone, 0, workHours.start).getTime();
  if (t < dayAnchor) return false;
  if ((t - dayAnchor) % durationMs !== 0) return false;
  // The whole slot must fit inside the work window — end on/before close, not
  // just start before it. Checking only the start hour lets a slot spill past
  // workHours.end (e.g. a 90-min slot starting 16:30 against a 17:00 close).
  // (t >= dayAnchor above already enforces start >= workHours.start.)
  const dayClose = tzHourPlusDays(startTime, timeZone, 0, workHours.end).getTime();
  if (t + durationMs > dayClose) return false;
  // Max days in advance: the whole slot must end on/before the window end —
  // local midnight `daysInAdvance` days out, matching fetchAvailability's `end`.
  const windowEnd = tzMidnightPlusDays(now, timeZone, daysInAdvance).getTime();
  if (t + durationMs > windowEnd) return false;
  // Work day in the configured time zone.
  const startTZ = new Date(
    Utilities.formatDate(startTime, timeZone, "yyyy-MM-dd'T'HH:mm:ss")
  );
  if (workDays.indexOf(startTZ.getDay()) < 0) return false;
  return true;
}

// Interpret a Freebusy response for one calendar. A revoked, deleted, or
// otherwise inaccessible calendar comes back with a populated `errors` array
// (and an empty `busy`); reading `.busy` alone would treat it as fully free and
// offer/confirm slots that actually conflict. Fail closed: return the busy
// intervals only when the result is trustworthy, or null when the calendar must
// be treated as busy.
function freebusyIntervals(
  response: any,
  calendarId: string
): { start: Date; end: Date }[] | null {
  const cal = response && response.calendars && response.calendars[calendarId];
  if (!cal || (cal.errors && cal.errors.length > 0) || !Array.isArray(cal.busy)) {
    return null;
  }
  return cal.busy.map((b: { start: string; end: string }) => ({
    start: new Date(b.start),
    end: new Date(b.end),
  }));
}

function fetchAvailability(eventTypeId?: string): {
  timeslots: string[];
  durationMinutes: number;
} {
  const eventType = CONFIG.EVENT_TYPES.find((et: EventType) => et.id === eventTypeId) || CONFIG.EVENT_TYPES[0];
  const durationMinutes = eventType.duration;
  const durationMs = durationMinutes * 60000;

  // Use event-specific overrides or fall back to global CONFIG. Work hours and
  // work days are read inside isSlotWithinWindow, the shared per-slot filter.
  const timeZone = CONFIG.TIME_ZONE;
  const daysInAdvance = eventType.MAX_DAYS_IN_ADVANCE ?? CONFIG.MAX_DAYS_IN_ADVANCE;
  const minDaysInAdvance = eventType.MIN_DAYS_IN_ADVANCE ?? CONFIG.MIN_DAYS_IN_ADVANCE ?? 0;
  const calendarsToQuery = eventType.CALENDARS ?? CONFIG.CALENDARS;

  // No calendars means nothing can be checked for conflicts, so we cannot know
  // any slot is actually free. Fail closed and offer nothing — otherwise the
  // collective comparison below (freeCalendarsCount === calendarsToQuery.length)
  // is 0 === 0 for every slot and the whole work week looks bookable.
  if (calendarsToQuery.length === 0) {
    return { timeslots: [], durationMinutes };
  }

  const now = new Date();
  // End of the booking window: local midnight `daysInAdvance` days out, in the
  // configured time zone — the same basis as every other boundary (see
  // tzMidnightPlusDays). Using UTC midnight here would shift the window by the
  // zone offset and drop/truncate the final advance day for non-UTC zones.
  const end = tzMidnightPlusDays(now, timeZone, daysInAdvance);
  // Earliest bookable moment: enforce a minimum lead time so slots sooner than
  // `minDaysInAdvance` days out are hidden (0 = no minimum). Measured as whole
  // calendar days in the configured time zone.
  const minStart = minDaysInAdvance > 0
    ? tzMidnightPlusDays(now, timeZone, minDaysInAdvance)
    : now;

  const response = Calendar.Freebusy!.query({
    timeMin: now.toISOString(),
    timeMax: end.toISOString(),
    items: calendarsToQuery.map((id: string) => ({ id })),
  });

  // null for a calendar means its freebusy couldn't be trusted (errored /
  // inaccessible); such calendars are treated as busy below (fail closed).
  const eventsByCalendar: Record<string, { start: Date; end: Date }[] | null> = {};
  calendarsToQuery.forEach((calendarId: string) => {
    eventsByCalendar[calendarId] = freebusyIntervals(response, calendarId);
  });

  // If a max-bookings limit is active, count existing bookings once over the
  // whole window, bucketed by period, so maxed-out periods can be hidden.
  // The lower bound reaches back far enough (per period) to fully cover the
  // *current* period, which usually started before now (and much earlier for
  // quarter/year) — otherwise it would be undercounted and slots shown that
  // bookTimeslot then rejects.
  // Note: the upper bound is only `end` (now + daysInAdvance), not padded, so a
  // period straddling the end of the display window could be undercounted here
  // relative to bookTimeslot's padded check. That can only happen if bookings
  // exist beyond the scheduling window; the authoritative check in bookTimeslot
  // still prevents overbooking, so the worst case is a slot shown then rejected.
  //
  // Counting is best-effort here: a calendar we can't read (revoked access, say)
  // is reported in failedCalendars and simply leaves its bookings uncounted, so
  // a maxed-out period may still show slots. That lands in the same worst case
  // as the note above — shown, then rejected by the authoritative check in
  // bookTimeslot — and is far better than one revoked teammate calendar taking
  // the whole availability page down.
  const limitActive = hasBookingLimit(eventType);
  const countFrom = limitActive
    ? new Date(now.getTime() - periodPaddingMs(eventType.maxBookingsPeriod!))
    : now;
  const bookingCounts = limitActive
    ? countBookingsByPeriod(calendarsToQuery, eventType.id, countFrom, end, eventType.maxBookingsPeriod!, timeZone).counts
    : {};

  //get all timeslots between now and end date
  const timeslots = [];
  const strategy = eventType.schedulingStrategy ?? CONFIG.schedulingStrategy ?? 'collective';
  const workHours = eventType.WORKHOURS ?? CONFIG.WORKHOURS;

  // Generate slots one local day at a time, anchoring each day's grid to
  // workHours.start (recomputed per day so it stays correct across DST). This
  // keeps slot boundaries aligned to the start of the work window for any
  // duration or zone offset; an epoch-anchored grid would phase them to UTC
  // midnight, which only coincides with workHours.start for whole-hour
  // durations in whole-hour-offset zones. isSlotWithinWindow re-validates every
  // candidate (and does the work-day filtering), so it stays authoritative.
  for (let dayOffset = 0; dayOffset <= daysInAdvance + 1; dayOffset++) {
    const dayStart = tzHourPlusDays(now, timeZone, dayOffset, workHours.start);
    if (dayStart.getTime() >= end.getTime()) break;
    // Work-window close for this local day; slots must end on/before it so none
    // spills past workHours.end.
    const dayClose = tzHourPlusDays(now, timeZone, dayOffset, workHours.end).getTime();

    for (
      let t = dayStart.getTime();
      t + durationMs <= end.getTime() && t + durationMs <= dayClose;
      t += durationMs
    ) {
      const start = new Date(t);
      // Enforce the minimum lead time: hide slots earlier than minStart.
      if (t < minStart.getTime()) continue;
      // Per-slot window filters (alignment, past-time, max-days, work
      // hours/days), shared with bookTimeslot so the two can't drift.
      if (!isSlotWithinWindow(start, eventType, now)) continue;

      const endTime = new Date(t + durationMs);
      const freeCalendarsCount = calendarsToQuery.filter((calId: string) => {
        const intervals = eventsByCalendar[calId];
        // An errored/inaccessible calendar (null) is treated as busy.
        if (intervals === null) return false;
        return !intervals.some((event) => event.start < endTime && event.end > start);
      }).length;

      const isAvailable = strategy === 'round_robin'
        ? freeCalendarsCount > 0
        : freeCalendarsCount === calendarsToQuery.length;

      if (!isAvailable) continue;

      // Skip slots whose period has already reached the booking limit.
      if (limitActive) {
        const key = periodKey(start, eventType.maxBookingsPeriod!, timeZone);
        if ((bookingCounts[key] || 0) >= eventType.maxBookings!) continue;
      }

      timeslots.push(start.toISOString());
    }
  }
  return { timeslots, durationMinutes };
}

// Actionable message for when the booking's target calendar isn't writable.
// Booking writes an event to the target calendar (Events.insert), which needs
// writer/owner access; read (freebusy) access only lets us check it for
// conflicts. See the README "Calendar Access" section.
function calendarWriteError(calendarId: string): string {
  return `Cannot create the booking on calendar "${calendarId}": the scheduler `
    + `only has read access to it. Grant it "Make changes to events" access in `
    + `Google Calendar, or remove it from this event type's calendars.`;
}

// Best-effort check of whether the script owner can write to `calendarId`.
// Returns true/false when the access role is known, or null when it can't be
// determined (e.g. the calendar isn't in the owner's calendar list) — in which
// case we let the insert proceed and classify any permission error instead.
function calendarIsWritable(calendarId: string): boolean | null {
  try {
    const entry: any = Calendar.CalendarList!.get(calendarId);
    const role = entry && entry.accessRole;
    if (role === 'owner' || role === 'writer') return true;
    if (role === 'reader' || role === 'freeBusyReader') return false;
    return null;
  } catch (e) {
    return null;
  }
}

function bookTimeslot(
  timeslot: string,
  name: string,
  email: string,
  phone: string,
  note: string,
  eventTypeId?: string
): string {
  const eventType = CONFIG.EVENT_TYPES.find((et: EventType) => et.id === eventTypeId) || CONFIG.EVENT_TYPES[0];
  const durationMinutes = eventType.duration;
  const calendarsToUse = eventType.CALENDARS ?? CONFIG.CALENDARS;
  // Without a calendar there is nothing to check for conflicts and the collective
  // check below would pass vacuously (0 free !== 0 used is false), leaving
  // Events.insert to target an undefined calendar. Fail closed.
  if (calendarsToUse.length === 0) {
    throw new Error("No calendars are configured for booking");
  }
  const startTime = new Date(timeslot);
  if (isNaN(startTime.getTime())) {
    throw new Error("Invalid start time");
  }
  const endTime = new Date(startTime.getTime());
  endTime.setUTCMinutes(startTime.getUTCMinutes() + durationMinutes);

  // Authoritative availability re-validation: bookTimeslot is anonymously
  // callable, so a crafted or stale request must satisfy the same per-slot
  // filters the picker applied (grid alignment, past-time, max-days-in-advance,
  // work hours, work days). Without this, a request could book 3am, a weekend,
  // a past slot, or one years out as long as the calendar happened to be free.
  if (!isSlotWithinWindow(startTime, eventType, new Date())) {
    throw new Error("This time is not available for booking");
  }

  // Authoritative minimum-lead-time check: reject bookings sooner than the
  // configured minimum days out, so a stale client can't book inside the window.
  const minDaysInAdvance = eventType.MIN_DAYS_IN_ADVANCE ?? CONFIG.MIN_DAYS_IN_ADVANCE ?? 0;
  if (minDaysInAdvance > 0) {
    const minStart = tzMidnightPlusDays(new Date(), CONFIG.TIME_ZONE, minDaysInAdvance);
    if (startTime.getTime() < minStart.getTime()) {
      throw new Error("This time is too soon; please choose a later time");
    }
  }

  // Serialize the freebusy check and the event creation under the script lock so
  // two concurrent bookings of the same slot can't both pass freebusy and both
  // insert (TOCTOU double-booking). Acquired unconditionally — it previously
  // wrapped only the max-bookings path, leaving unlimited event types racy. The
  // lock is global to the script and also covers the count-then-insert below.
  const bookingLock = LockService.getScriptLock();
  try {
    bookingLock.waitLock(15000);
  } catch (e) {
    throw new Error("Server is busy, please try again");
  }

  // Authoritative max-bookings pre-check (only when a limit is active). Count
  // over a window that comfortably covers the slot's period, then look up the
  // slot's own period bucket. This runs before the create-event try below, so
  // release the lock on any failure here (including the count query throwing)
  // and rethrow unchanged; on success the lock stays held through event
  // creation, where the finally block releases it.
  if (hasBookingLimit(eventType)) {
    try {
      const tz = CONFIG.TIME_ZONE;
      const period = eventType.maxBookingsPeriod!;
      const padMs = periodPaddingMs(period);
      const { counts, failedCalendars } = countBookingsByPeriod(
        calendarsToUse,
        eventType.id,
        new Date(startTime.getTime() - padMs),
        new Date(startTime.getTime() + padMs),
        period,
        tz
      );
      // A calendar we couldn't read may hold bookings for this period, so the
      // count is an undercount and trusting it could let the limit be exceeded.
      // This check is the authoritative one, so fail closed instead. (The
      // availability page tolerates the same failure — it only risks showing a
      // slot that this check then rejects.)
      if (failedCalendars.length > 0) {
        throw new Error("Could not verify the booking limit, please try again");
      }
      const key = periodKey(startTime, period, tz);
      if ((counts[key] || 0) >= eventType.maxBookings!) {
        throw new Error("Booking limit reached for this period");
      }
    } catch (e) {
      bookingLock.releaseLock();
      throw e;
    }
  }

  // Chosen inside the try (round-robin picks a free calendar; collective uses
  // the first), but declared out here so the catch can name it in access errors.
  let targetCalendarId = calendarsToUse[0];
  try {
    const possibleEvents = Calendar.Freebusy!.query({
      timeMin: startTime.toISOString(),
      timeMax: endTime.toISOString(),
      items: calendarsToUse.map((id: string) => ({ id })),
    });

    const freeCalendars = calendarsToUse.filter((calId: string) => {
      const intervals = freebusyIntervals(possibleEvents, calId);
      // null = errored/inaccessible calendar; not free (fail closed).
      return intervals !== null && intervals.length === 0;
    });

    const strategy = eventType.schedulingStrategy ?? CONFIG.schedulingStrategy ?? 'collective';
    let guestsToInvite = [email];

    if (strategy === 'round_robin') {
      if (freeCalendars.length === 0) {
        throw new Error("Timeslot not available");
      }
      // Randomly select one of the free calendars
      targetCalendarId = freeCalendars[Math.floor(Math.random() * freeCalendars.length)];
      // Round Robin: Only the assignee (targetCalendar) and the customer (email) attend.
      // guestsToInvite remains [email]
    } else {
      // Collective: Check if ALL are free
      if (freeCalendars.length !== calendarsToUse.length) {
        throw new Error("Timeslot not available");
      }
      // Default to first calendar
      targetCalendarId = calendarsToUse[0];
      // Collective: Invite all other calendars so everyone is blocked/attending
      const teamGuests = calendarsToUse.filter((id: string) => id !== targetCalendarId);
      guestsToInvite = [...guestsToInvite, ...teamGuests];
    }

    // Guard: Events.insert below writes to targetCalendarId, which requires
    // writer/owner access — read (freebusy) access is enough to check a calendar
    // for conflicts but not to book on it. When we can tell the target is
    // read-only, fail early with an actionable message (the insert's own
    // permission error is translated the same way in the catch below).
    if (calendarIsWritable(targetCalendarId) === false) {
      throw new Error(calendarWriteError(targetCalendarId));
    }

    // Create the event atomically with its event-type tag, using the advanced
    // Calendar API (Events.insert) rather than CalendarApp.createEvent followed
    // by a separate patch. A two-step create-then-tag can fail *after* the event
    // exists and invites have been sent, which would both report a real booking
    // as failed AND leave it untagged — invisible to countBookingsByPeriod, so
    // the limit would permanently under-count and a retry would duplicate the
    // booking. One insert makes it a single atomic operation and also gives us
    // the real event id directly (no fragile iCalUID suffix stripping).
    //
    // somedayEventTypeId is a *private* extended property (countBookingsByPeriod
    // filters on privateExtendedProperty). Private properties live only on the
    // organizer/target copy and don't propagate to guest calendars, which keeps
    // that function's single-copy assumption valid so summing across calendars
    // never double counts. sendUpdates: 'all' preserves the prior sendInvites.
    const resource: any = {
      summary: `Appointment with ${name}`,
      description: `Phone: ${phone}\nNote: ${note}`,
      start: { dateTime: startTime.toISOString() },
      end: { dateTime: endTime.toISOString() },
      status: "confirmed",
      attendees: guestsToInvite.map((guestEmail: string) => ({ email: guestEmail })),
      // Guest permissions (defaults: modify=false, invite=false, see=true)
      guestsCanModify: eventType.guestsCanModify ?? false,
      guestsCanInviteOthers: eventType.guestsCanInviteOthers ?? false,
      guestsCanSeeOtherGuests: eventType.guestsCanSeeOtherGuests ?? true,
      extendedProperties: { private: { somedayEventTypeId: eventType.id } },
    };
    // Visibility ('default' needs no explicit value)
    if (eventType.visibility === 'public') {
      resource.visibility = 'public';
    } else if (eventType.visibility === 'private') {
      resource.visibility = 'private';
    }

    Calendar.Events!.insert(resource, targetCalendarId, { sendUpdates: 'all' });

    return `Timeslot booked successfully`;
  } catch (e) {
    const error = e as Error;
    // The proactive guard's message is already actionable — pass it through.
    if (error.message === calendarWriteError(targetCalendarId)) {
      throw error;
    }
    // A permission failure from Events.insert means the target calendar isn't
    // writable; surface the same actionable message instead of the generic
    // wrapper. Google reports this as 403 / "forbidden" / "writer access".
    if (/forbidden|writer access|permission|access denied|insufficient|do not have/i.test(error.message)) {
      throw new Error(calendarWriteError(targetCalendarId));
    }
    throw new Error(`Failed to create event: ${error.message}`);
  } finally {
    bookingLock.releaseLock();
  }
}
