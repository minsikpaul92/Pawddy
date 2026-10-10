import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { placeLabel } from "../../../components/BookingCard";
import { SitterDashboard } from "../../../components/SitterDashboard";
import { Card } from "../../../components/ui/Card";
import { EmptyState } from "../../../components/ui/EmptyState";
import { LoadingView } from "../../../components/ui/LoadingView";
import { Screen } from "../../../components/ui/Screen";
import { caringPetsFromBookings, isCaring } from "../../../features/feed/caringPets";
import { SitterInquiryCard, listSitterInquiries } from "../../../features/inquiries/inquiryApi";
import { SPECIES_EMOJI } from "../../../features/pets/petFormat";
import { appToday, formatInstant, formatTime, isoToZoned } from "../../../features/schedule/dates";
import { BookingSummary, HandoffKind, listSitterBookings } from "../../../lib/bookings";
import { useSession } from "../../../providers/SessionProvider";
import { useThemedStyles } from "../../../providers/ThemeProvider";
import { useOnBookingChange } from "../../../providers/NotificationsProvider";
import { Theme } from "../../../theme/themes";

type State =
  | { status: "loading" }
  | { status: "ready"; bookings: BookingSummary[]; inquiries: SitterInquiryCard[] }
  | { status: "error"; message: string };

type Due = { booking: BookingSummary; kind: HandoffKind; at: string };

const pets = (b: BookingSummary) => b.pets.map((p) => `${SPECIES_EMOJI[p.species]} ${p.name}`).join("  ");

/**
 * Sitter Home dashboard (D47b; was Today / 3B.8): **Now caring** when on duty,
 * else **Requests** · **Today** (drop/pick due today) · **Upcoming** by time.
 * Tamagotchi / 8bit status joins later (11.12). Check-ins in Phase 06.
 */
export default function SitterHome() {
  const styles = useThemedStyles(makeStyles);
  const { profile } = useSession();
  const sitterId = profile?.id;
  const [state, setState] = useState<State>({ status: "loading" });

  const load = useCallback(async () => {
    if (!sitterId) return;
    try {
      const [bookings, inquiries] = await Promise.all([
        listSitterBookings(sitterId),
        listSitterInquiries().catch(() => [] as SitterInquiryCard[]),
      ]);
      setState({ status: "ready", bookings, inquiries });
    } catch (error) {
      setState({ status: "error", message: (error as Error).message });
    }
  }, [sitterId]);

  useOnBookingChange(() => void load());

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (state.status === "loading") return <LoadingView />;
  if (state.status === "error") {
    return (
      <Screen>
        <EmptyState
          emoji="🌤️"
          title="Couldn't load today"
          message={state.message}
          action={{ label: "Try again", onPress: () => void load() }}
        />
      </Screen>
    );
  }

  const now = Date.now();
  const today = appToday();
  const confirmed = state.bookings.filter((b) => b.status === "confirmed");
  const requests = state.bookings.filter((b) => b.status === "requested").length;
  // Questions an owner asked that still need the sitter's answer (a new owner message counts again, FB-34).
  const questions = state.inquiries.filter((i) => i.status === "open" && i.state !== "replied").length;
  const caring = confirmed.filter((b) => isCaring(b, now));
  const due: Due[] = confirmed
    .flatMap((b) =>
      (["drop_off", "pick_up"] as HandoffKind[]).flatMap((kind) => {
        const h = kind === "drop_off" ? b.dropOff : b.pickUp;
        return h && !h.completedAt && isoToZoned(h.at).day === today ? [{ booking: b, kind, at: h.at }] : [];
      }),
    )
    .sort((a, b) => a.at.localeCompare(b.at));
  const upcoming = confirmed
    .filter((b) => b.dropOff && !b.dropOff.completedAt && isoToZoned(b.dropOff.at).day > today)
    .sort((a, b) => (a.dropOff?.at ?? "").localeCompare(b.dropOff?.at ?? ""))
    .slice(0, 5);

  if (requests === 0 && questions === 0 && caring.length === 0 && due.length === 0 && upcoming.length === 0) {
    return (
      <Screen>
        <EmptyState
          emoji="🌤️"
          title="No bookings yet"
          message="Open your schedule so owners can find you."
          action={{ label: "Open your schedule", onPress: () => router.push("/sitter/schedule") }}
        />
      </Screen>
    );
  }

  const open = (b: BookingSummary) => router.push(`/sitter/bookings/${b.id}`);
  const caringPets = caringPetsFromBookings(confirmed, now);

  return (
    <Screen contentStyle={styles.content} testID="sitter-home">
      {requests > 0 ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push("/sitter/bookings")}
          style={({ pressed }) => [styles.requests, pressed && styles.pressed]}
          testID="today-requests"
        >
          <Text style={styles.requestsText}>{`📬 Requests (${requests}) — tap to answer`}</Text>
        </Pressable>
      ) : null}

      {questions > 0 ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push("/sitter/bookings")}
          style={({ pressed }) => [styles.requests, pressed && styles.pressed]}
          testID="today-questions"
        >
          <Text style={styles.requestsText}>{`💬 Questions (${questions}) — tap to answer`}</Text>
        </Pressable>
      ) : null}

      {caringPets.length > 0 ? <SitterDashboard pets={caringPets} /> : null}

      {due.length > 0 ? (
        <View style={styles.section} testID="today-due">
          <Text accessibilityRole="header" style={styles.heading}>
            Today
          </Text>
          {due.slice(0, 2).map(({ booking: b, kind, at }) => {
            const h = kind === "drop_off" ? b.dropOff : b.pickUp;
            return (
              <Pressable key={`${b.id}-${kind}`} accessibilityRole="button" onPress={() => open(b)}>
                <Card style={styles.card}>
                  <Text style={styles.title}>
                    {`${formatTime(isoToZoned(at).time)} · ${kind === "drop_off" ? "Drop-off" : "Pick-up"}`}
                  </Text>
                  <Text style={styles.body}>{`${pets(b)} · ${b.ownerName}`}</Text>
                  {h ? <Text style={styles.muted}>{placeLabel(h.locationType, h.note, b, "sitter")}</Text> : null}
                </Card>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {upcoming.length > 0 ? (
        <View style={styles.section} testID="today-upcoming">
          <Text accessibilityRole="header" style={styles.heading}>
            Upcoming
          </Text>
          {upcoming.slice(0, 2).map((b) => (
            <Pressable key={b.id} accessibilityRole="button" onPress={() => open(b)}>
              <Card style={styles.card}>
                <Text style={styles.title}>{`${b.ownerName} · ${b.dropOff ? formatInstant(b.dropOff.at) : ""}`}</Text>
                <Text style={styles.body}>{pets(b)}</Text>
              </Card>
            </Pressable>
          ))}
        </View>
      ) : null}
    </Screen>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    content: {
      gap: theme.spacing.lg,
    },
    section: {
      gap: theme.spacing.sm,
    },
    heading: {
      fontSize: theme.fontSize.body,
      fontWeight: "600",
      color: theme.color.text,
    },
    card: {
      gap: theme.spacing.xs,
    },
    title: {
      fontSize: theme.fontSize.body,
      fontWeight: "600",
      color: theme.color.text,
    },
    body: {
      fontSize: theme.fontSize.body,
      color: theme.color.text,
    },
    muted: {
      fontSize: theme.fontSize.small,
      color: theme.color.textMuted,
    },
    requests: {
      padding: theme.spacing.md,
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      borderColor: theme.color.primary,
      backgroundColor: theme.color.accent,
    },
    requestsText: {
      fontSize: theme.fontSize.body,
      fontWeight: "600",
      color: theme.color.primary,
    },
    pressed: {
      opacity: 0.8,
    },
  });
