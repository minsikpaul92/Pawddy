import { useEffect } from "react";

import { getSupabase } from "../../lib/supabase";

const POLL_MS = 5000;

/**
 * Keeps an open inquiry thread current without leaving and re-entering: a new message row refreshes it at once
 * (Realtime, RLS-scoped), and a slow poll covers a missed event or a dropped socket — the same pair the
 * notifications use.
 */
export function useLiveThread(inquiryId: string | undefined, reload: () => unknown): void {
  useEffect(() => {
    if (!inquiryId) return;
    const supabase = getSupabase();
    const channel = supabase
      .channel(`inquiry-thread:${inquiryId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "inquiry_messages", filter: `inquiry_id=eq.${inquiryId}` },
        () => reload(),
      )
      .subscribe();
    const poll = setInterval(reload, POLL_MS);
    return () => {
      clearInterval(poll);
      void supabase.removeChannel(channel);
    };
  }, [inquiryId, reload]);
}
