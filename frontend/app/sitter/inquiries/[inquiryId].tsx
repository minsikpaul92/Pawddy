import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { InquiryReplySheet, ReplyKind } from "../../../components/InquiryReplySheet";
import { MessageBubble } from "../../../components/MessageBubble";
import { QuoteCard } from "../../../components/QuoteCard";
import { Button } from "../../../components/ui/Button";
import { Card } from "../../../components/ui/Card";
import { Chip } from "../../../components/ui/Chip";
import { EmptyState } from "../../../components/ui/EmptyState";
import { LoadingView } from "../../../components/ui/LoadingView";
import { Screen } from "../../../components/ui/Screen";
import { TextButton } from "../../../components/ui/TextButton";
import { TextField } from "../../../components/ui/TextField";
import {
  InquiryView,
  getInquiry,
  markInquiryRead,
  recordReplySample,
  regenerateDraft,
  sendInquiryReply,
  tripSummary,
} from "../../../features/inquiries/inquiryApi";
import { useLiveThread } from "../../../features/inquiries/useLiveThread";
import { formatStamp } from "../../../features/schedule/dates";
import { useErrorDialog } from "../../../providers/ErrorDialogProvider";
import { useThemedStyles } from "../../../providers/ThemeProvider";
import { useToast } from "../../../providers/ToastProvider";
import { Theme } from "../../../theme/themes";

const QUICK: { value: ReplyKind; label: string }[] = [
  { value: "accept", label: "Accept" },
  { value: "decline", label: "Decline" },
  { value: "suggest", label: "Suggest other dates" },
];

/**
 * The sitter's side of one inquiry (phase-07B 7B.6): the owner's question, the draft in the sitter's own voice with
 * the warning line, and one tap to **Send** it as is — or Edit / Add, Regenerate, or lean it with an intent chip.
 * Nothing reaches the owner until Send (D36 · D38).
 */
export default function SitterInquiry() {
  const styles = useThemedStyles(makeStyles);
  const toast = useToast();
  const errorDialog = useErrorDialog();
  const { inquiryId } = useLocalSearchParams<{ inquiryId: string }>();
  const [inquiry, setInquiry] = useState<InquiryView | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"send" | "regenerate" | null>(null);
  const [quick, setQuick] = useState<ReplyKind | null>(null);

  const load = useCallback(async () => {
    try {
      setInquiry(await getInquiry(inquiryId));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [inquiryId]);

  useEffect(() => {
    void load();
    void markInquiryRead(inquiryId); // opening the thread is the only "read" the owner ever sees
  }, [load, inquiryId]);

  // Judged from the LATEST message: a new owner message after the reply needs an answer again (FB-34).
  const replied = inquiry?.messages.at(-1)?.author === "sitter";
  const draft = inquiry?.draft ?? null;
  useLiveThread(inquiryId, load);
  // The owner's newest message is read the moment it is on this screen (the only read mark there is).
  const unread = inquiry?.messages.some((m) => m.author === "owner" && !m.readAt) ?? false;
  useEffect(() => {
    if (unread) void markInquiryRead(inquiryId);
  }, [unread, inquiryId]);

  // A fresh draft replaces whatever was being edited.
  useEffect(() => {
    if (draft) {
      setText(draft.body);
      setEditing(false);
    }
  }, [draft?.id]);

  if (error && inquiry === undefined) {
    return (
      <Screen>
        <EmptyState emoji="💬" title="Couldn't load this question" message={error} action={{ label: "Try again", onPress: () => void load() }} />
      </Screen>
    );
  }
  if (inquiry === undefined) return <LoadingView />;
  if (inquiry === null) {
    return (
      <Screen>
        <EmptyState emoji="💬" title="Question not found" message="This question isn't available." />
      </Screen>
    );
  }

  const when = formatStamp;
  const question = inquiry.messages.filter((m) => m.author === "owner").at(-1);

  const send = async () => {
    if (busy || !text.trim()) return;
    setBusy("send");
    try {
      await sendInquiryReply(inquiry.id, text.trim(), draft?.id ?? null);
      void recordReplySample(inquiry.id);
      toast.show(`Sent ✅ ${inquiry.ownerName} was told`);
      await load();
    } catch (e) {
      errorDialog.show({ title: "Not sent", message: (e as Error).message, onRetry: () => void send() });
    } finally {
      setBusy(null);
    }
  };

  const regenerate = async () => {
    if (busy) return;
    setBusy("regenerate");
    try {
      await regenerateDraft(inquiry.id);
      await load();
      toast.show("New draft ready ✍️");
    } catch (e) {
      errorDialog.show({ title: "No new draft", message: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Screen testID="sitter-inquiry" contentStyle={styles.content}>
      <Stack.Screen options={{ title: inquiry.ownerName }} />
      <Card style={styles.trip}>
        <Text style={styles.tripTitle} testID="inquiry-trip">
          {tripSummary(inquiry.serviceType, inquiry.dropOffAt, inquiry.pickUpAt, inquiry.petNames)}
        </Text>
        <Text style={styles.muted}>{`Drop-off ${when(inquiry.dropOffAt)} · Pick-up ${when(inquiry.pickUpAt)}`}</Text>
      </Card>

      {inquiry.messages.map((m) => (
        <MessageBubble
          key={m.id}
          side={m.author === "sitter" ? "me" : "them"}
          body={m.body}
          meta={m.auto ? `${when(m.at)} · Sent automatically` : when(m.at)}
          testID={`inquiry-message-${m.author}`}
        />
      ))}

      {replied ? (
        <Text style={styles.muted} testID="inquiry-replied">{`You replied. ${inquiry.ownerName} was told.`}</Text>
      ) : draft || editing ? (
        <Card style={styles.draft} testID="inquiry-draft">
          {draft?.needsSitter ? (
            <Text style={styles.check} testID="inquiry-needs-you">
              ⚠️ Check this one — something needs your confirmation.
            </Text>
          ) : null}
          {draft?.canHost === false ? (
            <Text style={styles.noRoom} testID="inquiry-no-room">
              📅 Your calendar has no room for these dates, so a draft can't say yes. Open the days in your schedule and tap
              Regenerate, decline, or suggest other dates.
            </Text>
          ) : null}
          {editing ? (
            <TextField label="Your reply" value={text} multiline maxLength={2000} onChangeText={setText} testID="inquiry-edit" />
          ) : (
            <Text style={styles.body} testID="inquiry-draft-body">
              {draft?.body}
            </Text>
          )}
          {draft?.quote && draft.canHost !== false ? <QuoteCard quote={draft.quote} compact testID="inquiry-draft-quote" /> : null}
          {draft && draft.sources.length > 0 ? (
            <View style={styles.sources} testID="inquiry-draft-sources">
              {[...new Set(draft.sources.map((s) => s.label))].map((label) => (
                <Chip key={label} label={label} />
              ))}
            </View>
          ) : null}
          <Button
            label={busy === "send" ? "Sending…" : "Send"}
            disabled={busy != null || !text.trim()}
            onPress={() => void send()}
            testID="inquiry-send"
          />
          <Text style={styles.warning} testID="inquiry-warning">
            AI drafts can be wrong. You're responsible for what you send.
          </Text>
          <View style={styles.row}>
            <TextButton
              label={editing ? "Use the draft text" : "Edit / Add"}
              onPress={() => {
                if (editing && draft) setText(draft.body);
                setEditing(!editing);
              }}
              testID="inquiry-edit-toggle"
            />
            <TextButton
              label={busy === "regenerate" ? "Writing…" : "Regenerate"}
              disabled={busy != null}
              onPress={() => void regenerate()}
              testID="inquiry-regenerate"
            />
          </View>
          <Text style={styles.label}>Or reply with</Text>
          <View style={styles.row}>
            {QUICK.map((q) => (
              <Button
                key={q.value}
                label={q.label}
                variant="secondary"
                disabled={busy != null}
                onPress={() => setQuick(q.value)}
                testID={`inquiry-intent-${q.value}`}
              />
            ))}
          </View>
        </Card>
      ) : (
        <Card style={styles.draft} testID="inquiry-no-draft">
          <Text style={styles.muted}>{question ? "Your draft is being written…" : "Waiting for the question."}</Text>
          <TextButton label="Write it myself" onPress={() => setEditing(true)} testID="inquiry-write-myself" />
        </Card>
      )}
      <InquiryReplySheet kind={quick} inquiry={inquiry} draft={draft} onClose={() => setQuick(null)} onSent={() => void load()} />
    </Screen>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    content: { gap: theme.spacing.md },
    trip: { gap: theme.spacing.xs },
    tripTitle: { fontSize: theme.fontSize.body, fontWeight: "700", color: theme.color.text },
    muted: { fontSize: theme.fontSize.small, color: theme.color.textMuted },
    draft: { gap: theme.spacing.sm },
    warning: { fontSize: theme.fontSize.caption, color: theme.color.textMuted, textAlign: "center" },
    noRoom: { fontSize: theme.fontSize.small, color: theme.color.textMuted },
    check: { fontSize: theme.fontSize.small, fontWeight: "700", color: theme.color.warning },
    body: { fontSize: theme.fontSize.body, color: theme.color.text },
    label: { fontSize: theme.fontSize.small, fontWeight: "600", color: theme.color.textMuted },
    row: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.xs, alignItems: "center" },
    sources: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.xs },
  });
