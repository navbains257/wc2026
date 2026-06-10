-- =====================================================================
--  Migration v3 — per-player buy-in (enables side pots)
--  Run once in Supabase → SQL Editor.
-- =====================================================================

-- A player's own stake. NULL means "the standard buy-in" from settings.
-- Set this smaller for the one person buying in for less.
alter table players add column if not exists buy_in numeric;

-- settings.buy_in stays the STANDARD stake everyone else pays.
