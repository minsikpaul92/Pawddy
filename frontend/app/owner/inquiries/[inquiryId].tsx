import { router, Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { MessageBubble } from "../../../components/MessageBubble";
import { QuoteCard } from "../../../components/QuoteCard";
import { Button } from "../../../components/ui/Button";
import { Card } from "../../../components/ui/Card";
import { Chip } from "../../../components/ui/Chip";
import { EmptyState } from "../../../components/ui/EmptyState";
import { LoadingView } from "../../../components/ui/LoadingView";
import { Screen } from "../../../components/ui/Screen";
import { InquirySheet } from "../../../components/InquirySheet";
import { TextButton } from "../../../components/ui/TextButton";
import { TextField } from "../../../components/ui/TextField";
import {
  InquiryView,
  getInquiry,
  requestInquiryReply,
  sendOwnerMessage,
  tripSummary,
} from "../../../features/inquiries/inquiryApi";
import { useLiveThread } from "../../../features/inquiries/useLiveThread";
import { SitterSummary, getSitterProfile } from "../../../features/sitters/sitterApi";
import { useErrorDialog } from "../../../providers/ErrorDialogProvider";
import { formatStamp } from "../../../features/schedule/dates";
import { useThemedStyles } from "../../../providers/ThemeProvider";
import { Theme } from "../../../theme/themes";

/**
 * The owner's side of one inquiry (phase-07B 7B.5): their question, then the sitter's reply — shown as the
 * sitter's own message, with the quote and where the answer came from. While nothing has been sent yet it says so;
 * a draft the sitter hasn't approved is never visible here (RLS).
 */
export default function OwnerInquiry() {
  const styles = useThemedStyles(makeStyles);
  const { inquiryId } = useLocalSearchParams<{ inquiryId: string }>();
  const [inquiry, setInquiry] = useState<InquiryView | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const errorDialog = useErrorDialog();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [changing, setChanging] = useState(false);
  const [sitter, setSitter] = useState<SitterSummary | null>(null);

  const load = useCallback(async () => {
    try {
      setInquiry(await getInquiry(inquiryId));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [inquiryId]);

  // The thread's state is the LAST message: the sitter's reply is the one on screen until the owner writes again.
  const last = inquiry?.messages.at(-1);
  const reply = last?.author === "sitter" ? last : undefined;
  const sitterId = inquiry?.sitterId;
  useEffect(() => {
    if (!sitterId) return;
    getSitterProfile(sitterId)
      .then(setSitter)
      .catch(() => undefined);
  }, [sitterId]);
  // Auto-send: "typing…" between the two times the server stored, then the message itself (RLS shows it from then on).
  const [now, setNow] = useState(() => Date.now());
  const typingAt = inquiry?.replyTypingAt ? Date.parse(inquiry.replyTypingAt) : null;
  const visibleAt = inquiry?.replyVisibleAt ? Date.parse(inquiry.replyVisibleAt) : null;
  const scheduled = !!last && !reply && visibleAt != null && visibleAt > now;
  const typing = scheduled && typingAt != null && now >= typingAt;
  useEffect(() => {
    if (!scheduled || visibleAt == null) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const show = setTimeout(() => void load(), Math.max(0, visibleAt - Date.now()) + 400);
    return () => {
      clearInterval(tick);
      clearTimeout(show);
    };
  }, [scheduled, visibleAt, load]);
  useEffect(() => {
    void load();
  }, [load]);
  useLiveThread(inquiryId, load);

  if (error && inquiry === undefined) {
    return (
      <Screen>
        <EmptyState emoji="💬" title="Couldn't load this conversation" message={error} action={{ label: "Try again", onPress: () => void load() }} />
      </Screen>
    );
  }
  if (inquiry === undefined) return <LoadingView />;
  if (inquiry === null) {
    return (
      <Screen>
        <EmptyState emoji="💬" title="Conversation not found" message="This question isn't available." />
      </Screen>
    );
  }

  const send = async () => {
    if (sending || !text.trim()) return;
    setSending(true);
    try {
      await sendOwnerMessage(inquiry.id, text);
      setText("");
      void requestInquiryReply(inquiry.id); // the thread keeps waiting for the sitter either way
      await load();
    } catch (e) {
      errorDialog.show({ title: "Not sent", message: (e as Error).message, onRetry: () => void send() });
    } finally {
      setSending(false);
    }
  };
  const when = formatStamp;
  const canHost = reply?.canHost !== false;

  return (
    <Screen testID="owner-inquiry" contentStyle={styles.content}>
      <Stack.Screen options={{ title: inquiry.sitterName }} />
      <Card style={styles.trip}>
        <Text style={styles.tripTitle} testID="inquiry-trip">
          {tripSummary(inquiry.serviceType, inquiry.dropOffAt, inquiry.pickUpAt, inquiry.petNames)}
        </Text>
        <Text style={styles.muted}>{`Drop-off ${when(inquiry.dropOffAt)} · Pick-up ${when(inquiry.pickUpAt)}`}</Text>
      </Card>

      {inquiry.messages.map((m) =>
        m.author === "owner" ? (
          <MessageBubble key={m.id} side="me" body={m.body} meta={m.readAt ? `${when(m.at)} · Read` : when(m.at)} testID="inquiry-question-bubble" />
        ) : (
          <MessageBubble key={m.id} side="them" body={m.body} meta={when(m.at)} testID="inquiry-reply-bubble">
            {m.sources.length > 0 ? (
              <View style={styles.sources} testID="inquiry-sources">
                {[...new Set(m.sources.map((s) => s.label))].map((label) => (
                  <Chip key={label} label={label} />
                ))}
              </View>
            ) : null}
          </MessageBubble>
        ),
      )}

      {!reply ? (
        <View style={styles.waiting} testID="inquiry-waiting">
          {typing ? (
            <Text style={styles.typing} testID="inquiry-typing">{`${inquiry.sitterName} is typing…`}</Text>
          ) : (
            <>
              <Text style={styles.muted}>{`${inquiry.sitterName} will reply soon.`}</Text>
              <Text style={styles.muted}>You'll get a notification when they do.</Text>
            </>
          )}
        </View>
      ) : null}

      {reply?.quote && canHost ? <QuoteCard quote={reply.quote} testID="inquiry-quote" /> : null}

      {reply ? (
        inquiry.status === "booked" ? (
          <Button
            label="See your booking"
            variant="secondary"
            onPress={() => (inquiry.bookingId ? router.push(`/owner/bookings/${inquiry.bookingId}`) : router.push("/owner/bookings"))}
            testID="inquiry-see-booking"
          />
        ) : canHost ? (
          <Button
            label="Request booking"
            onPress={() => router.push(`/owner/bookings/new?inquiry=${inquiry.id}`)}
            testID="inquiry-request-booking"
          />
        ) : (
          <>
            <Button label="Change dates" onPress={() => setChanging(true)} testID="inquiry-change-dates" />
            <TextButton
              label="Find other sitters"
              onPress={() => router.push(`/owner/bookings/new?inquiry=${inquiry.id}&other=1`)}
              testID="inquiry-find-others"
            />
          </>
        )
      ) : null}

      {inquiry.status === "open" && reply ? (
        <View style={styles.compose} testID="inquiry-compose">
          <TextField
            label="Write back"
            value={text}
            multiline
            maxLength={2000}
            placeholder={`Ask ${inquiry.sitterName} something else`}
            onChangeText={setText}
            testID="inquiry-followup"
          />
          <Button
            label={sending ? "Sending…" : "Send"}
            variant={canHost ? "secondary" : "primary"}
            disabled={sending || !text.trim()}
            onPress={() => void send()}
            testID="inquiry-followup-send"
          />
        </View>
      ) : null}

      {changing ? (
        <InquirySheet
          visible
          onClose={() => setChanging(false)}
          sitter={{ id: inquiry.sitterId, displayName: inquiry.sitterName, services: sitter?.services ?? [inquiry.serviceType] }}
          change={{ inquiryId: inquiry.id, onChanged: () => void load() }}
          prefill={{
            serviceType: inquiry.serviceType,
            petIds: inquiry.petIds,
            dropOff: { at: inquiry.dropOffAt, locationType: inquiry.dropOffPlace },
            pickUp: { at: inquiry.pickUpAt, locationType: inquiry.pickUpPlace },
          }}
        />
      ) : null}
    </Screen>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    content: { gap: theme.spacing.md },
    trip: { gap: theme.spacing.xs },
    tripTitle: { fontSize: theme.fontSize.body, fontWeight: "700", color: theme.color.text },
    muted: { fontSize: theme.fontSize.small, color: theme.color.textMuted },
    sources: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing.xs },
    compose: { gap: theme.spacing.sm },
    waiting: { gap: 2, padding: theme.spacing.sm },
    typing: { fontSize: theme.fontSize.small, fontStyle: "italic", color: theme.color.textMuted },
  });
