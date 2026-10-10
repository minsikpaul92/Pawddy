import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { QUESTION_MAX, changeInquiryDates, createInquiry, requestInquiryReply } from "../features/inquiries/inquiryApi";
import { SPECIES_EMOJI } from "../features/pets/petFormat";
import { useMyPets } from "../features/pets/useMyPets";
import { addDays, appToday, daySpan, formatStamp, isoToZoned, zonedToIso } from "../features/schedule/dates";
import { DaySlot, loadSitterMonth } from "../features/schedule/scheduleApi";
import { SERVICE_LABEL, ServiceType } from "../features/sitters/sitterApi";
import type { LocationType } from "../lib/bookings";
import { tripProblem } from "../lib/trip";
import { useThemedStyles } from "../providers/ThemeProvider";
import { Theme } from "../theme/themes";
import { HandoffDraft, HandoffPicker } from "./HandoffPicker";
import { Button } from "./ui/Button";
import { CheckRow } from "./ui/CheckRow";
import { DayMark } from "./ui/DayPickerSheet";
import { SegmentedControl } from "./ui/SegmentedControl";
import { Sheet } from "./ui/Sheet";
import { TextField } from "./ui/TextField";

type Props = {
  visible: boolean;
  onClose: () => void;
  sitter: { id: string; displayName: string; services: ServiceType[] };
  /** "Change dates" in a thread: starts from the earlier trip (pets, service, times, places). */
  prefill?: {
    serviceType: ServiceType;
    petIds: string[];
    dropOff: { at: string; locationType: LocationType };
    pickUp: { at: string; locationType: LocationType };
  };
  /** With this, Send moves the trip of THIS inquiry (011j) instead of opening a new one: the conversation goes on. */
  change?: { inquiryId: string; onChanged: () => void };
};

/** How far ahead the date picker shows the sitter's days. */
const MARK_DAYS = 90; // get_sitter_schedule reads at most 92 days

/**
 * A day for these pets, by the booking engine's rule (a stay needs room for all its pets in every slot it
 * touches): no open slot → not open; any open slot without room for them → full; else open. Closed slots
 * next to open ones are the sitter's hours, not a gap.
 */
export function dayMarks(slots: Map<string, DaySlot>, petCount: number): Map<string, DayMark> {
  const need = Math.max(1, petCount);
  const marks = new Map<string, DayMark>();
  for (const s of slots.values()) {
    const before = marks.get(s.day);
    if (s.state === "closed") {
      if (!before) marks.set(s.day, "closed");
      continue;
    }
    const mark: DayMark = s.state === "open" && s.remaining >= need ? "open" : "full";
    if (!before || before === "closed" || mark === "full") marks.set(s.day, mark);
  }
  return marks;
}

/** A handoff from an earlier trip (a note-less place kept as is); a day already past falls back to today. */
function draftFrom(
  from: { at: string; locationType: LocationType } | undefined,
  day: string,
  time: string,
  today: string,
): HandoffDraft {
  if (!from) return { day, time, locationType: "sitter_home", note: "" };
  const z = isoToZoned(from.at);
  return { day: z.day < today ? today : z.day, time: z.time, locationType: from.locationType, note: "" };
}

/**
 * "Ask before booking" (phase-07B 7B.5, FB-33): the trip, the pets, and an optional question. Sending creates the
 * inquiry, asks for the sitter's draft in the background and opens the thread — the owner never waits on the model.
 */
export function InquirySheet({ visible, onClose, sitter, prefill, change }: Props) {
  const styles = useThemedStyles(makeStyles);
  const { pets } = useMyPets();
  const today = useMemo(() => appToday(), []);
  const [service, setService] = useState<ServiceType>(prefill?.serviceType ?? sitter.services[0] ?? "boarding");
  const [petIds, setPetIds] = useState<string[]>(prefill?.petIds ?? []);
  const [dropOff, setDropOff] = useState<HandoffDraft>(() => draftFrom(prefill?.dropOff, addDays(today, 1), "09:00", today));
  const [pickUp, setPickUp] = useState<HandoffDraft>(() => draftFrom(prefill?.pickUp, addDays(today, 3), "17:00", today));
  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slots, setSlots] = useState<Map<string, DaySlot> | null>(null);

  // The sitter's days, so the owner picks dates that work (FB-33). Without them the picker still works.
  useEffect(() => {
    if (!visible) return;
    let live = true;
    loadSitterMonth(sitter.id, today, addDays(today, MARK_DAYS))
      .then((found) => live && setSlots(found))
      .catch(() => live && setSlots(null));
    return () => {
      live = false;
    };
  }, [visible, sitter.id, today]);
  const marks = useMemo(() => (slots ? dayMarks(slots, petIds.length) : undefined), [slots, petIds.length]);

  useEffect(() => {
    if (pets.length === 1 && !prefill) setPetIds([pets[0].id]);
  }, [pets]);

  const houseSitting = service === "house_sitting";
  const problem = tripProblem(petIds, dropOff, pickUp);
  const placeProblem =
    !houseSitting && ((dropOff.locationType === "other" && !dropOff.note.trim()) || (pickUp.locationType === "other" && !pickUp.note.trim()))
      ? "Tell the sitter where to meet."
      : null;

  const send = async () => {
    if (problem || placeProblem || sending) return;
    setSending(true);
    setError(null);
    const place = (h: HandoffDraft) => (houseSitting ? ("owner_home" as const) : h.locationType);
    try {
      const dropOffAt = zonedToIso(dropOff.day, dropOff.time);
      const pickUpAt = zonedToIso(pickUp.day, pickUp.time);
      if (change) {
        const note = question.trim();
        await changeInquiryDates({
          inquiryId: change.inquiryId,
          dropOff: { at: dropOffAt, locationType: place(dropOff) },
          pickUp: { at: pickUpAt, locationType: place(pickUp) },
          body: `Changed dates: ${formatStamp(dropOffAt)} – ${formatStamp(pickUpAt)}${note ? `\n${note}` : ""}`,
        });
        void requestInquiryReply(change.inquiryId); // the thread keeps waiting for the sitter either way
        onClose();
        change.onChanged();
        return;
      }
      const id = await createInquiry({
        sitterId: sitter.id,
        serviceType: service,
        dropOff: { at: dropOffAt, locationType: place(dropOff) },
        pickUp: { at: pickUpAt, locationType: place(pickUp) },
        petIds,
        petNames: pets.filter((p) => petIds.includes(p.id)).map((p) => p.name),
        question,
      });
      void requestInquiryReply(id); // the thread keeps waiting for the sitter either way
      onClose();
      router.push(`/owner/inquiries/${id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <Sheet
      visible={visible}
      title={change ? "Change dates" : `Ask ${sitter.displayName} before booking`}
      onClose={onClose}
      testID="inquiry-sheet"
      footer={
        <Button
          label={sending ? "Sending…" : "Send"}
          disabled={!!problem || !!placeProblem || sending}
          onPress={() => void send()}
          testID="inquiry-send"
        />
      }
    >
      <View style={styles.body}>
        {sitter.services.length > 1 && !change ? (
          <SegmentedControl
            options={sitter.services.map((s) => ({ value: s, label: SERVICE_LABEL[s] }))}
            value={service}
            onChange={setService}
            testID="inquiry-service"
          />
        ) : null}
        {change ? null : <Text style={styles.label}>Who's staying?</Text>}
        {(change ? [] : pets).map((pet) => (
          <CheckRow
            key={pet.id}
            label={`${SPECIES_EMOJI[pet.species]} ${pet.name}`}
            checked={petIds.includes(pet.id)}
            onChange={(on) => setPetIds((ids) => (on ? [...ids, pet.id] : ids.filter((x) => x !== pet.id)))}
            testID={`inquiry-pet-${pet.name}`}
          />
        ))}
        <Text style={styles.hint}>
          {!change && petIds.length > 0
            ? `${pets.filter((p) => petIds.includes(p.id)).map((p) => `${p.name}'s`).join(", ")} profile and Life Record are shared with ${sitter.displayName}.`
            : ""}
        </Text>
        <HandoffPicker
          kind="drop_off"
          value={dropOff}
          minDay={today}
          sitterName={sitter.displayName}
          dayMarks={marks}
          fixedPlace={houseSitting ? `🔑 ${sitter.displayName} comes to my place` : undefined}
          onChange={(value) => {
            const moved = daySpan(dropOff.day, value.day) - 1;
            setDropOff(value);
            // Changing the dates of a stay moves the whole stay: the pick-up keeps its distance from the drop-off.
            if (change && moved !== 0) setPickUp((p) => ({ ...p, day: addDays(p.day, moved) }));
            else if (value.day > pickUp.day) setPickUp((p) => ({ ...p, day: value.day }));
          }}
        />
        <HandoffPicker
          kind="pick_up"
          value={pickUp}
          minDay={dropOff.day}
          sitterName={sitter.displayName}
          dayMarks={marks}
          fixedPlace={houseSitting ? "🔑 At my place" : undefined}
          onChange={setPickUp}
        />
        <TextField
          label={change ? "Add a note (optional)" : "Your question (optional)"}
          value={question}
          maxLength={QUESTION_MAX}
          multiline
          placeholder="e.g. Can you give Max his pill at 2 PM?"
          onChangeText={setQuestion}
          testID="inquiry-question"
        />
        {problem || placeProblem || error ? (
          <Text style={styles.error} testID="inquiry-problem">
            {error ?? placeProblem ?? problem}
          </Text>
        ) : null}
      </View>
    </Sheet>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    body: { gap: theme.spacing.sm },
    label: { fontSize: theme.fontSize.body, fontWeight: "600", color: theme.color.text },
    hint: { fontSize: theme.fontSize.small, color: theme.color.textMuted },
    error: { fontSize: theme.fontSize.small, color: theme.color.error },
  });
