-- =====================================================================
--  Migration: support dated knockout "slots" (kickoff known, teams not yet)
--  + match metadata. Run once in Supabase → SQL Editor, after schema.sql.
-- =====================================================================

-- knockout slots are inserted with no teams yet, so the team columns must allow NULL
alter table matches alter column home_team drop not null;
alter table matches alter column away_team drop not null;

alter table matches add column if not exists match_no  int;    -- FIFA match number (1–104)
alter table matches add column if not exists slot_home text;    -- e.g. 'Winner Group A' — shown until you set home_team
alter table matches add column if not exists slot_away text;    -- e.g. 'Runner-up Group B'
alter table matches add column if not exists venue     text;    -- stadium / city

-- Once a knockout slot's teams are known, just fill in home_team / away_team in the
-- table editor (and scores when played). The slot labels are only used while teams are null.
