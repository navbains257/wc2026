// =====================================================================
//  supabase/functions/sync/index.ts   (Deno — Supabase Edge Function)
//
//  Pulls scores + knockout matchups from football-data.org into `matches`,
//  then once per day snapshots the standings (for the ▲/▼ movers).
//
//  Deploy:
//    supabase functions deploy sync --no-verify-jwt
//    supabase secrets set FOOTBALL_DATA_TOKEN=your_token_here
//  (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
//
//  Schedule it (every 10 min) — see README for the pg_cron snippet.
//
//  football-data.org: free tier, 10 req/min, WC competition code "WC".
//  Match object gives score.fullTime (level score for shootouts), score.winner,
//  score.duration ('PENALTY_SHOOTOUT'), stage, utcDate, status.
// =====================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const FD_TOKEN = Deno.env.get('FOOTBALL_DATA_TOKEN')!;
const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

// football-data spelling -> our teams.name
const NAME: Record<string, string> = {
  'Korea Republic': 'South Korea', 'Republic of Korea': 'South Korea',
  'United States': 'USA', 'Türkiye': 'Turkey', 'Turkiye': 'Turkey',
  'Bosnia and Herzegovina': 'Bosnia-Herzegovina', "Côte d'Ivoire": 'Ivory Coast',
  'Curacao': 'Curaçao', 'Congo DR': 'DR Congo', 'DR Congo': 'DR Congo',
  'Czech Republic': 'Czechia', 'IR Iran': 'Iran', 'Cabo Verde': 'Cape Verde',
};
const norm = (s: string | null | undefined) => { s = (s || '').trim(); return NAME[s] || s; };
const STAGE: Record<string, string> = {
  GROUP_STAGE: 'group', LAST_32: 'r32', LAST_16: 'r16',
  QUARTER_FINALS: 'qf', SEMI_FINALS: 'sf', FINAL: 'final',
};

// ---- scoring (mirrors db.js — keep identical) ----
const STAGE_REACH: Record<string, number> = { r32: 5, r16: 2, qf: 2, sf: 3, final: 3 };
function matchWinner(m: any): string | null {
  if (!m.played || m.home_score == null || m.away_score == null) return null;
  if (m.home_score > m.away_score) return m.home_team;
  if (m.away_score > m.home_score) return m.away_team;
  return m.pen_winner || null;
}
function teamPoints(name: string, teams: any[], matches: any[]): number {
  const team = teams.find(t => t.name === name) || {};
  const mine = matches.filter(m => m.home_team === name || m.away_team === name);
  const played = mine.filter(m => m.played && m.home_score != null && m.away_score != null);
  let wins = 0, draws = 0, cs = 0;
  for (const m of played) {
    if ((m.home_team === name ? m.away_score : m.home_score) === 0) cs++;
    const w = matchWinner(m);
    if (w === name) wins++; else if (!w && m.stage === 'group') draws++;
  }
  const stages = new Set(played.map(m => m.stage));
  const champion = matches.some(m => m.stage === 'final' && matchWinner(m) === name);
  let stage = 0; for (const s of ['r32', 'r16', 'qf', 'sf', 'final']) if (stages.has(s)) stage += STAGE_REACH[s];
  if (champion) stage += 3;
  return wins * 3 + draws + cs * 2 + stage + (team.is_underdog ? wins * 3 : 0);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Rate-aware fetch for football-data.org. Reads the throttle headers
// (X-RequestsAvailable / X-RequestCounter-Reset) so we never hammer the limiter:
//  • proactively waits if the previous call left 0 requests in the window
//  • on a 429, waits for the counter to reset (per the header) and retries once
let fdReset = 0, fdAvail: number | null = null;   // carried between calls within one run
async function fdFetch(url: string) {
  if (fdAvail === 0 && fdReset > 0) { await sleep((fdReset + 1) * 1000); fdAvail = null; }
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, { headers: { 'X-Auth-Token': FD_TOKEN } });
    fdAvail = res.headers.get('X-RequestsAvailable') == null ? null : +res.headers.get('X-RequestsAvailable')!;
    fdReset = +(res.headers.get('X-RequestCounter-Reset') || '0');
    if (res.status === 429) {
      if (attempt === 0 && fdReset > 0 && fdReset <= 60) { await sleep((fdReset + 1) * 1000); continue; }
      throw new Error(`rate-limited (429); counter resets in ${fdReset}s`);
    }
    if (!res.ok) throw new Error(`football-data ${res.status}`);
    return { data: await res.json(), avail: fdAvail, reset: fdReset };
  }
  throw new Error('rate-limited after retry');
}

Deno.serve(async () => {
  const log: string[] = [];
  // 1) fetch the tournament from football-data.org (single bulk call, rate-aware)
  let apiMatches: any[] = [];
  try {
    const r = await fdFetch('https://api.football-data.org/v4/competitions/WC/matches');
    apiMatches = r.data.matches || [];
    log.push(`football-data: ${r.avail ?? '?'} requests left (resets in ${r.reset}s)`);
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error).message) }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }

  const { data: rows = [] } = await supabase.from('matches').select('*');
  const sameDay = (a: string | null, b: string | null) => a && b && a.slice(0, 16) === b.slice(0, 16);

  let scores = 0, advanced = 0;
  for (const am of apiMatches) {
    const stage = STAGE[am.stage]; if (!stage) continue;           // skip 3rd-place playoff etc.
    const home = norm(am.homeTeam?.name), away = norm(am.awayTeam?.name);
    const finished = am.status === 'FINISHED';
    const ft = am.score?.fullTime || {};
    const pens = am.score?.duration === 'PENALTY_SHOOTOUT';
    const winner = am.score?.winner === 'HOME_TEAM' ? home : am.score?.winner === 'AWAY_TEAM' ? away : null;

    const patch: any = { kickoff: am.utcDate, venue: am.venue || undefined };
    if (finished) {
      patch.home_score = ft.home; patch.away_score = ft.away; patch.played = true;
      patch.pen_winner = pens ? winner : null;
    }

    // find our row: group → by team pair; knockout → by team pair, else by kickoff (fills a slot)
    let row = rows.find(r => r.stage === stage && r.home_team && r.away_team &&
      ((r.home_team === home && r.away_team === away) || (r.home_team === away && r.away_team === home)));
    if (!row && stage !== 'group' && home && away) {
      row = rows.find(r => r.stage === stage && !r.home_team && sameDay(r.kickoff, am.utcDate)) ||
            rows.find(r => r.stage === stage && !r.home_team && (r.match_no === am.matchday || false));
      if (row) { patch.home_team = home; patch.away_team = away; advanced++; }   // bracket auto-advance
    }

    if (row) {
      await supabase.from('matches').update(patch).eq('id', row.id);
      if (finished) scores++;
    } else if (stage !== 'group' && home && away) {
      await supabase.from('matches').insert({ stage, home_team: home, away_team: away, ...patch, played: !!finished });
      if (home && away) advanced++;
    }
  }
  log.push(`scores updated: ${scores}, knockout teams filled: ${advanced}`);

  // 2) once-per-day standings snapshot (captures pre-today's-games standings on the first run of the day)
  const today = new Date().toISOString().slice(0, 10);
  const { data: todaySnap } = await supabase.from('standings_snapshots').select('captured_on').eq('captured_on', today).limit(1);
  if (!todaySnap?.length) {
    const [{ data: teams = [] }, { data: players = [] }, { data: assigns = [] }, { data: ms = [] }] = await Promise.all([
      supabase.from('teams').select('*'), supabase.from('players').select('*'),
      supabase.from('assignments').select('*'), supabase.from('matches').select('*'),
    ]);
    const ownerOf: Record<string, string> = Object.fromEntries(assigns.map((a: any) => [a.team_name, a.player_id]));
    const board = players.map((p: any) => ({
      id: p.id,
      points: teams.filter((t: any) => ownerOf[t.name] === p.id).reduce((s: number, t: any) => s + teamPoints(t.name, teams, ms), 0),
    })).sort((a, b) => b.points - a.points);
    if (board.length) {
      await supabase.from('standings_snapshots').insert(board.map((p, i) => ({ captured_on: today, player_id: p.id, rank: i + 1, points: p.points })));
      log.push(`snapshot written for ${today} (${board.length} players)`);
    }
  }

  return new Response(JSON.stringify({ ok: true, log }), { headers: { 'Content-Type': 'application/json' } });
});
