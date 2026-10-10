-- 011j (FB-34): the owner changes the dates in the SAME inquiry thread.
--
-- "Change dates" used to open a new inquiry, so the conversation broke. An inquiry's dates and places were never
-- the owner's to update (only status / booking_id are), so this is a function: it changes the trip on an OPEN
-- inquiry the caller owns and leaves one owner message in the thread saying so (the client writes the text, e.g.
-- "Changed dates: Oct 20, 9:00 AM – Oct 22, 5:00 PM"). The next AI draft then answers for the new dates. Pets,
-- sitter and service stay as they were.

create or replace function public.change_inquiry_dates(
  p_inquiry uuid,
  p_drop_off_at timestamptz,
  p_pick_up_at timestamptz,
  p_drop_off_place text,
  p_pick_up_place text,
  p_body text
)
returns public.inquiry_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inquiry public.inquiries;
  v_body text := btrim(coalesce(p_body, ''));
  v_row public.inquiry_messages;
begin
  select * into v_inquiry from public.inquiries where id = p_inquiry for update;
  if not found or v_inquiry.owner_id is distinct from auth.uid() then
    raise exception 'forbidden';
  end if;
  if v_inquiry.status <> 'open' then
    raise exception 'inquiry_closed';
  end if;
  if p_drop_off_at is null or p_pick_up_at is null or p_pick_up_at <= p_drop_off_at
    or p_pick_up_at - p_drop_off_at > interval '31 days'
  then
    raise exception 'invalid_window';
  end if;
  if char_length(v_body) = 0 then
    raise exception 'body_required';
  end if;
  if char_length(v_body) > 2000 then
    raise exception 'body_too_long';
  end if;

  update public.inquiries
  set drop_off_at = p_drop_off_at,
      pick_up_at = p_pick_up_at,
      drop_off_location_type = coalesce(p_drop_off_place, drop_off_location_type),
      pick_up_location_type = coalesce(p_pick_up_place, pick_up_location_type),
      -- an auto reply scheduled for the old dates must not show up now
      reply_typing_at = null,
      reply_visible_at = null
  where id = p_inquiry;

  -- Scheduled auto replies for the old dates (not visible yet) are withdrawn with them.
  delete from public.inquiry_messages
  where inquiry_id = p_inquiry and author = 'sitter' and status = 'sent' and visible_at > now();

  insert into public.inquiry_messages (inquiry_id, author, sender_id, body, drafted_by_ai, status)
  values (p_inquiry, 'owner', auth.uid(), v_body, false, 'sent')
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function public.change_inquiry_dates(uuid, timestamptz, timestamptz, text, text, text) from public, anon;
grant execute on function public.change_inquiry_dates(uuid, timestamptz, timestamptz, text, text, text) to authenticated, service_role;
