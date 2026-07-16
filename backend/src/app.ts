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

const CONFIG = {
  TIME_ZONE: props.getProperty('TIME_ZONE') || "America/New_York",
  WORKDAYS: JSON.parse(props.getProperty('WORKDAYS') || "[1, 2, 3, 4, 5]"),
  WORKHOURS: JSON.parse(props.getProperty('WORKHOURS') || '{"start": 9, "end": 16}'),
  MAX_DAYS_IN_ADVANCE: parseInt(props.getProperty('MAX_DAYS_IN_ADVANCE') || "28", 10),
  MIN_DAYS_IN_ADVANCE: parseInt(props.getProperty('MIN_DAYS_IN_ADVANCE') || "0", 10),
  EVENT_TYPES: (() => {
    const etProp = props.getProperty('EVENT_TYPES');
    if (etProp) return JSON.parse(etProp) as EventType[];

    // Migration from legacy TIMESLOT_DURATION
    const legacyDuration = parseInt(props.getProperty('TIMESLOT_DURATION') || "30", 10);
    return [{
      id: "default",
      name: "Appointment",
      duration: legacyDuration,
      selectable: true
    }] as EventType[];
  })(),
  CALENDARS: (() => {
    const calendarsProp = props.getProperty('CALENDARS');
    try {
      if (!calendarsProp) return ["primary"];
      const parsed = JSON.parse(calendarsProp);
      return Array.isArray(parsed) ? parsed : ["primary"];
    } catch (e) {
      return ["primary"];
    }
  })(),
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
    // Return safe public config for visitors
    return { ...config, CALENDARS: [] };
  }

  return config;
}

function setConfig(newConfig: Partial<typeof CONFIG>) {
  if (!isOwner()) {
    throw new Error("Unauthorized: Only the script owner can update configuration.");
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
function countBookingsByPeriod(
  calendarIds: string[],
  eventTypeId: string,
  timeMin: Date,
  timeMax: Date,
  period: BookingPeriod,
  tz: string
): Record<string, number> {
  const counts: Record<string, number> = {};
  calendarIds.forEach((calId) => {
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
  });
  return counts;
}

// UTC instant of midnight in `tz`, `days` whole calendar days after `from`.
// Used for the minimum-notice boundary so "N days out" is measured as N local
// days (midnight in the configured time zone), not from UTC midnight — which
// for a non-UTC zone would let same-evening slots slip past the cutoff.
function tzMidnightPlusDays(from: Date, tz: string, days: number): Date {
  const [y, m, d] = Utilities.formatDate(from, tz, "yyyy-MM-dd").split("-").map(Number);
  // Local wall-clock midnight of the target date, first read as if it were UTC.
  const wallAsUTC = new Date(Date.UTC(y, m - 1, d + days));
  // Shift by the zone's offset at that date to get the true UTC instant. "Z"
  // yields an RFC-822 offset like "-0400"; local = UTC + offset, so the UTC
  // instant of local midnight is wallAsUTC - offset.
  const offset = Utilities.formatDate(wallAsUTC, tz, "Z");
  const sign = offset.charAt(0) === '-' ? -1 : 1;
  const offsetMin = sign * (parseInt(offset.slice(1, 3), 10) * 60 + parseInt(offset.slice(3, 5), 10));
  return new Date(wallAsUTC.getTime() - offsetMin * 60000);
}

function fetchAvailability(eventTypeId?: string): {
  timeslots: string[];
  durationMinutes: number;
} {
  const eventType = CONFIG.EVENT_TYPES.find((et: EventType) => et.id === eventTypeId) || CONFIG.EVENT_TYPES[0];
  const durationMinutes = eventType.duration;
  const durationMs = durationMinutes * 60000;

  // Use event-specific overrides or fall back to global CONFIG
  const timeZone = CONFIG.TIME_ZONE;
  const workDays = eventType.WORKDAYS ?? CONFIG.WORKDAYS;
  const workHours = eventType.WORKHOURS ?? CONFIG.WORKHOURS;
  const daysInAdvance = eventType.MAX_DAYS_IN_ADVANCE ?? CONFIG.MAX_DAYS_IN_ADVANCE;
  const minDaysInAdvance = eventType.MIN_DAYS_IN_ADVANCE ?? CONFIG.MIN_DAYS_IN_ADVANCE ?? 0;
  const calendarsToQuery = eventType.CALENDARS ?? CONFIG.CALENDARS;

  const nearestTimeslot = new Date(
    Math.floor(new Date().getTime() / durationMs) * durationMs
  );
  const now = nearestTimeslot;
  const end = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + daysInAdvance
    )
  );
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

  const eventsByCalendar: Record<string, { start: Date; end: Date }[]> = {};
  calendarsToQuery.forEach((calendarId: string) => {
    const busyTimes = (response as any).calendars[calendarId].busy;
    eventsByCalendar[calendarId] = busyTimes.map(({ start, end }: { start: string; end: string }) => ({
      start: new Date(start),
      end: new Date(end)
    }));
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
  const limitActive = hasBookingLimit(eventType);
  const countFrom = limitActive
    ? new Date(now.getTime() - periodPaddingMs(eventType.maxBookingsPeriod!))
    : now;
  const bookingCounts = limitActive
    ? countBookingsByPeriod(calendarsToQuery, eventType.id, countFrom, end, eventType.maxBookingsPeriod!, timeZone)
    : {};

  //get all timeslots between now and end date
  const timeslots = [];
  const strategy = eventType.schedulingStrategy ?? CONFIG.schedulingStrategy ?? 'collective';

  for (
    let t = nearestTimeslot.getTime();
    t + durationMs <= end.getTime();
    t += durationMs
  ) {
    const start = new Date(t);
    const endTime = new Date(t + durationMs);
    // Enforce the minimum lead time: hide slots earlier than minStart.
    if (start.getTime() < minStart.getTime()) continue;
    const startTZ = new Date(
      Utilities.formatDate(start, timeZone, "yyyy-MM-dd'T'HH:mm:ss")
    );
    if (startTZ.getHours() < workHours.start) continue;
    if (startTZ.getHours() >= workHours.end) continue;
    if (workDays.indexOf(startTZ.getDay()) < 0) continue;

    const freeCalendarsCount = calendarsToQuery.filter((calId: string) => {
      return !eventsByCalendar[calId].some((event) => event.start < endTime && event.end > start);
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
  return { timeslots, durationMinutes };
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
  const startTime = new Date(timeslot);
  if (isNaN(startTime.getTime())) {
    throw new Error("Invalid start time");
  }
  const endTime = new Date(startTime.getTime());
  endTime.setUTCMinutes(startTime.getUTCMinutes() + durationMinutes);

  // Authoritative minimum-lead-time check: reject bookings sooner than the
  // configured minimum days out, so a stale client can't book inside the window.
  const minDaysInAdvance = eventType.MIN_DAYS_IN_ADVANCE ?? CONFIG.MIN_DAYS_IN_ADVANCE ?? 0;
  if (minDaysInAdvance > 0) {
    const minStart = tzMidnightPlusDays(new Date(), CONFIG.TIME_ZONE, minDaysInAdvance);
    if (startTime.getTime() < minStart.getTime()) {
      throw new Error("This time is too soon; please choose a later time");
    }
  }

  // Authoritative max-bookings check. Hold a script lock across the count-check
  // AND the event creation below so two concurrent bookings for the last slot in
  // a period can't both pass the check and both create events. Count over a
  // window that comfortably covers the slot's period, then look up the slot's
  // own period bucket.
  let bookingLock: GoogleAppsScript.Lock.Lock | null = null;
  if (hasBookingLimit(eventType)) {
    bookingLock = LockService.getScriptLock();
    try {
      bookingLock.waitLock(15000);
    } catch (e) {
      throw new Error("Server is busy, please try again");
    }
    // Release the lock on any failure within the pre-check itself (including the
    // count query throwing), then rethrow unchanged. On the happy path the lock
    // stays held through event creation, where the finally block releases it.
    try {
      const tz = CONFIG.TIME_ZONE;
      const period = eventType.maxBookingsPeriod!;
      const padMs = periodPaddingMs(period);
      const counts = countBookingsByPeriod(
        calendarsToUse,
        eventType.id,
        new Date(startTime.getTime() - padMs),
        new Date(startTime.getTime() + padMs),
        period,
        tz
      );
      const key = periodKey(startTime, period, tz);
      if ((counts[key] || 0) >= eventType.maxBookings!) {
        throw new Error("Booking limit reached for this period");
      }
    } catch (e) {
      bookingLock.releaseLock();
      bookingLock = null;
      throw e;
    }
  }

  try {
    const possibleEvents = Calendar.Freebusy!.query({
      timeMin: startTime.toISOString(),
      timeMax: endTime.toISOString(),
      items: calendarsToUse.map((id: string) => ({ id })),
    });

    const freeCalendars = calendarsToUse.filter((calId: string) =>
      (possibleEvents as any).calendars[calId].busy.length === 0
    );

    const strategy = eventType.schedulingStrategy ?? CONFIG.schedulingStrategy ?? 'collective';
    let targetCalendarId = calendarsToUse[0];
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
    throw new Error(`Failed to create event: ${error.message}`);
  } finally {
    if (bookingLock) bookingLock.releaseLock();
  }
}
