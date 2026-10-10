import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { BookingCard } from "../../../components/BookingCard";
import { Card } from "../../../components/ui/Card";
import { EmptyState } from "../../../components/ui/EmptyState";
import { LoadingView } from "../../../components/ui/LoadingView";
import { Screen } from "../../../components/ui/Screen";
import { SegmentedControl } from "../../../components/ui/SegmentedControl";
import { SitterInquiryCard, listSitterInquiries } from "../../../features/inquiries/inquiryApi";
import { SERVICE_LABEL } from "../../../features/sitters/sitterApi";
import { formatDay, isoToZoned } from "../../../features/schedule/dates";
import { BookingSummary, firstSitterBucket, listSitterBookings, sitterBucket } from "../../../lib/bookings";
import { useSession } from "../../../providers/SessionProvider";
import { useThemedStyles } from "../../../providers/ThemeProvider";
import { useOnBookingChange } from "../../../providers/NotificationsProvider";
import { Theme } from "../../../theme/themes";

type Bucket = "requests" | "inquiries" | "upcoming" | "past";

type State =
  | { status: "loading" }
  | { status: "ready"; bookings: BookingSummary[]; inquiries: SitterInquiryCard[] }
  | { status: "error"; message: string };

const EMPTY: Record<Bucket, { emoji: string; title: string; message: string }> = {
  requests: {
    emoji: "📬",
    title: "No requests yet",
    message: "Booking requests from owners will show here for you to accept.",
  },
  inquiries: {
    emoji: "💬",
    title: "No questions yet",
    message: "When an owner asks about a stay, your draft reply waits here.",
  },
  upcoming: {
    emoji: "📅",
    title: "No upcoming stays",
    message: "Stays you accept show here until the pets go home.",
  },
  past: {
    emoji: "🐾",
    title: "No past stays",
    message: "Finished, declined and cancelled bookings show here.",
  },
};

/** Sitter Bookings tab (phase-03b 3B.4): Requests · Upcoming · Past → booking detail. */
export default function SitterBookings() {
  const styles = useThemedStyles(makeStyles);
  const { profile } = useSession();
  const sitterId = profile?.id;
  const [state, setState] = useState<State>({ status: "loading" });
  const [bucket, setBucket] = useState<Bucket>("requests");
  const userPicked = useRef(false);

  // `open` = choose the tab to land on (when the sitter arrives); a refresh in place never moves them.
  const load = useCallback(
    async (open = false) => {
      if (!sitterId) return;
      try {
        const [bookings, inquiries] = await Promise.all([
          listSitterBookings(sitterId),
          listSitterInquiries().catch(() => [] as SitterInquiryCard[]),
        ]);
        setState({ status: "ready", bookings, inquiries });
        // Open on what needs the sitter most: a stay on or about to start, else open requests, else questions
        // waiting for an answer. Never override a tab the sitter picked themselves.
        if (open && !userPicked.current) {
          const waiting = inquiries.filter((i) => i.status === "open" && i.state !== "replied").length;
          setBucket(firstSitterBucket(bookings, Date.now(), waiting));
        }
      } catch (error) {
        setState({ status: "error", message: (error as Error).message });
      }
    },
    [sitterId],
  );

  useOnBookingChange(() => void load());

  useFocusEffect(
    useCallback(() => {
      void load(true);
    }, [load]),
  );

  if (state.status === "loading") return <LoadingView />;

  if (state.status === "error") {
    return (
      <Screen>
        <EmptyState
          emoji="📬"
          title="Couldn't load your bookings"
          message={state.message}
          action={{ label: "Try again", onPress: () => void load() }}
        />
      </Screen>
    );
  }

  const count = (b: "requests" | "upcoming" | "past") => state.bookings.filter((x) => sitterBucket(x) === b).length;
  const shown = bucket === "inquiries" ? [] : state.bookings.filter((b) => sitterBucket(b) === bucket);
  const requests = count("requests");
  // Open questions that still wait for the sitter's reply.
  const waiting = state.inquiries.filter((i) => i.status === "open" && i.state !== "replied").length;
  const empty = bucket === "inquiries" ? state.inquiries.length === 0 : shown.length === 0;

  return (
    <Screen contentStyle={styles.content}>
      <SegmentedControl
        options={[
          { value: "requests", label: "Requests", count: requests },
          { value: "inquiries", label: "Questions", count: waiting },
          { value: "upcoming", label: "Upcoming" },
          { value: "past", label: "Past" },
        ]}
        value={bucket}
        onChange={(next) => {
          userPicked.current = true;
          setBucket(next);
        }}
        testID="sitter-bookings-tabs"
      />
      {empty ? (
        <EmptyState {...EMPTY[bucket]} />
      ) : bucket === "inquiries" ? (
        <View style={styles.list} testID="sitter-inquiries">
          {state.inquiries.map((inq) => (
            <Pressable
              key={inq.id}
              accessibilityRole="button"
              onPress={() => router.push(`/sitter/inquiries/${inq.id}`)}
              testID={`inquiry-card-${inq.id}`}
            >
              <Card style={styles.inquiry}>
                <Text style={styles.inquiryTitle}>{`${inq.ownerName} · ${inq.petNames.join(", ")}`}</Text>
                <Text style={styles.muted}>
                  {`${SERVICE_LABEL[inq.serviceType].replace(/^\S+\s/, "")} · ${formatDay(isoToZoned(inq.dropOffAt).day)} – ${formatDay(isoToZoned(inq.pickUpAt).day)}`}
                </Text>
                <Text style={inq.state === "draft" ? styles.ready : styles.muted}>
                  {inq.state === "draft" ? "✍️ Draft ready" : inq.state === "replied" ? "Replied" : "Writing the draft…"}
                </Text>
              </Card>
            </Pressable>
          ))}
        </View>
      ) : (
        <View style={styles.list}>
          {shown.map((booking) => (
            <BookingCard
              key={booking.id}
              booking={booking}
              viewer="sitter"
              onPress={() => router.push(`/sitter/bookings/${booking.id}`)}
            />
          ))}
        </View>
      )}
    </Screen>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    content: {
      gap: theme.spacing.md,
    },
    list: {
      gap: theme.spacing.md,
    },
    inquiry: { gap: theme.spacing.xs },
    inquiryTitle: { fontSize: theme.fontSize.body, fontWeight: "700", color: theme.color.text },
    muted: { fontSize: theme.fontSize.small, color: theme.color.textMuted },
    ready: { fontSize: theme.fontSize.small, fontWeight: "700", color: theme.color.primary },
  });
