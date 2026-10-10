import { router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import {
  InquiryDraft,
  InquiryView,
  ReplyOutcome,
  getInquiry,
  recordReplySample,
  regenerateDraft,
  sendInquiryReply,
  stayShortfall,
} from "../features/inquiries/inquiryApi";
import { addDays, appToday, formatStamp, zonedToIso } from "../features/schedule/dates";
import { DaySlot, loadSitterMonth } from "../features/schedule/scheduleApi";
import { useErrorDialog } from "../providers/ErrorDialogProvider";
import { useToast } from "../providers/ToastProvider";
import { useThemedStyles } from "../providers/ThemeProvider";
import { Theme } from "../theme/themes";
import { dayMarks } from "./InquirySheet";
import { HandoffDraft, HandoffPicker } from "./HandoffPicker";
import { QuoteCard } from "./QuoteCard";
import { Button } from "./ui/Button";
import { Sheet } from "./ui/Sheet";
import { TextField } from "./ui/TextField";

export type ReplyKind = "accept" | "decline" | "suggest";

type Props = {
  /** Which quick reply is open; null = closed. */
  kind: ReplyKind | null;
  inquiry: InquiryView;
  /** The draft on screen (decides whether the dates have room). */
  draft: InquiryDraft | null;
  onClose: () => void;
  /** After the reply went out. */
  onSent: () => void;
};

const MARK_DAYS = 90; // get_sitter_schedule reads at most 92 days
const TITLE: Record<ReplyKind, string> = { accept: "Accept", decline: "Decline", suggest: "Suggest other dates" };
const SEND: Record<ReplyKind, string> = { accept: "Send acceptance", decline: "Send decline", suggest: "Send suggestion" };

const first = (name: string) => name.trim().split(/\s+/)[0] || "there";

/**
 * The sitter's quick replies (FB-34): **Accept** and **Decline** show a ready reply in a popup (the assistant's, in
 * the sitter's voice, editable) and **Send** puts it straight in the thread; **Suggest other dates** asks for the days
 * first (checked against the sitter's own calendar), writes the message with them and sends on confirm. Nothing
 * reaches the owner before that Send.
 */
export function InquiryReplySheet({ kind, inquiry, draft, onClose, onSent }: Props) {
  const styles = useThemedStyles(makeStyles);
  const toast = useToast();
  const errorDialog = useErrorDialog();
  const today = useMemo(() => appToday(), []);
  const owner = first(inquiry.ownerName);
  const pets = inquiry.petNames.join(", ") || "your pet";
  const asked = `${formatStamp(inquiry.dropOffAt)} to ${formatStamp(inquiry.pickUpAt)}`;
  const noRoom = kind === "accept" && draft?.canHost === false;

  // Accept / Decline: the reply written for this intent.
  const [text, setText] = useState("");
  const [written, setWritten] = useState<InquiryDraft | null>(null);
  const [writing, setWriting] = useState(false);
  const [sending, setSending] = useState(false);
  const run = useRef(0);

  useEffect(() => {
    if (kind !== "accept" && kind !== "decline") return;
    if (noRoom) return;
    const id = ++run.current;
    setWriting(true);
    setWritten(null);
    setText("");
    (async () => {
      let body: string | null = null;
      let found: InquiryDraft | null = null;
      try {
        await regenerateDraft(inquiry.id, kind);
        found = (await getInquiry(inquiry.id))?.draft ?? null;
        body = found?.body ?? null;
      } catch {
        // The assistant is out: a plain reply the sitter can still edit and send.
      }
      if (id !== run.current) return;
      setWritten(found);
      setText(
        body ??
          (kind === "accept"
            ? `Hi ${owner}! I'd be happy to host ${pets} for ${asked}. 🐾`
            : `Hi ${owner}! Thanks for thinking of me for ${pets}. Unfortunately I can't take them for ${asked}. I hope we can work something out another time.`),
      );
      setWriting(false);
    })();
  }, [kind, noRoom, inquiry.id, owner, pets, asked]);

  // Suggest other dates: the days, then the message built from them.
  const [dropOff, setDropOff] = useState<HandoffDraft>(() => ({ day: addDays(today, 1), time: "09:00", locationType: "sitter_home", note: "" }));
  const [pickUp, setPickUp] = useState<HandoffDraft>(() => ({ day: addDays(today, 3), time: "17:00", locationType: "sitter_home", note: "" }));
  const [slots, setSlots] = useState<Map<string, DaySlot> | null>(null);
  const [shortfall, setShortfall] = useState<string | null>(null);
  const [edited, setEdited] = useState(false);
  const suggestText = `Hi ${owner}! I can't do ${asked}, but I can host ${pets} from ${formatStamp(zonedToIso(dropOff.day, dropOff.time))} to ${formatStamp(zonedToIso(pickUp.day, pickUp.time))}. Would that work for you? 🐾`;

  useEffect(() => {
    if (kind !== "suggest") return;
    setEdited(false);
    let live = true;
    loadSitterMonth(inquiry.sitterId, today, addDays(today, MARK_DAYS))
      .then((found) => live && setSlots(found))
      .catch(() => live && setSlots(null));
    return () => {
      live = false;
    };
  }, [kind, inquiry.sitterId, today]);

  useEffect(() => {
    if (kind !== "suggest") return;
    let live = true;
    void stayShortfall(inquiry.sitterId, zonedToIso(dropOff.day, dropOff.time), zonedToIso(pickUp.day, pickUp.time), Math.max(1, inquiry.petIds.length)).then(
      (found) => live && setShortfall(found),
    );
    return () => {
      live = false;
    };
  }, [kind, inquiry.sitterId, inquiry.petIds.length, dropOff.day, dropOff.time, pickUp.day, pickUp.time]);

  if (!kind) return null;

  const marks = slots ? dayMarks(slots, inquiry.petIds.length) : undefined;
  const shown = kind === "suggest" && !edited ? suggestText : text;
  const problem =
    kind === "suggest" && shortfall
      ? shortfall === "invalid_window"
        ? "Pick dates in the future, up to 31 days."
        : "You have no room on those dates — pick days you have open."
      : null;
  const canSend = !noRoom && !writing && !sending && !problem && shown.trim().length > 0;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      await sendInquiryReply(inquiry.id, shown.trim(), kind === "suggest" ? null : (written?.id ?? null), kind as ReplyOutcome);
      void recordReplySample(inquiry.id);
      toast.show(`Sent ✅ ${owner} was told`);
      onClose();
      onSent();
    } catch (e) {
      errorDialog.show({ title: "Not sent", message: (e as Error).message, onRetry: () => void send() });
    } finally {
      setSending(false);
    }
  };

  return (
    <Sheet
      visible
      title={TITLE[kind]}
      onClose={onClose}
      testID="reply-sheet"
      footer={
        noRoom ? (
          <Button label="Open my schedule" onPress={() => { onClose(); router.push("/sitter/schedule"); }} testID="reply-open-schedule" />
        ) : (
          <Button label={sending ? "Sending…" : SEND[kind]} disabled={!canSend} onPress={() => void send()} testID="reply-send" />
        )
      }
    >
      <View style={styles.body}>
        {noRoom ? (
          <Text style={styles.note} testID="reply-no-room">
            📅 You have no room on {asked}, so a reply can't say yes — the owner couldn't book it. Open those days in your schedule first,
            then accept. Or decline, or suggest other dates.
          </Text>
        ) : kind === "suggest" ? (
          <>
            <Text style={styles.hint}>{`${owner} asked for ${asked}. Pick the days you can do instead.`}</Text>
            <HandoffPicker
              kind="drop_off"
              value={dropOff}
              minDay={today}
              sitterName={null}
              dayMarks={marks}
              fixedPlace="Same place as in the question"
              onChange={(value) => {
                setDropOff(value);
                if (value.day > pickUp.day) setPickUp((p) => ({ ...p, day: value.day }));
              }}
            />
            <HandoffPicker kind="pick_up" value={pickUp} minDay={dropOff.day} sitterName={null} dayMarks={marks} fixedPlace="Same place as in the question" onChange={setPickUp} />
            {problem ? (
              <Text style={styles.problem} testID="reply-problem">
                {problem}
              </Text>
            ) : null}
            <TextField label="Your message" value={shown} multiline maxLength={2000} onChangeText={(v) => { setEdited(true); setText(v); }} testID="reply-text" />
          </>
        ) : writing ? (
          <Text style={styles.hint} testID="reply-writing">
            Writing your reply…
          </Text>
        ) : (
          <>
            <TextField label="Your reply" value={shown} multiline maxLength={2000} onChangeText={setText} testID="reply-text" />
            {kind === "accept" && written?.quote ? <QuoteCard quote={written.quote} compact testID="reply-quote" /> : null}
          </>
        )}
        <Text style={styles.disclaimer}>AI drafts can be wrong. You're responsible for what you send.</Text>
      </View>
    </Sheet>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    body: { gap: theme.spacing.sm },
    hint: { fontSize: theme.fontSize.small, color: theme.color.textMuted },
    note: { fontSize: theme.fontSize.body, color: theme.color.text },
    problem: { fontSize: theme.fontSize.small, color: theme.color.error },
    disclaimer: { fontSize: theme.fontSize.caption, color: theme.color.textMuted, textAlign: "center" },
  });
