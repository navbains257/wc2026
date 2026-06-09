-- =====================================================================
--  World Cup 2026 Sweepstake — Supabase / Postgres schema
--  Run this once in: Supabase Dashboard → SQL Editor → New query → Run
-- =====================================================================

-- ---------- tables ----------
create table if not exists teams (
  name        text primary key,
  grp         text not null,
  fifa_rank   int  not null,
  is_underdog boolean not null default false
);

create table if not exists players (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_at timestamptz default now()
);

create table if not exists assignments (           -- the draw result
  team_name  text primary key references teams(name) on delete cascade,
  player_id  uuid not null references players(id)   on delete cascade
);

create table if not exists matches (               -- fixtures + results
  id         uuid primary key default gen_random_uuid(),
  stage      text not null check (stage in ('group','r32','r16','qf','sf','final')),
  home_team  text not null references teams(name),
  away_team  text not null references teams(name),
  home_score int,
  away_score int,
  pen_winner text references teams(name),   -- set only when a level knockout game is decided on penalties
  kickoff    timestamptz,
  played     boolean not null default false
);

-- if you already ran the earlier schema, this adds the new column safely:
alter table matches add column if not exists pen_winner text references teams(name);

-- ---------- row-level security: public can READ, nobody can write via the site ----------
-- (you enter data through the Supabase dashboard, which uses the service role and bypasses RLS)
alter table teams       enable row level security;
alter table players     enable row level security;
alter table assignments enable row level security;
alter table matches     enable row level security;

create policy "public read teams"       on teams       for select using (true);
create policy "public read players"     on players     for select using (true);
create policy "public read assignments" on assignments for select using (true);
create policy "public read matches"     on matches     for select using (true);

-- ---------- seed: 48 teams (group, current FIFA rank, underdog = bottom 12) ----------
insert into teams (name, grp, fifa_rank, is_underdog) values
  ('Mexico','A',15,false),('South Korea','A',25,false),('South Africa','A',60,true),('Czechia','A',41,false),
  ('Canada','B',30,false),('Switzerland','B',19,false),('Qatar','B',55,true),('Bosnia-Herzegovina','B',65,true),
  ('Brazil','C',6,false),('Morocco','C',8,false),('Scotland','C',43,false),('Haiti','C',83,true),
  ('USA','D',16,false),('Paraguay','D',40,false),('Australia','D',27,false),('Turkey','D',22,false),
  ('Germany','E',10,false),('Ecuador','E',23,false),('Ivory Coast','E',34,false),('Curaçao','E',82,true),
  ('Netherlands','F',7,false),('Japan','F',18,false),('Tunisia','F',44,false),('Sweden','F',38,false),
  ('Belgium','G',9,false),('Iran','G',21,false),('Egypt','G',29,false),('New Zealand','G',85,true),
  ('Spain','H',2,false),('Uruguay','H',17,false),('Saudi Arabia','H',61,true),('Cape Verde','H',69,true),
  ('France','I',1,false),('Senegal','I',14,false),('Norway','I',31,false),('Iraq','I',57,true),
  ('Argentina','J',3,false),('Austria','J',24,false),('Algeria','J',28,false),('Jordan','J',63,true),
  ('Portugal','K',5,false),('Colombia','K',13,false),('Uzbekistan','K',50,true),('DR Congo','K',46,false),
  ('England','L',4,false),('Croatia','L',11,false),('Panama','L',33,false),('Ghana','L',74,true)
on conflict (name) do nothing;

-- ---------- seed: all 72 group-stage fixtures (round-robin within each group) ----------
insert into matches (stage, home_team, away_team)
select 'group', a.name, b.name
from teams a join teams b
  on a.grp = b.grp and a.fifa_rank < b.fifa_rank
on conflict do nothing;

-- ---------- helper: random draw (run AFTER inserting players) ----------
-- usage:  select run_draw();
create or replace function run_draw() returns void
language plpgsql as $$
declare pids uuid[]; n int; i int := 0; t record;
begin
  select array_agg(id order by random()) into pids from players;
  n := array_length(pids, 1);
  if n is null or n < 2 then raise exception 'Add at least 2 players first'; end if;
  delete from assignments;
  for t in select name from teams order by random() loop
    insert into assignments(team_name, player_id) values (t.name, pids[(i % n) + 1]);
    i := i + 1;
  end loop;
end $$;
