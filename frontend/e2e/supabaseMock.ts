import type { Page, Route } from "@playwright/test";

import { addDays, appToday, zonedToIso } from "../features/schedule/dates";

/**
 * Fake Supabase Auth + `profiles` for e2e (no real project, no secrets).
 * The e2e build points EXPO_PUBLIC_SUPABASE_URL at the test server itself, so every
 * request is same-origin and handled here by path.
 */

export type MockUser = {
  id: string;
  email: string;
  password: string;
  role: "owner" | "sitter";
  displayName: string;
};

export const OWNER: MockUser = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "owner@goldito.test",
  password: "max-and-mochi",
  role: "owner",
  displayName: "Robert",
};

export const SITTER: MockUser = {
  id: "00000000-0000-4000-8000-000000000002",
  email: "sitter@goldito.test",
  password: "care-snap-tap",
  role: "sitter",
  displayName: "Chloe",
};

// "Now" for the mock's own rules and timestamps: the real clock, or the fixed time a test passes to
// mockSupabase({ now }) so it matches the browser clock (page.clock) the test installs.
let fixedNow: number | null = null;
function nowMs(): number {
  return fixedNow ?? Date.now();
}

function base64url(value: object): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sessionFor(user: MockUser) {
  const now = Math.floor(nowMs() / 1000);
  const claims = { sub: user.id, email: user.email, role: "authenticated", aud: "authenticated", iat: now, exp: now + 3600 };
  const timestamp = new Date(nowMs()).toISOString();
  return {
    access_token: `${base64url({ alg: "HS256", typ: "JWT" })}.${base64url(claims)}.e2e-signature`,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: now + 3600,
    refresh_token: `refresh-${user.id}`,
    user: {
      id: user.id,
      aud: "authenticated",
      role: "authenticated",
      email: user.email,
      email_confirmed_at: timestamp,
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: { role: user.role, display_name: user.displayName },
      created_at: timestamp,
      updated_at: timestamp,
    },
  };
}

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

export async function mockSupabase(page: Page, initialUsers: MockUser[], options: { now?: Date } = {}) {
  fixedNow = options.now ? options.now.getTime() : null;
  // Copies, so a test that edits a user (e.g. display name) never leaks into the next one.
  const users = initialUsers.map((user) => ({ ...user }));
  const signups: { email: string; role: string; display_name: string }[] = [];

  await page.route("**/auth/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const grant = url.searchParams.get("grant_type");

    if (url.pathname.endsWith("/token") && grant === "password") {
      const { email, password } = request.postDataJSON();
      const user = users.find((u) => u.email === email && u.password === password);
      if (!user) {
        return json(route, 400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" });
      }
      return json(route, 200, sessionFor(user));
    }
    if (url.pathname.endsWith("/token") && grant === "refresh_token") {
      const { refresh_token } = request.postDataJSON();
      const user = users.find((u) => `refresh-${u.id}` === refresh_token);
      return user ? json(route, 200, sessionFor(user)) : json(route, 400, { error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" });
    }
    if (url.pathname.endsWith("/signup")) {
      const { email, password, data } = request.postDataJSON();
      if (users.some((u) => u.email === email)) {
        return json(route, 422, { code: 422, error_code: "user_already_exists", msg: "User already registered" });
      }
      const user: MockUser = { id: crypto.randomUUID(), email, password, role: data.role, displayName: data.display_name };
      users.push(user);
      signups.push({ email, role: data.role, display_name: data.display_name });
      return json(route, 200, sessionFor(user));
    }
    if (url.pathname.endsWith("/logout")) {
      return route.fulfill({ status: 204 });
    }
    if (url.pathname.endsWith("/user")) {
      // auth.getUser() — used by signConsent / saveOwnerHomeAccess (03C).
      const auth = request.headers().authorization ?? "";
      const token = auth.replace(/^Bearer /, "");
      const payload = token.split(".")[1];
      let sub: string | null = null;
      try {
        sub = payload
          ? (JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { sub?: string }).sub ?? null
          : null;
      } catch {
        sub = null;
      }
      const user = users.find((u) => u.id === sub);
      if (!user) return json(route, 401, { msg: "Invalid JWT" });
      return json(route, 200, { user: sessionFor(user).user });
    }
    return json(route, 404, { msg: `Not mocked: ${request.method()} ${url.pathname}` });
  });

  const db = createMockDb();
  await page.route("**/rest/v1/**", (route) => handleRest(route, users, db));

  return { signups, db };
}

// ---------------------------------------------------------------------------
// A tiny in-memory PostgREST: only the request shapes the app sends.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

export type MockDb = {
  /** rpc/stay_capacity_check answer: null = the stay fits. */
  stayShortfall?: string | null;
  pets: Row[];
  pet_allergies: Row[];
  owner_profiles: Row[];
  sitter_profiles: Row[];
  sitter_availability: Row[];
  bookings: Row[];
  /** Capacity units of a booking: { booking_id, day, slot } (phase-02 booking_slots). */
  booking_slots: Row[];
  /** cancel_booking calls: { p_booking, p_reason }. */
  cancellations: Row[];
  booking_handoffs: Row[];
  booking_pets: Row[];
  /** What rpc/search_sitters returns (rows in the 004 shape); calls land in `searches`. */
  search_results: Row[];
  searches: Row[];
  /** request_booking calls with their parameters. */
  requests: Row[];
  care_tasks: Row[];
  /** Today's instances of care tasks (phase 06). */
  task_logs: Row[];
  /** log_care_checkin rows (phase 06). */
  care_checkins: Row[];
  /** Care request notes and Heads-ups (phase 06 6.13). */
  care_requests: Row[];
  pet_cautions: Row[];
  /** send_care_change_request / respond_care_change_request (phase 06 6.20). */
  care_change_requests: Row[];
  /** respond_booking / propose_handoff calls with their parameters. */
  responses: Row[];
  proposals: Row[];
  /** Meet & Greet RPC calls: { fn, ...params }. */
  meetGreetCalls: Row[];
  /** complete_handoff calls. */
  completions: Row[];
  /** complete_task_log calls (phase 06). */
  taskCompletions: Row[];
  /** save_care_request calls, even refused ones (phase 06 6.13). */
  saves: Row[];
  /** Owner consent signatures (03C). */
  booking_consents: Row[];
  /** Owner entry codes (03C) — sitters only via get_home_access. */
  owner_home_access: Row[];
  /** pay_booking_demo calls. */
  payments: Row[];
  /** Unread / Realtime notices (Phase 05) — empty in e2e unless a test seeds rows. */
  notifications: Row[];
  /** Feed posts + media rows (Phase 05 upload path). */
  feed_posts: Row[];
  media: Row[];
  /** AI drafts (private to the sitter) and sent reports (Phase 07). */
  daily_reports: Row[];
  /** Inquiries and their thread (Phase 07B). */
  inquiries: Row[];
  inquiry_messages: Row[];
  /** Reviews of finished stays (Phase 07C). */
  reviews: Row[];
  sitter_owner_notes: Row[];
  owner_favorite_sitters: Row[];
  /** Pet Life Records (Phase 07C): written by the backend, read by the owner. */
  pet_life_records: Row[];
  /** Prices a sitter set (006). Empty = nobody has any, like a fresh sitter. */
  sitter_rates: Row[];
  /** When set, quote_booking fails with this code (the real one throws before it prices anything). */
  quote_error: string | null;
};

const OWNER_PROFILE_FIELDS = ["home_address", "emergency_contact_name", "emergency_contact_phone", "vet_clinic_name", "vet_clinic_phone"];
const SITTER_PROFILE_FIELDS = ["bio", "service_area", "experience_years", "home_notes", "home_address"];

function emptyRow(id: string, fields: string[]): Row {
  return Object.fromEntries([["id", id], ...fields.map((f) => [f, null])]);
}

function createMockDb(): MockDb {
  return {
    pets: [],
    pet_allergies: [],
    owner_profiles: [],
    sitter_profiles: [],
    sitter_availability: [],
    bookings: [],
    booking_slots: [],
    cancellations: [],
    booking_handoffs: [],
    booking_pets: [],
    search_results: [],
    searches: [],
    requests: [],
    care_tasks: [],
    task_logs: [],
    care_checkins: [],
    care_requests: [],
    pet_cautions: [],
    care_change_requests: [],
    responses: [],
    proposals: [],
    meetGreetCalls: [],
    completions: [],
    taskCompletions: [],
    saves: [],
    booking_consents: [],
    owner_home_access: [],
    payments: [],
    notifications: [],
    feed_posts: [],
    media: [],
    daily_reports: [],
    inquiries: [],
    inquiry_messages: [],
    reviews: [],
    sitter_owner_notes: [],
    owner_favorite_sitters: [],
    pet_life_records: [],
    sitter_rates: [],
    quote_error: null,
  };
}

/** Fixed quote shape matching Goal boarding 2 pets + Thanksgiving (3C.1 / Checkout). */
export const DEMO_QUOTE = {
  service: "boarding",
  nights: 3,
  days: 0,
  unit_price: 55,
  base: 165,
  extra_pets: 82.5,
  holiday_days: [{ day: "2026-10-12", name: "Thanksgiving" }],
  holiday_surcharge: 20.63,
  total: 268.13,
  currency: "CAD",
  rate_version: "e2e",
};

function requiredKinds(db: MockDb, bookingId: string): string[] {
  const booking = db.bookings.find((b) => b.id === bookingId);
  if (!booking) return [];
  const kinds = ["emergency_vet", "safe_return"];
  if (booking.service_type === "boarding") kinds.push("handoff_rules", "cohabitation");
  const ownerHome = db.booking_handoffs.some(
    (h) =>
      h.booking_id === bookingId &&
      h.location_type === "owner_home" &&
      (h.status === "proposed" || h.status === "agreed"),
  );
  if (booking.service_type === "house_sitting" || ownerHome) kinds.push("home_access");
  return kinds;
}

const SLOT_NAMES = ["morning", "afternoon", "overnight"];

function* daysBetween(from: string, to: string) {
  for (let d = new Date(`${from}T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    yield d.toISOString().slice(0, 10);
  }
}

function coversDay(row: Row, day: string): boolean {
  return String(row.start_date) <= day && day <= String(row.end_date);
}

/** Confirmed pets in a sitter's day × slot. */
function usedSpots(db: MockDb, sitterId: string, day: string, slot: string): string[] {
  const confirmed = new Set(
    db.bookings.filter((b) => b.sitter_id === sitterId && b.status === "confirmed").map((b) => String(b.id)),
  );
  return db.booking_slots
    .filter((s) => confirmed.has(String(s.booking_id)) && s.day === day && s.slot === slot)
    .map((s) => String(s.booking_id));
}

/** get_sitter_schedule (003): newest open row sets hours and spots, any blocked row closes the slot. */
function sitterSchedule(db: MockDb, sitterId: string, from: string, to: string): Row[] {
  const rows = db.sitter_availability.filter((r) => r.sitter_id === sitterId);
  const out: Row[] = [];
  for (const day of daysBetween(from, to)) {
    for (const slot of SLOT_NAMES) {
      const here = rows.filter((r) => r.slot === slot && coversDay(r, day));
      const blocked = here.some((r) => r.kind === "blocked");
      const open = here
        .filter((r) => r.kind === "open")
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
      const remaining = open ? Math.max(Number(open.max_pets) - usedSpots(db, sitterId, day, slot).length, 0) : 0;
      out.push({
        day,
        slot,
        starts_at: open ? `${open.starts_at}:00` : null,
        ends_at: open ? `${open.ends_at}:00` : null,
        state: blocked ? "blocked" : !open ? "closed" : remaining === 0 ? "full" : "open",
        remaining: blocked || !open ? 0 : remaining,
      });
    }
  }
  return out;
}

/** guard_availability_change (003), blocks only: a block over a confirmed booking is refused. */
function blockConflicts(db: MockDb, inserted: Row[]): string[] {
  const ids = new Set<string>();
  for (const row of inserted.filter((r) => r.kind === "blocked")) {
    for (const day of daysBetween(String(row.start_date), String(row.end_date))) {
      for (const id of usedSpots(db, String(row.sitter_id), day, String(row.slot))) ids.add(id);
    }
  }
  return [...ids];
}

/** Role rows the signup trigger would have created (phase-02 handle_new_user). */
function ensureRoleRows(users: MockUser[], db: MockDb) {
  for (const user of users) {
    const table = user.role === "owner" ? db.owner_profiles : db.sitter_profiles;
    if (!table.some((row) => row.id === user.id)) {
      table.push(emptyRow(user.id, user.role === "owner" ? OWNER_PROFILE_FIELDS : SITTER_PROFILE_FIELDS));
    }
  }
}

function callerId(authorization: string | undefined): string | null {
  const token = (authorization ?? "").replace(/^Bearer /, "");
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof claims.sub === "string" ? claims.sub : null;
  } catch {
    return null;
  }
}

/** Meet & Greet RPCs (005): the same state machine, minus notifications. */
function handleMeetGreet(route: Route, fn: string, args: Row, me: string | null, db: MockDb) {
  db.meetGreetCalls.push({ fn, ...args });
  const fail = (message: string) => json(route, 400, { code: "P0001", message, details: null });
  const b = db.bookings.find((x) => x.id === args.p_booking);
  if (!b || ![b.owner_id, b.sitter_id].includes(me)) return fail("not_allowed");

  if (fn === "get_meet_greet_options") {
    return json(route, 200, {
      owner_name: "Robert",
      owner_spots: db.owner_profiles.find((p) => p.id === b.owner_id)?.meet_spots ?? [],
      sitter_name: "Chloe",
      sitter_spots: db.sitter_profiles.find((p) => p.id === b.sitter_id)?.meet_spots ?? [],
    });
  }
  if (b.status !== "requested") return fail("invalid_status");
  const status = String(b.meet_greet_status ?? "not_needed");
  const done = () => route.fulfill({ status: 204 });

  switch (fn) {
    case "propose_meet_greet": {
      if (!["required", "proposed", "agreed"].includes(status)) return fail("invalid_status");
      if (args.p_mode === "in_person" && !String(args.p_place ?? "").trim()) return fail("place_required");
      if (Date.parse(String(args.p_at)) <= nowMs()) return fail("invalid_window");
      Object.assign(b, {
        meet_greet_status: "proposed",
        meet_greet_mode: args.p_mode,
        meet_greet_at: args.p_at,
        meet_greet_place: args.p_mode === "in_person" ? args.p_place : null,
        meet_greet_link: null,
        meet_greet_proposed_by: me,
        meet_greet_skip_requested_by: null,
      });
      return done();
    }
    case "respond_meet_greet": {
      if (status !== "proposed") return fail("invalid_status");
      if (b.meet_greet_proposed_by === me) return fail("not_allowed");
      if (args.p_accept) b.meet_greet_status = "agreed";
      else
        Object.assign(b, {
          meet_greet_status: "required",
          meet_greet_mode: null,
          meet_greet_at: null,
          meet_greet_place: null,
          meet_greet_proposed_by: null,
        });
      return done();
    }
    case "complete_meet_greet": {
      if (status !== "agreed") return fail("invalid_status");
      if (nowMs() < Date.parse(String(b.meet_greet_at))) return fail("meet_greet_not_yet");
      b.meet_greet_status = "done";
      return done();
    }
    case "request_skip_meet_greet": {
      if (!["required", "proposed", "agreed"].includes(status)) return fail("invalid_status");
      Object.assign(b, { meet_greet_status: "skip_requested", meet_greet_skip_requested_by: me });
      return done();
    }
    case "respond_skip_meet_greet": {
      if (status !== "skip_requested") return fail("invalid_status");
      if (b.meet_greet_skip_requested_by === me) return fail("not_allowed");
      if (args.p_accept) b.meet_greet_status = "skipped";
      else Object.assign(b, { status: "cancelled", cancel_reason: "meet_greet_declined", cancelled_by: me });
      return done();
    }
  }
  return fail("not_mocked");
}

/** `col=eq.value`, `col=lte.value`, `col=gte.value` and `col=in.(a,b)` filters. */
function matches(row: Row, params: URLSearchParams): boolean {
  for (const [key, raw] of params) {
    if (["select", "order", "limit", "offset", "columns"].includes(key)) continue;
    if (raw.startsWith("eq.")) {
      if (String(row[key]) !== raw.slice(3)) return false;
    } else if (raw.startsWith("lte.")) {
      if (!(String(row[key]) <= raw.slice(4))) return false;
    } else if (raw.startsWith("gte.")) {
      if (!(String(row[key]) >= raw.slice(4))) return false;
    } else if (raw.startsWith("lt.")) {
      if (!(String(row[key]) < raw.slice(3))) return false;
    } else if (raw.startsWith("in.(")) {
      const values = raw.slice(4, -1).split(",").map((v) => v.replace(/^"|"$/g, ""));
      if (!values.includes(String(row[key]))) return false;
    } else if (raw === "is.null") {
      if (row[key] != null) return false;
    } else if (raw === "not.is.null") {
      if (row[key] == null) return false;
    }
  }
  return true;
}

/** The 010 RLS for inquiry_messages. */
function inquiryMessageVisible(db: MockDb, row: Row, me: string | null): boolean {
  const inquiry = db.inquiries.find((i) => i.id === row.inquiry_id);
  if (!inquiry) return false;
  if (inquiry.sitter_id === me) return true;
  return (
    inquiry.owner_id === me &&
    (row.author === "owner" || row.author === "sitter") &&
    (row.status ?? "sent") === "sent" &&
    Date.parse(String(row.visible_at ?? row.created_at ?? 0)) <= Date.now()
  );
}

/** Same as the SQL `pet_has_open_stay`. */
function hasOpenStay(db: MockDb, petId: unknown): boolean {
  return db.bookings.some(
    (b) =>
      b.status === "confirmed" &&
      db.booking_pets.some((bp) => bp.booking_id === b.id && bp.pet_id === petId) &&
      !db.booking_handoffs.some((h) => h.booking_id === b.id && h.kind === "pick_up" && h.completed_at),
  );
}

/** Same as the SQL `apply_care_change_request`: the tasks (minus the ones the owner does) and the Heads-ups. */
function applyChangeRequest(db: MockDb, req: Row) {
  const skip = (req.counter_owner_tasks as number[] | undefined) ?? [];
  (req.tasks as Record<string, string | boolean | null>[]).forEach((t, i) => {
    if (skip.includes(i)) return;
    db.care_tasks.push({
      id: crypto.randomUUID(),
      pet_id: req.pet_id,
      type: t.type,
      title: t.title,
      dose: t.dose ?? null,
      scheduled_time: `${t.time}:00`,
      notes: t.notes ?? null,
      repeat_daily: t.repeat ?? true,
      active: true,
      created_at: new Date(nowMs()).toISOString(),
    });
  });
  for (const text of req.cautions as string[]) {
    db.pet_cautions.push({ id: crypto.randomUUID(), pet_id: req.pet_id, text, active: true });
  }
}

function respond(route: Route, rows: Row[], wantsObject: boolean, status = 200, count?: number) {
  if (wantsObject) {
    if (rows.length !== 1) {
      return json(route, 406, { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" });
    }
    return json(route, status, rows[0]);
  }
  const headers: Record<string, string> = {};
  if (count != null) {
    headers["content-range"] =
      count === 0 ? "*/0" : `0-${Math.max(rows.length - 1, 0)}/${count}`;
  }
  return route.fulfill({
    status,
    contentType: "application/json",
    headers,
    body: JSON.stringify(rows),
  });
}

async function handleRest(route: Route, users: MockUser[], db: MockDb) {
  ensureRoleRows(users, db);
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname.split("/rest/v1/")[1] ?? "";
  const params = url.searchParams;
  const method = request.method();
  const headers = request.headers();
  const wantsObject = (headers.accept ?? "").includes("vnd.pgrst.object");
  const wantsRows = (headers.prefer ?? "").includes("return=representation");
  const me = callerId(headers.authorization);

  if (path === "rpc/get_my_sitter_profile") {
    return respond(route, db.sitter_profiles.filter((row) => row.id === me), wantsObject);
  }

  if (path === "rpc/get_sitter_schedule") {
    const { p_sitter, p_from, p_to } = request.postDataJSON();
    return json(route, 200, sitterSchedule(db, p_sitter, p_from, p_to));
  }

  if (path === "rpc/list_my_sitters") {
    // Sitters with a confirmed booking (or one confirmed and later cancelled) — 003/004.
    const counted = db.bookings.filter(
      (b) => b.owner_id === me && (b.status === "confirmed" || (b.status === "cancelled" && b.responded_at)),
    );
    const sitterIds = [...new Set(counted.map((b) => String(b.sitter_id)))];
    return json(
      route,
      200,
      sitterIds.map((id) => {
        const details = db.sitter_profiles.find((p) => p.id === id) ?? {};
        const mine = counted.filter((b) => b.sitter_id === id);
        return {
          sitter_id: id,
          display_name: users.find((u) => u.id === id)?.displayName ?? null,
          bio: details.bio ?? null,
          service_area: details.service_area ?? null,
          experience_years: details.experience_years ?? null,
          services: details.services ?? ["boarding"],
          booking_count: mine.length,
          last_booking_at: mine.map((b) => String(b.created_at ?? "")).sort().pop() ?? null,
        };
      }),
    );
  }

  if (path === "rpc/search_sitters") {
    db.searches.push(request.postDataJSON());
    return json(route, 200, db.search_results);
  }

  if (path === "rpc/request_booking") {
    // request_booking (004): booking + two proposed handoffs + pets. Errors can be forced
    // by setting `request_error` on the sitter's search row.
    const args = request.postDataJSON();
    db.requests.push(args);
    const forced = db.search_results.find((r) => r.sitter_id === args.p_sitter)?.request_error;
    if (forced) return json(route, 400, { code: "P0001", message: forced, details: null });
    const id = crypto.randomUUID();
    const created = new Date(nowMs()).toISOString();
    db.bookings.push({
      id,
      owner_id: me,
      sitter_id: args.p_sitter,
      status: "requested",
      service_type: args.p_service_type ?? "boarding",
      created_at: created,
    });
    for (const [kind, at, type, note] of [
      ["drop_off", args.p_drop_off_at, args.p_drop_off_location_type, args.p_drop_off_note],
      ["pick_up", args.p_pick_up_at, args.p_pick_up_location_type, args.p_pick_up_note],
    ]) {
      db.booking_handoffs.push({
        id: crypto.randomUUID(),
        booking_id: id,
        kind,
        scheduled_at: at,
        location_type: type,
        location_note: note,
        within_sitter_hours: true,
        status: "proposed",
        proposed_by: me,
        completed_at: null,
        created_at: created,
      });
    }
    for (const petId of args.p_pets) db.booking_pets.push({ booking_id: id, pet_id: petId });
    return json(route, 200, id);
  }

  if (path === "rpc/get_booking_pets") {
    const { p_booking } = request.postDataJSON();
    const rows = db.booking_pets
      .filter((bp) => bp.booking_id === p_booking)
      .map((bp) => db.pets.find((p) => p.id === bp.pet_id))
      .filter((p): p is Row => !!p)
      .map((p) => ({ pet_id: p.id, name: p.name, species: p.species, breed: p.breed ?? null }));
    return json(route, 200, rows);
  }

  if (path === "rpc/respond_booking") {
    // respond_booking (003 + 004 guard): decline ends it; accept needs the Meet & Greet and no
    // pending sitter counter-offer, then agrees the owner's proposals.
    const args = request.postDataJSON();
    db.responses.push(args);
    const booking = db.bookings.find((b) => b.id === args.p_booking && b.sitter_id === me);
    const fail = (message: string) => json(route, 400, { code: "P0001", message, details: null });
    if (!booking) return fail("not_allowed");
    if (booking.status !== "requested") return fail("invalid_status");
    const open = db.booking_handoffs.filter((h) => h.booking_id === booking.id && h.status === "proposed");
    if (!args.p_accept) {
      booking.status = "declined";
      for (const h of open) h.status = "rejected";
      return route.fulfill({ status: 204 });
    }
    if (!["not_needed", "done", "skipped", undefined].includes(booking.meet_greet_status as string | undefined)) {
      return fail("meet_greet_required");
    }
    if (open.some((h) => h.proposed_by === me)) return fail("handoff_pending");
    booking.status = "confirmed";
    for (const h of open) h.status = "agreed";
    return route.fulfill({ status: 204 });
  }

  if (path === "rpc/propose_handoff") {
    const args = request.postDataJSON();
    db.proposals.push(args);
    const booking = db.bookings.find((b) => b.id === args.p_booking && (b.owner_id === me || b.sitter_id === me));
    if (!booking) return json(route, 400, { code: "P0001", message: "not_allowed", details: null });
    const current = db.booking_handoffs.filter((h) => h.booking_id === booking.id && h.kind === args.p_kind);
    const base = current.find((h) => h.status === "proposed") ?? current.find((h) => h.status === "agreed");
    for (const h of current) if (h.status === "proposed") h.status = "superseded";
    const id = crypto.randomUUID();
    db.booking_handoffs.push({
      id,
      booking_id: booking.id,
      kind: args.p_kind,
      scheduled_at: args.p_at,
      // A time-only offer keeps the place (p_location_type omitted, 003).
      location_type: args.p_location_type ?? base?.location_type ?? "sitter_home",
      location_note: args.p_location_type ? (args.p_note ?? null) : (base?.location_note ?? null),
      within_sitter_hours: true,
      status: "proposed",
      proposed_by: me,
      completed_at: null,
      created_at: new Date(nowMs()).toISOString(),
    });
    return json(route, 200, id);
  }

  if (path.startsWith("rpc/") && path.includes("meet_greet")) {
    return handleMeetGreet(route, path.slice(4), request.postDataJSON(), me, db);
  }

  if (path === "rpc/complete_handoff") {
    // complete_handoff (003): sitter, confirmed, Received from 2 h before drop-off, Returned after it.
    const { p_booking, p_kind } = request.postDataJSON();
    db.completions.push({ p_booking, p_kind });
    const fail = (message: string) => json(route, 400, { code: "P0001", message, details: null });
    const booking = db.bookings.find((b) => b.id === p_booking && b.sitter_id === me);
    if (!booking) return fail("not_allowed");
    if (booking.status !== "confirmed") return fail("invalid_status");
    const agreed = (kind: string) =>
      db.booking_handoffs.find((h) => h.booking_id === p_booking && h.kind === kind && h.status === "agreed");
    const h = agreed(p_kind);
    if (!h) return fail("handoff_missing");
    if (h.completed_at) return fail("handoff_completed");
    if (p_kind === "drop_off" && nowMs() < Date.parse(String(h.scheduled_at)) - 2 * 3_600_000) {
      return fail("handoff_too_early");
    }
    if (p_kind === "pick_up" && !agreed("drop_off")?.completed_at) return fail("drop_off_not_completed");
    h.completed_at = new Date(nowMs()).toISOString();
    return route.fulfill({ status: 204 });
  }

  if (path === "rpc/respond_handoff") {
    // respond_handoff (003): the other side answers; declining before confirm ends the request.
    const { p_handoff, p_accept } = request.postDataJSON();
    db.responses.push({ p_handoff, p_accept });
    const fail = (message: string) => json(route, 400, { code: "P0001", message, details: null });
    const h = db.booking_handoffs.find((x) => x.id === p_handoff);
    const booking = h && db.bookings.find((b) => b.id === h.booking_id);
    if (!h || !booking || ![booking.owner_id, booking.sitter_id].includes(me) || h.proposed_by === me) {
      return fail("not_allowed");
    }
    if (h.status !== "proposed") return fail("invalid_status");
    if (!p_accept) {
      h.status = "rejected";
      if (booking.status === "requested") booking.status = me === booking.sitter_id ? "declined" : "cancelled";
      return route.fulfill({ status: 204 });
    }
    for (const x of db.booking_handoffs) {
      if (x.booking_id === h.booking_id && x.kind === h.kind && x.status === "agreed") x.status = "superseded";
    }
    h.status = "agreed";
    return route.fulfill({ status: 204 });
  }

  if (path === "rpc/get_handoff_details") {
    // Agreed handoffs with the real address after demo pay (3C.4), confirmed only. Paid once is enough —
    // a checkout reopened by an agreed change keeps them (009e).
    const { p_booking } = request.postDataJSON();
    const booking = db.bookings.find((b) => b.id === p_booking && (b.owner_id === me || b.sitter_id === me));
    if (!booking || booking.status !== "confirmed") return json(route, 400, { code: "P0001", message: "invalid_status" });
    if (!booking.paid_at && !booking.price_snapshot) return json(route, 400, { code: "P0001", message: "not_paid" });
    const sitter = db.sitter_profiles.find((p) => p.id === booking.sitter_id);
    const address = (h: Row) =>
      h.location_type === "sitter_home"
        ? (sitter?.home_address ?? null)
        : h.location_type === "owner_home"
          ? (db.owner_profiles.find((p) => p.id === booking.owner_id)?.home_address ?? null)
          : h.location_note;
    return json(
      route,
      200,
      db.booking_handoffs
        .filter((h) => h.booking_id === booking.id && h.status === "agreed")
        .map((h) => ({
          handoff_id: h.id,
          kind: h.kind,
          scheduled_at: h.scheduled_at,
          location_type: h.location_type,
          address: address(h),
          visitor_parking: h.location_type === "sitter_home" ? (sitter?.visitor_parking ?? null) : null,
          lobby_notes: h.location_type === "sitter_home" ? (sitter?.lobby_notes ?? null) : null,
          packing_list: h.location_type === "sitter_home" ? (sitter?.packing_list ?? null) : null,
        })),
    );
  }

  if (path === "rpc/cancel_booking") {
    const { p_booking, p_reason } = request.postDataJSON();
    const booking = db.bookings.find((b) => b.id === p_booking && (b.owner_id === me || b.sitter_id === me));
    if (!booking) return json(route, 400, { code: "P0001", message: "not_allowed", details: null });
    const received = db.booking_handoffs.some(
      (h) => h.booking_id === p_booking && h.kind === "drop_off" && h.status === "agreed" && h.completed_at,
    );
    if (received) return json(route, 400, { code: "P0001", message: "booking_in_progress", details: null });
    Object.assign(booking, { status: "cancelled", cancelled_by: me, cancel_reason: p_reason });
    db.cancellations.push({ p_booking, p_reason });
    return route.fulfill({ status: 204 });
  }

  if (path === "rpc/quote_booking") {
    if (db.quote_error) return json(route, 400, { code: "P0001", message: db.quote_error, details: null });
    return json(route, 200, DEMO_QUOTE);
  }

  if (path === "rpc/required_consents") {
    const { p_booking } = request.postDataJSON();
    const booking = db.bookings.find((b) => b.id === p_booking && (b.owner_id === me || b.sitter_id === me));
    if (!booking) return json(route, 400, { code: "P0001", message: "not_allowed", details: null });
    return json(route, 200, requiredKinds(db, p_booking));
  }

  if (path === "rpc/pay_booking_demo") {
    // pay_booking_demo (006): owner, confirmed, unpaid, all consents → paid_at + snapshot.
    const { p_booking } = request.postDataJSON();
    db.payments.push({ p_booking });
    const fail = (message: string, details: string | null = null) =>
      json(route, 400, { code: "P0001", message, details });
    const booking = db.bookings.find((b) => b.id === p_booking);
    if (!booking || booking.owner_id !== me) return fail("not_allowed");
    if (booking.status !== "confirmed") return fail("invalid_status");
    if (booking.paid_at) return fail("already_paid");
    const required = requiredKinds(db, p_booking);
    const signed = new Set(
      db.booking_consents.filter((c) => c.booking_id === p_booking).map((c) => String(c.kind)),
    );
    const missing = required.filter((k) => !signed.has(k));
    if (missing.length > 0) return fail("consents_missing", missing.join(","));
    booking.paid_at = new Date(nowMs()).toISOString();
    booking.price_snapshot = DEMO_QUOTE;
    return json(route, 200, DEMO_QUOTE);
  }

  if (path === "rpc/ensure_today_task_logs") {
    const { p_pet } = request.postDataJSON();
    const today = appToday();
    for (const task of db.care_tasks.filter((t) => t.pet_id === p_pet && t.active)) {
      const due = zonedToIso(today, String(task.scheduled_time).slice(0, 5));
      if (!db.task_logs.some((l) => l.task_id === task.id && l.due_at === due)) {
        db.task_logs.push({
          id: crypto.randomUUID(),
          task_id: task.id,
          pet_id: p_pet,
          due_at: due,
          status: "pending",
          completed_at: null,
          media_id: null,
          created_at: new Date(nowMs()).toISOString(),
        });
      }
    }
    const start = zonedToIso(today, "00:00");
    const end = zonedToIso(addDays(today, 1), "00:00");
    return json(
      route,
      200,
      db.task_logs.filter((l) => l.pet_id === p_pet && String(l.due_at) >= start && String(l.due_at) < end),
    );
  }

  if (path === "rpc/save_care_request") {
    const { p_pet, p_text, p_model, p_tasks, p_cautions } = request.postDataJSON();
    db.saves.push({ p_pet, p_text, p_model });
    const pet = db.pets.find((p) => p.id === p_pet);
    if (!pet || pet.owner_id !== me) return json(route, 400, { code: "P0001", message: "forbidden" });
    // All or nothing, like the SQL function: a task the pet can't do rolls everything back.
    for (const t of p_tasks as { type: string }[]) {
      if ((t.type === "walk" && pet.species === "cat") || (t.type === "litter" && pet.species === "dog")) {
        return json(route, 400, { code: "P0001", message: "task_type_not_allowed_for_species" });
      }
    }
    const id = crypto.randomUUID();
    db.care_requests.push({ id, pet_id: p_pet, created_by: me, raw_text: p_text, model: p_model });
    for (const t of p_tasks as Record<string, string | null>[]) {
      db.care_tasks.push({
        id: crypto.randomUUID(),
        pet_id: p_pet,
        type: t.type,
        title: t.title,
        dose: t.dose ?? null,
        scheduled_time: `${t.time}:00`,
        notes: t.notes ?? null,
        repeat_daily: true,
        active: true,
        request_id: id,
        created_at: new Date(nowMs()).toISOString(),
      });
    }
    for (const text of p_cautions as string[]) {
      db.pet_cautions.push({ id: crypto.randomUUID(), pet_id: p_pet, request_id: id, text, active: true });
    }
    return json(route, 200, id);
  }

  if (path === "rpc/send_care_change_request") {
    const { p_pet, p_tasks, p_cautions } = request.postDataJSON();
    const pet = db.pets.find((p) => p.id === p_pet);
    if (!pet || pet.owner_id !== me) return json(route, 400, { code: "P0001", message: "forbidden" });
    if ((p_tasks as unknown[]).length === 0 && (p_cautions as unknown[]).length === 0) {
      return json(route, 400, { code: "P0001", message: "empty_request" });
    }
    const booking = db.bookings.find(
      (b) => b.status === "confirmed" && db.booking_pets.some((bp) => bp.booking_id === b.id && bp.pet_id === p_pet),
    );
    if (!booking) return json(route, 400, { code: "P0001", message: "no_active_stay" });
    if (db.care_change_requests.some((r) => r.pet_id === p_pet && ["pending", "countered"].includes(r.status as string))) {
      return json(route, 400, { code: "P0001", message: "request_pending" });
    }
    const id = crypto.randomUUID();
    db.care_change_requests.push({
      id,
      pet_id: p_pet,
      booking_id: booking.id,
      requested_by: me,
      sitter_id: booking.sitter_id,
      status: "pending",
      tasks: p_tasks,
      cautions: p_cautions,
      decline_reason: null,
      created_at: new Date(nowMs()).toISOString(),
    });
    db.notifications.push({
      id: crypto.randomUUID(),
      user_id: booking.sitter_id,
      type: "care_request",
      title: `${users.find((u) => u.id === me)?.displayName} sent a care request for ${pet.name} 📝`,
      body: null,
      pet_id: p_pet,
      booking_id: booking.id,
      ref_id: id,
      read_at: null,
      created_at: new Date(nowMs()).toISOString(),
    });
    return json(route, 200, id);
  }

  if (path === "rpc/respond_care_change_request") {
    const { p_request, p_approve, p_reason, p_note } = request.postDataJSON();
    const req = db.care_change_requests.find((r) => r.id === p_request);
    if (!req || req.sitter_id !== me) return json(route, 400, { code: "P0001", message: "forbidden" });
    if (req.status !== "pending") return json(route, 400, { code: "P0001", message: "already_answered" });
    if (p_approve) applyChangeRequest(db, req);
    Object.assign(req, { status: p_approve ? "approved" : "declined", decline_reason: p_approve ? null : p_reason, note: p_approve ? null : p_note });
    const pet = db.pets.find((p) => p.id === req.pet_id);
    db.notifications.push({
      id: crypto.randomUUID(),
      user_id: req.requested_by,
      type: p_approve ? "care_request_approved" : "care_request_declined",
      title: p_approve ? `${pet?.name} request approved` : `Couldn't take this one for ${pet?.name}`,
      body: p_approve ? null : ([p_reason, p_note].filter(Boolean).join(" — ") || "Message them to adjust it."),
      pet_id: req.pet_id,
      booking_id: req.booking_id,
      ref_id: req.id,
      read_at: null,
      created_at: new Date(nowMs()).toISOString(),
    });
    return json(route, 200, req);
  }

  if (path === "rpc/counter_care_change_request") {
    const { p_request, p_note, p_fee_cents, p_owner_tasks } = request.postDataJSON();
    const req = db.care_change_requests.find((r) => r.id === p_request);
    if (!req || req.sitter_id !== me) return json(route, 400, { code: "P0001", message: "forbidden" });
    if (req.status !== "pending") return json(route, 400, { code: "P0001", message: "already_answered" });
    if (!String(p_note ?? "").trim()) return json(route, 400, { code: "P0001", message: "note_required" });
    Object.assign(req, { status: "countered", note: String(p_note).trim(), counter_fee_cents: p_fee_cents, counter_owner_tasks: p_owner_tasks });
    const pet = db.pets.find((p) => p.id === req.pet_id);
    db.notifications.push({
      id: crypto.randomUUID(),
      user_id: req.requested_by,
      type: "care_request_countered",
      title: `${users.find((u) => u.id === me)?.displayName} sent a counter-request for ${pet?.name} 💬`,
      body: req.note,
      pet_id: req.pet_id,
      booking_id: req.booking_id,
      ref_id: req.id,
      read_at: null,
      created_at: new Date(nowMs()).toISOString(),
    });
    return json(route, 200, req);
  }

  if (path === "rpc/answer_care_counter") {
    const { p_request, p_accept } = request.postDataJSON();
    const req = db.care_change_requests.find((r) => r.id === p_request);
    if (!req || req.requested_by !== me) return json(route, 400, { code: "P0001", message: "forbidden" });
    if (req.status !== "countered") return json(route, 400, { code: "P0001", message: "already_answered" });
    if (p_accept) applyChangeRequest(db, req);
    req.status = p_accept ? "accepted" : "withdrawn";
    db.notifications.push({
      id: crypto.randomUUID(),
      user_id: req.sitter_id,
      type: p_accept ? "care_counter_accepted" : "care_counter_declined",
      title: p_accept ? "Counter-request accepted" : "Counter-request declined",
      body: null,
      pet_id: req.pet_id,
      booking_id: req.booking_id,
      ref_id: req.id,
      read_at: null,
      created_at: new Date(nowMs()).toISOString(),
    });
    return json(route, 200, req);
  }

  if (path === "rpc/send_daily_report") {
    const { p_report, p_body } = request.postDataJSON();
    const report = db.daily_reports.find((r) => r.id === p_report);
    if (!report || report.sitter_id !== me) return json(route, 400, { code: "P0001", message: "forbidden" });
    if (report.status !== "draft") return json(route, 400, { code: "P0001", message: "report_already_sent" });
    if (!String(p_body ?? "").trim()) return json(route, 400, { code: "P0001", message: "body_required" });
    Object.assign(report, { body: String(p_body).trim(), status: "sent", sent_at: new Date(nowMs()).toISOString() });
    const pet = db.pets.find((p) => p.id === report.pet_id);
    db.notifications.push({
      id: crypto.randomUUID(),
      user_id: pet?.owner_id,
      type: "report_sent",
      title: `${users.find((u) => u.id === me)?.displayName} sent ${pet?.name}'s daily report 📓`,
      body: String(p_body).trim().slice(0, 140),
      pet_id: report.pet_id,
      booking_id: null,
      ref_id: report.id,
      read_at: null,
      created_at: new Date(nowMs()).toISOString(),
    });
    return json(route, 200, report);
  }

  if (path === "rpc/submit_review") {
    // 011: only the booking's owner, only after Returned, ★1–5, once.
    const { p_booking, p_rating, p_comment } = request.postDataJSON();
    const booking = db.bookings.find((b) => b.id === p_booking);
    if (!booking || booking.owner_id !== me) return json(route, 400, { code: "P0001", message: "forbidden" });
    const returned = db.booking_handoffs.some((h) => h.booking_id === p_booking && h.kind === "pick_up" && h.completed_at);
    if (booking.status !== "confirmed" || !returned) return json(route, 400, { code: "P0001", message: "stay_not_finished" });
    if (!(p_rating >= 1 && p_rating <= 5)) return json(route, 400, { code: "P0001", message: "invalid_rating" });
    if (db.reviews.some((r) => r.booking_id === p_booking)) return json(route, 400, { code: "P0001", message: "already_reviewed" });
    const row = {
      id: crypto.randomUUID(), booking_id: p_booking, owner_id: me, sitter_id: booking.sitter_id, rating: p_rating,
      comment: String(p_comment ?? "").trim() || null, created_at: new Date().toISOString(),
    };
    db.reviews.push(row);
    db.notifications.push({
      id: crypto.randomUUID(), user_id: booking.sitter_id, type: "review_received", title: "review", body: row.comment,
      pet_id: null, booking_id: p_booking, ref_id: row.id, read_at: null, created_at: row.created_at,
    });
    return json(route, 200, row);
  }

  if (path === "rpc/save_owner_note") {
    // 011g: the stay's sitter, after Returned, ★1–5; one note per booking, saving again edits it; nobody is told.
    const { p_booking, p_rating, p_comment } = request.postDataJSON();
    const booking = db.bookings.find((b) => b.id === p_booking);
    if (!booking || booking.sitter_id !== me) return json(route, 400, { code: "P0001", message: "forbidden" });
    const returned = db.booking_handoffs.some((h) => h.booking_id === p_booking && h.kind === "pick_up" && h.completed_at);
    if (booking.status !== "confirmed" || !returned) return json(route, 400, { code: "P0001", message: "stay_not_finished" });
    if (!(p_rating >= 1 && p_rating <= 5)) return json(route, 400, { code: "P0001", message: "invalid_rating" });
    const comment = String(p_comment ?? "").trim() || null;
    const now = new Date().toISOString();
    let row = db.sitter_owner_notes.find((n) => n.booking_id === p_booking);
    if (row) Object.assign(row, { rating: p_rating, comment, updated_at: now });
    else {
      row = { id: crypto.randomUUID(), booking_id: p_booking, sitter_id: me, owner_id: booking.owner_id, rating: p_rating, comment, created_at: now, updated_at: now };
      db.sitter_owner_notes.push(row);
    }
    return json(route, 200, row);
  }

  if (path === "rpc/sitter_rating_summary") {
    const { p_sitter } = request.postDataJSON();
    const mine = db.reviews.filter((r) => r.sitter_id === p_sitter);
    const avg = mine.length ? Math.round((mine.reduce((n, r) => n + Number(r.rating), 0) / mine.length) * 10) / 10 : null;
    const recent = mine
      .filter((r) => r.comment)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, 3)
      .map((r) => ({
        rating: r.rating, comment: r.comment, created_at: r.created_at,
        reviewer: (users.find((u) => u.id === r.owner_id)?.displayName ?? "An owner").split(" ")[0],
      }));
    return json(route, 200, { avg, count: mine.length, recent });
  }

  if (path === "rpc/send_inquiry_reply") {
    // 010b: only the thread's sitter; quote / sources / can_host are copied from the draft, nothing else.
    const { p_inquiry, p_body, p_draft, p_outcome } = request.postDataJSON();
    const inquiry = db.inquiries.find((i) => i.id === p_inquiry);
    if (!inquiry || inquiry.sitter_id !== me) return json(route, 400, { code: "P0001", message: "forbidden" });
    const body = String(p_body ?? "").trim();
    if (!body) return json(route, 400, { code: "P0001", message: "body_required" });
    let grounding: Row | null = null;
    if (p_outcome === "decline" || p_outcome === "suggest") {
      // 011k: a decline / suggestion can't host and carries no quote.
      grounding = { availability: { can_host: false } };
    } else if (p_draft) {
      const draft = db.inquiry_messages.find((m) => m.id === p_draft && m.inquiry_id === p_inquiry && m.author === "ai");
      if (!draft) return json(route, 400, { code: "P0001", message: "draft_not_found" });
      const g = (draft.grounding ?? {}) as Row;
      grounding = { quote: g.quote ?? null, sources: g.sources ?? [], availability: { can_host: (g.availability as Row | undefined)?.can_host ?? true } };
    }
    const row = {
      id: crypto.randomUUID(),
      inquiry_id: p_inquiry,
      author: "sitter",
      sender_id: me,
      body,
      grounding,
      drafted_by_ai: !!p_draft,
      status: "sent",
      confirmed_by_sitter_at: new Date().toISOString(),
      visible_at: new Date().toISOString(),
      read_at: null,
      created_at: new Date().toISOString(),
    };
    db.inquiry_messages.push(row);
    db.notifications.push({
      id: crypto.randomUUID(), user_id: inquiry.owner_id, type: "inquiry_replied", title: "reply", body: body.slice(0, 140),
      pet_id: null, booking_id: null, ref_id: p_inquiry, read_at: null, created_at: row.created_at,
    });
    return json(route, 200, row);
  }

  if (path === "rpc/change_inquiry_dates") {
    // 011j: the owner's own open inquiry only; one owner message records the change.
    const { p_inquiry, p_drop_off_at, p_pick_up_at, p_drop_off_place, p_pick_up_place, p_body } = request.postDataJSON();
    const inquiry = db.inquiries.find((i) => i.id === p_inquiry);
    if (!inquiry || inquiry.owner_id !== me) return json(route, 400, { code: "P0001", message: "forbidden" });
    if (inquiry.status !== "open") return json(route, 400, { code: "P0001", message: "inquiry_closed" });
    if (!(Date.parse(p_pick_up_at) > Date.parse(p_drop_off_at))) return json(route, 400, { code: "P0001", message: "invalid_window" });
    inquiry.drop_off_at = p_drop_off_at;
    inquiry.pick_up_at = p_pick_up_at;
    if (p_drop_off_place) inquiry.drop_off_location_type = p_drop_off_place;
    if (p_pick_up_place) inquiry.pick_up_location_type = p_pick_up_place;
    const row = {
      id: crypto.randomUUID(), inquiry_id: p_inquiry, author: "owner", sender_id: me, body: String(p_body), grounding: null,
      drafted_by_ai: false, status: "sent", visible_at: new Date().toISOString(), read_at: null, created_at: new Date().toISOString(),
    };
    db.inquiry_messages.push(row);
    return json(route, 200, row);
  }

  if (path === "rpc/stay_capacity_check") {
    // 011c: null = fits; a spec sets `db.stayShortfall` to see the refusal.
    return json(route, 200, db.stayShortfall ?? null);
  }

  if (path === "rpc/get_my_ai_reply_mode" || path === "rpc/set_ai_reply_mode") {
    const profile = db.sitter_profiles.find((p) => p.id === me);
    if (!profile) return json(route, 400, { code: "P0001", message: "forbidden" });
    if (path === "rpc/set_ai_reply_mode") {
      const { p_mode, p_consent } = request.postDataJSON();
      if (p_mode === "auto" && !p_consent && !profile.ai_consent_at) return json(route, 400, { code: "P0001", message: "consent_required" });
      profile.ai_reply_mode = p_mode;
      if (p_mode === "auto" && p_consent) profile.ai_consent_at = new Date().toISOString();
    }
    return json(route, 200, { mode: profile.ai_reply_mode ?? "manual", consented: !!profile.ai_consent_at });
  }

  if (path === "rpc/mark_inquiry_read") {
    const { p_inquiry } = request.postDataJSON();
    const inquiry = db.inquiries.find((i) => i.id === p_inquiry);
    if (inquiry?.sitter_id === me) {
      for (const m of db.inquiry_messages) {
        if (m.inquiry_id === p_inquiry && m.author === "owner" && !m.read_at) m.read_at = new Date().toISOString();
      }
    }
    return route.fulfill({ status: 204 });
  }

  if (path === "rpc/log_care_checkin") {
    const { p_pet, p_kind, p_value, p_note_text, p_media_id } = request.postDataJSON();
    const note = typeof p_note_text === "string" && p_note_text.trim() ? p_note_text.trim() : null;
    const pet = db.pets.find((p) => p.id === p_pet);
    if (p_kind === "note" && !note) return json(route, 400, { code: "P0001", message: "note_required" });
    if (p_kind === "walk" && pet?.species === "cat") {
      return json(route, 400, { code: "P0001", message: "checkin_not_allowed_for_species" });
    }
    const row = {
      id: crypto.randomUUID(),
      pet_id: p_pet,
      created_by: me,
      kind: p_kind,
      value: p_kind === "note" ? null : p_value,
      note_text: note,
      media_id: p_media_id,
      created_at: new Date(nowMs()).toISOString(),
    };
    db.care_checkins.push(row);
    // Same rule as the SQL: preset line, or only the typed memo.
    const preset = `${pet?.name} ${p_kind} ${p_value ?? ""}`.trim();
    db.notifications.push({
      id: crypto.randomUUID(),
      user_id: pet?.owner_id,
      type: "care_checkin",
      title: preset,
      body: note,
      pet_id: p_pet,
      booking_id: null,
      ref_id: row.id,
      read_at: null,
      created_at: row.created_at,
    });
    return json(route, 200, row);
  }

  if (path === "rpc/complete_task_log") {
    const { p_task_log, p_media_id, p_note_text } = request.postDataJSON();
    db.taskCompletions.push({ p_task_log, p_media_id, p_note_text });
    const note = typeof p_note_text === "string" && p_note_text.trim() ? p_note_text.trim() : null;
    const log = db.task_logs.find((l) => l.id === p_task_log);
    if (!log) return json(route, 400, { code: "P0001", message: "task_log_not_found" });
    if (log.status === "done") return json(route, 400, { code: "P0001", message: "already_done" });
    Object.assign(log, {
      status: "done",
      completed_at: new Date(nowMs()).toISOString(),
      completed_by: me,
      media_id: p_media_id,
      note_text: note,
    });
    const pet = db.pets.find((p) => p.id === log.pet_id);
    const task = db.care_tasks.find((t) => t.id === log.task_id);
    db.notifications.push({
      id: crypto.randomUUID(),
      user_id: pet?.owner_id,
      type: "task_done",
      title: `${pet?.name} finished ${task?.title}`,
      body: note,
      pet_id: log.pet_id,
      booking_id: null,
      ref_id: log.id,
      read_at: null,
      created_at: new Date(nowMs()).toISOString(),
    });
    if (p_media_id) {
      db.feed_posts.push({
        id: crypto.randomUUID(),
        pet_id: log.pet_id,
        sitter_id: me,
        posted_by: me,
        visibility: "shared",
        media_id: p_media_id,
        caption: note ?? `${task?.title} — done`,
        caption_source: "task",
        task_log_id: log.id,
        created_at: new Date(nowMs()).toISOString(),
      });
    }
    return json(route, 200, log);
  }

  if (path === "rpc/get_home_access") {
    const { p_booking } = request.postDataJSON();
    const fail = (message: string, details: string | null = null) =>
      json(route, 400, { code: "P0001", message, details });
    const booking = db.bookings.find((b) => b.id === p_booking);
    if (!booking || booking.sitter_id !== me) return fail("forbidden");
    if (!booking.paid_at) return fail("not_paid");
    const needs =
      booking.service_type === "house_sitting" ||
      db.booking_handoffs.some(
        (h) => h.booking_id === p_booking && h.location_type === "owner_home" && h.status === "agreed",
      );
    if (!needs) return fail("forbidden");
    const drop = db.booking_handoffs.find(
      (h) =>
        h.booking_id === p_booking &&
        h.status === "agreed" &&
        (booking.service_type === "house_sitting" || h.location_type === "owner_home"),
    );
    const unlockAt = drop ? Date.parse(String(drop.scheduled_at)) - 2 * 3_600_000 : nowMs();
    if (nowMs() < unlockAt) {
      return fail("access_locked", JSON.stringify({ unlocks_at: new Date(unlockAt).toISOString() }));
    }
    const access = db.owner_home_access.find((r) => r.owner_id === booking.owner_id);
    return json(route, 200, [
      {
        entry_steps: access?.entry_steps ?? null,
        lockbox_code: access?.lockbox_code ?? null,
        buzzer: access?.buzzer ?? null,
        fob_notes: access?.fob_notes ?? null,
        sitter_parking: access?.sitter_parking ?? null,
        first_revealed_at: new Date(nowMs()).toISOString(),
      },
    ]);
  }

  if (path === "profiles") {
    if (method === "PATCH") {
      const user = users.find((u) => u.id === me && matches({ id: u.id }, params));
      if (user) user.displayName = String(request.postDataJSON().display_name);
      return route.fulfill({ status: 204 });
    }
    const rows = users
      .map((u) => ({ id: u.id, role: u.role, display_name: u.displayName }) as Row)
      .filter((row) => matches(row, params));
    return respond(route, rows, wantsObject);
  }

  const table = db[path as keyof MockDb];
  if (!table) return json(route, 404, { message: `Not mocked: ${method} ${path}` });

  // supabase-js `head: true` (unread count) sends HEAD; answer like GET.
  if (method === "GET" || method === "HEAD") {
    // RLS: notifications are private to their user.
    let rows = table.filter(
      (row) =>
        matches(row, params) &&
        (path !== "notifications" || (row.user_id === me && (row.visible_at == null || Date.parse(String(row.visible_at)) <= Date.now()))) &&
        // RLS: a private post is only visible to its author (5.8).
        (path !== "feed_posts" || row.posted_by === me || row.visibility !== "private") &&
        // RLS: an owner only sees reports that were sent; a draft is the sitter's alone (009).
        (path !== "daily_reports" || row.sitter_id === me || row.status === "sent") &&
        // RLS: a party sees their own inquiries; the owner never sees an AI draft or an unsent / not-yet-visible reply (010).
        (path !== "inquiries" || row.owner_id === me || row.sitter_id === me) &&
        // RLS: a review is private to the owner who wrote it and the sitter it is about (011).
        (path !== "reviews" || row.owner_id === me || row.sitter_id === me) &&
        // RLS (011g): the sitter's note about an owner is the sitter's alone.
        (path !== "sitter_owner_notes" || row.sitter_id === me) &&
        // RLS (011h): an owner's favorites are theirs alone.
        (path !== "owner_favorite_sitters" || row.owner_id === me) &&
        // RLS (011): an owner reads their pets' records; the raw source_snapshot is never selectable.
        // …and a sitter with a pending / confirmed booking that includes the pet (can_view_pet_profile).
        (path !== "pet_life_records" ||
          db.pets.some((p) => p.id === row.pet_id && p.owner_id === me) ||
          db.bookings.some(
            (b) =>
              b.sitter_id === me &&
              (b.status === "requested" || b.status === "confirmed") &&
              db.booking_pets.some((bp) => bp.booking_id === b.id && bp.pet_id === row.pet_id),
          )) &&
        (path !== "inquiry_messages" || inquiryMessageVisible(db, row, me)),
    );
    if (path === "pets" && (params.get("select") ?? "").includes("pet_allergies(")) {
      rows = rows.map((pet) => ({
        ...pet,
        pet_allergies: db.pet_allergies
          .filter((a) => a.pet_id === pet.id)
          .map((a) => ({ id: a.id, allergen: a.allergen })),
      }));
    }
    const select = params.get("select") ?? "";
    if (path === "pets" && select.includes("pet_cautions(")) {
      rows = rows.map((pet) => ({
        ...pet,
        pet_cautions: db.pet_cautions.filter((c) => c.pet_id === pet.id),
      }));
    }
    if (path === "pets" && select.includes("care_tasks(")) {
      rows = rows.map((pet) => ({ ...pet, care_tasks: db.care_tasks.filter((t) => t.pet_id === pet.id) }));
    }
    if (path === "pets" && select.includes("owner:profiles")) {
      rows = rows.map((pet) => ({
        ...pet,
        owner: { display_name: users.find((u) => u.id === pet.owner_id)?.displayName ?? null },
      }));
    }
    if (path === "feed_posts" && select.includes("media")) {
      rows = rows.map((post) => {
        const media = db.media.find((m) => m.id === post.media_id) ?? null;
        const author = users.find((u) => u.id === post.posted_by);
        return {
          ...post,
          media: media
            ? {
                id: media.id,
                cloudinary_public_id: media.cloudinary_public_id,
                resource_type: media.resource_type,
                width: media.width ?? null,
                height: media.height ?? null,
                duration_s: media.duration_s ?? null,
              }
            : null,
          author: { display_name: author?.displayName ?? "Someone" },
        };
      });
    }
    // Diary reads (phase 06 6.11): embeds PostgREST would resolve from the foreign keys.
    const mediaOf = (id: unknown) => {
      const m = db.media.find((x) => x.id === id);
      return m
        ? { id: m.id, cloudinary_public_id: m.cloudinary_public_id, resource_type: m.resource_type }
        : null;
    };
    const nameOf = (id: unknown) => {
      const u = users.find((x) => x.id === id);
      return u ? { display_name: u.displayName } : null;
    };
    if (path === "task_logs" && select.includes("care_tasks")) {
      rows = rows.map((log) => {
        const task = db.care_tasks.find((t) => t.id === log.task_id);
        return {
          ...log,
          care_tasks: task ? { type: task.type, title: task.title } : null,
          media: mediaOf(log.media_id),
          completed: nameOf(log.completed_by),
        };
      });
    }
    if (path === "inquiries" && select.includes("sitter:profiles")) {
      const name = (id: unknown) => ({ display_name: users.find((u) => u.id === id)?.displayName ?? null });
      rows = rows.map((r) => ({ ...r, sitter: name(r.sitter_id), owner: name(r.owner_id) }));
    }
    if (path === "pet_life_records" && select.includes("sitter:profiles")) {
      rows = rows.map((r) => ({ ...r, sitter: { display_name: users.find((u) => u.id === r.sitter_id)?.displayName ?? null } }));
    }
    if (path === "daily_reports" && select.includes("pets(")) {
      rows = rows.map((r) => ({
        ...r,
        pets: { name: db.pets.find((p) => p.id === r.pet_id)?.name ?? null },
        sitter: { display_name: users.find((u) => u.id === r.sitter_id)?.displayName ?? null },
      }));
    }
    if (path === "care_change_requests") {
      rows = rows
        .filter((r) => r.requested_by === me || r.sitter_id === me)
        .map((r) => ({ ...r, pets: { name: db.pets.find((p) => p.id === r.pet_id)?.name ?? null } }));
    }
    if (path === "task_logs" && select.includes("media") && !select.includes("care_tasks")) {
      rows = rows.map((log) => ({ ...log, media: mediaOf(log.media_id) }));
    }
    if (path === "care_checkins" && select.includes("media")) {
      rows = rows.map((c) => ({ ...c, media: mediaOf(c.media_id), by: nameOf(c.created_by) }));
    }
    if (path === "bookings") {
      const name = (id: unknown) => ({ display_name: users.find((u) => u.id === id)?.displayName ?? null });
      rows = rows.map((b) => ({
        ...b,
        ...(select.includes("owner:profiles") ? { owner: name(b.owner_id) } : {}),
        ...(select.includes("sitter:profiles") ? { sitter: name(b.sitter_id) } : {}),
        ...(select.includes("booking_handoffs(")
          ? { booking_handoffs: db.booking_handoffs.filter((h) => h.booking_id === b.id) }
          : {}),
        ...(select.includes("booking_pets(")
          ? {
              booking_pets: db.booking_pets
                .filter((bp) => bp.booking_id === b.id)
                .map((bp) => {
                  const pet = db.pets.find((p) => p.id === bp.pet_id);
                  return { pets: pet ? { id: pet.id, name: pet.name, species: pet.species } : null };
                }),
            }
          : {}),
      }));
    }
    if ((params.get("order") ?? "").startsWith("created_at")) {
      rows = [...rows].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      // Feed + notifications are read newest first (`order=created_at.desc`).
      if ((path === "pet_life_records" || path === "feed_posts" || path === "notifications" || path === "care_checkins" || path === "care_change_requests" || path === "inquiries") && params.get("order")!.endsWith(".desc")) {
        rows.reverse();
      }
    }
    // Reads ordered by a report's sent time (Stay summary).
    if ((params.get("order") ?? "").startsWith("sent_at")) {
      rows = [...rows].sort((a, b) => String(a.sent_at).localeCompare(String(b.sent_at)));
      if (params.get("order")!.endsWith(".desc")) rows.reverse();
    }
    const wantsCount = (headers.prefer ?? "").includes("count=");
    return respond(route, rows, wantsObject, 200, wantsCount ? rows.length : undefined);
  }

  if (method === "POST") {
    const body = request.postDataJSON();
    const inserted: Row[] = (Array.isArray(body) ? body : [body]).map((row: Row): Row => ({
      id: crypto.randomUUID(),
      created_at: new Date(nowMs()).toISOString(),
      ...(path === "booking_consents" ? { signed_at: new Date(nowMs()).toISOString() } : {}),
      ...(path === "feed_posts" ? { visibility: "shared" } : {}),
      ...(path === "pet_cautions" ? { active: true } : {}),
      // Column defaults of 010.
      ...(path === "inquiries" ? { status: "open", booking_id: null } : {}),
      ...(path === "inquiry_messages" ? { status: "sent", visible_at: new Date().toISOString(), read_at: null } : {}),
      // 011h: owner_id defaults to the caller.
      ...(path === "owner_favorite_sitters" ? { owner_id: me } : {}),
      ...row,
    }));
    if (path === "booking_consents") {
      for (const row of inserted) {
        const dupe = db.booking_consents.some((c) => c.booking_id === row.booking_id && c.kind === row.kind);
        if (dupe) return json(route, 409, { code: "23505", message: "duplicate key value" });
        // 009d: the owner signs at checkout only — confirmed, not paid yet, a kind the booking requires.
        const booking = db.bookings.find((b) => b.id === row.booking_id);
        const open = !!booking && booking.owner_id === me && booking.status === "confirmed" && !booking.paid_at;
        if (row.signer_id !== me || !open || !requiredKinds(db, String(row.booking_id)).includes(String(row.kind))) {
          return json(route, 403, { code: "42501", message: "new row violates row-level security policy" });
        }
      }
    }
    if (path === "owner_home_access") {
      for (const row of inserted) {
        if (row.owner_id !== me) {
          return json(route, 403, { code: "42501", message: "new row violates row-level security policy" });
        }
      }
    }
    // 008j: no direct additions while a stay is on (confirmed booking, pet not picked up yet).
    if ((path === "care_tasks" || path === "pet_cautions") && inserted.some((row) => hasOpenStay(db, row.pet_id))) {
      return json(route, 403, { code: "42501", message: "new row violates row-level security policy" });
    }
    if (path === "care_tasks") {
      for (const row of inserted) {
        const pet = db.pets.find((p) => p.id === row.pet_id);
        if (!pet || pet.owner_id !== me) {
          return json(route, 403, { code: "42501", message: "new row violates row-level security policy" });
        }
        if ((row.type === "walk" && pet.species === "cat") || (row.type === "litter" && pet.species === "dog")) {
          return json(route, 400, { code: "P0001", message: "task_type_not_allowed_for_species" });
        }
        Object.assign(row, { active: true, repeat_daily: row.repeat_daily ?? true });
      }
    }
    if (path === "pets" && inserted.some((row) => row.owner_id !== me)) {
      return json(route, 403, { code: "42501", message: "new row violates row-level security policy" });
    }
    if (path === "sitter_availability") {
      if (inserted.some((row) => row.sitter_id !== me)) {
        return json(route, 403, { code: "42501", message: "new row violates row-level security policy" });
      }
      const conflicts = blockConflicts(db, inserted);
      if (conflicts.length > 0) {
        return json(route, 400, { code: "P0001", message: "overlaps_confirmed_booking", details: conflicts.join(",") });
      }
    }
    if (path === "pet_allergies") {
      for (const row of inserted) {
        const dupe = db.pet_allergies.some(
          (a) => a.pet_id === row.pet_id && String(a.allergen).toLowerCase() === String(row.allergen).toLowerCase(),
        );
        if (dupe) return json(route, 409, { code: "23505", message: "duplicate key value" });
      }
    }
    table.push(...inserted);
    if (!wantsRows) return route.fulfill({ status: 201 });
    return respond(route, inserted, wantsObject, 201);
  }

  if (method === "PATCH") {
    const changes = request.postDataJSON();
    if (path === "pets" && "species" in changes) {
      return json(route, 403, { code: "42501", message: "permission denied for column species" });
    }
    for (const row of table.filter(
      (r) => matches(r, params) && (path !== "notifications" || r.user_id === me),
    )) {
      Object.assign(row, changes);
    }
    return route.fulfill({ status: 204 });
  }

  if (method === "DELETE") {
    // RLS: notifications are deleted only by their user.
    const keep = table.filter(
      (row) => !(matches(row, params) && (path !== "notifications" || row.user_id === me)),
    );
    table.splice(0, table.length, ...keep);
    return route.fulfill({ status: 204 });
  }

  return json(route, 405, { message: `Not mocked: ${method} ${path}` });
}
