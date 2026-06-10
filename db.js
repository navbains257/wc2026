// =====================================================================
//  db.js — Supabase data layer + scoring (the only place points are defined)
// =====================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ↓↓↓ Supabase → Project Settings → API.  The anon/public key is SAFE in client code.
export const SUPABASE_URL  = 'https://tbbbojhhookjjwpqjxpv.supabase.co';
export const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRiYmJvamhob29ramp3cHFqeHB2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwMjgzMzksImV4cCI6MjA5NjYwNDMzOX0.zu4tgscylrlsEixvSd4pVA-ecirfSEU3kvY1M9KOWnk';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

export const STAGE_LABEL = { group:'Group', r32:'Round of 32', r16:'Round of 16',
                             qf:'Quarter-final', sf:'Semi-final', final:'Final' };
const STAGE_ORDER = { group:0, r32:1, r16:2, qf:3, sf:4, final:5 };

// Stage points as INCREMENTS so they sum to the highest-only totals and stay traceable per match:
//   R32 5 · R16 7 · QF 9 · SF 12 · runner-up 15 · winner 18
const STAGE_REACH  = { r32:5, r16:2, qf:2, sf:3, final:3 }; // earned by appearing in that round
const WINNER_BONUS = 3;                                     // extra, on top of reaching the final

export async function fetchAll() {
  const [teams, players, assignments, matches] = await Promise.all([
    supabase.from('teams').select('*'),
    supabase.from('players').select('*'),
    supabase.from('assignments').select('*'),
    supabase.from('matches').select('*'),
  ]);
  for (const r of [teams, players, assignments, matches]) if (r.error) throw r.error;
  // optional tables (exist after migration_v2) — tolerate their absence
  let settings = null, snapshots = [];
  try { const s = await supabase.from('settings').select('*').limit(1).maybeSingle(); if (!s.error) settings = s.data; } catch {}
  try { const s = await supabase.from('standings_snapshots').select('*').order('captured_on', { ascending: false }).limit(96); if (!s.error) snapshots = s.data || []; } catch {}
  return { teams: teams.data, players: players.data,
           assignments: assignments.data, matches: matches.data, settings, snapshots };
}

// Who advanced. Level score in a knockout → decided by the shootout (pen_winner).
export function matchWinner(m) {
  if (!m.played || m.home_score == null || m.away_score == null) return null;
  if (m.home_score > m.away_score) return m.home_team;
  if (m.away_score > m.home_score) return m.away_team;
  return m.pen_winner || null;
}
export function wentToPens(m) {
  return m.played && m.home_score != null && m.home_score === m.away_score && !!m.pen_winner;
}

// ---- full point breakdown for one team ----
export function computePoints(teamName, teams, matches) {
  const team = teams.find(t => t.name === teamName) || {};
  const mine = matches.filter(m => m.home_team === teamName || m.away_team === teamName);

  const played = mine.filter(m => m.played && m.home_score != null && m.away_score != null);
  let wins = 0, draws = 0, cleanSheets = 0, goalsFor = 0;
  for (const m of played) {
    const scored   = (m.home_team === teamName ? m.home_score : m.away_score);
    const conceded = (m.home_team === teamName ? m.away_score : m.home_score);
    goalsFor += scored;
    if (conceded === 0) cleanSheets++;                 // clean sheet = 0 conceded over 120 min (shootout ignored)
    const w = matchWinner(m);
    if (w === teamName) wins++;                        // includes a shootout win
    else if (!w && m.stage === 'group') draws++;       // only group games can draw
    // knockout loss, or knockout not yet decided → no result points
  }

  // stage points: highest-only, built from per-match increments over PLAYED rounds so the
  // headline total always reconciles with the Feed. (In a real bracket no round is skipped,
  // so this equals R32 5 · R16 7 · QF 9 · SF 12 · runner-up 15 · winner 18.)
  const stages = new Set(played.map(m => m.stage));
  const champion = matches.some(m => m.stage === 'final' && matchWinner(m) === teamName);
  let stagePoints = 0;
  for (const s of ['r32', 'r16', 'qf', 'sf', 'final']) if (stages.has(s)) stagePoints += STAGE_REACH[s];
  if (champion) stagePoints += WINNER_BONUS;

  let furthest = 'Group stage';
  if (stages.has('r32')) furthest = 'Round of 32';
  if (stages.has('r16')) furthest = 'Round of 16';
  if (stages.has('qf'))  furthest = 'Quarter-final';
  if (stages.has('sf'))  furthest = 'Semi-final';
  if (stages.has('final')) furthest = champion ? 'Winner' : 'Runner-up';
  const inFinal = stages.has('final');

  const underdog = team.is_underdog ? wins * 3 : 0;
  const total = wins * 3 + draws + cleanSheets * 2 + stagePoints + underdog;

  return { total, wins, draws, cleanSheets, goalsFor, stagePoints, furthest, underdog, champion, runnerUp: inFinal && !champion };
}

// ---- sweepstake league table (by person), tiebreak on total goals scored ----
export function leaderboard({ teams, players, assignments, matches }) {
  const ownerOf = Object.fromEntries(assignments.map(a => [a.team_name, a.player_id]));
  return players.map(p => {
    const myTeams = teams.filter(t => ownerOf[t.name] === p.id);
    let points = 0, goalsFor = 0;
    for (const t of myTeams) { const cp = computePoints(t.name, teams, matches); points += cp.total; goalsFor += cp.goalsFor; }
    return { ...p, points, goalsFor, teamCount: myTeams.length, teams: myTeams };
  }).sort((a, b) => b.points - a.points || b.goalsFor - a.goalsFor || a.name.localeCompare(b.name));
}

// ---- full ranking of all 48 teams by points earned ----
export function teamRanking({ teams, players, assignments, matches }) {
  const ownerOf = Object.fromEntries(assignments.map(a => [a.team_name, a.player_id]));
  const pName = Object.fromEntries(players.map(p => [p.id, p.name]));
  return teams.map(t => ({ ...t, owner: pName[ownerOf[t.name]] || null,
                           ...computePoints(t.name, teams, matches) }))
              .sort((a, b) => b.total - a.total || a.fifa_rank - b.fifa_rank);
}

// ---- real World Cup group tables ----
export function groupStandings(teams, matches) {
  const groups = {};
  for (const t of teams)
    (groups[t.grp] ||= []).push({ team: t.name, is_underdog: t.is_underdog,
                                  P:0, W:0, D:0, L:0, GF:0, GA:0, GD:0, Pts:0 });
  const grpOf = Object.fromEntries(teams.map(t => [t.name, t.grp]));
  const row = (g, n) => groups[g].find(r => r.team === n);
  for (const m of matches) {
    if (m.stage !== 'group' || !m.played || m.home_score == null || m.away_score == null) continue;
    const g = grpOf[m.home_team], h = row(g, m.home_team), a = row(g, m.away_team);
    if (!h || !a) continue;
    h.P++; a.P++; h.GF += m.home_score; h.GA += m.away_score; a.GF += m.away_score; a.GA += m.home_score;
    if (m.home_score > m.away_score) { h.W++; h.Pts += 3; a.L++; }
    else if (m.home_score < m.away_score) { a.W++; a.Pts += 3; h.L++; }
    else { h.D++; a.D++; h.Pts++; a.Pts++; }
  }
  for (const g in groups) {
    groups[g].forEach(r => r.GD = r.GF - r.GA);
    groups[g].sort((x, y) => y.Pts - x.Pts || y.GD - x.GD || y.GF - x.GF || x.team.localeCompare(y.team));
  }
  return groups;
}

// ---- upcoming fixtures, soonest first, tagged with owners ----
export function upcoming({ matches, teams, assignments, players }) {
  const ownerOf = Object.fromEntries(assignments.map(a => [a.team_name, a.player_id]));
  const pName = Object.fromEntries(players.map(p => [p.id, p.name]));
  return matches.filter(m => !m.played)
    .map(m => ({ ...m, home_owner: pName[ownerOf[m.home_team]] || null,
                       away_owner: pName[ownerOf[m.away_team]] || null }))
    .sort((a, b) => {
      const ak = a.kickoff ? Date.parse(a.kickoff) : Infinity;
      const bk = b.kickoff ? Date.parse(b.kickoff) : Infinity;
      return ak - bk || STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage] || a.home_team.localeCompare(b.home_team);
    });
}

// ---- knockout bracket ----
export function bracket(matches) {
  const out = {};
  for (const s of ['r32', 'r16', 'qf', 'sf', 'final'])
    out[s] = matches.filter(m => m.stage === s)
      .sort((a, b) => (a.kickoff ? Date.parse(a.kickoff) : Infinity) - (b.kickoff ? Date.parse(b.kickoff) : Infinity));
  return out;
}

// ---- results feed: every played match + exactly which points each side earned ----
export function feed({ teams, players, assignments, matches }) {
  const ownerOf = Object.fromEntries(assignments.map(a => [a.team_name, a.player_id]));
  const pName = Object.fromEntries(players.map(p => [p.id, p.name]));
  const isDog = Object.fromEntries(teams.map(t => [t.name, t.is_underdog]));

  const played = matches.filter(m => m.played && m.home_score != null && m.away_score != null);
  played.sort((a, b) => {
    const ak = a.kickoff ? Date.parse(a.kickoff) : 0, bk = b.kickoff ? Date.parse(b.kickoff) : 0;
    return bk - ak || STAGE_ORDER[b.stage] - STAGE_ORDER[a.stage];   // newest first
  });

  return played.map(m => {
    const w = matchWinner(m);
    const awards = ['home', 'away'].map(side => {
      const team = side === 'home' ? m.home_team : m.away_team;
      const opp  = side === 'home' ? m.away_score : m.home_score;
      const items = [];
      if (w === team) { items.push({ label: 'Win', pts: 3 }); if (isDog[team]) items.push({ label: 'Underdog bonus', pts: 3 }); }
      else if (!w && m.stage === 'group') items.push({ label: 'Draw', pts: 1 });
      if (opp === 0) items.push({ label: 'Clean sheet', pts: 2 });
      if (STAGE_REACH[m.stage]) items.push({ label: `Reached ${STAGE_LABEL[m.stage]}`, pts: STAGE_REACH[m.stage] });
      if (m.stage === 'final' && w === team) items.push({ label: 'Champion', pts: WINNER_BONUS });
      return { team, owner: pName[ownerOf[team]] || null, items, total: items.reduce((s, i) => s + i.pts, 0) };
    });
    return { ...m, winner: w, pens: wentToPens(m), awards };
  });
}

// ---- the race for the 8 best third-placed teams ----
export function bestThirds(teams, matches) {
  const g = groupStandings(teams, matches);
  const thirds = Object.keys(g).sort().map(k => ({ grp: k, ...g[k][2] }));   // 3rd row of each group
  // FIFA ranks thirds by: points, then GD, then GF (then fair play / lots — not modelled)
  const ranked = [...thirds].sort((x, y) => y.Pts - x.Pts || y.GD - x.GD || y.GF - x.GF || x.team.localeCompare(y.team));
  ranked.forEach((r, i) => { r.thirdRank = i + 1; r.qualified = i < 8; });
  return ranked;
}

// ---- rank movers vs the most recent standings snapshot ----
// snapshots: rows {player_id, rank, points, captured_on}. Returns { [player_id]: delta } (+ = climbed).
export function movers(currentBoard, snapshots) {
  if (!snapshots || !snapshots.length) return {};
  const latest = snapshots[0].captured_on;                       // snapshots come ordered desc
  const prevRank = {};
  for (const s of snapshots) if (s.captured_on === latest) prevRank[s.player_id] = s.rank;
  const out = {};
  currentBoard.forEach((p, i) => {
    const was = prevRank[p.id];
    out[p.id] = was == null ? null : was - (i + 1);              // positive = moved up the table
  });
  return out;
}

// ---- prize pot with side pots ----
// Players can buy in for less; each "contribution layer" is won only by players who paid into it,
// ranked among themselves, so a short stake is capped to the layers it funded and the remainder
// cascades to the next eligible player. Conserves money: sum of net positions = 0.
export function pot({ settings, players }, board) {
  const currency = settings?.currency ?? '£';
  const standard = settings?.buy_in ?? 0;
  const pct = { winner: settings?.split_winner ?? 70, runnerUp: settings?.split_runner_up ?? 20, spoon: settings?.split_spoon ?? 10 };

  // contribution per player (their own buy_in overrides the standard; unpaid = 0)
  const contribOf = {};
  let total = 0;
  for (const p of players) { const c = p.paid ? (p.buy_in ?? standard) : 0; contribOf[p.id] = c; total += c; }

  // paid players in current standing order (board is best→worst)
  const ranked = board.filter(p => contribOf[p.id] > 0);

  const winnings = {};
  for (const p of players) winnings[p.id] = 0;

  // build contribution layers (poker side pots) and split each among its eligible players
  const levels = [...new Set(ranked.map(p => contribOf[p.id]))].sort((a, b) => a - b);
  let prev = 0;
  for (const lvl of levels) {
    const eligible = ranked.filter(p => contribOf[p.id] >= lvl);   // already standing-ordered
    const layerTotal = (lvl - prev) * eligible.length;
    prev = lvl;
    if (!eligible.length || layerTotal <= 0) continue;
    const slots = [[eligible[0], pct.winner], [eligible[1], pct.runnerUp], [eligible[eligible.length - 1], pct.spoon]]
      .filter(([pl]) => pl);                       // drop positions that don't exist in a tiny field
    const denom = slots.reduce((s, [, sh]) => s + sh, 0) || 1;   // renormalise so the whole layer is paid out
    for (const [pl, sh] of slots) winnings[pl.id] += layerTotal * sh / denom;
  }

  const paidById = Object.fromEntries(players.map(p => [p.id, p]));
  const rows = board.map(p => {
    const contribution = contribOf[p.id];
    const win = winnings[p.id] || 0;
    return { id: p.id, name: p.name, paid: !!paidById[p.id]?.paid, contribution, winnings: win, net: win - contribution };
  });
  const shorts = players.filter(p => p.paid && p.buy_in != null && p.buy_in < standard).map(p => ({ name: p.name, buyIn: p.buy_in }));
  return { currency, standard, total, paidCount: ranked.length, totalPlayers: players.length, rows, shorts };
}

// ---- flags (flagcdn, cross-platform incl. Windows; home-nations get gb-eng/gb-sct) ----
export const TEAM_ISO = {
  'Mexico':'mx','South Korea':'kr','South Africa':'za','Czechia':'cz','Canada':'ca','Switzerland':'ch',
  'Qatar':'qa','Bosnia-Herzegovina':'ba','Brazil':'br','Morocco':'ma','Scotland':'gb-sct','Haiti':'ht',
  'USA':'us','Paraguay':'py','Australia':'au','Turkey':'tr','Germany':'de','Ecuador':'ec','Ivory Coast':'ci',
  'Curaçao':'cw','Netherlands':'nl','Japan':'jp','Tunisia':'tn','Sweden':'se','Belgium':'be','Iran':'ir',
  'Egypt':'eg','New Zealand':'nz','Spain':'es','Uruguay':'uy','Saudi Arabia':'sa','Cape Verde':'cv',
  'France':'fr','Senegal':'sn','Norway':'no','Iraq':'iq','Argentina':'ar','Austria':'at','Algeria':'dz',
  'Jordan':'jo','Portugal':'pt','Colombia':'co','Uzbekistan':'uz','DR Congo':'cd','England':'gb-eng',
  'Croatia':'hr','Panama':'pa','Ghana':'gh',
};
export const flagUrl = name => { const iso = TEAM_ISO[name]; return iso ? `https://flagcdn.com/20x15/${iso}.png` : null; };
