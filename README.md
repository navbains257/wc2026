# World Cup 2026 Sweepstake

Static site on **GitHub Pages**, data in **Supabase** (Postgres). Points are derived
from match results, so you only ever enter scores — wins, draws, clean sheets, stage
progression and the underdog bonus all compute automatically.

```
index.html      read-only public leaderboard + squads
db.js           Supabase client + scoring engine (the only place points are defined)
schema.sql      tables, RLS, 48-team seed, 72 group fixtures, draw function
```

## 1. Supabase
1. Create a project at supabase.com.
2. **SQL Editor → New query**, paste all of `schema.sql`, **Run**. This creates the tables,
   locks them to public-read-only, seeds the 48 teams, and pre-loads all 72 group fixtures.
3. **Project Settings → API**: copy the **Project URL** and the **anon / public** key.

## 2. Wire up the frontend
In `db.js`, set:
```js
export const SUPABASE_URL  = 'https://YOUR-PROJECT.supabase.co';
export const SUPABASE_ANON = 'YOUR-ANON-PUBLIC-KEY';
```
The anon key is **meant** to be public — security comes from RLS, which only permits `SELECT`.
Never put the `service_role` key in the repo.

## 3. Players + the draw
In the Supabase dashboard:
- **Table editor → players →** add a row per person.
- **SQL Editor →** run `select run_draw();` — randomly shares all 48 teams across the players
  (re-run any time to reshuffle).

## 4. Entering results
**Table editor → matches.** For each game, fill `home_score`, `away_score`, tick `played`.
The site updates on the next refresh.
- Group fixtures are already there. Filling them in also builds the live **Group tables** tab.
- Add knockout games as new rows: set `stage` to `r32`, `r16`, `qf`, `sf`, or `final`, plus the
  two teams. They appear in the **Bracket** tab automatically.
- **Penalties:** if a knockout is level after extra time, enter the level score (e.g. 1 and 1,
  `played` = true) and set `pen_winner` to the team that won the shootout. That team advances and,
  in the final, becomes champion. The shootout itself still scores as a draw (1 pt each).
- Want fixtures to show in time order on **Next up**? Fill in the `kickoff` column (timestamp).

The frontend has seven tabs: **Sweepstake** (league table — tap a name to expand that person's
team-by-team breakdown) · **Team ranking** (all 48 teams by points) · **Next up** (upcoming
fixtures, tagged with whose teams they are) · **Group tables** (real WC standings) · **Bracket** ·
**Feed** (every result with the exact points each side earned) · **Rules**.

## 5b. Kickoff times for all 104 matches (optional, makes Next up time-ordered)
Run `migration_fixtures.sql` in Supabase (adds `match_no`, `slot_home`, `slot_away`, `venue`, and
lets knockout rows exist before teams are known). Then load every kickoff from the official
calendar rather than typing them by hand:
1. Download the 2026 World Cup schedule as an `.ics` file (FIFA.com / any full-tournament calendar).
2. `npm i @supabase/supabase-js`
3. Run the importer with your **service-role** key (local only — never commit it):
   ```bash
   SUPABASE_URL="https://YOUR-PROJECT.supabase.co" \
   SUPABASE_SERVICE_KEY="eyJ...service-role..." \
   node import_fixtures.mjs worldcup2026.ics
   ```
Group games get their kickoff + venue set (matched by team names); knockout games are inserted as
dated "Winner Group A" slots that show in **Next up** and **Bracket** until you fill in the real
teams. If your `.ics` spells a nation differently, add it to the `NAME` map in the script.

## 6. Auto-pull results + auto-advance the bracket (Supabase Edge Function)
Stops you typing scores in by hand. Uses **football-data.org** (free tier, covers the World Cup).
1. Run `migration_v2.sql` in Supabase (adds pot/settings, a paid flag, standings snapshots, an audit
   log, and turns on realtime). Then `migration_v3.sql` adds the per-player `buy_in` used for side pots.
2. Get a free API token at football-data.org.
3. Deploy the function (it's `sync_function.ts` — place it at `supabase/functions/sync/index.ts`):
   ```bash
   supabase functions deploy sync --no-verify-jwt
   supabase secrets set FOOTBALL_DATA_TOKEN=your_token
   ```
4. Schedule it every 10 minutes (Database → Extensions: enable `pg_cron` + `pg_net`):
   ```sql
   select cron.schedule('wc-sync', '*/10 * * * *', $$
     select net.http_post(
       url := 'https://YOUR-PROJECT.functions.supabase.co/sync',
       headers := '{"Content-Type":"application/json"}'::jsonb) $$);
   ```
It sets group scores (incl. penalty shootouts → `pen_winner`), fills knockout matchups as they're
drawn (the bracket auto-advances from the API rather than recomputing FIFA's best-thirds table), and
writes a daily standings snapshot that powers the ▲/▼ movers. You can still enter or override any
score by hand in the dashboard; every change is logged to `match_audit`.

The free tier allows 10 requests/minute; one run makes a single bulk call, so a 10-minute cron sits
far under the limit. The function still reads football-data's `X-RequestsAvailable` /
`X-RequestCounter-Reset` headers, backs off and retries on a 429, and reports the remaining-requests
count in its JSON response (handy when test-running it by hand).

## What's on the site
**Sweepstake** (goals-scored tiebreaker, ▲/▼ movers, an "I am…" picker that highlights your row,
tap a name for the team-by-team breakdown) · **Team ranking** · **Next up** · **Group tables**
(real standings *plus* the live race for the 8 best third-placed spots) · **Bracket** · **Feed** ·
**Pot** (live +/− table showing every player's stake, projected payout and net position; supports
side pots — one player can stake less via their own `buy_in`, capping them to the main pot while the
rest cascades to the full-stake players) · **Rules**. Flags show throughout via flagcdn, so they render on Windows too.

## 5. GitHub Pages
```bash
git init && git add . && git commit -m "WC26 sweepstake"
git branch -M main
git remote add origin https://github.com/<you>/wc26-sweepstake.git
git push -u origin main
```
Repo **Settings → Pages → Source: main / root**. Live at
`https://<you>.github.io/wc26-sweepstake/` in a minute or two.

## Scoring (defined once in `db.js`)
- **3** win · **1** draw (group games only) · **+2** per clean sheet · **+3** per win for the 12 underdog teams.
- **Stage points, highest-only** (you bank the furthest round, not a running total): R32 **5**, R16 **7**, QF **9**, SF **12**, runner-up **15**, winner **18**.
- **Knockouts can't draw.** A tie after extra time goes to a shootout — winner gets the 3 points and advances, loser gets 0. Enter the level score and set `pen_winner`.
- **Clean sheets ignore the shootout**: only goals conceded over the 120 minutes count, so a 0-0 decided on pens is a clean sheet for both.
- **End-of-tournament awards** (run `migration_v4.sql`): the owner of the nation that takes the **Golden Boot / Golden Glove / Best Player / Fewest goals** gets **+4** each, and **most cards in the group stage** is **+3**. Assign them at the end by setting the winning nation, e.g. `update awards set team_name = 'Brazil' where award = 'golden_boot';` — the bonus then flows to that team's owner automatically. To find the fewest-scoring team: `select t.name, coalesce(sum(case when m.home_team=t.name then m.home_score when m.away_team=t.name then m.away_score end),0) gf from teams t left join matches m on (m.home_team=t.name or m.away_team=t.name) and m.played group by t.name order by gf asc;`

Internally, stage points are stored as increments (R32 +5, then +2 R16, +2 QF, +3 SF, +3 final, +3 win) so they sum to the highest-only totals **and** every point traces back to a single match in the Feed. Change `STAGE_REACH` / `computePoints` in `db.js` to adjust anything.

## Optional upgrades
- **Live updates** — replace the 60s refresh with Supabase Realtime: enable replication on the
  `matches` table, then `supabase.channel('m').on('postgres_changes',{event:'*',schema:'public',table:'matches'},render).subscribe()`.
- **Enter results from your phone** — add Supabase Auth (magic link, your email only) and an
  authenticated-write RLS policy, then build a small admin form. Not needed if you're happy
  using the dashboard.
