export interface EventType {
    id: string;
    name: string;
    duration: number; // in minutes
    selectable: boolean;
    description?: string;
    WORKDAYS?: number[];
    WORKHOURS?: { start: number; end: number };
    DAYS_IN_ADVANCE?: number;
    CALENDARS?: string[];
    schedulingStrategy?: 'collective' | 'round_robin';
    // Max bookings limit (undefined/0 = no limit). Active only when maxBookings > 0
    // and maxBookingsPeriod is set. Applies to the whole event type (aggregate).
    maxBookings?: number;
    maxBookingsPeriod?: 'day' | 'week' | 'month';
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
    DAYS_IN_ADVANCE: number;
    EVENT_TYPES: EventType[];
    CALENDARS: string[];
    schedulingStrategy?: 'collective' | 'round_robin';
}
