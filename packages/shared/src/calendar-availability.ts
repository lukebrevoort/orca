import { z } from "zod";

const nonEmpty = z.string().trim().min(1);
const utcTimestamp = z.string().datetime({ offset: false });

export const calendarProviderSchema = z.enum(["google", "outlook"]);
export type CalendarProvider = z.infer<typeof calendarProviderSchema>;

export const calendarGrantStateSchema = z.enum([
  "connected",
  "not_connected",
  "expired",
  "revoked",
  "error",
]);
export type CalendarGrantState = z.infer<typeof calendarGrantStateSchema>;

export const calendarAvailabilityStatusSchema = z.enum(["free", "busy", "unknown"]);
export type CalendarAvailabilityStatus = z.infer<typeof calendarAvailabilityStatusSchema>;

export const calendarAvailabilityFreshnessSchema = z.enum(["fresh", "stale", "unchecked"]);
export type CalendarAvailabilityFreshness = z.infer<typeof calendarAvailabilityFreshnessSchema>;

export const schedulingAmbiguityCodeSchema = z.enum([
  "missing_date",
  "missing_time",
  "missing_timezone",
  "approximate_time",
  "multiple_interpretations",
  "daylight_saving_transition",
]);
export type SchedulingAmbiguityCode = z.infer<typeof schedulingAmbiguityCodeSchema>;

export const schedulingAmbiguitySchema = z.object({
  code: schedulingAmbiguityCodeSchema,
  message: nonEmpty.max(500),
  sourceText: nonEmpty.max(500),
}).strict();
export type SchedulingAmbiguity = z.infer<typeof schedulingAmbiguitySchema>;

export const requestedAvailabilityWindowSchema = z.object({
  id: nonEmpty.max(200),
  messageId: nonEmpty.max(512),
  sourceText: nonEmpty.max(1_000),
  sourceUrl: z.string().url(),
  originalTimeZone: nonEmpty.max(100).nullable(),
  userTimeZone: nonEmpty.max(100),
  start: utcTimestamp.nullable(),
  end: utcTimestamp.nullable(),
  durationMinutes: z.number().int().positive().max(7 * 24 * 60).nullable(),
  interpretation: z.enum(["exact", "ambiguous"]),
  ambiguities: z.array(schedulingAmbiguitySchema).max(12),
}).strict().superRefine((window, context) => {
  if ((window.start === null) !== (window.end === null)) {
    context.addIssue({ code: "custom", path: ["end"], message: "A requested window needs both start and end" });
  }
  if (window.start && window.end && Date.parse(window.start) >= Date.parse(window.end)) {
    context.addIssue({ code: "custom", path: ["end"], message: "A requested window must end after it starts" });
  }
  if (window.interpretation === "exact" && (window.ambiguities.length > 0 || !window.start || !window.end)) {
    context.addIssue({ code: "custom", path: ["interpretation"], message: "Exact windows need times and no ambiguity" });
  }
  if (window.interpretation === "ambiguous" && window.ambiguities.length === 0) {
    context.addIssue({ code: "custom", path: ["ambiguities"], message: "Ambiguous windows need an explanation" });
  }
});
export type RequestedAvailabilityWindow = z.infer<typeof requestedAvailabilityWindowSchema>;

export const calendarWorkingHoursSchema = z.object({
  timeZone: nonEmpty.max(100),
  days: z.array(z.object({
    day: z.number().int().min(0).max(6),
    startLocal: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    endLocal: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  }).strict()).max(7),
}).strict();
export type CalendarWorkingHours = z.infer<typeof calendarWorkingHoursSchema>;

export const calendarPreferencesSchema = z.object({
  userTimeZone: nonEmpty.max(100),
  workingHours: calendarWorkingHoursSchema.nullable(),
  staleAfterMinutes: z.number().int().positive().max(24 * 60),
}).strict();
export type CalendarPreferences = z.infer<typeof calendarPreferencesSchema>;

export const updateCalendarPreferencesSchema = calendarPreferencesSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: "Expected at least one calendar preference" },
);
export type UpdateCalendarPreferences = z.infer<typeof updateCalendarPreferencesSchema>;

export const calendarConnectionSchema = z.object({
  id: nonEmpty,
  provider: calendarProviderSchema,
  accountLabel: nonEmpty.max(320),
  state: calendarGrantStateSchema,
  grantedScopes: z.array(nonEmpty).max(20),
  connectedAt: utcTimestamp.nullable(),
  error: nonEmpty.max(500).nullable(),
}).strict();
export type CalendarConnection = z.infer<typeof calendarConnectionSchema>;

export const calendarConnectionPageSchema = z.object({
  items: z.array(calendarConnectionSchema),
}).strict();
export type CalendarConnectionPage = z.infer<typeof calendarConnectionPageSchema>;

export const availabilityCalendarSchema = z.object({
  id: nonEmpty,
  connectionId: nonEmpty,
  provider: calendarProviderSchema,
  displayName: nonEmpty.max(500),
  timeZone: nonEmpty.max(100).nullable(),
  selected: z.boolean(),
  primary: z.boolean(),
}).strict();
export type AvailabilityCalendar = z.infer<typeof availabilityCalendarSchema>;

export const availabilityCalendarPageSchema = z.object({
  connection: calendarConnectionSchema,
  calendars: z.array(availabilityCalendarSchema),
}).strict();
export type AvailabilityCalendarPage = z.infer<typeof availabilityCalendarPageSchema>;

export const calendarAvailabilityRequestSchema = z.object({
  connectionId: nonEmpty,
  requestedWindows: z.array(requestedAvailabilityWindowSchema).min(1).max(20),
  userTimeZone: nonEmpty.max(100),
  workingHours: calendarWorkingHoursSchema.nullable(),
}).strict();
export type CalendarAvailabilityRequest = z.infer<typeof calendarAvailabilityRequestSchema>;

export const calendarBusyIntervalSchema = z.object({
  start: utcTimestamp,
  end: utcTimestamp,
}).strict().refine((interval) => Date.parse(interval.start) < Date.parse(interval.end), {
  path: ["end"],
  message: "A busy interval must end after it starts",
});
export type CalendarBusyInterval = z.infer<typeof calendarBusyIntervalSchema>;

export const calendarAvailabilityUnknownReasonSchema = z.enum([
  "calendar_not_connected",
  "grant_expired",
  "grant_revoked",
  "provider_error",
  "calendar_error",
  "no_calendars_selected",
  "ambiguous_request",
  "stale_data",
]);
export type CalendarAvailabilityUnknownReason = z.infer<typeof calendarAvailabilityUnknownReasonSchema>;

export const calendarWindowSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("message"), messageId: nonEmpty, url: z.string().url(), sourceText: nonEmpty.max(1_000) }).strict(),
  z.object({ kind: z.literal("calendar_freebusy"), calendarId: nonEmpty, checkedAt: utcTimestamp }).strict(),
]);
export type CalendarWindowSource = z.infer<typeof calendarWindowSourceSchema>;

export const calendarScopedResultSchema = z.object({
  calendarId: nonEmpty,
  status: calendarAvailabilityStatusSchema,
  busy: z.array(calendarBusyIntervalSchema).max(500),
  error: nonEmpty.max(500).nullable(),
}).strict();
export type CalendarScopedResult = z.infer<typeof calendarScopedResultSchema>;

export const calendarWindowResultSchema = z.object({
  windowId: nonEmpty,
  status: calendarAvailabilityStatusSchema,
  freshness: calendarAvailabilityFreshnessSchema,
  unknownReason: calendarAvailabilityUnknownReasonSchema.nullable(),
  checkedAt: utcTimestamp.nullable(),
  calendarResults: z.array(calendarScopedResultSchema),
  sources: z.array(calendarWindowSourceSchema).min(1),
  explanation: nonEmpty.max(1_000),
}).strict().superRefine((result, context) => {
  if (result.status === "unknown" && !result.unknownReason) {
    context.addIssue({ code: "custom", path: ["unknownReason"], message: "Unknown availability needs a reason" });
  }
  if (result.freshness === "unchecked" && result.checkedAt !== null) {
    context.addIssue({ code: "custom", path: ["checkedAt"], message: "Unchecked availability cannot have a checked-at time" });
  }
});
export type CalendarWindowResult = z.infer<typeof calendarWindowResultSchema>;

export const calendarAvailabilityResponseSchema = z.object({
  request: calendarAvailabilityRequestSchema,
  connection: calendarConnectionSchema.nullable(),
  calendars: z.array(availabilityCalendarSchema),
  results: z.array(calendarWindowResultSchema),
  checkedAt: utcTimestamp.nullable(),
  staleAfterMinutes: z.number().int().positive().max(24 * 60),
  limitations: z.array(nonEmpty.max(1_000)).min(1).max(20),
  humanConfirmationRequired: z.literal(true),
}).strict();
export type CalendarAvailabilityResponse = z.infer<typeof calendarAvailabilityResponseSchema>;

export const updateCalendarSelectionSchema = z.object({
  connectionId: nonEmpty,
  selectedCalendarIds: z.array(nonEmpty).max(50),
}).strict();
export type UpdateCalendarSelection = z.infer<typeof updateCalendarSelectionSchema>;
