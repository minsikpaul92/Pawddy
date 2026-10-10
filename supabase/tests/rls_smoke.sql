-- Goldito RLS + booking smoke test (Phase 02 DoD 2)
--
-- Run after all migrations (001–007) in the Supabase SQL Editor (as postgres), or locally with
-- tests/supabase_stub.sql first (see supabase/README.md). Everything runs in one transaction
-- and is rolled back, so no data is left behind.
-- Success = the script finishes without error ("PASS: ..." notices for each check).
-- Failure = "FAIL: <check>" error.
--
-- Cast (all fictional): owners Robert (dog Max, cat Mochi) and Joy (dogs Coco, Toto);
-- sitters Chloe (08–12 / 12–18 / 18–08, 3 pets), Paul (09–13 / 13–17, 2 pets),
-- Allen (08–12 / 12–18 / 18–08, 3 pets), Nora (no schedule).
-- Scenario letters match docs/plan/phases/phase-02.md "예시 시나리오".
-- H (last-spot race) runs sequentially here; the advisory lock serializes real concurrent calls.

begin;

-- ---------------------------------------------------------------------------
-- Test helpers (rolled back with everything else)
-- ---------------------------------------------------------------------------

create table public._t_ids (name text primary key, id uuid not null);
grant all on public._t_ids to authenticated;

create function public._t_put(p_name text, p_id uuid) returns void
language sql security definer set search_path = public as $$
  insert into public._t_ids values (p_name, p_id)
  on conflict (name) do update set id = excluded.id
$$;

create function public._t_get(p_name text) returns uuid
language sql stable security definer set search_path = public as $$
  select id from public._t_ids where name = p_name
$$;

-- Act as a signed-in user, as anon ('anon'), or back to the session role (null).
create function public._t_as(p_user uuid, p_role text default 'authenticated') returns void
language plpgsql as $$
begin
  if p_user is null and p_role = 'authenticated' then
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claims', '', true);
  elsif p_role = 'anon' then
    perform set_config('role', 'anon', true);
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  else
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claims',
      json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  end if;
end;
$$;

create function public._t_ok(p_cond boolean, p_label text) returns void
language plpgsql as $$
begin
  if p_cond is distinct from true then
    raise exception 'FAIL: %', p_label;
  end if;
  raise notice 'PASS: %', p_label;
end;
$$;

-- Fixture booking inserted directly (bypassing RPCs): agreed handoffs if confirmed.
create function public._t_booking(
  p_owner uuid, p_sitter uuid, p_pets uuid[], p_drop timestamptz, p_pick timestamptz,
  p_status text, p_received boolean default false
) returns uuid
language plpgsql set search_path = public as $$
declare
  v uuid;
  v_hs text := case when p_status = 'confirmed' then 'agreed' else 'proposed' end;
begin
  insert into bookings (owner_id, sitter_id, start_date, end_date, status, responded_at)
  values (p_owner, p_sitter, (p_drop at time zone app_timezone())::date,
    (p_pick at time zone app_timezone())::date, p_status,
    case when p_status = 'confirmed' then p_drop - interval '7 days' end)
  returning id into v;
  insert into booking_pets (booking_id, pet_id, care_range)
  select v, x, tstzrange(p_drop, p_pick, '[)') from unnest(p_pets) x;
  insert into booking_slots (booking_id, pet_id, day, slot)
  select v, x, (p_drop at time zone app_timezone())::date, 'morning' from unnest(p_pets) x;
  insert into booking_handoffs (booking_id, kind, scheduled_at, within_sitter_hours, status, proposed_by, completed_at)
  values (v, 'drop_off', p_drop, true, v_hs, p_owner, case when p_received then p_drop end),
         (v, 'pick_up', p_pick, true, v_hs, p_owner, null);
  return v;
end;
$$;

-- Stand-in for the Meet & Greet RPCs (3B.9): mark a first-time pair's meeting done / skipped
-- so the sitter can accept (D44).
create function public._t_meet(p_booking uuid, p_status text default 'done') returns void
language sql security definer set search_path = public as $$
  update bookings set meet_greet_status = p_status where id = p_booking
$$;

grant execute on function public._t_put(text, uuid), public._t_get(text), public._t_as(uuid, text),
  public._t_ok(boolean, text), public._t_meet(uuid, text) to authenticated, anon;

-- ---------------------------------------------------------------------------
-- Fixtures (signup trigger creates profiles)
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-4000-8000-0000000000a1', 'robert@example.test', '{"role":"owner","display_name":"Robert"}'),
  ('00000000-0000-4000-8000-0000000000a2', 'joy@example.test', '{"role":"owner","display_name":"Joy"}'),
  ('00000000-0000-4000-8000-0000000000b1', 'chloe@example.test', '{"role":"sitter","display_name":"Chloe"}'),
  ('00000000-0000-4000-8000-0000000000b2', 'paul@example.test', '{"role":"sitter","display_name":"Paul"}'),
  ('00000000-0000-4000-8000-0000000000b3', 'allen@example.test', '{"role":"sitter","display_name":"Allen"}'),
  ('00000000-0000-4000-8000-0000000000b4', 'nora@example.test', '{"role":"sitter"}');

insert into public.pets (id, owner_id, species, name) values
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000a1', 'dog', 'Max'),
  ('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-0000000000a1', 'cat', 'Mochi'),
  ('00000000-0000-4000-8000-0000000000c3', '00000000-0000-4000-8000-0000000000a2', 'dog', 'Coco'),
  ('00000000-0000-4000-8000-0000000000c4', '00000000-0000-4000-8000-0000000000a2', 'dog', 'Toto');

update public.owner_profiles set home_address = '1 Owner Ave' where id = '00000000-0000-4000-8000-0000000000a1';
update public.sitter_profiles set home_address = '100 Example St' where id = '00000000-0000-4000-8000-0000000000b1';

-- Permission fixtures:
--   current:       Chloe has Max + Mochi right now.
--   future:        Paul has Coco next week.
--   requested:     Nora has an unanswered request for Mochi in 40 days.
--   just_finished: Paul returned Toto 1 hour ago (inside the 2 h wrap-up).
--   finished:      Allen had Coco last week.
do $$
declare
  robert constant uuid := '00000000-0000-4000-8000-0000000000a1';
  joy constant uuid := '00000000-0000-4000-8000-0000000000a2';
  chloe constant uuid := '00000000-0000-4000-8000-0000000000b1';
  paul constant uuid := '00000000-0000-4000-8000-0000000000b2';
  allen constant uuid := '00000000-0000-4000-8000-0000000000b3';
  nora constant uuid := '00000000-0000-4000-8000-0000000000b4';
  max constant uuid := '00000000-0000-4000-8000-0000000000c1';
  mochi constant uuid := '00000000-0000-4000-8000-0000000000c2';
  coco constant uuid := '00000000-0000-4000-8000-0000000000c3';
  toto constant uuid := '00000000-0000-4000-8000-0000000000c4';
  v_id uuid;
begin
  perform _t_put('current', _t_booking(robert, chloe, array[max, mochi],
    now() - interval '1 day', now() + interval '1 day', 'confirmed'));
  perform _t_put('future', _t_booking(joy, paul, array[coco],
    now() + interval '7 days', now() + interval '8 days', 'confirmed'));
  perform _t_put('requested', _t_booking(robert, nora, array[mochi],
    now() + interval '40 days', now() + interval '41 days', 'requested'));
  perform _t_put('just_finished', _t_booking(joy, paul, array[toto],
    now() - interval '2 days', now() - interval '1 hour', 'confirmed', true));
  perform _t_put('finished', _t_booking(joy, allen, array[coco],
    now() - interval '6 days', now() - interval '5 days', 'confirmed', true));

  insert into public.media (pet_id, uploaded_by, cloudinary_public_id, resource_type, purpose) values
    (max, chloe, 'smoke/max', 'image', 'feed'),
    (mochi, chloe, 'smoke/mochi', 'image', 'feed'),
    (coco, paul, 'smoke/coco', 'image', 'feed'),
    (toto, paul, 'smoke/toto', 'image', 'feed');
  perform _t_put('media_bori', (select id from public.media where cloudinary_public_id = 'smoke/max'));
  perform _t_put('media_coco', (select id from public.media where cloudinary_public_id = 'smoke/coco'));
  perform _t_put('media_toto', (select id from public.media where cloudinary_public_id = 'smoke/toto'));

  insert into public.care_tasks (pet_id, type, title, scheduled_time)
  values (max, 'feeding', 'Breakfast', '08:00')
  returning id into v_id;
  perform _t_put('task_bori', v_id);

  insert into public.daily_reports (pet_id, sitter_id, report_date, body)
  values (max, chloe, app_today(), 'Draft');
end;
$$;

-- ---------------------------------------------------------------------------
-- Signup trigger & realtime
-- ---------------------------------------------------------------------------

do $$
begin
  perform _t_ok((select count(*) from public.profiles where id in (
      '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2',
      '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2',
      '00000000-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-0000000000b4')) = 6,
    'signup trigger creates profiles');
  perform _t_ok(exists (select 1 from public.owner_profiles where id = '00000000-0000-4000-8000-0000000000a1')
      and exists (select 1 from public.sitter_profiles where id = '00000000-0000-4000-8000-0000000000b1')
      and not exists (select 1 from public.sitter_profiles where id = '00000000-0000-4000-8000-0000000000a1'),
    'signup trigger creates the matching role profile');
  perform _t_ok((select display_name from public.profiles where id = '00000000-0000-4000-8000-0000000000b4') = 'nora',
    'display_name falls back to email prefix');
  perform _t_ok(exists (select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'),
    'notifications is in the realtime publication');
  perform _t_ok(exists (select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'feed_posts'),
    '5.7: feed_posts is in the realtime publication (owner refetch on delete)');
end;
$$;

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------

do $$
declare
  robert constant uuid := '00000000-0000-4000-8000-0000000000a1';
  joy constant uuid := '00000000-0000-4000-8000-0000000000a2';
  chloe constant uuid := '00000000-0000-4000-8000-0000000000b1';
  paul constant uuid := '00000000-0000-4000-8000-0000000000b2';
  allen constant uuid := '00000000-0000-4000-8000-0000000000b3';
  nora constant uuid := '00000000-0000-4000-8000-0000000000b4';
  max constant uuid := '00000000-0000-4000-8000-0000000000c1';
  mochi constant uuid := '00000000-0000-4000-8000-0000000000c2';
  coco constant uuid := '00000000-0000-4000-8000-0000000000c3';
  toto constant uuid := '00000000-0000-4000-8000-0000000000c4';
  n int;
  v_err text;
  r record;
begin
  -- Sitter with a pending request only (Nora → Mochi)
  perform _t_as(nora);
  select count(*) into n from public.pets where id = max;
  perform _t_ok(n = 0, 'sitter without booking cannot see pet');
  select count(*) into n from public.pets where id = mochi;
  perform _t_ok(n = 1, 'requested sitter can see the pet profile');
  select count(*) into n from public.media where pet_id = mochi;
  perform _t_ok(n = 0, 'requested sitter cannot see the pet''s media');
  select count(*) into n from public.owner_profiles where id = robert;
  perform _t_ok(n = 0, 'requested-only sitter cannot see owner profile');
  select count(*) into n from public.profiles where id = robert;
  perform _t_ok(n = 1, 'requested sitter sees the owner''s display name');
  select * into r from get_booking_pets(_t_get('requested'));
  perform _t_ok(r.name = 'Mochi' and r.species = 'cat', 'get_booking_pets returns the requested pets');

  -- Sitter with a confirmed booking next week and one that ended 1 h ago (Paul)
  perform _t_as(paul);
  select count(*) into n from public.pets where id = coco;
  perform _t_ok(n = 1, 'sitter with upcoming booking can see pet');
  begin
    insert into public.feed_posts (pet_id, sitter_id, media_id) values (coco, paul, _t_get('media_coco'));
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', 'sitter cannot post before drop-off');
  begin
    insert into public.feed_posts (pet_id, sitter_id, media_id) values (max, paul, _t_get('media_bori'));
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', 'other sitter cannot post for a pet in care');
  perform _t_ok(is_sitter_of(toto) and is_on_duty_for(toto), 'sitter keeps access for 2 h after pick-up');
  insert into public.feed_posts (pet_id, sitter_id, media_id) values (toto, paul, _t_get('media_toto'));
  perform _t_ok(true, 'sitter can post within the 2 h wrap-up after pick-up');
  begin
    perform complete_handoff(_t_get('future'), 'drop_off');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'handoff_too_early', 'Received is not allowed days before drop-off');
  begin
    perform complete_handoff(_t_get('future'), 'pick_up');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'drop_off_not_completed', 'Returned requires Received first');

  -- Sitter whose booking ended last week (Allen → Coco)
  perform _t_as(allen);
  select count(*) into n from public.pets where id = coco;
  perform _t_ok(n = 0, 'sitter loses pet access after the booking ends');
  select count(*) into n from public.owner_profiles where id = joy;
  perform _t_ok(n = 0, 'sitter loses owner contacts 24 h after pick-up');
  select count(*) into n from public.profiles where id = joy;
  perform _t_ok(n = 1, 'past sitter still sees the owner''s display name');
  begin
    perform get_handoff_details(_t_get('finished'));
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'not_paid', '3C.4: unpaid past booking still gated by not_paid');
  perform _t_as(null);
  update public.bookings set paid_at = now() - interval '7 days' where id = _t_get('finished');
  perform _t_as(allen);
  begin
    perform get_handoff_details(_t_get('finished'));
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'booking_finished', 'addresses are hidden after the booking ends');
  perform _t_ok((select count(*) from get_booking_pets(_t_get('finished'))) = 1,
    'past booking still lists its pets');

  -- Sitter currently caring for Max + Mochi (Chloe)
  perform _t_as(chloe);
  insert into public.feed_posts (pet_id, sitter_id, media_id) values (max, chloe, _t_get('media_bori'));
  perform _t_ok(true, 'on-duty sitter can post');
  perform _t_as(null);
  perform _t_ok(
    (select title from public.notifications n
     join public.feed_posts fp on fp.id = n.ref_id
     where n.user_id = robert and n.type = 'feed_post' and fp.pet_id = max
     order by n.created_at desc limit 1) = 'New photo of Max 📸',
    '5.3: feed post → owner feed_post notification');
  perform _t_as(chloe);
  select count(*) into n from public.owner_profiles where id = robert;
  perform _t_ok(n = 0, 'BF.6: a confirmed sitter cannot see the owner profile before payment');
  perform _t_as(null);
  update public.bookings set paid_at = now() where id = _t_get('current');
  perform _t_as(chloe);
  select count(*) into n from public.owner_profiles where id = robert;
  perform _t_ok(n = 1, 'paid sitter can see owner profile');
  perform _t_as(null);
  update public.bookings set paid_at = null where id = _t_get('current');
  perform _t_as(chloe);
  perform _t_ok(in_care_window(max, now()), 'in_care_window true during care');
  perform _t_ok(not in_care_window(max, now() - interval '2 days'), 'in_care_window false before drop-off');
  perform _t_ok((select home_address from get_my_sitter_profile()) = '100 Example St',
    'sitter reads own home_address via get_my_sitter_profile');
  begin
    update public.sitter_profiles set default_hours = '{"morning":["8am","noon"]}' where id = chloe;
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '23514', 'malformed default_hours is rejected');
  perform complete_handoff(_t_get('current'), 'drop_off');
  perform _t_as(null);
  perform _t_ok((select title from public.notifications where user_id = robert and type = 'pet_dropped_off')
      = 'Max and Mochi arrived at Chloe''s 🏠',
    'A: Received → owner notified');
  perform _t_as(chloe);
  begin
    perform cancel_booking(_t_get('current'), 'Something came up');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'booking_in_progress', 'cannot cancel after the pets are received');
  perform complete_handoff(_t_get('current'), 'pick_up');
  perform _t_as(null);
  perform _t_ok((select title from public.notifications where user_id = robert and type = 'pet_picked_up')
      = 'Max and Mochi are home safe 🏠',
    'Returned → owner notified');

  -- Owner
  perform _t_as(robert);
  begin
    insert into public.task_logs (task_id, pet_id, due_at) values (_t_get('task_bori'), max, now());
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', 'owner cannot insert task_logs directly');
  select count(*) into n from public.daily_reports where pet_id = max;
  perform _t_ok(n = 0, 'owner cannot see draft daily report');
  begin
    perform home_address from public.sitter_profiles where id = chloe;
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', 'owner cannot read sitter home_address');
  select count(*) into n from public.sitter_profiles where id = chloe and bio is null;
  perform _t_ok(n = 1, 'owner can read public sitter profile columns');
  begin
    update public.profiles set role = 'sitter' where id = robert;
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', 'user cannot change own role');
  begin
    update public.pets set species = 'cat' where id = max;
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', 'owner cannot change pet species');
  update public.pets set weight_kg = 7.5 where id = max;
  perform _t_ok(true, 'owner can update pet details');
  begin
    insert into public.sitter_availability (sitter_id, kind, start_date, end_date, slot)
    values (robert, 'blocked', app_today(), app_today(), 'morning');
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', 'owner cannot create sitter availability');
  begin
    perform propose_handoff(_t_get('current'), 'drop_off', now() + interval '1 hour');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'handoff_completed', 'a received drop-off cannot be changed');
  begin
    perform sitter_remaining(chloe, app_today(), 'morning');
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', 'internal helpers are not callable by clients');
  begin
    perform request_booking(chloe, array[coco], now() + interval '60 days', 'sitter_home', null,
      now() + interval '61 days', 'sitter_home', null, null);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'not_owner', 'owner cannot book someone else''s pet');
  begin
    perform request_booking(joy, array[max], now() + interval '60 days', 'sitter_home', null,
      now() + interval '61 days', 'sitter_home', null, null);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'not_a_sitter', 'booking an owner as sitter is rejected');
  begin
    perform request_booking(chloe, array[max], now() - interval '1 hour', 'sitter_home', null,
      now() + interval '1 day', 'sitter_home', null, null);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'invalid_window', 'drop-off in the past is rejected');
  perform _t_as(joy);
  begin
    perform cancel_booking(_t_get('just_finished'), null);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'booking_in_progress', 'cannot cancel a booking after its pick-up time');

  -- updated_at is maintained by trigger
  perform _t_as(null);
  alter table public.profiles disable trigger profiles_set_updated_at;
  update public.profiles set updated_at = '2000-01-01' where id = robert;
  alter table public.profiles enable trigger profiles_set_updated_at;
  perform _t_as(robert);
  update public.profiles set display_name = 'Robert K.' where id = robert;
  perform _t_as(null);
  perform _t_ok((select updated_at > '2001-01-01' from public.profiles where id = robert),
    'updated_at is refreshed on update');
  update public.profiles set display_name = 'Robert' where id = robert;

  -- Species care rules (D23)
  perform _t_as(robert);
  begin
    insert into public.care_tasks (pet_id, type, title, scheduled_time) values (mochi, 'walk', 'Walk', '09:00');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'task_type_not_allowed_for_species', 'cat cannot get a walk task');
  begin
    insert into public.care_tasks (pet_id, type, title, scheduled_time) values (max, 'litter', 'Litter', '09:00');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'task_type_not_allowed_for_species', 'dog cannot get a litter task');
  insert into public.care_tasks (pet_id, type, title, scheduled_time) values (mochi, 'litter', 'Litter box', '09:00');
  perform _t_ok(true, 'cat can get a litter task');

  -- Anonymous visitors
  perform _t_as(null, 'anon');
  select count(*) into n from public.pets;
  perform _t_ok(n = 0, 'anon sees no pets');
  begin
    perform get_sitter_schedule(chloe, '2030-01-01', '2030-01-02');
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', 'anon cannot call RPCs');

  perform _t_as(null);
end;
$$;

-- ---------------------------------------------------------------------------
-- Booking scenarios A–H (dates start 30 days from today to avoid fixture overlap)
-- ---------------------------------------------------------------------------

do $$
declare
  robert constant uuid := '00000000-0000-4000-8000-0000000000a1';
  joy constant uuid := '00000000-0000-4000-8000-0000000000a2';
  chloe constant uuid := '00000000-0000-4000-8000-0000000000b1';
  paul constant uuid := '00000000-0000-4000-8000-0000000000b2';
  allen constant uuid := '00000000-0000-4000-8000-0000000000b3';
  nora constant uuid := '00000000-0000-4000-8000-0000000000b4';
  max constant uuid := '00000000-0000-4000-8000-0000000000c1';
  mochi constant uuid := '00000000-0000-4000-8000-0000000000c2';
  coco constant uuid := '00000000-0000-4000-8000-0000000000c3';
  toto constant uuid := '00000000-0000-4000-8000-0000000000c4';
  d constant date := app_today() + 30;
  v_a uuid;
  v_b uuid;
  v_h uuid;
  v_err text;
  v_detail text;
  n int;
  r record;
begin
  -- Sitters open their schedules
  perform _t_as(chloe);
  insert into public.sitter_availability (sitter_id, kind, start_date, end_date, slot, starts_at, ends_at, max_pets)
  values (chloe, 'open', d - 1, d + 20, 'morning', '08:00', '12:00', 3),
         (chloe, 'open', d - 1, d + 20, 'afternoon', '12:00', '18:00', 3),
         (chloe, 'open', d - 1, d + 20, 'overnight', '18:00', '08:00', 3);
  perform _t_as(paul);
  insert into public.sitter_availability (sitter_id, kind, start_date, end_date, slot, starts_at, ends_at, max_pets)
  values (paul, 'open', d - 1, d + 20, 'morning', '09:00', '13:00', 2),
         (paul, 'open', d - 1, d + 20, 'afternoon', '13:00', '17:00', 2);
  perform _t_as(allen);
  insert into public.sitter_availability (sitter_id, kind, start_date, end_date, slot, starts_at, ends_at, max_pets)
  values (allen, 'open', d - 1, d + 20, 'morning', '08:00', '12:00', 3),
         (allen, 'open', d - 1, d + 20, 'afternoon', '12:00', '18:00', 3),
         (allen, 'open', d - 1, d + 20, 'overnight', '18:00', '08:00', 3);

  -- G: opening a schedule notifies nobody
  perform _t_as(null);
  perform _t_ok((select count(*) from public.notifications where user_id in (robert, joy)
      and type not in ('pet_dropped_off', 'pet_picked_up', 'review_requested', 'feed_post')) = 0,
    'G: opening a schedule sends no owner notifications');

  -- A: in-hours drop-off & pick-up at sitter's home → request → accept → confirmed
  perform _t_as(robert);
  v_a := request_booking(chloe, array[max, mochi],
    local_ts(d, '09:30'), 'sitter_home', null,
    local_ts(d + 3, '17:00'), 'sitter_home', null, 'First trip');
  perform _t_put('A', v_a);
  perform _t_ok((select count(*) from public.booking_slots where booking_id = v_a) = 22,
    'A: 2 pets × 11 slots');
  perform _t_ok((select count(*) from public.booking_pets where booking_id = v_a and active) = 2,
    'A: 2 pets on the booking');
  perform _t_ok((select start_date = d and end_date = d + 3 from public.bookings where id = v_a),
    'A: booking dates follow drop-off / pick-up');
  perform _t_ok((select count(*) from public.booking_handoffs
      where booking_id = v_a and status = 'proposed' and within_sitter_hours) = 2,
    'A: two in-hours handoff proposals');
  -- Chloe received Max + Mochi in the 'current' fixture (permissions block), so they have met.
  perform _t_ok((select service_type = 'boarding' and meet_greet_status = 'not_needed'
      from public.bookings where id = v_a),
    'A: boarding by default; a pair that already had a drop-off skips the Meet & Greet');
  perform _t_as(chloe);
  perform respond_booking(v_a, true, 'See you!');
  perform _t_as(null);
  perform _t_ok((select status from public.bookings where id = v_a) = 'confirmed', 'A: booking confirmed');
  perform _t_ok((select count(*) from public.booking_handoffs where booking_id = v_a and status = 'agreed') = 2,
    'A: both handoffs agreed');
  perform _t_ok((select count(*) from public.notifications where user_id = robert and type = 'booking_confirmed') = 1,
    'A: owner gets one booking_confirmed');
  perform _t_ok((select count(*) from public.notifications where user_id = chloe and type = 'booking_requested') = 1,
    'A: sitter got booking_requested');

  -- B + H: capacity 3 at day d morning; two requests race for the last spot
  perform _t_as(joy);
  v_b := request_booking(chloe, array[coco], local_ts(d, '09:00'), 'sitter_home', null,
    local_ts(d + 1, '17:00'), 'sitter_home', null, null);
  v_h := request_booking(chloe, array[toto], local_ts(d, '09:00'), 'sitter_home', null,
    local_ts(d + 1, '17:00'), 'sitter_home', null, null);
  -- Joy ↔ Chloe have never met: Accept waits for the Meet & Greet (D44).
  perform _t_ok((select count(*) from public.bookings
      where id in (v_b, v_h) and meet_greet_status = 'required') = 2,
    'B: first stay together needs a Meet & Greet');
  perform _t_as(chloe);
  begin
    perform respond_booking(v_b, true);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'meet_greet_required', 'B: sitter cannot accept a first-time pair before meeting');
  perform _t_meet(v_b);
  perform _t_meet(v_h);
  perform respond_booking(v_b, true);
  begin
    perform respond_booking(v_h, true);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'sitter_unavailable', 'H: second acceptance for the last spot fails');
  perform _t_as(joy);
  select * into r from get_sitter_schedule(chloe, d, d) s where s.slot = 'morning';
  perform _t_ok(r.state = 'full' and r.remaining = 0, 'B: schedule shows the slot as full');
  perform cancel_booking(v_h, 'Found another plan');
  begin
    perform request_booking(chloe, array[toto], local_ts(d, '09:00'), 'sitter_home', null,
      local_ts(d + 1, '17:00'), 'sitter_home', null, null);
    v_err := null;
  exception when others then
    v_err := sqlerrm;
    get stacked diagnostics v_detail = pg_exception_detail;
  end;
  perform _t_ok(v_err = 'sitter_unavailable' and v_detail like '%morning%',
    'B: new request into a full slot is rejected with the slot in detail');

  -- Capacity guard: lowering max_pets or removing an open slot below confirmed pets fails
  perform _t_as(chloe);
  begin
    insert into public.sitter_availability (sitter_id, kind, start_date, end_date, slot, starts_at, ends_at, max_pets)
    values (chloe, 'open', d, d, 'morning', '08:00', '12:00', 2);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'overlaps_confirmed_booking', 'newer open row with fewer spots than booked fails');
  begin
    delete from public.sitter_availability where sitter_id = chloe and kind = 'open' and slot = 'morning';
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'overlaps_confirmed_booking', 'removing a booked open slot fails');
  insert into public.sitter_availability (sitter_id, kind, start_date, end_date, slot, starts_at, ends_at, max_pets)
  values (chloe, 'open', d + 15, d + 15, 'morning', '09:00', '12:00', 1);
  select * into r from get_sitter_schedule(chloe, d + 15, d + 15) s where s.slot = 'morning';
  perform _t_ok(r.starts_at = '09:00' and r.remaining = 1, 'the newest open row sets hours and spots');

  -- C: early-flight drop-off at 07:00, before Paul's Morning (09:00) → negotiated to 08:30
  perform _t_as(robert);
  v_a := request_booking(paul, array[max], local_ts(d + 10, '07:00'), 'sitter_home', null,
    local_ts(d + 10, '16:00'), 'sitter_home', null, null);
  perform _t_meet(v_a);
  perform _t_ok((select within_sitter_hours from public.booking_handoffs
      where booking_id = v_a and kind = 'drop_off' and status = 'proposed') = false,
    'C: 07:00 drop-off is stored as a custom time (outside Paul''s hours)');
  perform _t_ok((select count(*) from public.booking_slots where booking_id = v_a) = 2
      and (select start_date from public.bookings where id = v_a) = d + 10,
    'C: the 1 h before Paul''s hours does not claim the previous night');
  begin
    perform request_booking(paul, array[mochi], local_ts(d + 11, '07:00'), 'sitter_home', null,
      local_ts(d + 11, '08:00'), 'sitter_home', null, null);
    v_err := null;
  exception when others then
    v_err := sqlerrm;
    get stacked diagnostics v_detail = pg_exception_detail;
  end;
  perform _t_ok(v_err = 'sitter_unavailable' and v_detail = 'no_open_slot',
    'C: a stay entirely outside the sitter''s slots is rejected');
  perform _t_as(paul);
  perform propose_handoff(v_a, 'drop_off', local_ts(d + 10, '08:30'));
  begin
    perform respond_booking(v_a, true);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'handoff_pending', 'C: sitter cannot accept while own counter-offer is pending');
  perform _t_as(robert);
  perform propose_handoff(v_a, 'drop_off', local_ts(d + 10, '08:00'));
  perform _t_as(paul);
  v_h := propose_handoff(v_a, 'drop_off', local_ts(d + 10, '08:30'));
  perform _t_as(robert);
  perform respond_handoff(v_h, true);
  perform _t_as(paul);
  perform respond_booking(v_a, true);
  perform _t_as(null);
  perform _t_ok((select status from public.bookings where id = v_a) = 'confirmed', 'C: booking confirmed');
  perform _t_ok((select scheduled_at from public.booking_handoffs
      where booking_id = v_a and kind = 'drop_off' and status = 'agreed') = local_ts(d + 10, '08:30'),
    'C: agreed drop-off is 08:30');
  perform _t_ok((select count(*) from public.booking_handoffs
      where booking_id = v_a and kind = 'drop_off' and status = 'superseded') = 3,
    'C: three superseded proposals');

  -- C″: owner declines sitter's counter-offer before confirmation → request ends
  perform _t_as(joy);
  v_a := request_booking(paul, array[coco], local_ts(d + 12, '10:00'), 'sitter_home', null,
    local_ts(d + 12, '15:00'), 'sitter_home', null, null);
  perform _t_ok((select meet_greet_status from public.bookings where id = v_a) = 'not_needed',
    'C″: a pair that already had a stay (Joy ↔ Paul) skips the Meet & Greet');
  perform _t_as(paul);
  v_h := propose_handoff(v_a, 'pick_up', local_ts(d + 12, '14:00'));
  perform _t_as(joy);
  perform respond_handoff(v_h, false);
  perform _t_as(null);
  perform _t_ok((select status from public.bookings where id = v_a) = 'cancelled', 'C″: booking cancelled');
  perform _t_ok(not exists (select 1 from public.booking_pets where booking_id = v_a and active),
    'C″: pets released');
  perform _t_ok(not exists (select 1 from public.booking_handoffs where booking_id = v_a and status = 'proposed'),
    'C″: no open proposals left');
  perform _t_ok((select count(*) from public.notifications where user_id = paul and type = 'booking_cancelled') = 1,
    'C″: sitter notified');

  -- D: confirmed booking, owner moves pick-up 17:00 → 20:00
  v_a := _t_get('A');
  perform _t_as(robert);
  v_h := propose_handoff(v_a, 'pick_up', local_ts(d + 3, '20:00'));
  begin
    perform respond_handoff(v_h, true);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'not_allowed', 'D: proposer cannot accept own proposal');
  perform _t_as(null);
  perform _t_ok((select scheduled_at from public.booking_handoffs
      where booking_id = v_a and kind = 'pick_up' and status = 'agreed') = local_ts(d + 3, '17:00'),
    'D: old pick-up stays valid until agreed');
  perform _t_as(chloe);
  perform respond_handoff(v_h, true);
  perform _t_as(null);
  perform _t_ok((select scheduled_at from public.booking_handoffs
      where booking_id = v_a and kind = 'pick_up' and status = 'agreed') = local_ts(d + 3, '20:00'),
    'D: new pick-up agreed');
  perform _t_ok((select count(*) from public.booking_slots where booking_id = v_a) = 24,
    'D: slots recalculated (overnight added)');
  perform _t_ok((select count(*) from public.notifications where user_id = robert and type = 'handoff_agreed') = 1,
    'D: owner notified of agreement');

  -- D″: sitter declines a change after confirmation → booking unchanged
  perform _t_as(robert);
  v_h := propose_handoff(v_a, 'pick_up', local_ts(d + 3, '21:00'));
  perform _t_as(chloe);
  perform respond_handoff(v_h, false);
  perform _t_as(null);
  perform _t_ok((select status from public.bookings where id = v_a) = 'confirmed'
      and (select scheduled_at from public.booking_handoffs
        where booking_id = v_a and kind = 'pick_up' and status = 'agreed') = local_ts(d + 3, '20:00'),
    'D″: declined change keeps the agreed pick-up');
  perform _t_ok((select count(*) from public.notifications where user_id = robert and type = 'handoff_declined') = 1,
    'D″: owner notified of the decline');

  -- D′: pick-up at the owner's home; a time-only counter-offer keeps the place;
  --     addresses only via get_handoff_details, only for the booking parties
  perform _t_as(robert);
  begin
    perform propose_handoff(v_a, 'pick_up', local_ts(d + 3, '20:00'), 'other');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'location_note_required', 'D′: "Somewhere else" needs a place note');
  perform propose_handoff(v_a, 'pick_up', local_ts(d + 3, '20:00'), 'owner_home');
  perform _t_as(chloe);
  v_h := propose_handoff(v_a, 'pick_up', local_ts(d + 3, '19:30'));
  perform _t_ok((select location_type from public.booking_handoffs where id = v_h) = 'owner_home',
    'D′: time-only counter-offer keeps the proposed place');
  perform _t_as(robert);
  perform respond_handoff(v_h, true);
  perform _t_as(null);
  update public.bookings set paid_at = now() where id = v_a;
  perform _t_as(robert);
  perform _t_ok((select address from get_handoff_details(v_a) where kind = 'drop_off') = '100 Example St',
    'D′: owner sees sitter address for the confirmed booking');
  perform _t_as(chloe);
  perform _t_ok((select address from get_handoff_details(v_a) where kind = 'pick_up') = '1 Owner Ave',
    'D′: sitter sees owner address for an owner_home pick-up');
  perform _t_as(nora);
  begin
    perform get_handoff_details(v_a);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'not_allowed', 'D′: outsider cannot read handoff details');

  -- E: sitter blocks a day overlapping a confirmed booking → must cancel first → owner rebooks
  perform _t_as(chloe);
  begin
    insert into public.sitter_availability (sitter_id, kind, start_date, end_date, slot)
    values (chloe, 'blocked', d + 2, d + 2, 'morning');
    v_err := null;
  exception when others then
    v_err := sqlerrm;
    get stacked diagnostics v_detail = pg_exception_detail;
  end;
  perform _t_ok(v_err = 'overlaps_confirmed_booking' and v_detail like '%' || v_a || '%',
    'E: block over a confirmed booking is rejected with the booking id');
  perform cancel_booking(v_a, 'Personal schedule');
  insert into public.sitter_availability (sitter_id, kind, start_date, end_date, slot)
  values (chloe, 'blocked', d + 2, d + 2, 'morning');
  perform _t_as(null);
  perform _t_ok(not exists (select 1 from public.booking_pets where booking_id = v_a and active),
    'E: cancelled booking releases the pets');
  perform _t_ok((select body from public.notifications where user_id = robert and type = 'booking_cancelled')
      like 'Chloe can''t take Max and Mochi on %. Find a new sitter.',
    'E: owner told to find a new sitter');
  perform _t_as(robert);
  select * into r from search_sitters(local_ts(d, '09:30'), local_ts(d + 3, '19:30'), 2) limit 1;
  perform _t_ok(r.sitter_id = allen and r.covered_slots = r.total_slots, 'E: fully available sitter ranks first');
  select * into r from search_sitters(local_ts(d, '09:30'), local_ts(d + 3, '19:30'), 2) s where s.sitter_id = paul;
  perform _t_ok(r.covered_slots < r.total_slots, 'E: sitter without overnights shows as partly available');
  v_b := request_booking(allen, array[max, mochi], local_ts(d, '09:30'), 'sitter_home', null,
    local_ts(d + 3, '19:30'), 'owner_home', null, null, v_a);
  perform _t_meet(v_b, 'skipped');
  perform _t_as(allen);
  perform respond_booking(v_b, true);
  perform _t_as(null);
  perform _t_ok((select status = 'confirmed' and rebooked_from = v_a from public.bookings where id = v_b),
    'E: rebooked with another sitter');

  -- F: Coco with Chloe 09:00–12:00, then Paul takes over at 12:00 (same pet & day)
  perform _t_as(joy);
  v_a := request_booking(chloe, array[coco], local_ts(d + 14, '09:00'), 'sitter_home', null,
    local_ts(d + 14, '12:00'), 'other', 'Paul picks up at Chloe''s', null);
  v_b := request_booking(paul, array[coco], local_ts(d + 14, '12:00'), 'other', 'Chloe''s place',
    local_ts(d + 14, '17:00'), 'sitter_home', null, null);
  perform _t_ok((select meet_greet_status from public.bookings where id = v_a) = 'not_needed',
    'F: a pair whose Meet & Greet was done (in B) does not meet again');
  perform _t_as(chloe);
  perform respond_booking(v_a, true);
  perform _t_as(paul);
  perform respond_booking(v_b, true);
  perform _t_as(joy);
  begin
    perform request_booking(allen, array[coco], local_ts(d + 14, '13:00'), 'sitter_home', null,
      local_ts(d + 14, '17:00'), 'sitter_home', null, null);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'pet_already_booked', 'F: a third sitter for the same hours is rejected');
  -- Overlapping stays are caught by time, even when the two sitters' slot names differ
  perform request_booking(chloe, array[toto], local_ts(d + 16, '12:00'), 'sitter_home', null,
    local_ts(d + 16, '17:00'), 'sitter_home', null, null);
  begin
    perform request_booking(paul, array[toto], local_ts(d + 16, '09:00'), 'sitter_home', null,
      local_ts(d + 16, '13:00'), 'sitter_home', null, null);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'pet_already_booked', 'F: overlapping stays at two sitters are rejected');
  perform _t_as(null);
  perform _t_ok((select count(*) from public.bookings where id in (v_a, v_b) and status = 'confirmed') = 2,
    'F: split day with two sitters confirmed');
  insert into public.daily_reports (pet_id, sitter_id, report_date, body)
  values (coco, chloe, d + 14, 'Morning report'), (coco, paul, d + 14, 'Afternoon report');
  perform _t_ok(true, 'F: one daily report per sitter for the same day');
end;
$$;

-- ---------------------------------------------------------------------------
-- Booking options (004, phase-03b 3B.0): service type, sitter services, Meet & Greet
-- state, meeting spots, media purposes. Runs after A–H (Robert ↔ Chloe met in the
-- 'current' fixture).
-- ---------------------------------------------------------------------------

do $$
declare
  robert constant uuid := '00000000-0000-4000-8000-0000000000a1';
  chloe constant uuid := '00000000-0000-4000-8000-0000000000b1';
  allen constant uuid := '00000000-0000-4000-8000-0000000000b3';
  max constant uuid := '00000000-0000-4000-8000-0000000000c1';
  mochi constant uuid := '00000000-0000-4000-8000-0000000000c2';
  d constant date := app_today() + 30;
  v_a uuid;
  v_err text;
  n int;
  r record;
begin
  -- House sitting needs the sitter to offer it; both handoffs move to the owner's home
  perform _t_as(robert);
  begin
    perform request_booking(chloe, array[max], local_ts(d + 18, '09:00'), 'sitter_home', null,
      local_ts(d + 18, '11:00'), 'sitter_home', null, null, null, 'house_sitting');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'service_not_offered', '3B.0: sitters offer boarding only by default');
  begin
    perform request_booking(chloe, array[max], local_ts(d + 18, '09:00'), 'sitter_home', null,
      local_ts(d + 18, '11:00'), 'sitter_home', null, null, null, 'dog_walking');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'invalid_service', '3B.0: unknown service type is rejected');

  perform _t_as(chloe);
  begin
    update public.sitter_profiles set services = '{}' where id = chloe;
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '23514', '3B.0: a sitter must offer at least one service');
  begin
    update public.sitter_profiles set services = '{boarding,dog_walking}' where id = chloe;
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '23514', '3B.0: services are boarding / house_sitting only');
  update public.sitter_profiles set services = '{boarding,house_sitting}' where id = chloe;

  perform _t_as(robert);
  v_a := request_booking(chloe, array[max], local_ts(d + 18, '09:00'), 'sitter_home', null,
    local_ts(d + 18, '11:00'), 'other', 'Trinity Bellwoods', null, null, 'house_sitting');
  perform _t_as(null);
  perform _t_ok((select service_type from public.bookings where id = v_a) = 'house_sitting',
    '3B.0: house sitting booking stored');
  perform _t_ok((select count(*) from public.booking_handoffs
      where booking_id = v_a and location_type = 'owner_home' and location_note is null) = 2,
    '3B.0: house sitting fixes both handoffs to the owner''s home');
  perform _t_ok((select meet_greet_status from public.bookings where id = v_a) = 'not_needed',
    '3B.0: a pair that already met does not meet again');

  -- A skipped Meet & Greet is not a meeting: Robert ↔ Allen are still first-time. Declining works.
  perform _t_as(robert);
  v_a := request_booking(allen, array[mochi], local_ts(d + 19, '09:00'), 'sitter_home', null,
    local_ts(d + 19, '11:00'), 'sitter_home', null, null);
  perform _t_ok((select meet_greet_status from public.bookings where id = v_a) = 'required',
    '3B.0: after a skipped Meet & Greet the pair still has not met');
  perform _t_as(allen);
  perform respond_booking(v_a, false, 'Fully booked that week');
  perform _t_as(null);
  perform _t_ok((select status from public.bookings where id = v_a) = 'declined',
    '3B.0: sitter can decline before the Meet & Greet');

  -- Search results carry the sitter's services
  perform _t_as(robert);
  select * into r from search_sitters(local_ts(d + 20, '09:00'), local_ts(d + 20, '11:00'), 1) s
  where s.sitter_id = chloe;
  perform _t_ok(r.services = '{boarding,house_sitting}', '3B.0: search_sitters returns services');
  select * into r from list_my_sitters() s where s.sitter_id = allen;
  perform _t_ok(r.services = '{boarding}', '3B.0: list_my_sitters returns services');

  -- Preferred meeting spots: ≤ 3 labels of ≤ 60 chars; sitter spots are not in the public list
  update public.owner_profiles set meet_spots = '{"Trinity Bellwoods — north gate"}' where id = robert;
  perform _t_ok((select meet_spots from public.owner_profiles where id = robert)
      = '{"Trinity Bellwoods — north gate"}', '3B.0: owner saves a meeting spot');
  begin
    update public.owner_profiles set meet_spots = '{a,b,c,d}' where id = robert;
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '23514', '3B.0: at most 3 meeting spots');
  begin
    update public.owner_profiles set meet_spots = array[repeat('x', 61)] where id = robert;
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '23514', '3B.0: meeting spot label is at most 60 characters');
  begin
    update public.owner_profiles set meet_spots = '{" "}' where id = robert;
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '23514', '3B.0: blank meeting spot is rejected');

  perform _t_as(chloe);
  update public.sitter_profiles set meet_spots = '{"Christie Pits — east entrance"}' where id = chloe;
  perform _t_ok((select meet_spots from get_my_sitter_profile()) = '{"Christie Pits — east entrance"}',
    '3B.0: sitter reads own meeting spots');
  perform _t_as(robert);
  perform _t_ok((select services from public.sitter_profiles where id = chloe) = '{boarding,house_sitting}',
    '3B.0: owners can read sitter services');
  begin
    select count(*) into n from (select meet_spots from public.sitter_profiles) s;
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', '3B.0: sitter meeting spots are not in the public sitter list');

  -- Media purposes for the daily report (07) and handoff photo check (06B)
  perform _t_as(null);
  insert into public.media (pet_id, uploaded_by, cloudinary_public_id, resource_type, purpose) values
    (max, chloe, 'smoke/max-report', 'image', 'report'),
    (max, chloe, 'smoke/max-handoff', 'image', 'handoff');
  begin
    insert into public.media (pet_id, uploaded_by, cloudinary_public_id, resource_type, purpose)
    values (max, chloe, 'smoke/max-other', 'image', 'selfie');
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '23514', '3B.0: media purpose is still checked');

  -- The new request_booking signature is not open to anon (plain timestamps: local_ts is
  -- not granted to anon either, and would fail first)
  perform _t_as(null, 'anon');
  begin
    perform request_booking(chloe, array[max], now() + interval '60 days', 'sitter_home', null,
      now() + interval '61 days', 'sitter_home', null, null, null, 'boarding');
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', '3B.0: anon cannot call request_booking');
  perform _t_as(null);
end;
$$;

-- ---------------------------------------------------------------------------
-- Meet & Greet (005, phase-03b 3B.9, D44): propose / respond / done, skip accepted /
-- declined. First-time pairs: Robert ↔ Nora (the 'requested' fixture) and Joy ↔ Nora.
-- ---------------------------------------------------------------------------

do $$
declare
  robert constant uuid := '00000000-0000-4000-8000-0000000000a1';
  joy constant uuid := '00000000-0000-4000-8000-0000000000a2';
  chloe constant uuid := '00000000-0000-4000-8000-0000000000b1';
  nora constant uuid := '00000000-0000-4000-8000-0000000000b4';
  coco constant uuid := '00000000-0000-4000-8000-0000000000c3';
  toto constant uuid := '00000000-0000-4000-8000-0000000000c4';
  v_a uuid := _t_get('requested');
  v_b uuid;
  v_err text;
  r record;
begin
  perform _t_meet(v_a, 'required');

  -- Proposals are checked
  perform _t_as(robert);
  begin
    perform propose_meet_greet(v_a, 'in_person', now() + interval '1 day', '  ');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'place_required', '3B.9: in person needs a place');
  begin
    perform propose_meet_greet(v_a, 'video', now() - interval '1 hour');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'invalid_window', '3B.9: a Meet & Greet in the past is rejected');
  begin
    perform propose_meet_greet(v_a, 'phone', now() + interval '1 day');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'invalid_mode', '3B.9: only in person or video');

  -- In person: propose → the other side declines → back to required
  perform propose_meet_greet(v_a, 'in_person', now() + interval '1 day', 'Trinity Bellwoods — north gate');
  perform _t_as(null);
  perform _t_ok((select meet_greet_status = 'proposed' and meet_greet_place = 'Trinity Bellwoods — north gate'
      and meet_greet_proposed_by = robert from public.bookings where id = v_a),
    '3B.9: in-person proposal stored');
  perform _t_ok(exists (select 1 from public.notifications where user_id = nora and type = 'meet_greet_proposed'
      and title like 'Robert suggested meeting at Trinity Bellwoods — north gate on %'),
    '3B.9: the other side gets meet_greet_proposed');
  perform _t_as(robert);
  begin
    perform respond_meet_greet(v_a, true);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'not_allowed', '3B.9: the proposer cannot accept their own Meet & Greet');
  perform _t_as(chloe);
  begin
    perform respond_meet_greet(v_a, true);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'not_allowed', '3B.9: an outsider cannot answer');
  perform _t_as(nora);
  perform respond_meet_greet(v_a, false);
  perform _t_as(null);
  perform _t_ok((select meet_greet_status = 'required' and meet_greet_mode is null and meet_greet_at is null
      from public.bookings where id = v_a),
    '3B.9: a declined Meet & Greet goes back to required');
  perform _t_ok(exists (select 1 from public.notifications where user_id = robert and type = 'meet_greet_declined'),
    '3B.9: the proposer hears about the decline');

  -- Video: Nora proposes, Robert agrees, done only once the time has come, then Accept works
  perform _t_as(nora);
  perform propose_meet_greet(v_a, 'video', now() + interval '2 days');
  perform _t_as(robert);
  perform respond_meet_greet(v_a, true);
  perform _t_as(null);
  perform _t_ok((select meet_greet_status = 'agreed' and meet_greet_mode = 'video' and meet_greet_place is null
      from public.bookings where id = v_a),
    '3B.9: video Meet & Greet agreed');
  perform _t_ok(exists (select 1 from public.notifications where user_id = nora and type = 'meet_greet_agreed'),
    '3B.9: the proposer gets meet_greet_agreed');
  perform _t_as(nora);
  begin
    perform respond_booking(v_a, true);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'meet_greet_required', '3B.9: Accept still waits while the Meet & Greet is only agreed');
  begin
    perform complete_meet_greet(v_a);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'meet_greet_not_yet', '3B.9: Done only after the meeting time');
  perform _t_as(null);
  update public.bookings set meet_greet_at = now() - interval '1 hour' where id = v_a;
  perform _t_as(robert);
  perform complete_meet_greet(v_a);
  perform _t_as(chloe);
  begin
    select * into r from get_meet_greet_options(v_a);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'not_allowed', '3B.9: meeting spots are only for the two parties');
  perform _t_as(nora);
  select * into r from get_meet_greet_options(v_a);
  perform _t_ok(r.owner_name = 'Robert' and r.owner_spots = '{"Trinity Bellwoods — north gate"}'
      and r.sitter_spots = '{}',
    '3B.9: both sides'' meeting spots for the In person sheet');
  insert into public.sitter_availability (sitter_id, kind, start_date, end_date, slot, starts_at, ends_at, max_pets)
  select nora, 'open', app_today() + 38, app_today() + 43, s, '00:00', '23:59', 3
  from unnest(array['morning', 'afternoon']::care_slot[]) s;
  insert into public.sitter_availability (sitter_id, kind, start_date, end_date, slot, starts_at, ends_at, max_pets)
  values (nora, 'open', app_today() + 38, app_today() + 43, 'overnight', '18:00', '08:00', 3);
  perform respond_booking(v_a, true);
  perform _t_as(null);
  perform _t_ok((select status = 'confirmed' and meet_greet_status = 'done' from public.bookings where id = v_a),
    '3B.9: after the Meet & Greet is done the sitter can accept');

  -- Skip accepted: Joy asks, Nora continues without meeting
  v_b := _t_booking(joy, nora, array[toto], now() + interval '50 days', now() + interval '51 days', 'requested');
  perform _t_meet(v_b, 'required');
  perform _t_as(joy);
  perform request_skip_meet_greet(v_b);
  begin
    perform respond_skip_meet_greet(v_b, true);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'not_allowed', '3B.9: the one who asked to skip cannot answer it');
  perform _t_as(nora);
  perform respond_skip_meet_greet(v_b, true);
  perform _t_as(null);
  perform _t_ok((select meet_greet_status = 'skipped' and status = 'requested' from public.bookings where id = v_b),
    '3B.9: skip accepted → skipped, the request goes on');
  perform _t_ok(exists (select 1 from public.notifications where user_id = nora and type = 'meet_greet_skip_requested')
      and exists (select 1 from public.notifications where user_id = joy and type = 'meet_greet_skipped'),
    '3B.9: skip request and answer are notified');

  -- Skip declined: the booking is cancelled and the owner is told to find a new sitter
  v_b := _t_booking(joy, nora, array[coco], now() + interval '60 days', now() + interval '61 days', 'requested');
  perform _t_meet(v_b, 'required');
  perform _t_as(joy);
  perform request_skip_meet_greet(v_b);
  perform _t_as(nora);
  perform respond_skip_meet_greet(v_b, false);
  perform _t_as(null);
  perform _t_ok((select status = 'cancelled' and cancel_reason = 'meet_greet_declined' and cancelled_by = nora
      from public.bookings where id = v_b),
    '3B.9: declining the skip cancels the booking');
  perform _t_ok(not exists (select 1 from public.booking_pets where booking_id = v_b and active),
    '3B.9: the cancelled booking frees the pet');
  perform _t_ok(exists (select 1 from public.notifications where user_id = joy and type = 'booking_cancelled'
      -- The Nora fixture has no display_name, so the signup trigger used the email prefix.
      and title = 'nora would like to meet first, so this booking was cancelled'),
    '3B.9: the owner is told the sitter wants to meet first');
  perform _t_as(joy);
  begin
    perform propose_meet_greet(v_b, 'video', now() + interval '1 day');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'invalid_status', '3B.9: no Meet & Greet on a cancelled booking');
  perform _t_as(null);
end;
$$;

-- ---------------------------------------------------------------------------
-- Quote (006, phase-03c 3C.1, D29): rates + Ontario holidays + quote_booking
-- ---------------------------------------------------------------------------

do $$
declare
  robert constant uuid := '00000000-0000-4000-8000-0000000000a1';
  chloe constant uuid := '00000000-0000-4000-8000-0000000000b1';
  paul constant uuid := '00000000-0000-4000-8000-0000000000b2';
  q jsonb;
  v_err text;
  -- Goal example: boarding Oct 9 07:30 → Oct 12 17:00 Toronto, 2 pets, Thanksgiving Oct 12.
  v_drop timestamptz := ('2026-10-09 07:30:00'::timestamp at time zone app_timezone());
  v_pick timestamptz := ('2026-10-12 17:00:00'::timestamp at time zone app_timezone());
  v_hs_drop timestamptz := ('2026-10-05 09:00:00'::timestamp at time zone app_timezone());
  v_hs_pick timestamptz := ('2026-10-08 17:00:00'::timestamp at time zone app_timezone());
  v_day_drop timestamptz := ('2026-10-10 08:00:00'::timestamp at time zone app_timezone());
  v_day_pick timestamptz := ('2026-10-10 18:00:00'::timestamp at time zone app_timezone());
begin
  -- Chloe: Boarding $55 · House sitting $70 · Daycare $35 · +50% · +25% (Goal)
  perform _t_as(null);
  update public.sitter_profiles
  set services = array['boarding', 'house_sitting']
  where id = chloe;

  perform _t_as(chloe);
  insert into public.sitter_rates (
    sitter_id, boarding_nightly, house_sitting_nightly, daycare_daily,
    extra_pet_pct, holiday_pct
  ) values (chloe, 55.00, 70.00, 35.00, 50, 25);

  -- Boarding · 2 pets · Thanksgiving (phase-03c Goal): $268.13 CAD
  perform _t_as(robert);
  q := quote_booking(chloe, 'boarding', v_drop, v_pick, 2);
  perform _t_ok(
    (q->>'nights')::int = 3
    and (q->>'days')::int = 3
    and (q->>'unit_price')::numeric = 55.00
    and (q->>'base')::numeric = 165.00
    and (q->>'extra_pets')::numeric = 82.50
    and (q->>'holiday_surcharge')::numeric = 20.63
    and (q->>'total')::numeric = 268.13
    and q->>'currency' = 'CAD'
    and q->'holiday_days' = '[{"day":"2026-10-12","name":"Thanksgiving Day"}]'::jsonb,
    '3C.1: boarding 2 pets + Thanksgiving = $268.13');

  -- House sitting · 1 pet · no holiday in Oct 5–8
  q := quote_booking(chloe, 'house_sitting', v_hs_drop, v_hs_pick, 1);
  perform _t_ok(
    (q->>'nights')::int = 3
    and (q->>'unit_price')::numeric = 70.00
    and (q->>'base')::numeric = 210.00
    and (q->>'extra_pets')::numeric = 0
    and (q->>'holiday_surcharge')::numeric = 0
    and (q->>'total')::numeric = 210.00
    and q->'holiday_days' = '[]'::jsonb,
    '3C.1: house sitting 1 pet = $210.00');

  -- Daycare · same day · 2 pets
  q := quote_booking(chloe, 'daycare', v_day_drop, v_day_pick, 2);
  perform _t_ok(
    (q->>'nights')::int = 0
    and (q->>'days')::int = 1
    and (q->>'unit_price')::numeric = 35.00
    and (q->>'base')::numeric = 35.00
    and (q->>'extra_pets')::numeric = 17.50
    and (q->>'holiday_surcharge')::numeric = 0
    and (q->>'total')::numeric = 52.50,
    '3C.1: daycare same day 2 pets = $52.50');

  -- Paul has no rates → service_not_offered
  begin
    q := quote_booking(paul, 'boarding', v_drop, v_pick, 1);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'service_not_offered', '3C.1: no rates → service_not_offered');

  -- House sitting rate without the service in the profile is rejected on insert
  perform _t_as(null);
  update public.sitter_profiles set services = array['boarding'] where id = paul;
  perform _t_as(paul);
  begin
    insert into public.sitter_rates (sitter_id, house_sitting_nightly)
    values (paul, 60.00);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'service_not_offered', '3C.1: rates must match offered services');

  perform _t_as(null);
end;
$$;

-- ---------------------------------------------------------------------------
-- Consents (006, phase-03c 3C.2, D30): required_consents + booking_consents RLS
-- ---------------------------------------------------------------------------

do $$
declare
  robert constant uuid := '00000000-0000-4000-8000-0000000000a1';
  joy constant uuid := '00000000-0000-4000-8000-0000000000a2';
  chloe constant uuid := '00000000-0000-4000-8000-0000000000b1';
  paul constant uuid := '00000000-0000-4000-8000-0000000000b2';
  max constant uuid := '00000000-0000-4000-8000-0000000000c1';
  coco constant uuid := '00000000-0000-4000-8000-0000000000c3';
  v_board uuid;
  v_house uuid;
  v_kinds text[];
  v_err text;
  n int;
  v_signed_at timestamptz;
begin
  -- Boarding (sitter_home handoffs): emergency_vet, safe_return, handoff_rules, cohabitation
  v_board := _t_booking(robert, chloe, array[max],
    now() + interval '20 days', now() + interval '23 days', 'confirmed');
  perform _t_as(robert);
  v_kinds := required_consents(v_board);
  perform _t_ok(v_kinds = array['emergency_vet', 'safe_return', 'handoff_rules', 'cohabitation'],
    '3C.2: boarding requires 4 consents');

  insert into public.booking_consents (booking_id, kind, version, signer_id, signer_name, details)
  values (v_board, 'emergency_vet', '1', robert, 'Robert',
    jsonb_build_object('limit_cad', 500, 'vet_clinic_name', 'Demo Vet'));
  select signed_at into v_signed_at from public.booking_consents
    where booking_id = v_board and kind = 'emergency_vet';
  perform _t_ok(v_signed_at is not null, '3C.2: owner signature stores signed_at');

  begin
    insert into public.booking_consents (booking_id, kind, version, signer_id, signer_name)
    values (v_board, 'emergency_vet', '1', robert, 'Robert');
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '23505', '3C.2: same kind cannot be signed twice');

  begin
    update public.booking_consents set signer_name = 'Changed' where booking_id = v_board;
    get diagnostics n = row_count;
    v_err := null;
  exception when others then
    v_err := sqlstate;
    n := -1;
  end;
  perform _t_ok(n = 0 or v_err = '42501', '3C.2: signatures are read-only after signing');

  perform _t_as(chloe);
  select count(*) into n from public.booking_consents where booking_id = v_board;
  perform _t_ok(n = 1, '3C.2: sitter can read owner signatures');

  perform _t_as(paul);
  select count(*) into n from public.booking_consents where booking_id = v_board;
  perform _t_ok(n = 0, '3C.2: outsider cannot read consents');
  begin
    v_kinds := required_consents(v_board);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'not_allowed', '3C.2: outsider cannot call required_consents');

  -- House sitting → home_access instead of boarding-only kinds
  perform _t_as(null);
  v_house := _t_booking(joy, paul, array[coco],
    now() + interval '70 days', now() + interval '72 days', 'confirmed');
  update public.bookings set service_type = 'house_sitting' where id = v_house;
  update public.booking_handoffs set location_type = 'owner_home' where booking_id = v_house;

  perform _t_as(joy);
  v_kinds := required_consents(v_house);
  perform _t_ok(v_kinds = array['emergency_vet', 'safe_return', 'home_access'],
    '3C.2: house sitting requires home_access');

  begin
    insert into public.booking_consents (booking_id, kind, version, signer_id, signer_name)
    values (v_house, 'safe_return', '1', paul, 'Paul');
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', '3C.2: only the owner can sign');

  perform _t_as(null);
end;
$$;

-- ---------------------------------------------------------------------------
-- Demo pay (006, phase-03c 3C.3, D30): pay_booking_demo — no Stripe
-- ---------------------------------------------------------------------------

do $$
declare
  robert constant uuid := '00000000-0000-4000-8000-0000000000a1';
  chloe constant uuid := '00000000-0000-4000-8000-0000000000b1';
  paul constant uuid := '00000000-0000-4000-8000-0000000000b2';
  v_pay uuid;
  v_kind text;
  v_quote jsonb;
  v_err text;
  v_detail text;
  v_dog uuid;
  v_cat uuid;
begin
  -- Confirmed boarding with Chloe rates already seeded in 3C.1. The Thanksgiving dates are fixed, so this
  -- booking gets its own pets: Max and Mochi are booked relative to now(), which would overlap it for a few days.
  insert into public.pets (owner_id, species, name) values (robert, 'dog', 'Payer') returning id into v_dog;
  insert into public.pets (owner_id, species, name) values (robert, 'cat', 'Payee') returning id into v_cat;
  v_pay := _t_booking(robert, chloe, array[v_dog, v_cat],
    ('2026-10-09 07:30:00'::timestamp at time zone app_timezone()),
    ('2026-10-12 17:00:00'::timestamp at time zone app_timezone()),
    'confirmed');

  perform _t_as(robert);
  begin
    v_quote := pay_booking_demo(v_pay);
    v_err := null;
    v_detail := null;
  exception when others then
    get stacked diagnostics v_err = message_text, v_detail = pg_exception_detail;
  end;
  perform _t_ok(v_err = 'consents_missing', '3C.3: pay without consents → consents_missing');
  perform _t_ok(v_detail like '%emergency_vet%', '3C.3: consents_missing lists the kinds');

  -- Sign every required kind
  foreach v_kind in array required_consents(v_pay) loop
    insert into public.booking_consents (booking_id, kind, version, signer_id, signer_name, details)
    values (v_pay, v_kind, '1', robert, 'Robert',
      case v_kind
        when 'emergency_vet' then jsonb_build_object('limit_cad', 500, 'vet_clinic_name', 'Demo Vet')
        when 'safe_return' then jsonb_build_object('receiver_name', 'Robert')
        else '{}'::jsonb
      end);
  end loop;

  v_quote := pay_booking_demo(v_pay);
  perform _t_ok(
    (v_quote->>'total')::numeric = 268.13
    and (select paid_at is not null and price_snapshot->>'total' = '268.13' from public.bookings where id = v_pay),
    '3C.3: demo pay freezes $268.13 and sets paid_at');
  perform _t_as(null);
  perform _t_ok(exists (
      select 1 from public.notifications
      where user_id = chloe and type = 'booking_paid' and booking_id = v_pay),
    '3C.3: sitter gets booking_paid');

  perform _t_as(robert);
  begin
    v_quote := pay_booking_demo(v_pay);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'already_paid', '3C.3: second pay → already_paid');

  perform _t_as(chloe);
  begin
    v_quote := pay_booking_demo(v_pay);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'not_allowed', '3C.3: sitter cannot pay');

  perform _t_as(paul);
  begin
    v_quote := pay_booking_demo(v_pay);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'not_allowed', '3C.3: outsider cannot pay');

  perform _t_as(null);
end;
$$;

-- ---------------------------------------------------------------------------
-- Paid address gate (006, phase-03c 3C.4, D31)
-- ---------------------------------------------------------------------------

do $$
declare
  robert constant uuid := '00000000-0000-4000-8000-0000000000a1';
  chloe constant uuid := '00000000-0000-4000-8000-0000000000b1';
  max constant uuid := '00000000-0000-4000-8000-0000000000c1';
  v_id uuid;
  r record;
  v_err text;
begin
  perform _t_as(null);
  update public.sitter_profiles
  set visitor_parking = 'Visitor spot B-12',
      lobby_notes = 'Buzz 1204',
      packing_list = array['food', 'leash']
  where id = chloe;

  v_id := _t_booking(robert, chloe, array[max],
    now() + interval '80 days', now() + interval '83 days', 'confirmed');

  perform _t_as(robert);
  begin
    select * into r from get_handoff_details(v_id);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'not_paid', '3C.4: address hidden before demo pay');

  perform _t_as(null);
  update public.bookings set paid_at = now() where id = v_id;

  perform _t_as(robert);
  select * into r from get_handoff_details(v_id) where kind = 'drop_off';
  perform _t_ok(
    r.address = '100 Example St'
    and r.visitor_parking = 'Visitor spot B-12'
    and r.lobby_notes = 'Buzz 1204'
    and r.packing_list = array['food', 'leash'],
    '3C.4: after pay, sitter home + packing list return');

  perform _t_as(null);
end;
$$;

-- ---------------------------------------------------------------------------
-- Home access unlock (006, phase-03c 3C.5 / I–K, D31)
-- ---------------------------------------------------------------------------

do $$
declare
  robert constant uuid := '00000000-0000-4000-8000-0000000000a1';
  joy constant uuid := '00000000-0000-4000-8000-0000000000a2';
  chloe constant uuid := '00000000-0000-4000-8000-0000000000b1';
  paul constant uuid := '00000000-0000-4000-8000-0000000000b2';
  max constant uuid := '00000000-0000-4000-8000-0000000000c1';
  coco constant uuid := '00000000-0000-4000-8000-0000000000c3';
  v_id uuid;
  r record;
  v_err text;
  v_detail text;
  n int;
begin
  -- I: before pay — get_home_access blocked; owner can save codes privately
  perform _t_as(robert);
  insert into public.owner_home_access (owner_id, entry_steps, lockbox_code, buzzer, fob_notes, sitter_parking)
  values (robert, '1. Buzz 1204  2. Lockbox left of door', '0000', '#1204', 'Fob on key hook', 'Street parking OK')
  on conflict (owner_id) do update set
    entry_steps = excluded.entry_steps,
    lockbox_code = excluded.lockbox_code,
    buzzer = excluded.buzzer,
    fob_notes = excluded.fob_notes,
    sitter_parking = excluded.sitter_parking;

  perform _t_as(null);
  v_id := _t_booking(robert, chloe, array[max],
    now() + interval '90 days', now() + interval '93 days', 'confirmed');
  update public.booking_handoffs set location_type = 'owner_home'
    where booking_id = v_id and kind = 'drop_off';

  perform _t_as(chloe);
  begin
    select * into r from get_home_access(v_id);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'not_paid', '3C.5 I: access hidden before pay');

  perform _t_as(null);
  update public.bookings set paid_at = now() where id = v_id;
  -- Drop-off still > 2 h away
  update public.booking_handoffs
  set scheduled_at = now() + interval '5 hours'
  where booking_id = v_id and kind = 'drop_off';
  update public.booking_handoffs
  set scheduled_at = now() + interval '3 days'
  where booking_id = v_id and kind = 'pick_up';

  -- J: T−2h before → access_locked with unlocks_at
  perform _t_as(chloe);
  begin
    select * into r from get_home_access(v_id);
    v_err := null;
    v_detail := null;
  exception when others then
    get stacked diagnostics v_err = message_text, v_detail = pg_exception_detail;
  end;
  perform _t_ok(v_err = 'access_locked' and v_detail like '%unlocks_at%',
    '3C.5 J: locked before T−2h with unlocks_at');

  perform _t_as(null);
  update public.booking_handoffs
  set scheduled_at = now() + interval '1 hour'
  where booking_id = v_id and kind = 'drop_off';

  perform _t_as(chloe);
  select * into r from get_home_access(v_id);
  perform _t_ok(r.lockbox_code = '0000' and r.buzzer = '#1204',
    '3C.5 J: codes return inside the window');
  perform _t_as(null);
  perform _t_ok((select count(*) from public.access_reveals where booking_id = v_id) = 1,
    '3C.5 J: first reveal recorded once');
  perform _t_ok((select count(*) from public.notifications
      where user_id = robert and type = 'access_unlocked' and booking_id = v_id) = 1,
    '3C.5 J: owner notified once');

  perform _t_as(chloe);
  select * into r from get_home_access(v_id);
  perform _t_as(null);
  perform _t_ok((select count(*) from public.access_reveals where booking_id = v_id) = 1
      and (select count(*) from public.notifications
        where user_id = robert and type = 'access_unlocked' and booking_id = v_id) = 1,
    '3C.5 J: second open does not re-notify');

  -- K: other sitter forbidden; after pick-up completed → locked_since
  perform _t_as(paul);
  begin
    select * into r from get_home_access(v_id);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'forbidden', '3C.5 K: other sitter forbidden');

  perform _t_as(robert);
  begin
    select * into r from get_home_access(v_id);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'forbidden', '3C.5 K: owner cannot call get_home_access');

  perform _t_as(null);
  update public.booking_handoffs
  set completed_at = now() - interval '1 minute'
  where booking_id = v_id and kind = 'pick_up';

  perform _t_as(chloe);
  begin
    select * into r from get_home_access(v_id);
    v_err := null;
    v_detail := null;
  exception when others then
    get stacked diagnostics v_err = message_text, v_detail = pg_exception_detail;
  end;
  perform _t_ok(v_err = 'access_locked' and v_detail like '%locked_since%',
    '3C.5 K: locked again after pick-up completed');

  -- Paul cannot read Robert's owner_home_access row directly
  perform _t_as(paul);
  select count(*) into n from public.owner_home_access where owner_id = robert;
  perform _t_ok(n = 0, '3C.5 K: sitter RLS cannot read owner_home_access');

  -- 3C.7 polish: unlock notice must never echo lockbox / buzzer codes (DoD #3)
  perform _t_ok(
    not exists (
      select 1 from public.notifications n
      where n.booking_id = v_id and n.type = 'access_unlocked'
        and (coalesce(n.title, '') || ' ' || coalesce(n.body, ''))
          ~* '(0000|#1204|Buzz 1204|lockbox left)'
    ),
    '3C.7: access_unlocked notice has no entry codes');

  -- Phase 05 (5.3): feed_posts.category
  perform _t_as(chloe);
  begin
    insert into public.feed_posts (pet_id, sitter_id, media_id, category)
    values (max, chloe, _t_get('media_bori'), 'not_a_category');
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '23514', '5.3: feed_posts.category check');

  -- Phase 05 (5.8): visibility + owner posts
  perform _t_as(null);
  insert into public.media (pet_id, uploaded_by, cloudinary_public_id, resource_type, purpose) values
    (max, chloe, 'smoke/max-private', 'image', 'feed'),
    (max, robert, 'smoke/max-owner-private', 'image', 'feed'),
    (max, robert, 'smoke/max-owner-shared', 'image', 'feed');
  perform _t_put('m_priv', (select id from public.media where cloudinary_public_id = 'smoke/max-private'));
  perform _t_put('m_opriv', (select id from public.media where cloudinary_public_id = 'smoke/max-owner-private'));
  perform _t_put('m_oshared', (select id from public.media where cloudinary_public_id = 'smoke/max-owner-shared'));

  perform _t_as(chloe);
  insert into public.feed_posts (pet_id, sitter_id, media_id, visibility)
  values (max, chloe, _t_get('m_priv'), 'private');
  select count(*) into n from public.feed_posts where media_id = _t_get('m_priv');
  perform _t_ok(n = 1, '5.8: author sees her own private post');
  begin
    insert into public.feed_posts (pet_id, sitter_id, media_id, visibility)
    values (max, chloe, _t_get('media_bori'), 'hidden');
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '23514', '5.8: visibility check');
  begin
    insert into public.feed_posts (pet_id, sitter_id, media_id)
    values (max, chloe, _t_get('m_oshared'));
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', '5.8: cannot attach media someone else uploaded');
  perform _t_as(null);
  perform _t_ok(not exists (
      select 1 from public.notifications n join public.feed_posts fp on fp.id = n.ref_id
      where n.type = 'feed_post' and fp.media_id = _t_get('m_priv')),
    '5.8: private post sends no owner notification');

  perform _t_as(robert);
  select count(*) into n from public.feed_posts where media_id = _t_get('m_priv');
  perform _t_ok(n = 0, '5.8: owner cannot see the sitter''s private post');
  select count(*) into n from public.media where id = _t_get('m_priv');
  perform _t_ok(n = 0, '5.8: owner cannot read the private post''s media row');
  insert into public.feed_posts (pet_id, sitter_id, media_id, visibility)
  values (max, null, _t_get('m_opriv'), 'private');
  insert into public.feed_posts (pet_id, sitter_id, media_id, visibility)
  values (max, null, _t_get('m_oshared'), 'shared');
  perform _t_ok(true, '5.8: owner can post for her own pet');
  perform _t_as(null);
  perform _t_ok((select count(*) from public.notifications n
      join public.feed_posts fp on fp.id = n.ref_id
      where n.type = 'feed_post' and fp.media_id = _t_get('m_oshared') and n.user_id = chloe) = 1,
    '5.9: owner''s shared post notifies the on-duty sitter');
  perform _t_ok((select count(*) from public.notifications n
      join public.feed_posts fp on fp.id = n.ref_id
      where n.type = 'feed_post' and fp.media_id = _t_get('m_oshared') and n.user_id <> chloe) = 0,
    '5.9: nobody else is notified (not the other sitter, not the owner)');
  perform _t_ok(not exists (select 1 from public.notifications n
      join public.feed_posts fp on fp.id = n.ref_id
      where n.type = 'feed_post' and fp.media_id = _t_get('m_opriv')),
    '5.9: owner''s private post notifies nobody');
  perform _t_as(robert);
  begin
    insert into public.feed_posts (pet_id, sitter_id, media_id)
    values (max, chloe, _t_get('media_bori'));
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err in ('42501', '23514'), '5.8: owner cannot post as the sitter');
  begin
    insert into public.feed_posts (pet_id, sitter_id, media_id)
    values (coco, null, _t_get('media_coco'));
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', '5.8: owner cannot post for another owner''s pet');
  delete from public.feed_posts where media_id = _t_get('media_bori');
  get diagnostics n = row_count;
  perform _t_ok(n = 0, '5.8: owner cannot delete the sitter''s post');

  perform _t_as(chloe);
  select count(*) into n from public.feed_posts where media_id = _t_get('m_opriv');
  perform _t_ok(n = 0, '5.8: sitter cannot see the owner''s private post');
  select count(*) into n from public.media where id = _t_get('m_opriv');
  perform _t_ok(n = 0, '5.8: sitter cannot read the owner''s private media row');
  select count(*) into n from public.feed_posts where media_id = _t_get('m_oshared');
  perform _t_ok(n = 1, '5.8: sitter on duty sees the owner''s shared post');
  delete from public.feed_posts where media_id = _t_get('m_oshared');
  get diagnostics n = row_count;
  perform _t_ok(n = 0, '5.8: sitter cannot delete the owner''s post');
  delete from public.feed_posts where media_id = _t_get('m_priv');
  get diagnostics n = row_count;
  perform _t_ok(n = 1, '5.8: author deletes her own post');

  -- Phase 06 (6.2): ensure_today_task_logs
  perform _t_as(robert);
  begin
    perform ensure_today_task_logs(max);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'not_on_duty', '6.2: the owner cannot create task logs');
  perform _t_as(paul);
  begin
    perform ensure_today_task_logs(max);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'not_on_duty', '6.2: a sitter who is not on duty cannot create task logs');

  -- (seeded as the system: the owner can no longer add tasks to a pet whose stay is on — see 6.23)
  perform _t_as(null);
  insert into public.care_tasks (pet_id, type, title, scheduled_time, active)
  values (max, 'play', 'Paused play', '17:00', false);
  insert into public.care_tasks (pet_id, type, title, scheduled_time, repeat_daily)
  values (max, 'medication', 'One-off pill', '12:00', false)
  returning id into v_id;
  perform _t_put('task_once', v_id);

  perform _t_as(chloe);
  select count(*) into n from ensure_today_task_logs(max);
  perform _t_ok(n = 2, '6.2: logs for the active tasks only (Breakfast + one-off pill, not the paused one)');
  select count(*) into n from ensure_today_task_logs(max);
  perform _t_ok(n = 2, '6.2: calling again is idempotent');
  perform _t_ok(
    (select due_at from public.task_logs where task_id = _t_get('task_bori'))
      = local_ts(app_today(), '08:00'),
    '6.2: due_at is today at the task time in the app timezone');
  perform _t_ok(
    (select count(*) from public.task_logs where task_id = _t_get('task_once')) = 1,
    '6.2: a non-repeating task gets one log');
  perform _t_ok(
    (select count(*) from ensure_today_task_logs('00000000-0000-4000-8000-0000000000c2')) = 1,
    '6.2: each pet gets its own logs (Mochi: litter box)');

  perform _t_as(robert);
  select count(*) into n from public.task_logs where pet_id = max;
  perform _t_ok(n = 2, '6.2: the owner reads the logs through RLS');
  -- A pet nobody has booked: only its owner reads its logs (later scenarios hand Max to
  -- different sitters, so Max is not a stable "no access" pet).
  perform _t_as(null);
  insert into public.pets (owner_id, species, name) values (robert, 'dog', 'Solo') returning id into v_id;
  insert into public.care_tasks (pet_id, type, title, scheduled_time) values (v_id, 'feeding', 'Dinner', '18:00');
  insert into public.task_logs (task_id, pet_id, due_at)
  select id, v_id, local_ts(app_today(), '18:00') from public.care_tasks where pet_id = v_id;
  perform _t_as(chloe);
  select count(*) into n from public.task_logs where pet_id = v_id;
  perform _t_ok(n = 0, '6.2: a sitter with no booking for the pet cannot read the logs');
  perform _t_as(robert);
  select count(*) into n from public.task_logs where pet_id = v_id;
  perform _t_ok(n = 1, '6.2: the owner sees the logs of her unbooked pet');

  -- Phase 06 (6.4): complete_task_log
  perform _t_as(null);
  insert into public.media (pet_id, uploaded_by, cloudinary_public_id, resource_type, purpose)
  values (max, chloe, 'smoke/proof-pill', 'image', 'task_proof');
  perform _t_put('m_proof', (select id from public.media where cloudinary_public_id = 'smoke/proof-pill'));
  perform _t_put('log_bf', (select id from public.task_logs where task_id = _t_get('task_bori')));
  perform _t_put('log_pill', (select id from public.task_logs where task_id = _t_get('task_once')));

  perform _t_as(robert);
  begin
    perform complete_task_log(_t_get('log_bf'));
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'not_in_care_window', '6.4: the owner cannot complete a task');
  perform _t_as(paul);
  begin
    perform complete_task_log(_t_get('log_bf'));
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'not_in_care_window', '6.4: a sitter outside the care window cannot complete it');

  perform _t_as(chloe);
  begin
    perform complete_task_log(_t_get('log_bf'), _t_get('media_bori'));
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'invalid_media', '6.4: media must be a task_proof upload');
  perform _t_ok((select status from public.task_logs where id = _t_get('log_bf')) = 'pending',
    '6.4: a rejected completion leaves the log pending');

  perform complete_task_log(_t_get('log_bf'));
  perform _t_ok(
    (select status = 'done' and completed_by = chloe and completed_at is not null and media_id is null
     from public.task_logs where id = _t_get('log_bf')),
    '6.4: Mark done without a photo');
  begin
    perform complete_task_log(_t_get('log_bf'));
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'already_done', '6.4: completing twice is refused');

  perform _t_as(null);
  perform _t_ok(
    (select count(*) from public.notifications
     where user_id = robert and type = 'task_done' and ref_id = _t_get('log_bf')
       and title like 'Max had breakfast%') = 1,
    '6.4: the owner gets a task_done notice');
  perform _t_ok(not exists (select 1 from public.feed_posts where task_log_id = _t_get('log_bf')),
    '6.4: no photo → no feed post');

  perform _t_as(chloe);
  perform complete_task_log(_t_get('log_pill'), _t_get('m_proof'));
  perform _t_as(null);
  perform _t_ok(
    (select count(*) from public.feed_posts
     where task_log_id = _t_get('log_pill') and caption_source = 'task' and visibility = 'shared'
       and media_id = _t_get('m_proof') and posted_by = chloe) = 1,
    '6.4: with a photo → a shared feed post with a task caption');
  perform _t_ok(
    (select count(*) from public.notifications where user_id = robert and ref_id = _t_get('log_pill')
       and type = 'task_done') = 1
    and not exists (select 1 from public.notifications n join public.feed_posts fp on fp.id = n.ref_id
       where n.type = 'feed_post' and fp.task_log_id = _t_get('log_pill')),
    '6.4: task_done only — no extra feed_post notice for a task photo');
  perform _t_as(robert);
  perform _t_ok(
    (select count(*) from public.feed_posts where task_log_id = _t_get('log_pill')) = 1,
    '6.4: the owner sees the task photo in the feed');

  -- Phase 06 (6.8): care_checkins
  perform _t_as(null);
  insert into public.pets (owner_id, species, name) values (robert, 'dog', 'Solo2') returning id into v_id;
  insert into public.care_checkins (pet_id, kind, value) values (v_id, 'meal', 'all');
  insert into public.care_checkins (pet_id, kind, value) values (v_id, 'walk', '30');
  insert into public.care_checkins (pet_id, kind, note_text) values (v_id, 'note', 'Watched a squirrel for ten minutes');
  insert into public.care_checkins (pet_id, kind, value) values (max, 'mood', 'happy');
  perform _t_ok(true, '6.8: valid check-ins of every shape insert');

  begin
    insert into public.care_checkins (pet_id, kind, value) values (v_id, 'meal', 'a lot');
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '23514', '6.8: value must fit the kind');
  begin
    insert into public.care_checkins (pet_id, kind, value) values (v_id, 'walk', '15');
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '23514', '6.8: walk minutes are 10 / 20 / 30 / 45 / 60');
  begin
    insert into public.care_checkins (pet_id, kind) values (v_id, 'note');
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '23514', '6.8: a note needs its line');
  insert into public.care_checkins (pet_id, kind, value, note_text) values (v_id, 'mood', 'calm', 'Hid under the bed');
  perform _t_ok(true, '6.8: any check-in may carry a short memo');
  begin
    insert into public.care_checkins (pet_id, kind, value, note_text) values (v_id, 'mood', 'calm', '   ');
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '23514', '6.8: a memo is never an empty string');
  begin
    insert into public.care_checkins (pet_id, kind, value, note_text) values (v_id, 'meal', 'all', repeat('x', 121));
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '23514', '6.8: a memo is at most 120 characters on any kind');
  begin
    insert into public.care_checkins (pet_id, kind, note_text) values (v_id, 'note', repeat('x', 121));
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '23514', '6.8: a note is at most 120 characters');
  begin
    insert into public.care_checkins (pet_id, kind, value)
    values ('00000000-0000-4000-8000-0000000000c2', 'walk', '20');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'checkin_not_allowed_for_species', '6.8: no walk check-in for a cat (D23)');

  -- RLS: read only, owner and the sitter in the window.
  perform _t_as(chloe);
  begin
    insert into public.care_checkins (pet_id, created_by, kind, value) values (max, chloe, 'mood', 'calm');
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', '6.8: clients cannot insert directly (log_care_checkin writes)');
  perform _t_ok((select count(*) from public.care_checkins where pet_id = v_id) = 0,
    '6.8: a sitter with no booking for the pet reads nothing');
  perform _t_ok((select count(*) from public.care_checkins where pet_id = max and kind = 'mood') >= 1,
    '6.8: the sitter in the care window reads the pet''s check-ins');
  perform _t_as(robert);
  perform _t_ok((select count(*) from public.care_checkins where pet_id = v_id) = 4,
    '6.8: the owner reads her pet''s check-ins');
  begin
    update public.care_checkins set value = 'none' where pet_id = v_id and kind = 'meal';
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', '6.8: nobody edits a check-in from the client');
  begin
    delete from public.care_checkins where pet_id = v_id;
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', '6.8: nobody deletes one from the client');
  perform _t_as(null, 'anon');
  begin
    perform count(*) from public.care_checkins;
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', '6.8: anon cannot read check-ins');

  -- Phase 06 (6.9): log_care_checkin
  perform _t_as(null);
  insert into public.media (pet_id, uploaded_by, cloudinary_public_id, resource_type, purpose)
  values (max, chloe, 'smoke/proof-checkin', 'image', 'task_proof');
  perform _t_put('m_checkin', (select id from public.media where cloudinary_public_id = 'smoke/proof-checkin'));

  perform _t_as(robert);
  begin
    perform log_care_checkin(max, 'meal', 'all');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'not_in_care_window', '6.9: the owner cannot log a check-in');
  perform _t_as('00000000-0000-4000-8000-0000000000b3');
  begin
    perform log_care_checkin(max, 'meal', 'all');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'not_in_care_window', '6.9: a sitter outside the care window cannot');

  perform _t_as(chloe);
  perform log_care_checkin(max, 'meal', 'all');
  perform _t_ok(
    (select count(*) from public.care_checkins where pet_id = max and kind = 'meal' and value = 'all'
       and created_by = chloe and note_text is null and media_id is null) = 1,
    '6.9: one tap, no memo');
  perform log_care_checkin(max, 'mood', 'tired', '   ');
  perform _t_ok(
    (select note_text from public.care_checkins where pet_id = max and kind = 'mood' and value = 'tired') is null,
    '6.9: a blank memo is dropped');
  perform log_care_checkin(max, 'meal', 'little', ' Left the chicken bits, sniffed and walked off ');
  perform _t_ok(
    (select note_text from public.care_checkins where pet_id = max and value = 'little')
      = 'Left the chicken bits, sniffed and walked off',
    '6.9: something special → a trimmed memo on the check-in');
  perform log_care_checkin(max, 'note', null, 'Watched a squirrel for ten minutes');
  begin
    perform log_care_checkin(max, 'note', null, '  ');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'note_required', '6.9: a note check-in needs its line');
  begin
    perform log_care_checkin(max, 'meal', 'plenty');
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '23514', '6.9: a value that does not fit the kind is refused');
  begin
    perform log_care_checkin('00000000-0000-4000-8000-0000000000c2', 'walk', '20');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'checkin_not_allowed_for_species', '6.9: no walk check-in for a cat');
  begin
    perform log_care_checkin(max, 'meal', 'all', null, _t_get('media_bori'));
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'invalid_media', '6.9: the photo must be a task_proof upload');

  perform _t_as(null);
  perform _t_ok(
    (select count(*) from public.notifications n join public.care_checkins c on c.id = n.ref_id
     where n.user_id = robert and n.type = 'care_checkin' and c.kind = 'meal' and c.value = 'all'
       and n.title like 'Max ate everything%' and n.body is null) >= 1,
    '6.9: no memo typed → the preset line, "Max ate everything 🍽️"');
  perform _t_ok(
    (select count(*) from public.notifications n join public.care_checkins c on c.id = n.ref_id
     where n.user_id = robert and n.type = 'care_checkin' and c.value = 'little'
       and n.title like 'Max ate a little%' and n.body = 'Left the chicken bits, sniffed and walked off') = 1,
    '6.9: a typed memo rides along as the body of the preset title');
  perform _t_ok(not exists (select 1 from public.feed_posts fp
      join public.care_checkins c on c.pet_id = fp.pet_id and c.media_id = fp.media_id),
    '6.9: no photo → no feed post');

  perform _t_as(chloe);
  perform log_care_checkin(max, 'meal', 'most', null, _t_get('m_checkin'));
  perform _t_as(null);
  perform _t_ok(
    (select count(*) from public.feed_posts
     where media_id = _t_get('m_checkin') and caption_source = 'task' and visibility = 'shared'
       and posted_by = chloe and task_log_id is null) = 1,
    '6.9: with a photo → a shared feed post');
  perform _t_ok(
    (select count(*) from public.notifications n join public.feed_posts fp on fp.id = n.ref_id
     where n.type = 'feed_post' and fp.media_id = _t_get('m_checkin')) = 0
    and (select count(*) from public.notifications n join public.care_checkins c on c.id = n.ref_id
     where n.type = 'care_checkin' and c.media_id = _t_get('m_checkin')) = 1,
    '6.9: a check-in photo sends the care_checkin notice only');
  perform _t_as(robert);
  perform _t_ok((select count(*) from public.feed_posts where media_id = _t_get('m_checkin')) = 1,
    '6.9: the owner sees the check-in photo in the feed');

  -- Phase 06 follow-ups: task memo, editing a task, deleting notifications
  perform _t_as(null);
  insert into public.care_tasks (pet_id, type, title, scheduled_time)
  values (max, 'play', 'Evening play', '21:00') returning id into v_id;
  perform _t_put('task_play', v_id);
  perform _t_as(chloe);
  perform ensure_today_task_logs(max);
  perform _t_ok((select count(*) from public.task_logs where task_id = _t_get('task_play')) = 1,
    '6.x: the new task gets today''s log');

  perform _t_as(robert);
  update public.care_tasks set scheduled_time = '22:00' where id = _t_get('task_play');
  perform _t_ok((select count(*) from public.task_logs where task_id = _t_get('task_play')) = 0,
    '6.x: changing a task''s time drops today''s unfinished log');
  perform _t_as(chloe);
  perform ensure_today_task_logs(max);
  perform _t_ok(
    (select count(*) from public.task_logs
     where task_id = _t_get('task_play') and due_at = local_ts(app_today(), '22:00')) = 1,
    '6.x: …and today gets one log at the new time');

  perform _t_as(robert);
  update public.care_tasks set active = false where id = _t_get('task_play');
  perform _t_ok((select count(*) from public.task_logs where task_id = _t_get('task_play')) = 0,
    '6.x: pausing a task drops today''s unfinished log');
  update public.care_tasks set active = true where id = _t_get('task_play');

  perform _t_as(chloe);
  perform ensure_today_task_logs(max);
  perform complete_task_log(
    (select id from public.task_logs where task_id = _t_get('task_play')), null, '  Chased the ball twice, then napped  ');
  perform _t_as(null);
  perform _t_ok(
    (select note_text from public.task_logs where task_id = _t_get('task_play')) = 'Chased the ball twice, then napped',
    '6.x: Mark done with a memo stores it (trimmed)');
  perform _t_ok(
    (select count(*) from public.notifications n join public.task_logs l on l.id = n.ref_id
     where n.user_id = robert and n.type = 'task_done' and l.task_id = _t_get('task_play')
       and n.title like 'Max had playtime%' and n.body = 'Chased the ball twice, then napped') = 1,
    '6.x: with a memo the owner gets what was done (title) plus the memo (body)');

  perform _t_as(robert);
  update public.care_tasks set scheduled_time = '23:00' where id = _t_get('task_play');
  perform _t_as(chloe);
  perform ensure_today_task_logs(max);
  perform _t_ok((select count(*) from public.task_logs where task_id = _t_get('task_play')) = 1,
    '6.x: a task finished today gets no second log when its time is edited (history stays)');
  begin
    perform complete_task_log(
      (select id from public.task_logs where task_id = _t_get('task_play')), null, repeat('x', 121));
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err is not null, '6.x: a memo over 120 characters is refused');

  -- Notifications can be deleted — by their owner only
  perform _t_as(robert);
  delete from public.notifications where id = (select id from public.notifications where user_id = robert limit 1);
  get diagnostics n = row_count;
  perform _t_ok(n = 1, '6.x: a user deletes their own notification');
  perform _t_as(chloe);
  delete from public.notifications where user_id = robert;
  get diagnostics n = row_count;
  perform _t_ok(n = 0, '6.x: nobody deletes someone else''s notifications');
  perform _t_as(robert);
  delete from public.notifications;
  perform _t_ok((select count(*) from public.notifications) = 0, '6.x: Clear all empties one''s own list');
  perform _t_as(chloe);
  perform _t_ok((select count(*) from public.notifications) > 0, '6.x: …and leaves other people''s alone');

  -- Phase 06 (6.13): care requests, tasks and Heads-ups saved in one go — on pets with no stay on
  -- (009b: while a stay is on the owner sends a change request instead, see 6.20).
  perform _t_as(robert);
  begin
    perform save_care_request(max, 'x', null, '[]'::jsonb, array['Be careful']);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'stay_in_progress', 'BF.4: no saved checklist for a pet whose stay is on');
  perform _t_as(null);
  insert into public.pets (id, owner_id, species, name) values
    ('00000000-0000-4000-8000-0000000000d1', robert, 'dog', 'Biscuit'),
    ('00000000-0000-4000-8000-0000000000d2', robert, 'cat', 'Pickle');
  perform _t_as(robert);
  v_id := save_care_request(
    '00000000-0000-4000-8000-0000000000d1',
    'Meals: 8:00 AM — 1 cup of kibble. Heads-up: text instead of knocking.',
    'nvidia/test-model',
    '[{"type":"feeding","time":"08:00","title":"Breakfast","dose":"1 cup of kibble","notes":null},
      {"type":"medication","time":"14:00","title":"Skin pill","dose":"1 skin pill with a treat"}]'::jsonb,
    array['Text instead of knocking', 'Keep other dogs away on walks']);
  perform _t_put('req_saved', v_id);
  perform _t_ok((select count(*) from public.care_tasks where request_id = v_id) = 2,
    '6.13: the checklist rows are saved with the request');
  perform _t_ok((select count(*) from public.pet_cautions where request_id = v_id and active) = 2,
    '6.13: the Heads-ups are saved with the request');
  perform _t_ok((select scheduled_time from public.care_tasks where request_id = v_id and type = 'medication') = '14:00',
    '6.13: times arrive as clock times');
  perform _t_ok((select count(*) from public.care_requests where id = v_id and model = 'nvidia/test-model') = 1,
    '6.13: the note is kept as written');

  begin
    perform save_care_request(
      '00000000-0000-4000-8000-0000000000d2', 'walk', null,
      '[{"type":"feeding","time":"07:00","title":"Breakfast"},{"type":"walk","time":"17:00","title":"Walk"}]'::jsonb,
      array['Close the door gently']);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'task_type_not_allowed_for_species', '6.13: a walk for a cat is refused…');
  perform _t_ok(
    (select count(*) from public.care_requests where pet_id = '00000000-0000-4000-8000-0000000000d2') = 0
    and (select count(*) from public.pet_cautions where pet_id = '00000000-0000-4000-8000-0000000000d2') = 0
    and (select count(*) from public.care_tasks where pet_id = '00000000-0000-4000-8000-0000000000d2'
         and title in ('Breakfast', 'Walk') and created_at > now() - interval '1 minute') = 0,
    '6.13: …and the whole save is rolled back (no request, no cautions, no half a checklist)');

  begin
    perform save_care_request('00000000-0000-4000-8000-0000000000d1', 'x', null, '[]'::jsonb,
      (select array_agg('c' || g) from generate_series(1, 9) g));
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'too_many_items', '6.13: more than 8 Heads-ups is refused');

  perform _t_as(chloe);
  begin
    perform save_care_request(max, 'x', null, '[]'::jsonb, array['Be careful']);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'forbidden', '6.13: a sitter cannot write a care request');
  perform _t_ok((select count(*) from public.pet_cautions where request_id = _t_get('req_saved')) = 0,
    '6.13: a sitter with no booking of the pet does not see its Heads-ups');
  perform _t_ok((select count(*) from public.care_requests) = 0,
    '6.13: …but not the owner''s note as written');
  begin
    insert into public.pet_cautions (pet_id, text) values (max, 'Sitter wrote this');
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', '6.13: a sitter cannot add a Heads-up');
  update public.pet_cautions set active = false where request_id = _t_get('req_saved');
  perform _t_ok((select count(*) from public.pet_cautions where request_id = _t_get('req_saved') and not active) = 0,
    '6.13: …or switch one off');

  perform _t_as(robert);
  update public.pet_cautions set active = false
  where request_id = _t_get('req_saved') and text = 'Keep other dogs away on walks';
  perform _t_ok((select count(*) from public.pet_cautions where request_id = _t_get('req_saved') and active) = 1,
    '6.13: the owner switches a Heads-up off');
  delete from public.pet_cautions where request_id = _t_get('req_saved') and not active;
  perform _t_ok((select count(*) from public.pet_cautions where request_id = _t_get('req_saved')) = 1,
    '6.13: …and deletes it');
  delete from public.care_requests where id = _t_get('req_saved');
  perform _t_ok((select count(*) from public.care_tasks where request_id is null and title = 'Skin pill') = 1,
    '6.13: deleting the note keeps the tasks it created (request_id → null)');

  -- Phase 06 (6.20): while a stay is on, the owner SENDS a care request and the sitter answers it
  perform _t_as(robert);
  v_id := send_care_change_request(
    max,
    '[{"type":"feeding","time":"19:00","title":"Late snack","dose":"a few treats","notes":null,"repeat":false}]'::jsonb,
    array['Never feed grapes']
  );
  perform _t_put('ccr', v_id);
  perform _t_ok((select count(*) from public.care_change_requests where id = v_id and status = 'pending') = 1,
    '6.20: the owner sends a care request (pending)');
  begin
    perform send_care_change_request(max, '[]'::jsonb, array['One more']);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'request_pending', '6.20: only one open request per pet');
  -- The request goes to the sitter of the stay that is on (the fixtures hold several bookings of Max).
  perform _t_as(null);
  perform _t_put('ccr_sitter', (select sitter_id from public.care_change_requests where id = _t_get('ccr')));
  perform _t_as(_t_get('ccr_sitter'));
  perform _t_ok((select count(*) from public.notifications where user_id = _t_get('ccr_sitter') and type = 'care_request' and ref_id = _t_get('ccr')) = 1,
    '6.20: the sitter is told about the request');
  perform _t_ok((select count(*) from public.care_change_requests where id = _t_get('ccr')) = 1,
    '6.20: the sitter sees the request');
  begin
    perform send_care_change_request(max, '[]'::jsonb, array['Sitter wrote this']);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'forbidden', '6.20: a sitter cannot send a care request');
  perform _t_as(robert);
  begin
    perform respond_care_change_request(_t_get('ccr'), true, null);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'forbidden', '6.20: the owner cannot approve their own request');
  perform _t_as(_t_get('ccr_sitter'));
  perform respond_care_change_request(_t_get('ccr'), true, null);
  perform _t_ok(exists (select 1 from public.care_tasks where pet_id = max and title = 'Late snack' and not repeat_daily and scheduled_time = '19:00'),
    '6.20: approving creates the task (one-time here)');
  perform _t_ok(exists (select 1 from public.pet_cautions where pet_id = max and text = 'Never feed grapes'),
    '6.20: …and the Heads-up');
  begin
    perform respond_care_change_request(_t_get('ccr'), false, 'late');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'already_answered', '6.20: a request is answered once');
  perform _t_as(robert);
  perform _t_ok((select count(*) from public.notifications where user_id = robert and type = 'care_request_approved' and ref_id = _t_get('ccr')) = 1,
    '6.20: the owner is told it was approved');

  v_id := send_care_change_request(max, '[{"type":"walk","time":"22:00","title":"Night walk","dose":null,"notes":null}]'::jsonb, '{}');
  perform _t_put('ccr2', v_id);
  perform _t_as(_t_get('ccr_sitter'));
  perform respond_care_change_request(_t_get('ccr2'), false, 'I''m out by then');
  perform _t_ok(not exists (select 1 from public.care_tasks where pet_id = max and title = 'Night walk'),
    '6.20: declining creates nothing');
  perform _t_as(robert);
  perform _t_ok((select count(*) from public.notifications where user_id = robert and type = 'care_request_declined'
      and ref_id = _t_get('ccr2') and body = 'I''m out by then') = 1,
    '6.20: the owner gets the sitter''s reason');
  begin
    perform send_care_change_request(max, '[]'::jsonb, '{}');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'empty_request', '6.20: an empty request is refused');
  begin
    insert into public.care_change_requests (pet_id, booking_id, requested_by, sitter_id)
    select max, booking_id, robert, chloe from public.care_change_requests limit 1;
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', '6.20: requests are written only through the functions');

  -- Phase 06 (6.23): no direct additions while a stay is on
  perform _t_as(robert);
  begin
    insert into public.care_tasks (pet_id, type, title, scheduled_time) values (max, 'play', 'Sneaky task', '10:00');
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', '6.23: the owner cannot add a task to a pet whose stay is on');
  begin
    insert into public.pet_cautions (pet_id, text, created_by) values (max, 'Sneaky heads-up', robert);
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', '6.23: …or a Heads-up');
  update public.care_tasks set title = 'Late snack (edited)' where pet_id = max and title = 'Late snack';
  perform _t_ok(exists (select 1 from public.care_tasks where title = 'Late snack (edited)'),
    '6.23: …but can still edit what is already there');
  delete from public.care_tasks where title = 'Late snack (edited)';
  perform _t_ok(not exists (select 1 from public.care_tasks where title = 'Late snack (edited)'),
    '6.23: …and remove it');
  perform _t_as(null);
  insert into public.pets (owner_id, species, name) values (robert, 'dog', 'Homebody') returning id into v_id;
  perform _t_as(robert);
  insert into public.care_tasks (pet_id, type, title, scheduled_time) values (v_id, 'feeding', 'Breakfast', '08:00');
  insert into public.pet_cautions (pet_id, text, created_by) values (v_id, 'Shy with strangers', robert);
  perform _t_ok(true, '6.23: a pet with no stay on is edited directly as before');

  -- Phase 07 (7.5): the sitter sends the daily report; the owner only ever sees the sent text
  perform _t_as(null);
  insert into public.daily_reports (pet_id, sitter_id, report_date, body, status, model)
  values (max, _t_get('ccr_sitter'), '2026-10-15', 'AI DRAFT: Max had a day.', 'draft', 'test-model')
  returning id into v_id;
  perform _t_put('report', v_id);
  perform _t_as(robert);
  perform _t_ok((select count(*) from public.daily_reports where id = _t_get('report')) = 0,
    '7.5: the owner does not see the draft');
  begin
    perform send_daily_report(_t_get('report'), 'I am the owner');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'forbidden', '7.5: the owner cannot send it');
  perform _t_as(_t_get('ccr_sitter'));
  perform _t_ok((select count(*) from public.daily_reports where id = _t_get('report')) = 1,
    '7.5: the sitter sees their own draft');
  perform _t_as(chloe);
  begin
    perform send_daily_report(_t_get('report'), 'Not mine');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'forbidden', '7.5: another sitter cannot send it');
  perform _t_as(_t_get('ccr_sitter'));
  begin
    perform send_daily_report(_t_get('report'), '   ');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'body_required', '7.5: an empty report cannot be sent');
  begin
    perform send_daily_report(_t_get('report'), repeat('x', 2001));
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'body_too_long', '7.5: …or one over 2000 characters');
  perform send_daily_report(_t_get('report'), '  Max had a lovely day — my own words.  ');
  perform _t_ok((select status = 'sent' and body = 'Max had a lovely day — my own words.' and sent_at is not null
      from public.daily_reports where id = _t_get('report')),
    '7.5: sending publishes the sitter''s edited text (trimmed), not the AI draft');
  perform _t_as(robert);
  perform _t_ok((select body from public.daily_reports where id = _t_get('report')) = 'Max had a lovely day — my own words.',
    '7.5: the owner now sees the sent report');
  perform _t_ok((select count(*) from public.notifications where user_id = robert and type = 'report_sent'
      and ref_id = _t_get('report') and pet_id = max and body like 'Max had a lovely day%') = 1,
    '7.5: the owner is told, with the start of the text');
  perform _t_as(_t_get('ccr_sitter'));
  begin
    perform send_daily_report(_t_get('report'), 'Again');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'report_already_sent', '7.5: a report is sent once');
  update public.daily_reports set body = 'Rewritten after sending' where id = _t_get('report');
  perform _t_as(null);
  perform _t_ok((select body from public.daily_reports where id = _t_get('report')) = 'Max had a lovely day — my own words.',
    '7.5: a sent report cannot be edited directly');

  -- 011f (FB-22): after one is sent, another report can be written the same day — but only one draft at a time
  perform _t_as(null);
  insert into public.daily_reports (pet_id, sitter_id, report_date, body, status, model)
  values (max, _t_get('ccr_sitter'), '2026-10-15', 'AI DRAFT: the evening went well.', 'draft', 'test-model')
  returning id into v_id;
  perform _t_ok(v_id is not null, '011f: a second report the same day can be drafted once the first is sent');
  begin
    insert into public.daily_reports (pet_id, sitter_id, report_date, body, status, model)
    values (max, _t_get('ccr_sitter'), '2026-10-15', 'AI DRAFT: a third one', 'draft', 'test-model');
    v_err := null;
  exception when unique_violation then v_err := 'unique_violation';
  end;
  perform _t_ok(v_err = 'unique_violation', '011f: …but there is only ever one draft per pet, sitter and day');
  perform _t_as(_t_get('ccr_sitter'));
  perform send_daily_report(v_id, 'Evening update: Max is asleep.');
  perform _t_as(robert);
  perform _t_ok((select count(*) from public.daily_reports where pet_id = max and report_date = '2026-10-15' and status = 'sent') = 2,
    '011f: the owner sees both reports of the day');

  -- Phase 06 (6.21): a decline can carry a note; the sitter can send a counter-request instead
  perform _t_as(robert);
  v_id := send_care_change_request(
    max,
    '[{"type":"feeding","time":"06:00","title":"Early meal","dose":null,"notes":null},{"type":"walk","time":"23:00","title":"Late walk","dose":null,"notes":null}]'::jsonb,
    array['Keep the porch light on']
  );
  perform _t_put('ccr3', v_id);
  perform _t_as(_t_get('ccr_sitter'));
  begin
    perform counter_care_change_request(_t_get('ccr3'), '   ', 500, '{}');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'note_required', '6.21: a counter-request needs a note');
  begin
    perform counter_care_change_request(_t_get('ccr3'), 'x', 500, array[5]);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'invalid_tasks', '6.21: …and the tasks must be on the request');
  perform counter_care_change_request(_t_get('ccr3'), 'I can do the early meal for $5; please do the late walk yourself.', 500, array[1]);
  perform _t_ok((select status from public.care_change_requests where id = _t_get('ccr3')) = 'countered'
      and not exists (select 1 from public.care_tasks where pet_id = max and title in ('Early meal', 'Late walk')),
    '6.21: a counter-request creates nothing yet');
  perform _t_as(robert);
  perform _t_ok((select count(*) from public.notifications where user_id = robert and type = 'care_request_countered'
      and ref_id = _t_get('ccr3') and body like '%$5.00%') = 1,
    '6.21: the owner is told, with the fee');
  begin
    perform send_care_change_request(max, '[]'::jsonb, array['Another']);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'request_pending', '6.21: a counter-request keeps the request open');
  perform _t_as(_t_get('ccr_sitter'));
  begin
    perform answer_care_counter(_t_get('ccr3'), true);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'forbidden', '6.21: only the owner answers a counter-request');
  perform _t_as(robert);
  perform answer_care_counter(_t_get('ccr3'), true);
  perform _t_ok(exists (select 1 from public.care_tasks where pet_id = max and title = 'Early meal')
      and not exists (select 1 from public.care_tasks where pet_id = max and title = 'Late walk')
      and exists (select 1 from public.pet_cautions where pet_id = max and text = 'Keep the porch light on'),
    '6.21: accepting creates what the sitter agreed to (not the tasks the owner will do)');
  perform _t_as(_t_get('ccr_sitter'));
  perform _t_ok((select count(*) from public.notifications where user_id = _t_get('ccr_sitter') and type = 'care_counter_accepted'
      and ref_id = _t_get('ccr3')) = 1, '6.21: the sitter is told it was accepted');

  perform _t_as(robert);
  v_id := send_care_change_request(max, '[{"type":"play","time":"15:00","title":"Tug game","dose":null,"notes":null}]'::jsonb, '{}');
  perform _t_put('ccr4', v_id);
  perform _t_as(_t_get('ccr_sitter'));
  perform counter_care_change_request(_t_get('ccr4'), 'Extra time for this one.', 300, '{}');
  perform _t_as(robert);
  perform answer_care_counter(_t_get('ccr4'), false);
  perform _t_ok((select status from public.care_change_requests where id = _t_get('ccr4')) = 'withdrawn'
      and not exists (select 1 from public.care_tasks where pet_id = max and title = 'Tug game'),
    '6.21: declining the counter-request closes it and creates nothing');

  perform _t_as(robert);
  v_id := send_care_change_request(max, '[{"type":"play","time":"16:00","title":"Ball","dose":null,"notes":null}]'::jsonb, '{}');
  perform _t_as(_t_get('ccr_sitter'));
  perform respond_care_change_request(v_id, false, 'Needs a different time', 'Could we do 5 PM instead?');
  perform _t_as(robert);
  perform _t_ok((select count(*) from public.notifications where user_id = robert and type = 'care_request_declined'
      and body = 'Needs a different time — Could we do 5 PM instead?') = 1,
    '6.21: a decline carries the reason and the note');

  perform _t_as(null);
end;
$$;

-- ---------------------------------------------------------------------------
-- Review fixes (009b+, 2026-10-06)
-- ---------------------------------------------------------------------------

do $$
declare
  robert constant uuid := '00000000-0000-4000-8000-0000000000a1';
  chloe constant uuid := '00000000-0000-4000-8000-0000000000b1';
  paul constant uuid := '00000000-0000-4000-8000-0000000000b2';
  pepper uuid;
  v_b1 uuid;
  v_b2 uuid;
  v_req uuid;
  v_err text;
  nori uuid;
  sesame uuid;
  v_b3 uuid;
  v_b4 uuid;
  v_b5 uuid;
  v_b6 uuid;
  v_prop uuid;
begin
  -- BF.4 (009b): an open care request ends with its stay
  perform _t_as(null);
  insert into public.pets (owner_id, species, name) values (robert, 'dog', 'Pepper') returning id into pepper;
  v_b1 := _t_booking(robert, chloe, array[pepper], now() + interval '100 days', now() + interval '102 days', 'confirmed');
  perform _t_as(robert);
  v_req := send_care_change_request(pepper,
    '[{"type":"play","time":"10:00","title":"Fetch","dose":null,"notes":null}]'::jsonb, '{}');
  perform cancel_booking(v_b1, 'Plans changed');
  perform _t_ok((select status from public.care_change_requests where id = v_req) = 'closed',
    'BF.4: cancelling the booking closes its open care request');
  perform _t_as(chloe);
  begin
    perform respond_care_change_request(v_req, true, null);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'already_answered', 'BF.4: …so the old sitter can no longer approve it');
  perform _t_as(null);
  perform _t_ok(not exists (select 1 from public.care_tasks where pet_id = pepper and title = 'Fetch'),
    'BF.4: …and nothing was added');

  v_b2 := _t_booking(robert, paul, array[pepper], now() + interval '110 days', now() + interval '112 days', 'confirmed');
  perform _t_as(robert);
  v_req := send_care_change_request(pepper,
    '[{"type":"play","time":"11:00","title":"Tug","dose":null,"notes":null}]'::jsonb, '{}');
  perform _t_ok((select status from public.care_change_requests where id = v_req) = 'pending',
    'BF.4: the next stay''s request is not blocked by the closed one');
  perform _t_as(null);
  update public.booking_handoffs set completed_at = now() where booking_id = v_b2 and kind = 'drop_off';
  update public.booking_handoffs set completed_at = now() where booking_id = v_b2 and kind = 'pick_up';
  perform _t_ok((select status from public.care_change_requests where id = v_req) = 'closed',
    'BF.4: picking the pet up closes an unanswered request');

  -- BF.5 (009c): a checked handoff stays checked; passed times can't be agreed; house sitting stays home
  perform _t_as(null);
  insert into public.sitter_availability (sitter_id, kind, start_date, end_date, slot, starts_at, ends_at, max_pets)
  values (chloe, 'open', app_today() + 115, app_today() + 150, 'morning', '08:00', '12:00', 3),
         (chloe, 'open', app_today() + 115, app_today() + 150, 'afternoon', '12:00', '18:00', 3),
         (chloe, 'open', app_today() + 115, app_today() + 150, 'overnight', '18:00', '08:00', 3);
  insert into public.pets (owner_id, species, name) values (robert, 'dog', 'Nori') returning id into nori;
  v_b3 := _t_booking(robert, chloe, array[nori], now() + interval '120 days', now() + interval '122 days', 'confirmed', true);
  perform _t_as(robert);
  v_prop := propose_handoff(v_b3, 'pick_up', now() + interval '123 days');
  perform _t_as(chloe);
  perform complete_handoff(v_b3, 'pick_up');
  perform _t_ok((select status from public.booking_handoffs where id = v_prop) = 'superseded',
    'BF.5: Returned closes the open pick-up proposal');
  begin
    perform respond_handoff(v_prop, true);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'invalid_status', 'BF.5: …so it can no longer be accepted');
  perform _t_as(null);
  insert into public.booking_handoffs (booking_id, kind, scheduled_at, within_sitter_hours, status, proposed_by)
  values (v_b3, 'pick_up', now() + interval '124 days', true, 'proposed', robert)
  returning id into v_prop;
  perform _t_as(chloe);
  begin
    perform respond_handoff(v_prop, true);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'handoff_completed', 'BF.5: a checked handoff is never replaced');
  perform _t_as(null);
  perform _t_ok((select count(*) from public.booking_handoffs
      where booking_id = v_b3 and kind = 'pick_up' and status = 'agreed' and completed_at is not null) = 1,
    'BF.5: …the Returned pick-up is still the agreed one');

  insert into public.pets (owner_id, species, name) values (robert, 'dog', 'Sesame') returning id into sesame;
  v_b4 := _t_booking(robert, chloe, array[sesame], now() + interval '130 days', now() + interval '132 days', 'confirmed');
  v_b5 := _t_booking(robert, chloe, array[sesame], now() + interval '140 days', now() + interval '142 days', 'requested');
  update public.booking_handoffs set scheduled_at = now() - interval '1 minute'
  where booking_id = v_b5 and kind = 'drop_off'
  returning id into v_prop;
  perform _t_as(chloe);
  begin
    perform respond_handoff(v_prop, true);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'proposal_expired', 'BF.5: a proposed time that has passed cannot be accepted');

  perform _t_as(null);
  v_b6 := _t_booking(robert, chloe, array[sesame], now() + interval '145 days', now() + interval '147 days', 'requested');
  update public.booking_handoffs set status = 'agreed' where booking_id = v_b6;
  update public.booking_handoffs set scheduled_at = now() - interval '1 hour' where booking_id = v_b6 and kind = 'pick_up';
  begin
    update public.bookings set status = 'confirmed' where id = v_b6;
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'request_expired', 'BF.5: a request whose pick-up has passed cannot be confirmed');

  update public.bookings set service_type = 'house_sitting' where id = v_b4;
  update public.booking_handoffs set location_type = 'owner_home' where booking_id = v_b4;
  perform _t_as(robert);
  begin
    perform propose_handoff(v_b4, 'drop_off', now() + interval '130 days', 'sitter_home');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'invalid_location', 'BF.5: house sitting handoffs stay at the owner''s home');
  perform propose_handoff(v_b4, 'drop_off', now() + interval '130 days' + interval '1 hour');
  perform _t_ok(true, 'BF.5: …a new time at the same place is fine');
end;
$$;

do $$
declare
  robert constant uuid := '00000000-0000-4000-8000-0000000000a1';
  chloe constant uuid := '00000000-0000-4000-8000-0000000000b1';
  miso uuid;
  v_b uuid;
  v_req uuid;
  v_kind text;
  v_prop uuid;
  v_paid jsonb;
  v_quote jsonb;
  v_err text;
begin
  -- BF.6 (009d): consents are signed at checkout only, and a paid booking follows agreed changes
  perform _t_as(null);
  -- From here on only Miso's stay is a paid Robert ↔ Chloe booking (earlier fixtures reset).
  update public.bookings set paid_at = null, price_snapshot = null where owner_id = robert and sitter_id = chloe;
  insert into public.pets (owner_id, species, name) values (robert, 'dog', 'Miso') returning id into miso;
  v_req := _t_booking(robert, chloe, array[miso], now() + interval '160 days', now() + interval '162 days', 'requested');
  v_b := _t_booking(robert, chloe, array[miso], now() + interval '134 days', now() + interval '136 days', 'confirmed');
  perform _t_as(robert);
  begin
    insert into public.booking_consents (booking_id, kind, version, signer_id, signer_name)
    values (v_req, 'emergency_vet', '1', robert, 'Robert');
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', 'BF.6: nothing is signed before the sitter confirms');
  begin
    insert into public.booking_consents (booking_id, kind, version, signer_id, signer_name)
    values (v_b, 'home_access', '1', robert, 'Robert');
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', 'BF.6: only a kind the booking requires can be signed');
  perform _t_as(chloe);
  perform _t_ok((select count(*) from public.owner_profiles where id = robert) = 0,
    'BF.6: the sitter sees no owner profile before payment');
  perform _t_as(robert);

  foreach v_kind in array required_consents(v_b) loop
    insert into public.booking_consents (booking_id, kind, version, signer_id, signer_name)
    values (v_b, v_kind, '1', robert, 'Robert');
  end loop;
  v_paid := pay_booking_demo(v_b);

  -- Pick-up moves to the owner's home → home_access is now required
  v_prop := propose_handoff(v_b, 'pick_up', now() + interval '136 days', 'owner_home');
  perform _t_ok('home_access' = any (required_consents(v_b)), 'BF.6: an owner_home handoff requires home_access');
  begin
    insert into public.booking_consents (booking_id, kind, version, signer_id, signer_name)
    values (v_b, 'home_access', '1', robert, 'Robert');
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', 'BF.6: …but nothing is signed on a paid booking');
  perform _t_as(chloe);
  perform respond_handoff(v_prop, true);
  perform _t_as(null);
  perform _t_ok((select paid_at is null and price_snapshot->>'total' = v_paid->>'total'
      from public.bookings where id = v_b),
    'BF.6: agreeing to it reopens checkout (the paid quote is kept)');
  perform _t_ok(exists (select 1 from public.notifications
      where user_id = robert and type = 'checkout_needed' and booking_id = v_b),
    'BF.6: …and the owner is told to sign');
  perform _t_as(chloe);
  begin
    perform get_home_access(v_b);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'not_paid', 'BF.6: …so the entry codes stay locked until then');
  perform _t_ok((select count(*) from public.owner_profiles where id = robert) = 1,
    'BF.6: …while the owner''s emergency contact stays visible');
  perform _t_ok((select address from get_handoff_details(v_b) where kind = 'pick_up') = '1 Owner Ave',
    'BF.7: …and the sitter still sees where to bring the pet back');
  perform _t_as(robert);
  perform _t_ok((select count(*) from get_handoff_details(v_b)) = 2,
    'BF.7: …and the owner still sees both handoff places');

  insert into public.booking_consents (booking_id, kind, version, signer_id, signer_name)
  values (v_b, 'home_access', '1', robert, 'Robert');
  v_paid := pay_booking_demo(v_b);
  perform _t_ok((select paid_at is not null from public.bookings where id = v_b),
    'BF.6: signing home_access finishes checkout again');

  -- Longer stay → re-quoted, owner told the new total; checkout stays done
  v_prop := propose_handoff(v_b, 'pick_up', now() + interval '138 days');
  v_quote := quote_booking(chloe, 'boarding', now() + interval '134 days', now() + interval '138 days', 1);
  perform _t_as(chloe);
  perform respond_handoff(v_prop, true);
  perform _t_as(null);
  perform _t_ok((select paid_at is not null
        and (price_snapshot->>'total')::numeric = (v_quote->>'total')::numeric
        and (price_snapshot->>'total')::numeric > (v_paid->>'total')::numeric
      from public.bookings where id = v_b),
    'BF.6: a longer stay is re-quoted and stays paid');
  perform _t_ok(exists (select 1 from public.notifications
      where user_id = robert and type = 'price_updated' and booking_id = v_b),
    'BF.6: …and the owner gets the new total');
end;
$$;

-- ---------------------------------------------------------------------------
-- M (Phase 07B, 7B.1): inquiries, the thread, the knowledge base
-- ---------------------------------------------------------------------------

do $$
declare
  robert constant uuid := '00000000-0000-4000-8000-0000000000a1';
  joy constant uuid := '00000000-0000-4000-8000-0000000000a2';
  chloe constant uuid := '00000000-0000-4000-8000-0000000000b1';
  paul constant uuid := '00000000-0000-4000-8000-0000000000b2';
  max constant uuid := '00000000-0000-4000-8000-0000000000c1';
  coco constant uuid := '00000000-0000-4000-8000-0000000000c3';
  v_inq uuid;
  v_other uuid;
  v_msg uuid;
  v_draft uuid;
  v_err text;
begin
  -- Robert asks Chloe; she can ask only about her own pets and only a sitter
  perform _t_as(robert);
  insert into public.inquiries (owner_id, sitter_id, drop_off_at, pick_up_at, pet_ids)
  values (robert, chloe, now() + interval '200 days', now() + interval '203 days', array[max])
  returning id into v_inq;
  begin
    insert into public.inquiries (owner_id, sitter_id, drop_off_at, pick_up_at, pet_ids)
    values (robert, chloe, now() + interval '200 days', now() + interval '203 days', array[coco]);
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', 'M: an owner cannot ask about someone else''s pet');
  begin
    insert into public.inquiries (owner_id, sitter_id, drop_off_at, pick_up_at, pet_ids)
    values (robert, joy, now() + interval '200 days', now() + interval '203 days', array[max]);
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', 'M: …nor ask an owner');
  begin
    insert into public.inquiries (owner_id, sitter_id, drop_off_at, pick_up_at, pet_ids, status)
    values (robert, chloe, now() + interval '200 days', now() + interval '203 days', array[max], 'booked');
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', 'M: …and a new inquiry cannot start as booked');

  insert into public.inquiry_messages (inquiry_id, author, sender_id, body)
  values (v_inq, 'owner', robert, 'Can you give Max his pill at 2 PM?') returning id into v_msg;
  begin
    insert into public.inquiry_messages (inquiry_id, author, body, drafted_by_ai, status)
    values (v_inq, 'ai', 'forged draft', true, 'draft');
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', 'M: an owner cannot write an AI draft');
  begin
    insert into public.inquiry_messages (inquiry_id, author, sender_id, body)
    values (v_inq, 'sitter', robert, 'pretend to be Chloe');
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', 'M: …nor write as the sitter');

  -- The AI draft arrives (service role): Chloe is told, Robert sees nothing of it
  perform _t_as(null);
  insert into public.inquiry_messages (inquiry_id, author, body, drafted_by_ai, status, grounding, model)
  values (v_inq, 'ai', 'Hi Robert! I''m available…', true, 'draft', '{"quote":{"total":268.13}}', 'm')
  returning id into v_draft;
  perform _t_ok(exists (select 1 from public.notifications
      where user_id = chloe and type = 'inquiry_received' and ref_id = v_inq),
    'M: the sitter is told the draft is ready');
  perform _t_as(robert);
  perform _t_ok((select count(*) from public.inquiry_messages where inquiry_id = v_inq) = 1,
    'M: the owner sees her own message and not the AI draft');
  perform _t_as(chloe);
  perform _t_ok((select count(*) from public.inquiry_messages where inquiry_id = v_inq) = 2,
    'M: the sitter sees the question and the draft');

  -- Third parties see nothing
  perform _t_as(joy);
  perform _t_ok((select count(*) from public.inquiries) = 0 and (select count(*) from public.inquiry_messages) = 0,
    'M: a third party sees no inquiry and no message');
  perform _t_as(paul);
  perform _t_ok((select count(*) from public.inquiries) = 0 and (select count(*) from public.inquiry_messages) = 0,
    'M: another sitter sees none either');

  -- Chloe sends it through the RPC; a direct insert as the sitter is refused
  perform _t_as(chloe);
  begin
    insert into public.inquiry_messages (inquiry_id, author, sender_id, body)
    values (v_inq, 'sitter', chloe, 'a message written around the RPC');
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', 'M: a sitter cannot insert a message directly (only through send_inquiry_reply)');
  perform _t_as(paul);
  begin
    perform send_inquiry_reply(v_inq, 'as Paul', null);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'forbidden', 'M: another sitter cannot reply in Chloe''s thread');
  perform _t_as(robert);
  begin
    perform send_inquiry_reply(v_inq, 'as Robert', null);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'forbidden', 'M: the owner cannot reply as the sitter');
  perform _t_as(chloe);
  begin
    perform send_inquiry_reply(v_inq, '   ', v_draft);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'body_required', 'M: an empty reply is refused');
  begin
    perform send_inquiry_reply(v_inq, 'hi', gen_random_uuid());
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'draft_not_found', 'M: a draft that is not in this thread is refused');
  perform send_inquiry_reply(v_inq, 'Hi Robert! I''m available…', v_draft);
  perform _t_as(robert);
  perform _t_ok((select count(*) from public.inquiry_messages where inquiry_id = v_inq and author = 'sitter') = 1
      and (select count(*) from public.inquiry_messages where inquiry_id = v_inq and author = 'ai') = 0,
    'M: the owner sees the sitter''s sent reply, still not the draft');
  perform _t_ok((select grounding -> 'quote' ->> 'total' from public.inquiry_messages
        where inquiry_id = v_inq and author = 'sitter') = '268.13'
      and (select grounding ? 'needs_sitter' from public.inquiry_messages where inquiry_id = v_inq and author = 'sitter') = false,
    'M: the reply carries the quote but none of the draft''s internal notes');
  perform _t_ok((select drafted_by_ai and confirmed_by_sitter_at is not null and sender_id = chloe
        from public.inquiry_messages where inquiry_id = v_inq and author = 'sitter'),
    'M: …marked as approved by the sitter');
  perform _t_ok(exists (select 1 from public.notifications
      where user_id = robert and type = 'inquiry_replied' and ref_id = v_inq),
    'M: the owner is told Chloe replied');

  -- The sitter opening the thread is the only "read"
  perform _t_ok((select read_at is null from public.inquiry_messages where id = v_msg),
    'M: the owner''s message is unread until the sitter opens the thread');
  perform _t_as(paul);
  perform mark_inquiry_read(v_inq);
  perform _t_as(chloe);
  perform _t_ok((select read_at is null from public.inquiry_messages where id = v_msg),
    'M: another sitter opening it marks nothing');
  perform mark_inquiry_read(v_inq);
  perform _t_ok((select read_at is not null from public.inquiry_messages where id = v_msg),
    'M: the sitter opening the thread marks the owner''s message read');

  -- A reply that is not visible yet stays hidden from the owner
  perform _t_as(null);
  insert into public.inquiry_messages (inquiry_id, author, sender_id, body, status, visible_at)
  values (v_inq, 'sitter', chloe, 'later', 'sent', now() + interval '1 hour');
  perform _t_as(robert);
  perform _t_ok((select count(*) from public.inquiry_messages where inquiry_id = v_inq and body = 'later') = 0,
    'M: a reply before its visible_at is hidden from the owner');

  -- Booking link: only her own booking with this sitter
  begin
    update public.inquiries set booking_id = (select id from public.bookings where owner_id = joy limit 1)
    where id = v_inq;
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err is not null or (select booking_id is null from public.inquiries where id = v_inq),
    'M: an inquiry cannot be linked to someone else''s booking');
  update public.inquiries set status = 'closed' where id = v_inq;
  perform _t_ok((select status = 'closed' from public.inquiries where id = v_inq), 'M: the owner can close her inquiry');
  begin
    update public.inquiries set owner_id = joy where id = v_inq;
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', 'M: …but cannot change who it belongs to');

  -- Sitter policies: written by the sitter only
  perform _t_as(chloe);
  update public.sitter_profiles set policies = 'No dogs over 20 kg.' where id = chloe;
  perform _t_ok((select policies from public.sitter_profiles where id = chloe) = 'No dogs over 20 kg.',
    'M: a sitter writes her own policies');
  perform _t_as(paul);
  update public.sitter_profiles set policies = 'hijacked' where id = chloe;
  perform _t_ok((select policies from public.sitter_profiles where id = chloe) = 'No dogs over 20 kg.',
    'M: …and nobody else can');

  -- The knowledge base is service-role only
  perform _t_as(null);
  insert into public.knowledge_chunks (scope, sitter_id, source_type, source_id, content, embedding)
  values ('sitter', chloe, 'sitter_policy', chloe, 'No dogs over 20 kg.', (select array_fill(0.1::real, array[1024])::extensions.vector(1024)));
  v_other := null;
  perform _t_as(robert);
  begin
    perform count(*) from public.knowledge_chunks;
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', 'M: knowledge_chunks is not readable by authenticated');
  perform _t_as(null, 'anon');
  begin
    perform count(*) from public.knowledge_chunks;
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', 'M: …nor by anon');
  perform _t_as(robert);
  begin
    perform * from public.match_knowledge((select array_fill(0.1::real, array[1024])::extensions.vector(1024)), chloe, array[max], robert);
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', 'M: …and match_knowledge is not callable by clients');
  -- match_knowledge stays inside each source's scope (service role)
  perform _t_as(null);
  insert into public.knowledge_chunks (scope, sitter_id, owner_id, source_type, source_id, content, embedding)
  values
    ('owner', paul, robert, 'inquiry', gen_random_uuid(), 'Robert asked Paul about weekends', (select array_fill(0.1::real, array[1024])::extensions.vector(1024))),
    ('owner', chloe, robert, 'inquiry', gen_random_uuid(), 'Robert asked Chloe about pills', (select array_fill(0.1::real, array[1024])::extensions.vector(1024))),
    ('owner', chloe, joy, 'inquiry', gen_random_uuid(), 'Joy asked Chloe about Toto', (select array_fill(0.1::real, array[1024])::extensions.vector(1024)));
  insert into public.knowledge_chunks (scope, sitter_id, source_type, source_id, content, embedding)
  values ('sitter', paul, 'sitter_policy', paul, 'Paul never takes cats', (select array_fill(0.1::real, array[1024])::extensions.vector(1024)));
  insert into public.knowledge_chunks (scope, pet_id, source_type, source_id, content, embedding)
  values ('pet', coco, 'life_record', gen_random_uuid(), 'Coco is afraid of thunder', (select array_fill(0.1::real, array[1024])::extensions.vector(1024)));
  perform _t_ok((select array_agg(content order by content) from public.match_knowledge(
        (select array_fill(0.1::real, array[1024])::extensions.vector(1024)), chloe, array[max], robert, 20))
      = array['No dogs over 20 kg.', 'Robert asked Chloe about pills'],
    'M: a search reaches only this sitter''s policy and this owner × sitter conversation — no other pet, sitter or owner');
  -- tone_samples: service role only, and a search never reaches another sitter's voice or a thrown-away draft
  perform _t_as(null);
  insert into public.tone_samples (sitter_id, kind, source, context_summary, final_text, embedding) values
    (chloe, 'inquiry', 'approved', 'asks about a pill', 'Hi! Happy to help 🐾', (select array_fill(0.1::real, array[1024])::extensions.vector(1024))),
    (chloe, 'inquiry', 'regenerated', 'asks about a pill', '', (select array_fill(0.1::real, array[1024])::extensions.vector(1024))),
    (chloe, 'report', 'approved', 'daily report', 'A lovely day!', (select array_fill(0.1::real, array[1024])::extensions.vector(1024))),
    (paul, 'inquiry', 'approved', 'asks about a pill', 'Hello. Yes.', (select array_fill(0.1::real, array[1024])::extensions.vector(1024)));
  perform _t_ok((select array_agg(final_text) from public.match_tone(
        (select array_fill(0.1::real, array[1024])::extensions.vector(1024)), chloe, 'inquiry', 10))
      = array['Hi! Happy to help 🐾'],
    'M: match_tone returns only this sitter''s approved / edited examples of this kind');
  perform _t_as(chloe);
  begin
    perform count(*) from public.tone_samples;
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', 'M: tone_samples is not readable by clients, not even the sitter''s own');
  begin
    perform style_card from public.sitter_profiles where id = chloe;
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', 'M: …and neither is the style card');
  -- Auto-send settings: consent first, the sitter's own row only, and the mode is not a plain column update
  perform _t_as(chloe);
  perform _t_ok((public.get_my_ai_reply_mode() ->> 'mode') = 'manual' and (public.get_my_ai_reply_mode() ->> 'consented') = 'false',
    'M: auto-send is off until the sitter turns it on');
  begin
    perform set_ai_reply_mode('auto', false);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'consent_required', 'M: auto-send needs the sitter''s consent');
  begin
    update public.sitter_profiles set ai_reply_mode = 'auto' where id = chloe;
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', 'M: …and cannot be switched with a plain update');
  perform set_ai_reply_mode('auto', true);
  perform _t_ok((get_my_ai_reply_mode() ->> 'mode') = 'auto' and (get_my_ai_reply_mode() ->> 'consented') = 'true',
    'M: with consent auto-send turns on');
  perform set_ai_reply_mode('manual');
  perform set_ai_reply_mode('auto');
  perform _t_ok((get_my_ai_reply_mode() ->> 'mode') = 'auto',
    'M: turning it off and on again needs no second consent');
  perform _t_as(robert);
  begin
    perform set_ai_reply_mode('auto', true);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'forbidden', 'M: an owner has no auto-send setting');

  -- A notice that is written now but appears later
  perform _t_as(null);
  insert into public.notifications (user_id, type, title, ref_id, visible_at)
  values (robert, 'inquiry_replied', 'later', v_inq, now() + interval '1 hour'),
         (robert, 'inquiry_replied', 'now', v_inq, now() - interval '1 second');
  perform _t_as(robert);
  perform _t_ok((select count(*) from public.notifications where title = 'now') = 1
      and (select count(*) from public.notifications where title = 'later') = 0,
    'M: a notice with a later visible_at stays hidden until then');
  perform _t_as(null);
  update public.inquiries set reply_typing_at = now() + interval '5 seconds', reply_visible_at = now() + interval '30 seconds' where id = v_inq;
  perform _t_as(robert);
  perform _t_ok((select reply_visible_at is not null from public.inquiries where id = v_inq),
    'M: the owner can read when the reply will appear (times only, no text)');
  begin
    update public.inquiries set reply_visible_at = now() where id = v_inq;
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', 'M: …but cannot change it');
end;
$$;

-- ---------------------------------------------------------------------------
-- N (Phase 07C, 7C.1): home safe, reviews, Pet Life Records
-- ---------------------------------------------------------------------------

do $$
declare
  robert constant uuid := '00000000-0000-4000-8000-0000000000a1';
  joy constant uuid := '00000000-0000-4000-8000-0000000000a2';
  chloe constant uuid := '00000000-0000-4000-8000-0000000000b1';
  paul constant uuid := '00000000-0000-4000-8000-0000000000b2';
  max uuid;
  coco constant uuid := '00000000-0000-4000-8000-0000000000c3';
  v_b uuid;
  v_open uuid;
  v_rev public.reviews;
  v_err text;
  v_sum jsonb;
begin
  -- A pet of their own (earlier scenarios keep Max booked far into the future)
  perform _t_as(null);
  insert into public.pets (owner_id, species, name) values (robert, 'dog', 'Rex') returning id into max;
  -- A stay: Received, not Returned yet
  perform _t_as(null);
  v_b := _t_booking(robert, chloe, array[max], now() + interval '300 days', now() + interval '302 days', 'confirmed', true);

  perform _t_as(robert);
  begin
    perform submit_review(v_b, 5, 'Great');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'stay_not_finished', 'N: no review before the pets are back');

  -- Returned → home safe + the owner is asked for a review, in that order
  perform _t_as(chloe);
  perform complete_handoff(v_b, 'pick_up');
  perform _t_as(null);
  perform _t_ok((select title from public.notifications where user_id = robert and type = 'pet_picked_up' and booking_id = v_b)
      = 'Rex is home safe 🏠', 'N: Returned says the pet is home safe');
  perform _t_ok((select title from public.notifications where user_id = robert and type = 'review_requested' and booking_id = v_b)
      = 'Thanks for trusting Chloe! How was Rex''s stay? ⭐', 'N: …and asks for a review');
  perform _t_ok((select created_at from public.notifications where type = 'review_requested' and booking_id = v_b)
      >= (select created_at from public.notifications where type = 'pet_picked_up' and booking_id = v_b),
    'N: …right after it');

  -- Who may review
  perform _t_as(chloe);
  begin
    perform submit_review(v_b, 5, null);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'forbidden', 'N: the sitter cannot review their own stay');
  perform _t_as(joy);
  begin
    perform submit_review(v_b, 5, null);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'forbidden', 'N: a third party cannot review it');
  perform _t_as(robert);
  begin
    insert into public.reviews (booking_id, owner_id, sitter_id, rating) values (v_b, robert, chloe, 5);
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', 'N: reviews are not written around submit_review');
  begin
    perform submit_review(v_b, 6, null);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'invalid_rating', 'N: ★1–5 only');
  begin
    perform submit_review(v_b, 4, repeat('x', 501));
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'comment_too_long', 'N: a comment is at most 500 characters');

  v_rev := submit_review(v_b, 5, '  Lovely, Rex came home happy!  ');
  perform _t_ok(v_rev.rating = 5 and v_rev.comment = 'Lovely, Rex came home happy!', 'N: the owner reviews once the pets are back');
  begin
    perform submit_review(v_b, 1, null);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'already_reviewed', 'N: one review per booking');
  perform _t_as(null);
  perform _t_ok(exists (select 1 from public.notifications where user_id = chloe and type = 'review_received' and ref_id = v_rev.id),
    'N: the sitter is told');

  -- Rows are private to the two parties; the summary is public
  perform _t_as(chloe);
  perform _t_ok((select count(*) from public.reviews) >= 1, 'N: the sitter reads reviews about them');
  perform _t_as(joy);
  perform _t_ok((select count(*) from public.reviews) = 0, 'N: a third party reads no review rows');
  v_sum := sitter_rating_summary(chloe);
  perform _t_ok((v_sum ->> 'count')::int = 1 and (v_sum ->> 'avg')::numeric = 5.0
      and v_sum -> 'recent' -> 0 ->> 'reviewer' = 'Robert' and v_sum -> 'recent' -> 0 ->> 'comment' like 'Lovely%',
    'N: …but anyone signed in sees the average, the count and recent comments with a first name');
  perform _t_ok(not (v_sum::text like '%' || robert::text || '%'), 'N: …and no id of the reviewer');
  perform _t_as(null, 'anon');
  begin
    perform sitter_rating_summary(chloe);
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', 'N: signed-out visitors get no summary');

  -- Life Records: written by the service role, read by the right people
  perform _t_as(null);
  insert into public.pet_life_records (pet_id, booking_id, sitter_id, summary)
  values (max, v_b, chloe, '{"eats":"finishes breakfast","heads_up":["chicken allergy"]}');
  perform _t_as(robert);
  perform _t_ok((select count(*) from public.pet_life_records where pet_id = max) = 1, 'N: the owner reads their pet''s record');
  begin
    insert into public.pet_life_records (pet_id, booking_id, summary) values (max, v_b, '{}');
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', 'N: clients never write records');
  begin
    perform source_snapshot from public.pet_life_records;
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err = '42501', 'N: even the owner reads the summary, not the raw source_snapshot');
  perform _t_as(chloe);
  perform _t_ok((select count(*) from public.pet_life_records) = 1,
    'N: the sitter still reads it until their wrap-up window (2 h after the agreed pick-up) closes');
  perform _t_as(null);
  update public.booking_handoffs set scheduled_at = case kind when 'drop_off' then now() - interval '2 days' else now() - interval '3 hours' end
  where booking_id = v_b;
  perform _t_as(chloe);
  perform _t_ok((select count(*) from public.pet_life_records) = 0,
    'N: …then the sitter of a finished stay no longer reads the record');
  perform _t_as(joy);
  perform _t_ok((select count(*) from public.pet_life_records) = 0, 'N: a third party reads no record');

  -- Paul is asked to care for Max: a request opens it
  perform _t_as(null);
  perform _t_booking(robert, paul, array[max], now() + interval '330 days', now() + interval '332 days', 'requested');
  perform _t_as(paul);
  perform _t_ok((select count(*) from public.pet_life_records where pet_id = max) = 1,
    'N: a sitter with a pending request for the pet reads its record');
  perform _t_as(null);
  update public.bookings set status = 'declined' where owner_id = robert and sitter_id = paul;
  perform _t_as(paul);
  perform _t_ok((select count(*) from public.pet_life_records) = 0, 'N: …until the request ends');

  -- …or an open inquiry
  perform _t_as(robert);
  insert into public.inquiries (owner_id, sitter_id, drop_off_at, pick_up_at, pet_ids)
  values (robert, paul, now() + interval '340 days', now() + interval '342 days', array[max]) returning id into v_open;
  perform _t_as(paul);
  perform _t_ok((select count(*) from public.pet_life_records where pet_id = max) = 1,
    'N: a sitter with an open inquiry about the pet reads its record');
  perform _t_as(robert);
  update public.inquiries set status = 'closed' where id = v_open;
  perform _t_as(paul);
  perform _t_ok((select count(*) from public.pet_life_records) = 0, 'N: …until the inquiry is closed');
  perform _t_as(joy);
  begin
    perform count(*) from public.pet_life_records where pet_id = coco;
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err is null, 'N: a query on someone else''s pet just returns nothing');
end;
$$;


-- ---------------------------------------------------------------------------
-- O (011g, FB-25 · FB-29): the sitter's private note about an owner
-- ---------------------------------------------------------------------------

do $$
declare
  robert constant uuid := '00000000-0000-4000-8000-0000000000a1';
  joy constant uuid := '00000000-0000-4000-8000-0000000000a2';
  chloe constant uuid := '00000000-0000-4000-8000-0000000000b1';
  paul constant uuid := '00000000-0000-4000-8000-0000000000b2';
  pet uuid;
  v_b uuid;
  v_err text;
  v_notes int;
begin
  perform _t_as(null);
  insert into public.pets (owner_id, species, name) values (robert, 'dog', 'Notey') returning id into pet;
  v_b := _t_booking(robert, chloe, array[pet], now() + interval '310 days', now() + interval '312 days', 'confirmed', true);

  perform _t_as(chloe);
  begin
    perform save_owner_note(v_b, 4, 'Clear care notes');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'stay_not_finished', 'O: no owner note before the pets are back');

  perform complete_handoff(v_b, 'pick_up');
  perform _t_as(null); -- count every notice of the owner (RLS hides them from the sitter)
  select count(*) into v_notes from public.notifications where user_id = robert;
  perform _t_as(chloe);
  perform save_owner_note(v_b, 4, '  Clear care notes  ');
  perform _t_ok((select rating = 4 and comment = 'Clear care notes' from public.sitter_owner_notes where booking_id = v_b),
    'O: the sitter saves a private note about the owner (trimmed)');
  perform save_owner_note(v_b, 5, 'Happy to host again');
  perform _t_ok((select count(*) = 1 and max(rating) = 5 from public.sitter_owner_notes where booking_id = v_b),
    'O: saving again edits the same note');
  perform _t_as(null);
  perform _t_ok((select count(*) from public.notifications where user_id = robert) = v_notes,
    'O: the owner is not told');

  perform _t_as(robert);
  perform _t_ok((select count(*) from public.sitter_owner_notes where booking_id = v_b) = 0, 'O: the owner cannot read it');
  begin
    perform save_owner_note(v_b, 1, 'From the owner');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'forbidden', 'O: …or write one');
  perform _t_as(paul);
  perform _t_ok((select count(*) from public.sitter_owner_notes where booking_id = v_b) = 0, 'O: another sitter cannot read it');
  begin
    insert into public.sitter_owner_notes (booking_id, sitter_id, owner_id, rating) values (v_b, paul, robert, 1);
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err is not null, 'O: no direct insert, only save_owner_note');
  perform _t_as(chloe);
  begin
    perform save_owner_note(v_b, 6, null);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'invalid_rating', 'O: 1 to 5 stars');
end;
$$;


-- ---------------------------------------------------------------------------
-- P (011h, FB-28): an owner's favorite sitters
-- ---------------------------------------------------------------------------

do $$
declare
  robert constant uuid := '00000000-0000-4000-8000-0000000000a1';
  joy constant uuid := '00000000-0000-4000-8000-0000000000a2';
  chloe constant uuid := '00000000-0000-4000-8000-0000000000b1';
  v_err text;
begin
  perform _t_as(robert);
  insert into public.owner_favorite_sitters (sitter_id) values (chloe);
  perform _t_ok((select count(*) from public.owner_favorite_sitters where sitter_id = chloe) = 1,
    'P: an owner adds a sitter to their favorites (owner_id defaults to them)');
  begin
    insert into public.owner_favorite_sitters (sitter_id) values (joy);
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err is not null, 'P: only a sitter can be a favorite');
  begin
    insert into public.owner_favorite_sitters (owner_id, sitter_id) values (joy, chloe);
    v_err := null;
  exception when others then v_err := sqlstate;
  end;
  perform _t_ok(v_err is not null, 'P: …and only into their own list');
  perform _t_as(joy);
  perform _t_ok((select count(*) from public.owner_favorite_sitters) = 0, 'P: another owner does not see the list');
  perform _t_as(chloe);
  perform _t_ok((select count(*) from public.owner_favorite_sitters) = 0, 'P: the sitter is not told (cannot read it)');
  perform _t_as(robert);
  delete from public.owner_favorite_sitters where sitter_id = chloe;
  perform _t_ok((select count(*) from public.owner_favorite_sitters) = 0, 'P: the owner removes a favorite');
end;
$$;

-- ---------------------------------------------------------------------------
-- Care window follows Received (011i): the pets are at the sitter's early → check-ins open at once
-- ---------------------------------------------------------------------------

do $$
declare
  robert constant uuid := '00000000-0000-4000-8000-0000000000a1';
  chloe constant uuid := '00000000-0000-4000-8000-0000000000b1';
  paul constant uuid := '00000000-0000-4000-8000-0000000000b2';
  v_pet uuid;
  v_booking uuid;
  v_err text;
begin
  perform _t_as(null);
  insert into public.pets (owner_id, species, name) values (robert, 'dog', 'Early') returning id into v_pet;
  -- Agreed drop-off an hour away, pick-up in three days; nothing received yet.
  v_booking := _t_booking(robert, chloe, array[v_pet], now() + interval '1 hour', now() + interval '3 days', 'confirmed');

  perform _t_as(chloe);
  perform _t_ok(not in_care_window(v_pet, now()), '011i: before Received and before the agreed drop-off the window is closed');
  begin
    perform log_care_checkin(v_pet, 'meal', 'all');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err = 'not_in_care_window', '011i: …and a check-in is refused');

  -- The sitter taps Received an hour early (allowed from 2 h before).
  perform complete_handoff(v_booking, 'drop_off');
  perform _t_ok(in_care_window(v_pet, now()), '011i: after an early Received the window is open now');
  perform log_care_checkin(v_pet, 'meal', 'all');
  perform _t_ok(
    (select count(*) from public.care_checkins where pet_id = v_pet and kind = 'meal' and created_by = chloe) = 1,
    '011i: an early Received lets the sitter log a check-in before the agreed time');

  -- Nobody else gains access, and the owner still cannot log one.
  perform _t_as(paul);
  perform _t_ok(not in_care_window(v_pet, now()), '011i: another sitter is not inside the window');
  perform _t_as(robert);
  perform _t_ok(not in_care_window(v_pet, now()), '011i: the owner is not inside the window');
  perform _t_as(null);
end;
$$;

-- ---------------------------------------------------------------------------
-- Stay capacity check (011c, RV-1): the inquiry AI's availability = request_booking's capacity rule
-- ---------------------------------------------------------------------------

do $$
declare
  robert constant uuid := '00000000-0000-4000-8000-0000000000a1';
  chloe constant uuid := '00000000-0000-4000-8000-0000000000b1';
  d constant date := app_today() + 200;
  v text;
  v_err text;
begin
  -- Chloe opens four days with room for 2, then lowers one night to 1 (the newest open row sets the spots).
  perform _t_as(chloe);
  insert into public.sitter_availability (sitter_id, kind, start_date, end_date, slot, starts_at, ends_at, max_pets)
  values (chloe, 'open', d, d + 3, 'morning', '08:00', '12:00', 2),
         (chloe, 'open', d, d + 3, 'afternoon', '12:00', '18:00', 2),
         (chloe, 'open', d, d + 3, 'overnight', '18:00', '08:00', 2);
  insert into public.sitter_availability (sitter_id, kind, start_date, end_date, slot, starts_at, ends_at, max_pets)
  values (chloe, 'open', d + 2, d + 2, 'overnight', '18:00', '08:00', 1);

  perform _t_as(robert);
  v := stay_capacity_check(chloe, local_ts(d, '10:00'), local_ts(d + 1, '10:00'), 2);
  perform _t_ok(v is null, '011c: two pets fit where every slot has two spots');
  v := stay_capacity_check(chloe, local_ts(d + 1, '10:00'), local_ts(d + 3, '10:00'), 2);
  perform _t_ok(v = format('%s overnight', d + 2),
    '011c: two pets and a night with one spot left → that slot, as request_booking would refuse');
  v := stay_capacity_check(chloe, local_ts(d + 1, '10:00'), local_ts(d + 3, '10:00'), 1);
  perform _t_ok(v is null, '011c: …while one pet still fits');
  v := stay_capacity_check(chloe, local_ts(d + 10, '10:00'), local_ts(d + 11, '10:00'), 1);
  perform _t_ok(v like '%' || (d + 10)::text || ' afternoon%' and v like '%overnight%',
    '011c: days the sitter never opened count as no room (their default slots are listed)');
  v := stay_capacity_check(chloe, local_ts(d + 3, '10:00'), local_ts(d + 5, '10:00'), 1);
  perform _t_ok(v like '%' || (d + 4)::text || '%' and v not like '%' || (d + 3)::text || ' morning%',
    '011c: a stay running past the opened days names the unopened slots');
  v := stay_capacity_check(chloe, local_ts(d + 1, '10:00'), local_ts(d, '10:00'), 1);
  perform _t_ok(v = 'invalid_window', '011c: a reversed window is invalid_window');

  perform _t_as(null, 'anon');
  begin
    perform stay_capacity_check(chloe, local_ts(d, '10:00'), local_ts(d + 1, '10:00'), 1);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform _t_ok(v_err like 'permission denied%', '011c: anon cannot call it');
  perform _t_as(null);
end;
$$;

-- ---------------------------------------------------------------------------
-- Inquiry access (011e, RV-4 / FB-31 + RV-5's limits): names and the asked pets for the asked sitter
-- ---------------------------------------------------------------------------

do $$
declare
  ivy constant uuid := '00000000-0000-4000-8000-0000000000a9';
  sam constant uuid := '00000000-0000-4000-8000-0000000000b9';
  paul constant uuid := '00000000-0000-4000-8000-0000000000b2';
  pip constant uuid := '00000000-0000-4000-8000-0000000000c9';
  v_inq uuid;
begin
  -- A new owner and a new sitter with no booking between them.
  perform _t_as(null);
  insert into auth.users (id, email, raw_user_meta_data) values
    (ivy, 'ivy@example.test', '{"role":"owner","display_name":"Ivy"}'),
    (sam, 'sam@example.test', '{"role":"sitter","display_name":"Sam"}');
  insert into public.pets (id, owner_id, species, name) values (pip, ivy, 'dog', 'Pip');
  insert into public.pet_allergies (pet_id, allergen) values (pip, 'chicken');

  perform _t_as(sam);
  perform _t_ok(not exists (select 1 from public.profiles where id = ivy), '011e: before any inquiry Sam cannot see Ivy');
  perform _t_ok(not exists (select 1 from public.pets where id = pip), '011e: …nor her pet');

  perform _t_as(ivy);
  insert into public.inquiries (owner_id, sitter_id, drop_off_at, pick_up_at, pet_ids)
  values (ivy, sam, now() + interval '10 days', now() + interval '12 days', array[pip])
  returning id into v_inq;

  perform _t_as(sam);
  perform _t_ok((select display_name from public.profiles where id = ivy) = 'Ivy',
    '011e: the asked sitter sees the owner''s name (no more "An owner")');
  perform _t_ok((select name from public.pets where id = pip) = 'Pip', '011e: …and the pet asked about');
  perform _t_ok(exists (select 1 from public.pet_allergies where pet_id = pip), '011e: …and its allergies');

  perform _t_as(paul);
  perform _t_ok(not exists (select 1 from public.profiles where id = ivy), '011e: a sitter who was not asked sees no name');
  perform _t_ok(not exists (select 1 from public.pets where id = pip), '011e: …and no pet');

  -- The stay asked about is over: the pet goes, the name stays.
  perform _t_as(null);
  update public.inquiries set drop_off_at = now() - interval '3 days', pick_up_at = now() - interval '1 day' where id = v_inq;
  perform _t_as(sam);
  perform _t_ok(not exists (select 1 from public.pets where id = pip), '011e: after the asked stay the pet is hidden again');
  perform _t_ok(exists (select 1 from public.profiles where id = ivy), '011e: …while the name stays');

  -- Asked more than 30 days ago (stay still ahead), or closed: hidden too.
  perform _t_as(null);
  update public.inquiries
  set drop_off_at = now() + interval '10 days', pick_up_at = now() + interval '12 days', created_at = now() - interval '31 days'
  where id = v_inq;
  perform _t_as(sam);
  perform _t_ok(not exists (select 1 from public.pets where id = pip), '011e: an inquiry older than 30 days no longer opens the pet');
  perform _t_as(null);
  update public.inquiries set created_at = now(), status = 'closed' where id = v_inq;
  perform _t_as(sam);
  perform _t_ok(not exists (select 1 from public.pets where id = pip), '011e: a closed inquiry no longer opens the pet');
  perform _t_as(null);
end;
$$;

-- ---------------------------------------------------------------------------
-- Same-thread date change (011j) and the sitter's reply outcome (011k), FB-34
-- ---------------------------------------------------------------------------

do $$
declare
  kai constant uuid := '00000000-0000-4000-8000-0000000000aa';
  lou constant uuid := '00000000-0000-4000-8000-0000000000ba';
  kip constant uuid := '00000000-0000-4000-8000-0000000000ca';
  v_inq uuid;
  v_draft uuid;
  v_err text;
  v_msg public.inquiry_messages;
begin
  perform _t_as(null);
  insert into auth.users (id, email, raw_user_meta_data) values
    (kai, 'kai@example.test', '{"role":"owner","display_name":"Kai"}'),
    (lou, 'lou@example.test', '{"role":"sitter","display_name":"Lou"}');
  insert into public.pets (id, owner_id, species, name) values (kip, kai, 'dog', 'Kip');

  perform _t_as(kai);
  insert into public.inquiries (owner_id, sitter_id, drop_off_at, pick_up_at, pet_ids)
  values (kai, lou, now() + interval '5 days', now() + interval '7 days', array[kip]) returning id into v_inq;
  insert into public.inquiry_messages (inquiry_id, author, sender_id, body) values (v_inq, 'owner', kai, 'Can you host Kip?');

  -- 011j: the owner moves the dates in the same thread; one owner message records it.
  v_msg := public.change_inquiry_dates(v_inq, now() + interval '20 days', now() + interval '22 days', 'owner_home', null, 'Changed dates');
  perform _t_ok(v_msg.author = 'owner' and v_msg.inquiry_id = v_inq and v_msg.body = 'Changed dates', '011j: the change leaves an owner message in the thread');
  perform _t_ok((select drop_off_at from public.inquiries where id = v_inq) > now() + interval '19 days', '011j: the inquiry has the new drop-off');
  perform _t_ok((select drop_off_location_type from public.inquiries where id = v_inq) = 'owner_home', '011j: …a given place is changed');
  perform _t_ok((select pick_up_location_type from public.inquiries where id = v_inq) = 'sitter_home', '011j: …a null place is kept');
  perform _t_ok((select count(*) from public.inquiries where owner_id = kai) = 1, '011j: still one inquiry (the thread continues)');

  v_err := null;
  begin
    perform public.change_inquiry_dates(v_inq, now() + interval '22 days', now() + interval '20 days', null, null, 'x');
  exception when others then v_err := sqlerrm; end;
  perform _t_ok(v_err = 'invalid_window', '011j: a pick-up before the drop-off is refused');
  v_err := null;
  begin
    perform public.change_inquiry_dates(v_inq, now() + interval '20 days', now() + interval '60 days', null, null, 'x');
  exception when others then v_err := sqlerrm; end;
  perform _t_ok(v_err = 'invalid_window', '011j: a trip over 31 days is refused');
  v_err := null;
  begin
    perform public.change_inquiry_dates(v_inq, now() + interval '20 days', now() + interval '22 days', null, null, '   ');
  exception when others then v_err := sqlerrm; end;
  perform _t_ok(v_err = 'body_required', '011j: an empty message is refused');

  perform _t_as(lou);
  v_err := null;
  begin
    perform public.change_inquiry_dates(v_inq, now() + interval '20 days', now() + interval '22 days', null, null, 'x');
  exception when others then v_err := sqlerrm; end;
  perform _t_ok(v_err = 'forbidden', '011j: the sitter cannot change the owner''s dates');

  -- 011k: the outcome the sitter chose decides what the owner sees.
  perform _t_as(null);
  insert into public.inquiry_messages (inquiry_id, author, sender_id, body, drafted_by_ai, status, grounding)
  values (v_inq, 'ai', null, 'Yes! $100', true, 'draft',
    '{"quote":{"total":100},"sources":[{"id":"policy-0"}],"availability":{"can_host":true}}') returning id into v_draft;

  perform _t_as(lou);
  v_msg := public.send_inquiry_reply(v_inq, 'Sorry, I cannot.', v_draft, 'decline');
  perform _t_ok((v_msg.grounding #>> '{availability,can_host}') = 'false', '011k: a decline says can_host false');
  perform _t_ok(v_msg.grounding -> 'quote' is null, '011k: …and carries no quote');
  perform _t_ok(v_msg.drafted_by_ai and v_msg.confirmed_by_sitter_at is not null, '011k: …yet it is still the approved draft');
  v_msg := public.send_inquiry_reply(v_inq, 'How about Nov 3?', null, 'suggest');
  perform _t_ok((v_msg.grounding #>> '{availability,can_host}') = 'false' and not v_msg.drafted_by_ai, '011k: a suggestion says can_host false');
  v_msg := public.send_inquiry_reply(v_inq, 'Yes, happy to!', v_draft, 'accept');
  perform _t_ok((v_msg.grounding #>> '{quote,total}') = '100' and (v_msg.grounding #>> '{availability,can_host}') = 'true', '011k: an accept keeps the draft''s quote and availability');
  v_msg := public.send_inquiry_reply(v_inq, 'Plain', v_draft);
  perform _t_ok((v_msg.grounding #>> '{quote,total}') = '100', '011k: no outcome behaves as before');
  v_err := null;
  begin
    perform public.send_inquiry_reply(v_inq, 'x', v_draft, 'maybe');
  exception when others then v_err := sqlerrm; end;
  perform _t_ok(v_err = 'invalid_outcome', '011k: an unknown outcome is refused');

  -- The owner sees the decline without a quote.
  perform _t_as(kai);
  perform _t_ok((select count(*) from public.inquiry_messages where inquiry_id = v_inq and author = 'sitter') = 4, '011k: the owner sees the sent replies');
  perform _t_ok(not exists (select 1 from public.inquiry_messages where inquiry_id = v_inq and body = 'Sorry, I cannot.' and grounding ? 'quote'), '011k: …the decline among them has no quote');
  perform _t_as(null);
end;
$$;

rollback;
