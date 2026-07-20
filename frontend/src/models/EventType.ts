export interface EventType {
    id: string;
    name: string;
    duration: number; // in minutes
    selectable: boolean;
    description?: string;
    WORKDAYS?: number[];
    WORKHOURS?: { start: number; end: number };
    MAX_DAYS_IN_ADVANCE?: number;
    MIN_DAYS_IN_ADVANCE?: number;
    CALENDARS?: string[];
    // Fixed host calendar (the event's organizer). When set, the event is always
    // created here regardless of schedulingStrategy, and CALENDARS is purely the
    // availability/conflict-check set. Empty/undefined = derive the host from the
    // strategy (collective → first calendar, round-robin → a free one).
    hostCalendar?: string;
    // Only meaningful with a fixed hostCalendar: also invite the availability
    // (CALENDARS) calendars as attendees (true) or check them for conflicts only
    // (false, default).
    inviteAvailabilityCalendars?: boolean;
    schedulingStrategy?: 'collective' | 'round_robin';
    // Max bookings limit (undefined/0 = no limit). Active only when maxBookings > 0
    // and maxBookingsPeriod is set. Applies to the whole event type (aggregate).
    maxBookings?: number;
    maxBookingsPeriod?: 'day' | 'week' | 'month' | 'quarter' | 'year';
    // Guest permissions
    guestsCanModify?: boolean;
    guestsCanInviteOthers?: boolean;
    guestsCanSeeOtherGuests?: boolean;
    // Meeting visibility
    visibility?: 'default' | 'public' | 'private';
}

export interface Config {
    TIME_ZONE: string;
    WORKDAYS: number[];
    WORKHOURS: { start: number; end: number };
    MAX_DAYS_IN_ADVANCE: number;
    MIN_DAYS_IN_ADVANCE?: number;
    EVENT_TYPES: EventType[];
    CALENDARS: string[];
    hostCalendar?: string;
    inviteAvailabilityCalendars?: boolean;
    schedulingStrategy?: 'collective' | 'round_robin';
}
