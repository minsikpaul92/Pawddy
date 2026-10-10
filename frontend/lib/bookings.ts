import { getSupabase } from "./supabase";
import type { ServiceType } from "../features/sitters/sitterApi";

/**
 * Booking RPC wrappers (phase-03b). RPCs raise the error code as the message —
 * full list in supabase/README.md "RPC errors"; each screen adds the copy it needs.
 */

const MESSAGES: Record<string, string> = {
  booking_in_progress: "The pets are already with you — change the pick-up time instead.",
  invalid_status: "This booking has already changed. Reopen it to see the latest.",
  not_allowed: "You can't change this booking.",
  invalid_window: "Pick a drop-off in the future and a pick-up after it.",
  location_note_required: "Tell the sitter where to meet.",
  service_not_offered: "This sitter doesn't offer that service.",
  rates_not_set: "This sitter hasn't set their prices yet, so there is nothing to pay. Ask them to add prices, then try again.",
  consents_missing: "Sign every consent before paying.",
  already_paid: "This booking is already paid.",
  handoff_missing: "Agree on drop-off and pick-up times first.",
  access_locked: "Entry info isn't available yet — or the stay has ended.",
  forbidden: "You can't view this entry info.",
  not_paid: "Addresses unlock after checkout.",
  proposal_expired: "That time has already passed — suggest another time.",
  request_expired: "This request's pick-up time has passed, so it can't be accepted.",
  invalid_location: "House sitting happens at the owner's home.",
};

export function bookingErrorMessage(code: string | undefined, fallback: string): string {
  return (code && MESSAGES[code]) || fallback;
}

/** Error with the RPC code kept, so a screen can add its own copy (e.g. a pet's name). */
export class BookingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** RPC error detail, e.g. "2026-10-05 morning, …" for sitter_unavailable. */
    readonly detail: string | null = null,
  ) {
    super(message);
  }
}

/** Owner or sitter, before the drop-off (3B.7). The other side gets `booking_cancelled`. */
export async function cancelBooking(bookingId: string, reason: string | null): Promise<void> {
  const { error } = await getSupabase().rpc("cancel_booking", { p_booking: bookingId, p_reason: reason });
  if (error) {
    throw new Error(bookingErrorMessage(error.message, "Couldn't cancel this booking. Try again."));
  }
}

// ---------------------------------------------------------------------------
// Checkout quote + demo pay (03C — no Stripe)
// ---------------------------------------------------------------------------

function asQuote(raw: unknown): PriceQuote {
  const q = raw as PriceQuote;
  return {
    ...q,
    unit_price: Number(q.unit_price),
    base: Number(q.base),
    extra_pets: Number(q.extra_pets),
    holiday_surcharge: Number(q.holiday_surcharge),
    total: Number(q.total),
    nights: Number(q.nights),
    days: Number(q.days),
    holiday_days: q.holiday_days ?? [],
  };
}

async function sitterHasRates(sitterId: string): Promise<boolean> {
  const { data, error } = await getSupabase().from("sitter_rates").select("sitter_id").eq("sitter_id", sitterId).maybeSingle();
  // If we can't tell, keep the old wording rather than blame the sitter.
  return error != null || data != null;
}

/** Read-only quote for Checkout / inquiry card (same RPC Checkout freezes at pay). */
export async function quoteBooking(input: {
  sitterId: string;
  serviceType: ServiceType | "daycare";
  dropOffAt: string;
  pickUpAt: string;
  petCount: number;
}): Promise<PriceQuote> {
  const { data, error } = await getSupabase().rpc("quote_booking", {
    p_sitter: input.sitterId,
    p_service: input.serviceType,
    p_drop_off_at: input.dropOffAt,
    p_pick_up_at: input.pickUpAt,
    p_pet_count: input.petCount,
  });
  if (error) {
    // quote_booking raises service_not_offered both for a service the sitter doesn't offer and for a
    // sitter with no price row at all. The rates are readable by every signed-in user, so tell them apart.
    let code = error.message;
    if (code === "service_not_offered" && !(await sitterHasRates(input.sitterId))) code = "rates_not_set";
    throw new BookingError(code, bookingErrorMessage(code, "Couldn't load the price. Try again."), error.details ?? null);
  }
  return asQuote(data);
}

/**
 * Demo checkout (D30): no card. Requires confirmed booking + every required consent signed.
 * Returns the frozen price_snapshot.
 */
export async function payBookingDemo(bookingId: string): Promise<PriceQuote> {
  const { data, error } = await getSupabase().rpc("pay_booking_demo", { p_booking: bookingId });
  if (error) {
    throw new BookingError(
      error.message,
      bookingErrorMessage(error.message, "Couldn't complete the demo payment. Try again."),
      error.details ?? null,
    );
  }
  return asQuote(data);
}

/** Owner entry codes — never shown except via get_home_access to the booked sitter (D31). */
export type HomeAccess = {
  entrySteps: string | null;
  lockboxCode: string | null;
  buzzer: string | null;
  fobNotes: string | null;
  sitterParking: string | null;
  firstRevealedAt: string;
};

export type HomeAccessLocked = {
  locked: true;
  unlocksAt: string | null;
  lockedSince: string | null;
};

export async function getHomeAccess(
  bookingId: string,
): Promise<HomeAccess | HomeAccessLocked> {
  const { data, error } = await getSupabase().rpc("get_home_access", { p_booking: bookingId });
  if (error) {
    if (error.message === "access_locked") {
      let unlocksAt: string | null = null;
      let lockedSince: string | null = null;
      try {
        const detail = JSON.parse(error.details ?? "{}") as {
          unlocks_at?: string;
          locked_since?: string;
        };
        unlocksAt = detail.unlocks_at ?? null;
        lockedSince = detail.locked_since ?? null;
      } catch {
        /* detail may be plain text in some clients */
      }
      return { locked: true, unlocksAt, lockedSince };
    }
    throw new BookingError(
      error.message,
      bookingErrorMessage(error.message, "Couldn't load entry info."),
      error.details ?? null,
    );
  }
  const rows = (data ?? []) as {
    entry_steps: string | null;
    lockbox_code: string | null;
    buzzer: string | null;
    fob_notes: string | null;
    sitter_parking: string | null;
    first_revealed_at: string;
  }[];
  const row = rows[0];
  if (!row) throw new Error("Couldn't load entry info.");
  return {
    entrySteps: row.entry_steps,
    lockboxCode: row.lockbox_code,
    buzzer: row.buzzer,
    fobNotes: row.fob_notes,
    sitterParking: row.sitter_parking,
    firstRevealedAt: row.first_revealed_at,
  };
}

export async function saveOwnerHomeAccess(fields: {
  entrySteps: string | null;
  lockboxCode: string | null;
  buzzer: string | null;
  fobNotes: string | null;
  sitterParking: string | null;
}): Promise<void> {
  const { data: userData, error: userError } = await getSupabase().auth.getUser();
  if (userError || !userData.user) throw new Error("Couldn't confirm you are signed in.");
  const row = {
    owner_id: userData.user.id,
    entry_steps: fields.entrySteps,
    lockbox_code: fields.lockboxCode,
    buzzer: fields.buzzer,
    fob_notes: fields.fobNotes,
    sitter_parking: fields.sitterParking,
  };
  const { error } = await getSupabase().from("owner_home_access").upsert(row, { onConflict: "owner_id" });
  if (error) throw new Error("Couldn't save your entry info. Try again.");
}

// ---------------------------------------------------------------------------
// Book care (3B.3)
// ---------------------------------------------------------------------------

/** Handoff place = transport mode (D28): sitter_home = Owner drives, owner_home = Sitter drives. */
export type LocationType = "sitter_home" | "owner_home" | "other";

export type HandoffInput = { at: string; locationType: LocationType; note: string | null };

/** One row of search_sitters: how much of the trip a sitter covers and whether times fit their hours. */
export type SitterMatch = {
  sitterId: string;
  displayName: string;
  bio: string | null;
  serviceArea: string | null;
  experienceYears: number | null;
  services: ServiceType[];
  isMySitter: boolean;
  coveredSlots: number;
  totalSlots: number;
  dropOffWithinHours: boolean;
  pickUpWithinHours: boolean;
};

export function coversWholeTrip(m: SitterMatch): boolean {
  return m.totalSlots > 0 && m.coveredSlots === m.totalSlots;
}

/** Sitters with room for at least part of [dropOffAt, pickUpAt), whole-trip and your sitters first. */
export async function searchSitters(dropOffAt: string, pickUpAt: string, petCount: number): Promise<SitterMatch[]> {
  const { data, error } = await getSupabase().rpc("search_sitters", {
    p_drop_off_at: dropOffAt,
    p_pick_up_at: pickUpAt,
    p_pet_count: petCount,
  });
  if (error) {
    throw new BookingError(error.message, bookingErrorMessage(error.message, "Couldn't search sitters. Try again."));
  }
  return ((data ?? []) as {
    sitter_id: string;
    display_name: string;
    bio: string | null;
    service_area: string | null;
    experience_years: number | null;
    services: ServiceType[] | null;
    is_my_sitter: boolean;
    covered_slots: number;
    total_slots: number;
    drop_off_within_hours: boolean;
    pick_up_within_hours: boolean;
  }[]).map((r) => ({
    sitterId: r.sitter_id,
    displayName: r.display_name,
    bio: r.bio,
    serviceArea: r.service_area,
    experienceYears: r.experience_years,
    services: r.services ?? ["boarding"],
    isMySitter: r.is_my_sitter,
    coveredSlots: r.covered_slots,
    totalSlots: r.total_slots,
    dropOffWithinHours: r.drop_off_within_hours,
    pickUpWithinHours: r.pick_up_within_hours,
  }));
}

export type BookingRequest = {
  sitterId: string;
  petIds: string[];
  dropOff: HandoffInput;
  pickUp: HandoffInput;
  note: string | null;
  serviceType?: ServiceType;
  rebookedFrom?: string | null;
};

/** request_booking → booking + two proposed handoffs + `booking_requested` for the sitter. */
export async function requestBooking(input: BookingRequest): Promise<string> {
  const { data, error } = await getSupabase().rpc("request_booking", {
    p_sitter: input.sitterId,
    p_pets: input.petIds,
    p_drop_off_at: input.dropOff.at,
    p_drop_off_location_type: input.dropOff.locationType,
    p_drop_off_note: input.dropOff.note,
    p_pick_up_at: input.pickUp.at,
    p_pick_up_location_type: input.pickUp.locationType,
    p_pick_up_note: input.pickUp.note,
    p_note: input.note,
    p_rebooked_from: input.rebookedFrom ?? null,
    p_service_type: input.serviceType ?? "boarding",
  });
  if (error) {
    throw new BookingError(error.message, bookingErrorMessage(error.message, "Couldn't send the request. Try again."));
  }
  return data as string;
}

// ---------------------------------------------------------------------------
// Booking lists and details (owner 3B.3, sitter 3B.4)
// ---------------------------------------------------------------------------

export type BookingStatus = "requested" | "confirmed" | "declined" | "cancelled";

export type MeetGreetStatus =
  | "not_needed"
  | "required"
  | "proposed"
  | "agreed"
  | "done"
  | "skip_requested"
  | "skipped";

/** Server quote from quote_booking / price_snapshot (03C, D29). */
export type PriceQuote = {
  service: string;
  nights: number;
  days: number;
  unit_price: number;
  base: number;
  extra_pets: number;
  holiday_days: { day: string; name: string }[];
  holiday_surcharge: number;
  total: number;
  currency: string;
  rate_version: string;
};

type HandoffRow = {
  id: string;
  kind: "drop_off" | "pick_up";
  scheduled_at: string;
  location_type: LocationType;
  location_note: string | null;
  within_sitter_hours: boolean;
  status: "proposed" | "agreed" | "rejected" | "superseded";
  proposed_by: string;
  completed_at: string | null;
  created_at: string;
};

export type HandoffKind = HandoffRow["kind"];

/** One offer in the back-and-forth for a handoff, oldest first (3B.5 history line). */
export type ProposalStep = {
  id: string;
  at: string;
  locationType: LocationType;
  note: string | null;
  proposedBy: string;
  status: HandoffRow["status"];
};

export type Handoff = {
  id: string;
  at: string;
  locationType: LocationType;
  note: string | null;
  proposedBy: string;
  withinSitterHours: boolean;
  /** Still waiting for the other side's OK. */
  pending: boolean;
  completedAt: string | null;
};

export type BookingSummary = {
  id: string;
  status: BookingStatus;
  ownerId: string;
  ownerName: string;
  sitterId: string;
  sitterName: string;
  serviceType: ServiceType;
  meetGreetStatus: MeetGreetStatus;
  meetGreet: MeetGreet;
  /** Who cancelled and why (cancel_booking reason, or meet_greet_declined / handoff_declined). */
  cancelledBy: string | null;
  cancelReason: string | null;
  /**
   * Set by pay_booking_demo (03C). Null until checkout finishes — and again when an agreed change
   * needs a new consent (009d); priceSnapshot then still holds the last paid quote.
   */
  paidAt: string | null;
  /** Quote frozen at demo pay, re-quoted when an agreed change moves the total (009d). */
  priceSnapshot: PriceQuote | null;
  pets: { id?: string; name: string; species: "dog" | "cat" }[];
  dropOff: Handoff | null;
  pickUp: Handoff | null;
  /** The sitter suggested another time and is waiting for the owner. */
  sitterSuggested: boolean;
  /** Every offer per handoff, oldest first. */
  history: Record<HandoffKind, ProposalStep[]>;
  /** The open offer per handoff (waiting for someone's OK), if any. */
  pending: Record<HandoffKind, ProposalStep | null>;
  createdAt: string;
};

/** Meet & Greet plan on a first-time booking (004 columns, 005 RPCs). */
export type MeetGreet = {
  mode: "in_person" | "video" | null;
  at: string | null;
  place: string | null;
  link: string | null;
  proposedBy: string | null;
  skipRequestedBy: string | null;
};

export type OwnerBooking = BookingSummary;

/** "You: 7:00 AM → Chloe: 8:30 AM → You: 8:00 AM" for a handoff with more than one offer. */
export function historyLine(b: BookingSummary, kind: HandoffKind, me: string, format: (iso: string) => string): string | null {
  const steps = b.history[kind];
  if (steps.length < 2) return null;
  return steps
    .map((s) => `${s.proposedBy === me ? "You" : s.proposedBy === b.ownerId ? b.ownerName : b.sitterName}: ${format(s.at)}`)
    .join(" → ");
}

/** My newest offer for a confirmed booking was declined, so the agreed time stayed. */
export function declinedChange(b: BookingSummary, kind: HandoffKind, me: string): boolean {
  const last = b.history[kind][b.history[kind].length - 1];
  return b.status === "confirmed" && !!last && last.proposedBy === me && last.status === "rejected";
}

/** Accept works only once a first-time pair met or both agreed to skip (D44, 004). */
export function meetGreetBlocksAccept(b: BookingSummary): boolean {
  return !["not_needed", "done", "skipped"].includes(b.meetGreetStatus);
}

/** Same rule as current_handoff (003): confirmed → agreed; requested → pending proposal, else agreed. */
function currentHandoff(rows: HandoffRow[], kind: HandoffRow["kind"], status: BookingStatus): Handoff | null {
  const ofKind = rows.filter((h) => h.kind === kind);
  const pick =
    (status === "requested" ? ofKind.find((h) => h.status === "proposed") : undefined) ??
    ofKind.find((h) => h.status === "agreed") ??
    // Ended bookings keep their last proposal for the card.
    ofKind.find((h) => h.status === "superseded" || h.status === "rejected");
  return pick
    ? {
        id: pick.id,
        at: pick.scheduled_at,
        locationType: pick.location_type,
        note: pick.location_note,
        proposedBy: pick.proposed_by,
        withinSitterHours: pick.within_sitter_hours,
        pending: pick.status === "proposed",
        completedAt: pick.completed_at,
      }
    : null;
}

const BOOKING_COLUMNS =
  "id, status, owner_id, sitter_id, service_type, meet_greet_status, meet_greet_mode, meet_greet_at, " +
  "meet_greet_place, meet_greet_link, meet_greet_proposed_by, meet_greet_skip_requested_by, cancelled_by, cancel_reason, " +
  "paid_at, price_snapshot, created_at, " +
  "owner:profiles!bookings_owner_id_fkey(display_name), " +
  "sitter:profiles!bookings_sitter_id_fkey(display_name), " +
  "booking_handoffs(id, kind, scheduled_at, location_type, location_note, within_sitter_hours, status, proposed_by, " +
  "completed_at, created_at)";

type BookingRow = {
  id: string;
  status: BookingStatus;
  owner_id: string;
  sitter_id: string;
  service_type: ServiceType | null;
  meet_greet_status: MeetGreetStatus | null;
  meet_greet_mode: "in_person" | "video" | null;
  meet_greet_at: string | null;
  meet_greet_place: string | null;
  meet_greet_link: string | null;
  meet_greet_proposed_by: string | null;
  meet_greet_skip_requested_by: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  paid_at: string | null;
  price_snapshot: PriceQuote | null;
  created_at: string;
  owner: { display_name: string } | null;
  sitter: { display_name: string } | null;
  booking_handoffs: HandoffRow[] | null;
  booking_pets?: { pets: { id?: string; name: string; species: "dog" | "cat" } | null }[] | null;
};

function toStep(h: HandoffRow): ProposalStep {
  return {
    id: h.id,
    at: h.scheduled_at,
    locationType: h.location_type,
    note: h.location_note,
    proposedBy: h.proposed_by,
    status: h.status,
  };
}

function toSummary(b: BookingRow, pets: BookingSummary["pets"]): BookingSummary {
  const handoffs = [...(b.booking_handoffs ?? [])].sort((x, y) => x.created_at.localeCompare(y.created_at));
  const steps = (kind: HandoffKind) => handoffs.filter((h) => h.kind === kind).map(toStep);
  const open = (kind: HandoffKind) =>
    b.status === "requested" || b.status === "confirmed"
      ? (steps(kind).find((s) => s.status === "proposed") ?? null)
      : null;
  return {
    id: b.id,
    status: b.status,
    ownerId: b.owner_id,
    ownerName: b.owner?.display_name ?? "The owner",
    sitterId: b.sitter_id,
    sitterName: b.sitter?.display_name ?? "Your sitter",
    serviceType: b.service_type ?? "boarding",
    meetGreetStatus: b.meet_greet_status ?? "not_needed",
    meetGreet: {
      mode: b.meet_greet_mode ?? null,
      at: b.meet_greet_at ?? null,
      place: b.meet_greet_place ?? null,
      link: b.meet_greet_link ?? null,
      proposedBy: b.meet_greet_proposed_by ?? null,
      skipRequestedBy: b.meet_greet_skip_requested_by ?? null,
    },
    cancelledBy: b.cancelled_by ?? null,
    cancelReason: b.cancel_reason ?? null,
    paidAt: b.paid_at ?? null,
    priceSnapshot: b.price_snapshot ?? null,
    pets,
    dropOff: currentHandoff(handoffs, "drop_off", b.status),
    pickUp: currentHandoff(handoffs, "pick_up", b.status),
    sitterSuggested:
      b.status === "requested" && handoffs.some((h) => h.status === "proposed" && h.proposed_by === b.sitter_id),
    history: { drop_off: steps("drop_off"), pick_up: steps("pick_up") },
    pending: { drop_off: open("drop_off"), pick_up: open("pick_up") },
    createdAt: b.created_at,
  };
}

function newestFirst(a: BookingSummary, b: BookingSummary): number {
  return b.createdAt.localeCompare(a.createdAt);
}

export async function listOwnerBookings(ownerId: string): Promise<OwnerBooking[]> {
  const { data, error } = await getSupabase()
    .from("bookings")
    .select(`${BOOKING_COLUMNS}, booking_pets(pets(id, name, species))`)
    .eq("owner_id", ownerId)
    .order("created_at", { ascending: false });
  if (error) throw new Error("Couldn't load your bookings. Check your connection and try again.");
  return ((data ?? []) as unknown as BookingRow[])
    .map((b) => toSummary(b, (b.booking_pets ?? []).flatMap((bp) => (bp.pets ? [bp.pets] : []))))
    .sort(newestFirst);
}

/**
 * Pet cards for a booking via get_booking_pets — pets RLS hides a pet from the sitter once
 * the booking has ended, the RPC does not (003).
 */
export async function getBookingPets(bookingId: string): Promise<BookingSummary["pets"]> {
  const { data, error } = await getSupabase().rpc("get_booking_pets", { p_booking: bookingId });
  if (error) throw new Error("Couldn't load the pets on this booking.");
  return ((data ?? []) as { pet_id: string; name: string; species: "dog" | "cat" }[]).map((p) => ({
    id: p.pet_id,
    name: p.name,
    species: p.species,
  }));
}

export async function listSitterBookings(sitterId: string): Promise<BookingSummary[]> {
  const { data, error } = await getSupabase()
    .from("bookings")
    .select(BOOKING_COLUMNS)
    .eq("sitter_id", sitterId)
    .order("created_at", { ascending: false });
  if (error) throw new Error("Couldn't load your bookings. Check your connection and try again.");
  const rows = (data ?? []) as unknown as BookingRow[];
  const pets = await Promise.all(rows.map((b) => getBookingPets(b.id)));
  return rows.map((b, i) => toSummary(b, pets[i])).sort(newestFirst);
}

export async function getBooking(bookingId: string): Promise<BookingSummary | null> {
  const { data, error } = await getSupabase().from("bookings").select(BOOKING_COLUMNS).eq("id", bookingId).maybeSingle();
  if (error) throw new Error("Couldn't load this booking. Check your connection and try again.");
  if (!data) return null;
  return toSummary(data as unknown as BookingRow, await getBookingPets(bookingId));
}

/** A request nobody answered before its pick-up time — it can't be accepted any more (009c). */
export function requestExpired(b: BookingSummary, now: number = Date.now()): boolean {
  return b.status === "requested" && !!b.pickUp && Date.parse(b.pickUp.at) <= now;
}

/** Requests · Upcoming · Past for the sitter's Bookings tab. */
export function sitterBucket(b: BookingSummary): "requests" | "upcoming" | "past" {
  if (b.status === "requested") return requestExpired(b) ? "past" : "requests";
  if (b.status === "confirmed" && !b.pickUp?.completedAt) return "upcoming";
  return "past";
}

const SOON_MS = 48 * 3_600_000;

/**
 * Which sitter segment to open on: a stay in care or starting within 48 h → Upcoming; else open Requests; else
 * Questions waiting for an answer; else Upcoming if any.
 */
export function firstSitterBucket(
  bookings: BookingSummary[],
  now = Date.now(),
  waitingQuestions = 0,
): "requests" | "inquiries" | "upcoming" | "past" {
  const upcoming = bookings.filter((b) => sitterBucket(b) === "upcoming");
  const soon = upcoming.some((b) => !!b.dropOff && (!!b.dropOff.completedAt || Date.parse(b.dropOff.at) - now <= SOON_MS));
  if (soon) return "upcoming";
  if (bookings.some((b) => sitterBucket(b) === "requests")) return "requests";
  if (waitingQuestions > 0) return "inquiries";
  return upcoming.length > 0 ? "upcoming" : "requests";
}

// ---------------------------------------------------------------------------
// Sitter actions (3B.4)
// ---------------------------------------------------------------------------

/** respond_booking — Accept also accepts the owner's pending times; Decline ends the request. */
export async function respondBooking(bookingId: string, accept: boolean): Promise<void> {
  const { error } = await getSupabase().rpc("respond_booking", { p_booking: bookingId, p_accept: accept, p_note: null });
  if (error) {
    throw new BookingError(
      error.message,
      bookingErrorMessage(error.message, "Couldn't answer this request. Try again."),
      error.details ?? null,
    );
  }
}

/**
 * propose_handoff — a new time (and optionally a new place) for one handoff. Without
 * `place` the place stays as it is (p_location_type omitted, 003).
 */
export async function proposeHandoff(
  bookingId: string,
  kind: HandoffKind,
  at: string,
  place?: { locationType: LocationType; note: string | null },
): Promise<void> {
  const args: Record<string, unknown> = { p_booking: bookingId, p_kind: kind, p_at: at };
  if (place) {
    args.p_location_type = place.locationType;
    args.p_note = place.note;
  }
  const { error } = await getSupabase().rpc("propose_handoff", args);
  if (error) {
    throw new BookingError(
      error.message,
      bookingErrorMessage(error.message, "Couldn't send the new time. Try again."),
      error.details ?? null,
    );
  }
}

/**
 * respond_handoff — answer the other side's offer. Declining before the booking is
 * confirmed ends the request (owner → cancelled, sitter → declined); after it, the agreed
 * time stays (003).
 */
export async function respondHandoff(handoffId: string, accept: boolean): Promise<void> {
  const { error } = await getSupabase().rpc("respond_handoff", { p_handoff: handoffId, p_accept: accept });
  if (error) {
    throw new BookingError(
      error.message,
      bookingErrorMessage(error.message, "Couldn't answer this change. Try again."),
      error.details ?? null,
    );
  }
}

/** How early the sitter may tap Received before the agreed drop-off (complete_handoff, 003). */
export const CHECK_IN_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * complete_handoff (sitter) — Received from 2 h before the agreed drop-off, Returned after
 * Received. The owner gets `pet_dropped_off` / `pet_picked_up` (3B.6).
 */
export async function completeHandoff(bookingId: string, kind: HandoffKind): Promise<void> {
  const { error } = await getSupabase().rpc("complete_handoff", { p_booking: bookingId, p_kind: kind });
  if (error) {
    const copy: Record<string, string> = {
      handoff_too_early: "You can check in from 2 hours before drop-off.",
      drop_off_not_completed: "Tap Received first.",
      handoff_completed: "That handoff is already checked.",
      handoff_missing: "There's no agreed time for this handoff yet.",
    };
    throw new BookingError(error.message, copy[error.message] ?? bookingErrorMessage(error.message, "Couldn't save. Try again."));
  }
}

/** Real addresses + sitter place notes after demo pay, until 24 h after pick-up (3C.4). */
export type HandoffPlace = {
  address: string | null;
  visitorParking: string | null;
  lobbyNotes: string | null;
  packingList: string[] | null;
};

export async function getHandoffDetails(
  bookingId: string,
): Promise<{ places: Partial<Record<HandoffKind, HandoffPlace>>; error: string | null }> {
  const { data, error } = await getSupabase().rpc("get_handoff_details", { p_booking: bookingId });
  if (error) {
    if (error.message === "not_paid") return { places: {}, error: "not_paid" };
    if (error.message === "booking_finished") return { places: {}, error: "booking_finished" };
    return { places: {}, error: error.message };
  }
  const places: Partial<Record<HandoffKind, HandoffPlace>> = {};
  for (const row of (data ?? []) as {
    kind: HandoffKind;
    address: string | null;
    visitor_parking: string | null;
    lobby_notes: string | null;
    packing_list: string[] | null;
  }[]) {
    places[row.kind] = {
      address: row.address,
      visitorParking: row.visitor_parking,
      lobbyNotes: row.lobby_notes,
      packingList: row.packing_list,
    };
  }
  return { places, error: null };
}

/** @deprecated Prefer getHandoffDetails — kept for existing booking screens. */
export async function getHandoffAddresses(bookingId: string): Promise<Partial<Record<HandoffKind, string>>> {
  const { places } = await getHandoffDetails(bookingId);
  const out: Partial<Record<HandoffKind, string>> = {};
  for (const kind of Object.keys(places) as HandoffKind[]) {
    const addr = places[kind]?.address;
    if (addr) out[kind] = addr;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pet details for the requested / booked sitter (pets RLS: can_view_pet_profile)
// ---------------------------------------------------------------------------

export type PetCare = {
  id: string;
  name: string;
  species: "dog" | "cat";
  breed: string | null;
  notes: string | null;
  allergies: string[];
  /** Active Heads-ups the owner wrote (care request or by hand). */
  cautions: string[];
  tasks: { id: string; title: string; type: string; time: string; dose: string | null }[];
};

export async function loadPetCare(petIds: string[]): Promise<PetCare[]> {
  if (petIds.length === 0) return [];
  const { data, error } = await getSupabase()
    .from("pets")
    .select(
      "id, name, species, breed, notes, pet_allergies(allergen), care_tasks(id, title, type, scheduled_time, dose, active), pet_cautions(text, active, created_at)",
    )
    .in("id", petIds);
  if (error) throw new Error("Couldn't load the pet profiles.");
  return ((data ?? []) as unknown as {
    id: string;
    name: string;
    species: "dog" | "cat";
    breed: string | null;
    notes: string | null;
    pet_allergies: { allergen: string }[] | null;
    pet_cautions: { text: string; active: boolean; created_at: string }[] | null;
    care_tasks:
      | { id: string; title: string; type: string; scheduled_time: string; dose: string | null; active: boolean }[]
      | null;
  }[])
    .map((p) => ({
      id: p.id,
      name: p.name,
      species: p.species,
      breed: p.breed,
      notes: p.notes,
      allergies: (p.pet_allergies ?? []).map((a) => a.allergen),
      cautions: (p.pet_cautions ?? [])
        .filter((c) => c.active)
        .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))
        .map((c) => c.text),
      tasks: (p.care_tasks ?? [])
        .filter((t) => t.active)
        .map((t) => ({ id: t.id, title: t.title, type: t.type, time: t.scheduled_time.slice(0, 5), dose: t.dose }))
        .sort((a, b) => a.time.localeCompare(b.time)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

