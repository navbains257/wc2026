-- =====================================================================
--  Migration v2 — pot, rank-mover snapshots, audit log, realtime
--  Run once in Supabase → SQL Editor (after schema.sql + migration_fixtures.sql).
-- =====================================================================

-- ---- prize pot config (single row) ----
create table if not exists settings (
  id              int primary key default 1,
  buy_in          numeric not null default 0,    -- amount per player (pot is undetermined for now → 0)
  currency        text    not null default '£',
  split_winner    int     not null default 70,   -- payout %
  split_runner_up int     not null default 20,
  split_spoon     int     not null default 10,   -- wooden spoon (last place)
  constraint one_row check (id = 1)
);
insert into settings (id) values (1) on conflict (id) do nothing;

-- who has paid in
alter table players add column if not exists paid boolean not null default false;

-- ---- daily standings snapshots (for ▲/▼ movers) ----
create table if not exists standings_snapshots (
  captured_on date not null,
  player_id   uuid not null references players(id) on delete cascade,
  rank        int  not null,
  points      int  not null,
  primary key (captured_on, player_id)
);

-- ---- audit log of score edits (dispute trail) ----
create table if not exists match_audit (
  id         bigint generated always as identity primary key,
  match_id   uuid,
  changed_at timestamptz not null default now(),
  old_home   int, old_away int, old_pen text,
  new_home   int, new_away int, new_pen text
);
create or replace function log_match_edit() returns trigger language plpgsql as $$
begin
  if (new.home_score is distinct from old.home_score)
     or (new.away_score is distinct from old.away_score)
     or (new.pen_winner is distinct from old.pen_winner) then
    insert into match_audit(match_id, old_home, old_away, old_pen, new_home, new_away, new_pen)
    values (old.id, old.home_score, old.away_score, old.pen_winner, new.home_score, new.away_score, new.pen_winner);
  end if;
  return new;
end $$;
drop trigger if exists trg_match_edit on matches;
create trigger trg_match_edit after update on matches for each row execute function log_match_edit();

-- ---- RLS: public read on the new readable tables ----
alter table settings            enable row level security;
alter table standings_snapshots enable row level security;
create policy "public read settings"  on settings            for select using (true);
create policy "public read snapshots" on standings_snapshots for select using (true);
-- match_audit stays private (no policy = readable only via service role / dashboard)
alter table match_audit enable row level security;

-- ---- realtime: push live updates to the site instead of polling ----
alter publication supabase_realtime add table matches;
alter publication supabase_realtime add table players;
alter publication supabase_realtime add table assignments;
alter publication supabase_realtime add table standings_snapshots;
