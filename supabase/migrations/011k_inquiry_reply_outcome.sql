-- 011k (FB-34): the sitter's reply says what it IS — accept, decline or suggest other dates.
--
-- A reply used to inherit "can host" from the draft it was sent from, so a sitter who declined a stay the AI
-- had priced still showed the owner a quote and "Request booking". `send_inquiry_reply` now takes the outcome the
-- sitter chose:
--   'decline' | 'suggest'  can_host = false, no quote — the owner gets Change dates, not Request booking
--   'accept' | null        as before: the draft's quote, sources and availability are kept
-- Any other value is refused. The two-argument-plus-draft call (no outcome) still works unchanged.

drop function if exists public.send_inquiry_reply(uuid, text, uuid);

create or replace function public.send_inquiry_reply(
  p_inquiry uuid,
  p_body text,
  p_draft uuid default null,
  p_outcome text default null
)
returns public.inquiry_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inquiry public.inquiries;
  v_draft public.inquiry_messages;
  v_body text := btrim(coalesce(p_body, ''));
  v_grounding jsonb;
  v_row public.inquiry_messages;
begin
  select * into v_inquiry from public.inquiries where id = p_inquiry;
  if not found or v_inquiry.sitter_id is distinct from auth.uid() then
    raise exception 'forbidden';
  end if;
  if v_inquiry.status = 'closed' then
    raise exception 'inquiry_closed';
  end if;
  if p_outcome is not null and p_outcome not in ('accept', 'decline', 'suggest') then
    raise exception 'invalid_outcome';
  end if;
  if char_length(v_body) = 0 then
    raise exception 'body_required';
  end if;
  if char_length(v_body) > 2000 then
    raise exception 'body_too_long';
  end if;

  if p_draft is not null then
    select * into v_draft from public.inquiry_messages
    where id = p_draft and inquiry_id = p_inquiry and author = 'ai';
    if not found then
      raise exception 'draft_not_found';
    end if;
  end if;

  if p_outcome in ('decline', 'suggest') then
    v_grounding := jsonb_build_object('availability', jsonb_build_object('can_host', false));
  elsif p_draft is not null then
    v_grounding := jsonb_strip_nulls(jsonb_build_object(
      'quote', v_draft.grounding -> 'quote',
      'sources', v_draft.grounding -> 'sources',
      'availability', jsonb_build_object('can_host', coalesce(v_draft.grounding #> '{availability,can_host}', 'true'::jsonb))
    ));
  end if;

  insert into public.inquiry_messages
    (inquiry_id, author, sender_id, body, grounding, drafted_by_ai, status, confirmed_by_sitter_at)
  values
    (p_inquiry, 'sitter', auth.uid(), v_body, v_grounding, p_draft is not null, 'sent', now())
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function public.send_inquiry_reply(uuid, text, uuid, text) from public, anon;
grant execute on function public.send_inquiry_reply(uuid, text, uuid, text) to authenticated, service_role;
