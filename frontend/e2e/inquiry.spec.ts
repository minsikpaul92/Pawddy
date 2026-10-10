import { expect, test } from "@playwright/test";

import { app, signIn } from "./helpers";
import { MockDb, OWNER, SITTER, mockSupabase } from "./supabaseMock";

// Owner inquiry (phase-07B 7B.5): Ask about a stay → the thread → the sitter's sent reply with the quote → Request booking.
// The AI endpoint is mocked (covered by pytest); a sitter reply is added to the mock DB the way the 010 RPC will.

const MAX = "00000000-0000-4000-8000-0000000000c1";
const MOCHI = "00000000-0000-4000-8000-0000000000c2";
const QUOTE = {
  service: "boarding", nights: 3, days: 0, unit_price: 55, base: 165, extra_pets: 82.5,
  holiday_days: [{ day: "2026-10-12", name: "Thanksgiving" }], holiday_surcharge: 20.63,
  total: 268.13, currency: "CAD", rate_version: "e2e",
};

function seed(db: MockDb) {
  db.pets.push(
    { id: MAX, owner_id: OWNER.id, species: "dog", name: "Max", breed: null, birthdate: null, weight_kg: null, notes: null, created_at: "2026-01-01T00:00:00Z" },
    { id: MOCHI, owner_id: OWNER.id, species: "cat", name: "Mochi", breed: null, birthdate: null, weight_kg: null, notes: null, created_at: "2026-01-02T00:00:00Z" },
  );
  db.sitter_profiles.push({
    id: SITTER.id, bio: "Cozy home", service_area: "North York", experience_years: 3, home_notes: null, home_address: "12 Maple St",
    services: ["boarding", "house_sitting"],
  });
  db.search_results.push({
    sitter_id: SITTER.id, display_name: SITTER.displayName, bio: null, service_area: null, experience_years: null,
    services: ["boarding", "house_sitting"], is_my_sitter: false, covered_slots: 11, total_slots: 11,
    drop_off_within_hours: true, pick_up_within_hours: true,
  });
}

async function openProfile(page: import("@playwright/test").Page) {
  const { db } = await mockSupabase(page, [OWNER, SITTER]);
  seed(db);
  const replyRequests: Record<string, unknown>[] = [];
  await page.route("**/api/ai/inquiry-reply", (route) => {
    replyRequests.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await signIn(page, OWNER);
  await expect(page).toHaveURL(/\/owner$/);
  await page.goto(`/owner/sitters/${SITTER.id}`);
  await app(page).getByTestId("ask-about-stay").click();
  return { db, replyRequests };
}

/** `YYYY-MM-DD`, `n` days from today in the app timezone. */
function dayFromToday(n: number): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

test.describe("ask before booking (FB-33)", () => {
  test("the profile reads Ask before booking next to Book, and the dates show the sitter's days for these pets", async ({ page }) => {
    const { db } = await mockSupabase(page, [OWNER, SITTER]);
    seed(db);
    const first = dayFromToday(0);
    const short = dayFromToday(1); // the sheet's default drop-off day
    const hours: Record<string, [string, string]> = { morning: ["08:00", "12:00"], afternoon: ["12:00", "18:00"], overnight: ["18:00", "08:00"] };
    for (const [slot, [starts, ends]] of Object.entries(hours)) {
      db.sitter_availability.push({
        id: `open-${slot}`, sitter_id: SITTER.id, kind: "open", slot, start_date: first, end_date: dayFromToday(20),
        starts_at: starts, ends_at: ends, max_pets: 2, created_at: "2026-01-01T00:00:00Z",
      });
    }
    // One night with a single spot: room for one pet, not for two.
    db.sitter_availability.push({
      id: "one-spot", sitter_id: SITTER.id, kind: "open", slot: "overnight", start_date: short, end_date: short,
      starts_at: "18:00", ends_at: "08:00", max_pets: 1, created_at: "2026-01-02T00:00:00Z",
    });
    await signIn(page, OWNER);
    await expect(page).toHaveURL(/\/owner$/);
    await page.goto(`/owner/sitters/${SITTER.id}`);
    const screen = app(page);

    await expect(screen.getByTestId("ask-about-stay")).toHaveText("Ask before booking");
    await expect(screen.getByTestId("book-this-sitter")).toHaveText("Book");
    await screen.getByTestId("ask-about-stay").click();
    await expect(screen.getByText("Ask Chloe before booking")).toBeVisible();

    await screen.getByTestId("inquiry-pet-Max").click();
    await expect(screen.getByTestId("drop_off-day-note")).toHaveCount(0); // one pet fits that night
    await screen.getByTestId("inquiry-pet-Mochi").click();
    await expect(screen.getByTestId("drop_off-day-note")).toContainText("Chloe has no room for your pets that day");

    await screen.getByTestId("drop_off-day-open").click();
    await expect(screen.getByTestId(`drop_off-calendar-${short}-full`)).toBeVisible();
    await expect(screen.getByTestId("drop_off-calendar-legend")).toContainText("Room for your pets");
  });
});

test.describe("owner inquiry", () => {
  test("ask → thread waits for the sitter → the sent reply shows with the quote → Request booking is prefilled", async ({ page }) => {
    const { db, replyRequests } = await openProfile(page);
    const screen = app(page);

    await expect(screen.getByTestId("inquiry-send")).toBeDisabled(); // nobody picked yet
    await screen.getByTestId("inquiry-pet-Max").click();
    await screen.getByTestId("inquiry-pet-Mochi").click();
    await screen.getByTestId("inquiry-question").fill("Can you give Max his pill at 2 PM?");
    await screen.getByTestId("inquiry-send").click();

    await expect(page).toHaveURL(/\/owner\/inquiries\/.+/);
    expect(db.inquiries).toHaveLength(1);
    expect(db.inquiries[0]).toMatchObject({ owner_id: OWNER.id, sitter_id: SITTER.id, service_type: "boarding", pet_ids: [MAX, MOCHI], status: "open" });
    expect(db.inquiry_messages[0]).toMatchObject({ author: "owner", sender_id: OWNER.id, body: "Can you give Max his pill at 2 PM?" });
    await expect.poll(() => replyRequests.length).toBe(1);
    expect(replyRequests[0]).toMatchObject({ inquiry_id: db.inquiries[0].id });

    await expect(screen.getByTestId("inquiry-question-bubble")).toContainText("pill at 2 PM");
    await expect(screen.getByTestId("inquiry-waiting")).toContainText("Chloe will reply soon");

    // A draft is invisible to the owner; the sent reply appears (poll).
    const inquiryId = db.inquiries[0].id as string;
    db.inquiry_messages.push({
      id: "draft1", inquiry_id: inquiryId, author: "ai", sender_id: null, body: "SECRET DRAFT", status: "draft", drafted_by_ai: true,
      visible_at: new Date().toISOString(), created_at: new Date().toISOString(), grounding: { quote: QUOTE },
    });
    await page.waitForTimeout(3500);
    await expect(screen.getByText("SECRET DRAFT")).toHaveCount(0);
    await expect(screen.getByTestId("inquiry-waiting")).toBeVisible();

    db.inquiry_messages.push({
      id: "reply1", inquiry_id: inquiryId, author: "sitter", sender_id: SITTER.id, status: "sent", drafted_by_ai: true,
      body: "Hi Robert! I'm available. The total is $268.13 CAD. 🐾",
      visible_at: new Date().toISOString(), created_at: new Date().toISOString(),
      grounding: { quote: QUOTE, sources: [{ id: "policy-0", type: "sitter_policy", label: "From Chloe's policies", text: "x" }], availability: { can_host: true } },
    });
    await expect(screen.getByTestId("inquiry-reply-bubble")).toContainText("268.13", { timeout: 8000 });
    await expect(screen.getByTestId("inquiry-waiting")).toHaveCount(0);
    await expect(screen.getByTestId("inquiry-quote")).toContainText("268.13");
    await expect(screen.getByTestId("inquiry-sources")).toContainText("From Chloe's policies");

    await screen.getByTestId("inquiry-request-booking").click();
    await expect(page).toHaveURL(new RegExp(`/owner/bookings/new\\?inquiry=${inquiryId}`));
    await expect(screen.getByTestId("pick-pet-Max")).toHaveAttribute("aria-checked", "true");
    await expect(screen.getByTestId("pick-pet-Mochi")).toHaveAttribute("aria-checked", "true");
    await expect(screen.getByTestId("pick-sitter-Chloe")).toHaveAttribute("aria-checked", "true");
    await screen.getByTestId("request-booking").click();
    await expect(screen.getByTestId("toast")).toContainText("Request sent to Chloe");
    expect(db.requests[0]).toMatchObject({ p_sitter: SITTER.id, p_pets: [MAX, MOCHI] });
    await expect.poll(() => db.inquiries[0].status).toBe("booked");
    expect(db.inquiries[0].booking_id).toBe(db.bookings.at(-1)?.id);
  });

  test("with no question a one-line summary of the trip is sent", async ({ page }) => {
    const { db } = await openProfile(page);
    const screen = app(page);
    await screen.getByTestId("inquiry-pet-Max").click();
    await screen.getByTestId("inquiry-send").click();
    await expect(page).toHaveURL(/\/owner\/inquiries\/.+/);
    expect(String(db.inquiry_messages[0].body)).toMatch(/^Boarding · .+ – .+ · Max$/);
  });

  test("a reply for dates the sitter can't take points to other sitters, with no Request booking", async ({ page }) => {
    const { db } = await openProfile(page);
    const screen = app(page);
    await screen.getByTestId("inquiry-pet-Max").click();
    await screen.getByTestId("inquiry-send").click();
    await expect(page).toHaveURL(/\/owner\/inquiries\/.+/);
    const inquiryId = db.inquiries[0].id as string;
    db.inquiry_messages.push({
      id: "reply2", inquiry_id: inquiryId, author: "sitter", sender_id: SITTER.id, status: "sent", drafted_by_ai: true,
      body: "Hi Robert! I can't take Max on Oct 10 — want me to look at other dates?",
      visible_at: new Date().toISOString(), created_at: new Date().toISOString(),
      grounding: { quote: null, sources: [], availability: { can_host: false, unavailable_days: [] } },
    });
    await expect(screen.getByTestId("inquiry-find-others")).toBeVisible({ timeout: 8000 });
    await expect(screen.getByTestId("inquiry-request-booking")).toHaveCount(0);
    await expect(screen.getByTestId("inquiry-quote")).toHaveCount(0);
    await screen.getByTestId("inquiry-find-others").click();
    await expect(page).toHaveURL(/inquiry=.+&other=1/);
    await expect(screen.getByTestId("pick-pet-Max")).toHaveAttribute("aria-checked", "true");
    await expect(screen.getByTestId("pick-sitter-Chloe")).not.toHaveAttribute("aria-checked", "true");
  });

  test("nobody else can open the conversation", async ({ page }) => {
    await mockSupabase(page, [OWNER, SITTER]);
    await signIn(page, OWNER);
    await expect(page).toHaveURL(/\/owner$/);
    await page.goto("/owner/inquiries/00000000-0000-4000-8000-0000000000ff");
    await expect(app(page).getByText("Conversation not found")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------------------------
// Sitter side (7B.6)
// ---------------------------------------------------------------------------------------------

const INQ = "00000000-0000-4000-8000-0000000000d1";

function seedThread(db: MockDb, extra: Record<string, unknown> = {}) {
  seed(db);
  db.inquiries.push({
    id: INQ, owner_id: OWNER.id, sitter_id: SITTER.id, service_type: "boarding",
    drop_off_at: "2030-10-09T11:30:00.000Z", pick_up_at: "2030-10-12T21:00:00.000Z",
    drop_off_location_type: "sitter_home", pick_up_location_type: "sitter_home",
    pet_ids: [MAX], status: "open", booking_id: null, created_at: "2026-10-06T10:00:00Z",
  });
  db.inquiry_messages.push(
    { id: "q1", inquiry_id: INQ, author: "owner", sender_id: OWNER.id, body: "Can you give Max his pill at 2 PM?", status: "sent", drafted_by_ai: false, visible_at: "2026-10-06T10:00:00Z", read_at: null, created_at: "2026-10-06T10:00:00Z", grounding: null },
    {
      id: "draft1", inquiry_id: INQ, author: "ai", sender_id: null, body: "Hi Robert! I'm available. The total is $268.13 CAD. 🐾", status: "draft", drafted_by_ai: true,
      visible_at: "2026-10-06T10:00:05Z", read_at: null, created_at: "2026-10-06T10:00:05Z",
      grounding: { quote: QUOTE, sources: [{ id: "policy-0", type: "sitter_policy", label: "From Chloe's policies", text: "x" }], availability: { can_host: true }, needs_sitter: false, intent: null, policy_conflicts: [] },
      ...extra,
    },
  );
}

async function openSitterThread(page: import("@playwright/test").Page, extra: Record<string, unknown> = {}) {
  const { db } = await mockSupabase(page, [OWNER, SITTER]);
  seedThread(db, extra);
  const asked: Record<string, unknown>[] = [];
  await page.route("**/api/ai/inquiry-reply", (route) => {
    const body = route.request().postDataJSON();
    asked.push(body);
    db.inquiry_messages.push({
      id: `draft-${asked.length + 1}`, inquiry_id: INQ, author: "ai", sender_id: null, status: "draft", drafted_by_ai: true,
      body: body.intent === "decline" ? "Hi Robert! I'm sorry, I can't this time." : "Hi Robert! A fresh take: $268.13 CAD.",
      visible_at: new Date().toISOString(), read_at: null, created_at: new Date(Date.now() + 1000 * asked.length).toISOString(),
      grounding: { quote: QUOTE, sources: [], availability: { can_host: true }, needs_sitter: false, intent: body.intent ?? null },
    });
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await signIn(page, SITTER);
  await app(page).getByRole("heading", { name: "Home" }).waitFor();
  await page.goto("/sitter/bookings");
  await app(page).getByTestId("sitter-bookings-tabs-inquiries").click();
  return { db, asked };
}

test.describe("sitter inquiry", () => {
  test("Questions lists the thread with a draft ready; one tap on Send keeps the quote and tells the owner", async ({ page }) => {
    const learned: Record<string, unknown>[] = [];
    await page.route("**/api/tone/record-reply", (route) => {
      learned.push(route.request().postDataJSON());
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ recorded: 1 }) });
    });
    const { db } = await openSitterThread(page);
    const screen = app(page);
    await expect(screen.getByTestId("sitter-bookings-tabs-inquiries-count")).toHaveText("1");
    await expect(screen.getByTestId(`inquiry-card-${INQ}`)).toContainText("Draft ready");
    await screen.getByTestId(`inquiry-card-${INQ}`).click();

    await expect(screen.getByTestId("inquiry-warning")).toHaveText("AI drafts can be wrong. You're responsible for what you send.");
    await expect(screen.getByTestId("inquiry-draft-body")).toContainText("$268.13");
    await expect(screen.getByTestId("inquiry-draft-quote")).toContainText("268.13");
    await expect(screen.getByTestId("inquiry-draft-sources")).toContainText("From Chloe's policies");
    await expect(screen.getByTestId("inquiry-needs-you")).toHaveCount(0);
    // Opening the thread is the read mark.
    await expect.poll(() => db.inquiry_messages.find((m) => m.id === "q1")?.read_at).toBeTruthy();

    await screen.getByTestId("inquiry-send").click(); // no typing at all
    await expect(screen.getByTestId("toast")).toContainText("Sent ✅ Robert was told");
    const sent = db.inquiry_messages.find((m) => m.author === "sitter");
    expect(sent).toMatchObject({ drafted_by_ai: true, sender_id: SITTER.id, body: "Hi Robert! I'm available. The total is $268.13 CAD. 🐾" });
    expect((sent?.grounding as { quote: { total: number } }).quote.total).toBe(268.13);
    expect(sent?.grounding).not.toHaveProperty("needs_sitter");
    expect(db.notifications.find((n) => n.type === "inquiry_replied")?.user_id).toBe(OWNER.id);
    await expect(screen.getByTestId("inquiry-replied")).toContainText("Robert was told");
    await expect(screen.getByTestId("inquiry-draft")).toHaveCount(0);
    await expect.poll(() => learned.length).toBe(1); // the assistant is asked to learn from this send
    expect(learned[0]).toEqual({ inquiry_id: INQ });
  });

  test("Edit / Add sends the sitter's own text, and a needs-you draft says so", async ({ page }) => {
    const { db } = await openSitterThread(page);
    db.inquiry_messages.find((m) => m.id === "draft1")!.grounding = {
      quote: QUOTE, sources: [], availability: { can_host: true }, needs_sitter: true, intent: null,
    };
    const screen = app(page);
    await screen.getByTestId(`inquiry-card-${INQ}`).click();
    await expect(screen.getByTestId("inquiry-needs-you")).toBeVisible();
    await screen.getByTestId("inquiry-edit-toggle").click();
    await screen.getByTestId("inquiry-edit").fill("Hi Robert! Yes — pill at 2 PM works. $268.13 CAD total.");
    await screen.getByTestId("inquiry-send").click();
    await expect(screen.getByTestId("toast")).toContainText("Sent ✅");
    expect(db.inquiry_messages.find((m) => m.author === "sitter")?.body).toBe("Hi Robert! Yes — pill at 2 PM works. $268.13 CAD total.");
  });

  test("Regenerate asks for another draft and the newest one is shown", async ({ page }) => {
    const { asked } = await openSitterThread(page);
    const screen = app(page);
    await screen.getByTestId(`inquiry-card-${INQ}`).click();
    await screen.getByTestId("inquiry-regenerate").click();
    await expect(screen.getByTestId("inquiry-draft-body")).toContainText("A fresh take");
    expect(asked[0]).toEqual({ inquiry_id: INQ, regenerate: true });
  });

  test("with no draft yet the sitter sees it is being written and can write it themselves", async ({ page }) => {
    const { db } = await mockSupabase(page, [OWNER, SITTER]);
    seedThread(db);
    db.inquiry_messages.splice(db.inquiry_messages.findIndex((m) => m.id === "draft1"), 1);
    await signIn(page, SITTER);
    await app(page).getByRole("heading", { name: "Home" }).waitFor();
    await page.goto(`/sitter/inquiries/${INQ}`);
    const screen = app(page);
    await expect(screen.getByTestId("inquiry-no-draft")).toContainText("Your draft is being written");
    await screen.getByTestId("inquiry-write-myself").click();
    await screen.getByTestId("inquiry-edit").fill("Hi Robert! I'll check and reply properly soon.");
    await screen.getByTestId("inquiry-send").click();
    await expect(screen.getByTestId("toast")).toContainText("Sent ✅");
    expect(db.inquiry_messages.find((m) => m.author === "sitter")).toMatchObject({ drafted_by_ai: false, grounding: null });
  });

  test("the sitter's policies are saved and handed to the assistant", async ({ page }) => {
    const { db } = await mockSupabase(page, [OWNER, SITTER]);
    db.sitter_profiles.push({ id: SITTER.id, bio: null, service_area: null, experience_years: null, home_notes: null, home_address: null, services: ["boarding"], policies: null });
    const reindex: number[] = [];
    await page.route("**/api/rag/reindex-sitter", (route) => {
      reindex.push(1);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ chunks: 1 }) });
    });
    await signIn(page, SITTER);
    await app(page).getByRole("heading", { name: "Home" }).waitFor();
    await page.goto("/profile");
    const screen = app(page);
    await screen.getByLabel("House rules & policies (optional)").fill("No dogs over 20 kg.");
    await screen.getByRole("button", { name: "Save" }).click();
    await expect(screen.getByTestId("toast")).toContainText("Profile saved");
    expect(db.sitter_profiles[0].policies).toBe("No dogs over 20 kg.");
    await expect.poll(() => reindex.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Auto-send at a human pace (7B.10)
// ---------------------------------------------------------------------------------------------

test.describe("auto-send", () => {
  test("the owner sees nothing, then \"typing…\", then the reply — and Read only once the sitter opened the thread", async ({ page }) => {
    const { db } = await mockSupabase(page, [OWNER, SITTER]);
    seedThread(db);
    // The AI draft is the sitter's; the auto reply is stored now but only appears at visible_at.
    const now = Date.now();
    const visible = new Date(now + 12000).toISOString();
    db.inquiries[0].reply_typing_at = new Date(now + 6000).toISOString();
    db.inquiries[0].reply_visible_at = visible;
    db.inquiry_messages.push({
      id: "auto1", inquiry_id: INQ, author: "sitter", sender_id: SITTER.id, status: "sent", drafted_by_ai: true, confirmed_by_sitter_at: null,
      body: "Hi Robert! I'm available. The total is $268.13 CAD. 🐾", visible_at: visible, read_at: null,
      created_at: new Date(now).toISOString(), grounding: { quote: QUOTE, sources: [], availability: { can_host: true } },
    });
    await signIn(page, OWNER);
    await expect(page).toHaveURL(/\/owner$/);
    await page.goto(`/owner/inquiries/${INQ}`);
    const screen = app(page);

    await expect(screen.getByTestId("inquiry-waiting")).toContainText("will reply soon");
    await expect(screen.getByTestId("inquiry-typing")).toHaveText("Chloe is typing…", { timeout: 9000 });
    await expect(screen.getByTestId("inquiry-reply-bubble")).toContainText("268.13", { timeout: 12000 });
    await expect(screen.getByTestId("inquiry-typing")).toHaveCount(0);
    // Nobody has opened the thread: no "Read", whatever the screen was doing.
    await expect(screen.getByTestId("inquiry-question-bubble")).not.toContainText("Read");

    db.inquiry_messages.find((m) => m.id === "q1")!.read_at = new Date().toISOString(); // the sitter opened it
    await page.reload();
    await expect(screen.getByTestId("inquiry-question-bubble")).toContainText("· Read");
  });

  test("the sitter sees the auto reply marked as sent automatically, with no draft to approve", async ({ page }) => {
    const { db } = await mockSupabase(page, [OWNER, SITTER]);
    seedThread(db);
    db.inquiry_messages.push({
      id: "auto1", inquiry_id: INQ, author: "sitter", sender_id: SITTER.id, status: "sent", drafted_by_ai: true, confirmed_by_sitter_at: null,
      body: "Hi Robert! I'm available.", visible_at: new Date(Date.now() + 20000).toISOString(), read_at: null,
      created_at: "2026-10-06T10:00:06Z", grounding: null,
    });
    await signIn(page, SITTER);
    await app(page).getByRole("heading", { name: "Home" }).waitFor();
    await page.goto(`/sitter/inquiries/${INQ}`);
    const screen = app(page);
    await expect(screen.getByTestId("inquiry-message-sitter")).toContainText("Sent automatically");
    await expect(screen.getByTestId("inquiry-draft")).toHaveCount(0);
    await expect(screen.getByTestId("inquiry-replied")).toBeVisible();
  });

  test("the sitter turns auto-send on only after the responsibility modal, and off again freely", async ({ page }) => {
    const { db } = await mockSupabase(page, [OWNER, SITTER]);
    db.sitter_profiles.push({ id: SITTER.id, bio: null, service_area: null, experience_years: null, home_notes: null, home_address: null, services: ["boarding"], policies: null });
    await signIn(page, SITTER);
    await app(page).getByRole("heading", { name: "Home" }).waitFor();
    await page.goto("/profile");
    const screen = app(page);
    await expect(screen.getByTestId("profile-ai-replies")).toContainText("You read each drafted reply");
    await screen.getByTestId("profile-ai-mode-auto").click();
    await expect(screen.getByTestId("ai-consent-sheet")).toContainText("Replies go out in your name. You're responsible for what's sent.");
    expect(db.sitter_profiles[0].ai_reply_mode).toBeUndefined(); // nothing changed yet
    await screen.getByTestId("ai-consent-confirm").click();
    await expect(screen.getByTestId("profile-ai-replies")).toContainText("go out in your name");
    expect(db.sitter_profiles[0]).toMatchObject({ ai_reply_mode: "auto" });
    expect(db.sitter_profiles[0].ai_consent_at).toBeTruthy();

    await screen.getByTestId("profile-ai-mode-manual").click();
    await expect(screen.getByTestId("profile-ai-replies")).toContainText("You read each drafted reply");
    await screen.getByTestId("profile-ai-mode-auto").click(); // consented once: no second modal
    await expect(screen.getByTestId("ai-consent-sheet")).toHaveCount(0);
    await expect(screen.getByTestId("profile-ai-replies")).toContainText("go out in your name");
  });
});

test.describe("owner questions list", () => {
  test("Bookings lists my questions with where each stands and opens the conversation", async ({ page }) => {
    const { db } = await mockSupabase(page, [OWNER, SITTER]);
    seedThread(db);
    // A second question the sitter already answered, and a third already turned into a booking.
    db.inquiries.push(
      { id: "inq-b", owner_id: OWNER.id, sitter_id: SITTER.id, service_type: "boarding", drop_off_at: "2030-11-01T12:00:00.000Z", pick_up_at: "2030-11-03T20:00:00.000Z", drop_off_location_type: "sitter_home", pick_up_location_type: "sitter_home", pet_ids: [MAX], status: "open", booking_id: null, created_at: "2026-10-05T10:00:00Z" },
      { id: "inq-c", owner_id: OWNER.id, sitter_id: SITTER.id, service_type: "boarding", drop_off_at: "2030-12-01T12:00:00.000Z", pick_up_at: "2030-12-03T20:00:00.000Z", drop_off_location_type: "sitter_home", pick_up_location_type: "sitter_home", pet_ids: [MAX], status: "booked", booking_id: null, created_at: "2026-10-04T10:00:00Z" },
    );
    db.inquiry_messages.push(
      { id: "r-b", inquiry_id: "inq-b", author: "sitter", sender_id: SITTER.id, status: "sent", body: "Yes!", visible_at: "2026-10-05T10:05:00Z", created_at: "2026-10-05T10:05:00Z", grounding: null },
      // A reply that is not visible yet must not count as a reply.
      { id: "r-hidden", inquiry_id: INQ, author: "sitter", sender_id: SITTER.id, status: "sent", body: "later", visible_at: new Date(Date.now() + 3_600_000).toISOString(), created_at: "2026-10-06T10:06:00Z", grounding: null },
    );
    await signIn(page, OWNER);
    await expect(page).toHaveURL(/\/owner$/);
    await page.goto("/owner/bookings");
    const screen = app(page);
    await expect(screen.getByTestId("owner-questions")).toContainText("Your questions");
    await expect(screen.getByTestId(`question-card-${INQ}`)).toContainText("Waiting for Chloe");
    await expect(screen.getByTestId("question-card-inq-b")).toContainText("Reply ready");
    await expect(screen.getByTestId("question-card-inq-c")).toContainText("Booking requested");
    // Newest first.
    const ids = await page.frameLocator('iframe[title="Goldito app"]').locator("[data-testid^='question-card-']").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
    expect(ids).toEqual([`question-card-${INQ}`, "question-card-inq-b", "question-card-inq-c"]);
    await screen.getByTestId("question-card-inq-b").click();
    await expect(page).toHaveURL(/\/owner\/inquiries\/inq-b$/);
    await expect(screen.getByTestId("inquiry-reply-bubble")).toContainText("Yes!");
  });
});

// ---------------------------------------------------------------------------------------------
// FB-34: the owner writes again, Change dates, and "replied" follows the latest owner message
// ---------------------------------------------------------------------------------------------

const SENT_REPLY = {
  id: "reply1", inquiry_id: INQ, author: "sitter", sender_id: SITTER.id, status: "sent", drafted_by_ai: true,
  body: "Hi Robert! I can't take Max that weekend.", visible_at: "2026-10-06T10:05:00Z", read_at: null,
  created_at: "2026-10-06T10:05:00Z", confirmed_by_sitter_at: "2026-10-06T10:05:00Z",
  grounding: { quote: null, sources: [], availability: { can_host: false } },
};

async function openOwnerThread(page: import("@playwright/test").Page, reply: Record<string, unknown> = SENT_REPLY) {
  const { db } = await mockSupabase(page, [OWNER, SITTER]);
  seedThread(db);
  db.inquiry_messages.push(reply);
  const asked: Record<string, unknown>[] = [];
  await page.route("**/api/ai/inquiry-reply", (route) => {
    asked.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await signIn(page, OWNER);
  await expect(page).toHaveURL(/\/owner$/);
  await page.goto(`/owner/inquiries/${INQ}`);
  return { db, asked };
}

test.describe("owner follow-up (FB-34)", () => {
  test("the thread shows every message in order; writing back adds the message and asks for a new draft", async ({ page }) => {
    const { db, asked } = await openOwnerThread(page);
    const screen = app(page);
    await expect(screen.getByTestId("inquiry-question-bubble")).toHaveCount(1);
    await expect(screen.getByTestId("inquiry-reply-bubble")).toContainText("can't take Max");
    await expect(screen.getByTestId("inquiry-compose")).toBeVisible();

    await screen.getByTestId("inquiry-followup").fill("What about the weekend after?");
    await screen.getByTestId("inquiry-followup-send").click();

    await expect(screen.getByTestId("inquiry-question-bubble")).toHaveCount(2);
    await expect(screen.getByTestId("inquiry-question-bubble").last()).toContainText("weekend after");
    expect(db.inquiry_messages.filter((m) => m.author === "owner").at(-1)).toMatchObject({
      sender_id: OWNER.id, body: "What about the weekend after?",
    });
    expect(asked).toEqual([{ inquiry_id: INQ }]);
    // Waiting for the sitter again: no reply box, no stale buttons from the earlier answer.
    await expect(screen.getByTestId("inquiry-waiting")).toBeVisible();
    await expect(screen.getByTestId("inquiry-compose")).toHaveCount(0);
    await expect(screen.getByTestId("inquiry-change-dates")).toHaveCount(0);
  });

  test("a declined reply offers Change dates first and Find other sitters second; Change dates moves the dates of the same thread", async ({ page }) => {
    const { db, asked } = await openOwnerThread(page);
    const screen = app(page);
    await expect(screen.getByTestId("inquiry-change-dates")).toBeVisible();
    await expect(screen.getByTestId("inquiry-find-others")).toBeVisible();
    const before = String(db.inquiries[0].drop_off_at);
    await screen.getByTestId("inquiry-change-dates").click();

    await expect(screen.getByTestId("inquiry-sheet")).toBeVisible();
    await expect(screen.getByText("Change dates").first()).toBeVisible();
    await expect(screen.getByTestId("inquiry-pet-Max")).toHaveCount(0); // the pets stay as asked
    // Move the drop-off a day later: the pick-up moves with it (same length of stay).
    const dropDay = await screen.getByTestId("drop_off-day-value").innerText();
    const pickDay = await screen.getByTestId("pick_up-day-value").innerText();
    await screen.getByTestId("drop_off-day-plus").click();
    await expect(screen.getByTestId("drop_off-day-value")).not.toHaveText(dropDay);
    await expect(screen.getByTestId("pick_up-day-value")).not.toHaveText(pickDay);
    await screen.getByTestId("inquiry-send").click();

    // Still one inquiry, same URL: the conversation goes on.
    await expect(screen.getByTestId("inquiry-waiting")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/owner/inquiries/${INQ}`));
    expect(db.inquiries).toHaveLength(1);
    expect(db.inquiries[0].id).toBe(INQ);
    expect(Date.parse(String(db.inquiries[0].drop_off_at))).toBe(Date.parse(before) + 86_400_000);
    const mine = db.inquiry_messages.filter((m) => m.author === "owner");
    expect(String(mine.at(-1)?.body)).toMatch(/^Changed dates: /);
    expect(asked).toEqual([{ inquiry_id: INQ }]);
    await expect(screen.getByTestId("inquiry-question-bubble").last()).toContainText("Changed dates");
  });

  test("the sitter's list and thread follow the latest owner message: a reply, then a new question, needs an answer again", async ({ page }) => {
    const { db } = await mockSupabase(page, [OWNER, SITTER]);
    seedThread(db);
    // The draft was sent; then the owner wrote again after it.
    db.inquiry_messages.push(
      { ...SENT_REPLY, id: "reply1" },
      { id: "q2", inquiry_id: INQ, author: "owner", sender_id: OWNER.id, body: "What about the weekend after?", status: "sent", drafted_by_ai: false, visible_at: "2026-10-06T11:00:00Z", read_at: null, created_at: "2026-10-06T11:00:00Z", grounding: null },
    );
    await signIn(page, SITTER);
    await app(page).getByRole("heading", { name: "Home" }).waitFor();
    await page.goto("/sitter/bookings");
    await app(page).getByTestId("sitter-bookings-tabs-inquiries").click();
    const screen = app(page);
    await expect(screen.getByTestId("sitter-bookings-tabs-inquiries-count")).toHaveText("1");
    await expect(screen.getByTestId(`inquiry-card-${INQ}`)).toContainText("Writing the draft");

    // The draft for the new message lands: the card says so, and the thread offers it (the old draft stays out).
    db.inquiry_messages.push({
      id: "draft2", inquiry_id: INQ, author: "ai", sender_id: null, body: "Hi Robert! The weekend after works.", status: "draft", drafted_by_ai: true,
      visible_at: "2026-10-06T11:00:05Z", read_at: null, created_at: "2026-10-06T11:00:05Z",
      grounding: { quote: null, sources: [], availability: { can_host: true }, needs_sitter: false, intent: null },
    });
    await page.reload();
    await app(page).getByTestId("sitter-bookings-tabs-inquiries").click();
    await expect(screen.getByTestId(`inquiry-card-${INQ}`)).toContainText("Draft ready");
    await screen.getByTestId(`inquiry-card-${INQ}`).click();
    await expect(screen.getByTestId("inquiry-draft-body")).toContainText("weekend after works");
    await expect(screen.getByTestId("inquiry-replied")).toHaveCount(0);
    await screen.getByTestId("inquiry-send").click();
    await expect(screen.getByTestId("toast")).toContainText("Sent");
    await expect(screen.getByTestId("inquiry-replied")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------------------------
// FB-34 follow-ups from the 2026-10-10 local run: stamps, live threads, source chips, no-room drafts
// ---------------------------------------------------------------------------------------------

test.describe("inquiry thread polish (FB-34)", () => {
  test("message times read like Oct 6, 10:05 AM, and another year adds the year", async ({ page }) => {
    await openOwnerThread(page, { ...SENT_REPLY, created_at: "2031-02-03T15:05:00Z" });
    const screen = app(page);
    await expect(screen.getByTestId("inquiry-question-bubble")).toContainText("Oct 6, 6:00 AM"); // this year: no year
    await expect(screen.getByTestId("inquiry-question-bubble")).not.toContainText("2026");
    await expect(screen.getByTestId("inquiry-reply-bubble")).toContainText("Feb 3, 2031, 10:05 AM");
    await expect(screen.getByTestId("inquiry-reply-bubble")).not.toContainText("02-03");
  });

  test("a sitter reply shows on the owner's open thread, and an owner message on the sitter's, with no reload", async ({ browser }) => {
    const ownerPage = await browser.newPage();
    const { db } = await openOwnerThread(ownerPage, { ...SENT_REPLY, id: "reply0" });
    await expect(app(ownerPage).getByTestId("inquiry-reply-bubble")).toHaveCount(1);
    db.inquiry_messages.push({
      ...SENT_REPLY, id: "reply-live", body: "One more thing: I can do the 14th!",
      visible_at: new Date().toISOString(), created_at: new Date(Date.now() + 1000).toISOString(),
    });
    await expect(app(ownerPage).getByTestId("inquiry-reply-bubble")).toHaveCount(2, { timeout: 12000 });
    await expect(app(ownerPage).getByTestId("inquiry-reply-bubble").last()).toContainText("the 14th");
    await ownerPage.close();

    const sitterPage = await browser.newPage();
    const mock = await mockSupabase(sitterPage, [OWNER, SITTER]);
    seedThread(mock.db);
    await signIn(sitterPage, SITTER);
    await app(sitterPage).getByRole("heading", { name: "Home" }).waitFor();
    await sitterPage.goto(`/sitter/inquiries/${INQ}`);
    await expect(app(sitterPage).getByTestId("inquiry-message-owner")).toHaveCount(1);
    mock.db.inquiry_messages.push({
      id: "q-live", inquiry_id: INQ, author: "owner", sender_id: OWNER.id, body: "Are you free the 14th too?", status: "sent",
      drafted_by_ai: false, visible_at: new Date().toISOString(), read_at: null, created_at: new Date(Date.now() + 2000).toISOString(), grounding: null,
    });
    await expect(app(sitterPage).getByTestId("inquiry-message-owner")).toHaveCount(2, { timeout: 12000 });
    // The new message is marked read the moment it is on the sitter's screen.
    await expect.poll(() => mock.db.inquiry_messages.find((m) => m.id === "q-live")?.read_at, { timeout: 12000 }).toBeTruthy();
    await sitterPage.close();
  });

  test("the earlier-messages source is not shown to the owner or the sitter", async ({ page }) => {
    const sources = [
      { id: "earlier-0", type: "inquiry", label: "From your earlier messages", text: "x" },
      { id: "policy-0", type: "sitter_policy", label: "From Chloe's policies", text: "y" },
    ];
    await openOwnerThread(page, { ...SENT_REPLY, grounding: { quote: null, sources, availability: { can_host: true } } });
    await expect(app(page).getByTestId("inquiry-sources")).toContainText("From Chloe's policies");
    await expect(app(page).getByTestId("inquiry-sources")).not.toContainText("earlier messages");
  });

  test("a draft for dates with no room says why, and Accept explains instead of sending a yes", async ({ page }) => {
    await openSitterThread(page, { grounding: { quote: null, sources: [], availability: { can_host: false }, needs_sitter: false, intent: null } });
    const screen = app(page);
    await screen.getByTestId(`inquiry-card-${INQ}`).click();
    await expect(screen.getByTestId("inquiry-no-room")).toContainText("no room");
    await screen.getByTestId("inquiry-intent-accept").click();
    await expect(screen.getByTestId("reply-no-room")).toContainText("no room");
    await expect(screen.getByTestId("reply-send")).toHaveCount(0);
    await expect(screen.getByTestId("reply-open-schedule")).toBeVisible();
  });
});

test.describe("sitter lands on what is waiting (FB-34)", () => {
  test("Home shows the waiting question, and Bookings opens on Questions when nothing else needs an answer", async ({ page }) => {
    const { db } = await mockSupabase(page, [OWNER, SITTER]);
    seedThread(db);
    await signIn(page, SITTER);
    const screen = app(page);
    await expect(screen.getByTestId("today-questions")).toContainText("Questions (1)");
    await screen.getByTestId("today-questions").click();
    await expect(page).toHaveURL(/\/sitter\/bookings/);
    // No tab tap needed: the Questions list is already open.
    await expect(screen.getByTestId(`inquiry-card-${INQ}`)).toBeVisible();
    // Once answered, the banner is gone.
    db.inquiry_messages.push({ ...SENT_REPLY, id: "answered", created_at: "2026-10-06T10:30:00Z" });
    await page.goto("/sitter");
    await expect(screen.getByRole("heading", { name: "Home" })).toBeVisible();
    await expect(screen.getByTestId("today-questions")).toHaveCount(0);
  });
});

test.describe("sitter quick replies (FB-34)", () => {
  test("Accept writes the reply in a popup; confirming sends it with the quote", async ({ page }) => {
    const { db, asked } = await openSitterThread(page);
    const screen = app(page);
    await screen.getByTestId(`inquiry-card-${INQ}`).click();
    await screen.getByTestId("inquiry-intent-accept").click();
    await expect(screen.getByTestId("reply-text")).toHaveValue(/A fresh take/, { timeout: 8000 });
    expect(asked.at(-1)).toEqual({ inquiry_id: INQ, regenerate: true, intent: "accept" });
    await screen.getByTestId("reply-send").click();
    await expect(screen.getByTestId("inquiry-replied")).toBeVisible();
    const sent = db.inquiry_messages.find((m) => m.author === "sitter");
    expect(sent).toMatchObject({ drafted_by_ai: true, sender_id: SITTER.id });
    expect((sent?.grounding as { quote: { total: number } }).quote.total).toBe(268.13);
    expect((sent?.grounding as { availability: { can_host: boolean } }).availability.can_host).toBe(true);
  });

  test("Decline writes a decline in a popup; confirming sends it as a no, with no quote", async ({ page }) => {
    const { db, asked } = await openSitterThread(page);
    const screen = app(page);
    await screen.getByTestId(`inquiry-card-${INQ}`).click();
    await screen.getByTestId("inquiry-intent-decline").click();
    await expect(screen.getByTestId("reply-text")).toHaveValue(/I can't this time/, { timeout: 8000 });
    expect(asked.at(-1)).toEqual({ inquiry_id: INQ, regenerate: true, intent: "decline" });
    await screen.getByTestId("reply-text").fill("Hi Robert! Sorry, I can't that week.");
    await screen.getByTestId("reply-send").click();
    await expect(screen.getByTestId("inquiry-replied")).toBeVisible();
    const sent = db.inquiry_messages.find((m) => m.author === "sitter");
    expect(sent?.body).toBe("Hi Robert! Sorry, I can't that week.");
    expect(sent?.grounding).toEqual({ availability: { can_host: false } });
  });

  test("Suggest other dates: pick the days, the message carries them, confirming sends it as a no for the asked dates", async ({ page }) => {
    const { db } = await openSitterThread(page);
    const screen = app(page);
    await screen.getByTestId(`inquiry-card-${INQ}`).click();
    await screen.getByTestId("inquiry-intent-suggest").click();
    await expect(screen.getByTestId("handoff-drop_off")).toBeVisible();
    await expect(screen.getByTestId("reply-text")).toHaveValue(/I can host Max from .+ to .+\. Would that work/);
    await screen.getByTestId("reply-send").click();
    await expect(screen.getByTestId("inquiry-replied")).toBeVisible();
    const sent = db.inquiry_messages.find((m) => m.author === "sitter");
    expect(sent?.drafted_by_ai).toBe(false);
    expect(sent?.grounding).toEqual({ availability: { can_host: false } });
  });

  test("Suggest other dates won't send days the sitter has no room for", async ({ page }) => {
    const { db } = await openSitterThread(page);
    db.stayShortfall = "2030-10-20 overnight";
    const screen = app(page);
    await screen.getByTestId(`inquiry-card-${INQ}`).click();
    await screen.getByTestId("inquiry-intent-suggest").click();
    await expect(screen.getByTestId("reply-problem")).toContainText("no room");
    await expect(screen.getByTestId("reply-send")).toBeDisabled();
  });
});
