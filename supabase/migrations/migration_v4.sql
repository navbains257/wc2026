-- =====================================================================
--  Migration v4 — end-of-tournament award bonuses
--  Each award points to the nation that won it; the bonus goes to that
--  nation's owner. Assign them at the end (see the UPDATEs at the bottom).
--  Run once in Supabase → SQL Editor.
-- =====================================================================

create table if not exists awards (
  award     text primary key,                       -- stable key
  label     text not null,                          -- shown in the breakdown
  points    int  not null,
  team_name text references teams(name)             -- the winning nation (set at the end)
);

insert into awards (award, label, points) values
  ('golden_boot',      'Golden Boot',               4),
  ('golden_glove',     'Golden Glove',              4),
  ('best_player',      'Best Player',               4),
  ('least_goals',      'Fewest goals scored',       4),
  ('most_cards_group', 'Most cards (group stage)',  3)
on conflict (award) do nothing;

alter table awards enable row level security;
create policy "public read awards" on awards for select using (true);
alter publication supabase_realtime add table awards;

-- ── at the end of the tournament, set the winning nation for each award ──
-- update awards set team_name = 'Brazil'  where award = 'golden_boot';
-- update awards set team_name = 'Spain'   where award = 'golden_glove';
-- update awards set team_name = 'France'  where award = 'best_player';
-- update awards set team_name = 'Haiti'   where award = 'least_goals';
-- update awards set team_name = 'Croatia' where award = 'most_cards_group';
