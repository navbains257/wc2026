// =====================================================================
//  Scoring tests — assert db.js behaviour without editing any rule.
//  Run: npm test   (uses tests/loader-register.mjs to resolve db.js's
//  browser-native Supabase import to the local package).
// =====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  matchWinner, wentToPens, computePoints, leaderboard,
  groupStandings, bestThirds, movers, pot, feed,
} from '../db.js';

// ---- helpers ----
let _id = 0;
function m(stage, home, away, hs, as, opts = {}) {
  return {
    id: `m${_id++}`, stage, home_team: home, away_team: away,
    home_score: hs, away_score: as, played: true,
    pen_winner: opts.pen_winner ?? null, kickoff: opts.kickoff ?? null,
  };
}
// A knockout run: team wins every round up to `furthest`, where it loses (1-2),
// unless `win` is set — then the final is a 0-0 won on penalties (champion).
function runTo(team, furthest, win = false) {
  const order = ['r32', 'r16', 'qf', 'sf', 'final'];
  const idx = order.indexOf(furthest);
  const ms = [];
  for (let i = 0; i <= idx; i++) {
    const stage = order[i];
    if (i < idx) ms.push(m(stage, team, `Opp${i}`, 1, 0));            // won this round
    else if (win) ms.push(m(stage, team, `Opp${i}`, 0, 0, { pen_winner: team })); // champion on pens
    else ms.push(m(stage, team, `Opp${i}`, 1, 2));                    // eliminated here
  }
  return ms;
}

// =====================================================================
//  Highest-only stage points: R32 5 · R16 7 · QF 9 · SF 12 · RU 15 · W 18
// =====================================================================
test('stage points are highest-only and match the published ladder', () => {
  const rungs = [
    ['r32', 5, 'Round of 32'],
    ['r16', 7, 'Round of 16'],
    ['qf', 9, 'Quarter-final'],
    ['sf', 12, 'Semi-final'],
    ['final', 15, 'Runner-up'], // lost the final
  ];
  for (const [stage, pts, furthest] of rungs) {
    const cp = computePoints('Spain', [], runTo('Spain', stage));
    assert.equal(cp.stagePoints, pts, `${stage} → ${pts}`);
    assert.equal(cp.furthest, furthest);
  }
  // winner: full run, final won on penalties → 18 and "Winner"
  const champ = computePoints('Spain', [], runTo('Spain', 'final', true));
  assert.equal(champ.stagePoints, 18);
  assert.equal(champ.furthest, 'Winner');
  assert.equal(champ.champion, true);
  assert.equal(champ.runnerUp, false);
});

// =====================================================================
//  Knockouts never draw
// =====================================================================
test('a level knockout with no shootout has no winner and scores no draw', () => {
  const ms = [m('r16', 'Spain', 'Brazil', 1, 1)]; // level, no pen_winner
  assert.equal(matchWinner(ms[0]), null);
  assert.equal(wentToPens(ms[0]), false);
  assert.equal(computePoints('Spain', [], ms).draws, 0);
  assert.equal(computePoints('Brazil', [], ms).draws, 0);
});

test('a level GROUP game is a draw worth 1 to each side', () => {
  const ms = [m('group', 'Spain', 'Brazil', 1, 1)];
  assert.equal(matchWinner(ms[0]), null);
  assert.equal(computePoints('Spain', [], ms).draws, 1);
  assert.equal(computePoints('Brazil', [], ms).draws, 1);
});

// =====================================================================
//  Penalty shootout: 3pts to the shootout winner, clean sheet on a level 0-0
// =====================================================================
test('a 0-0 settled on penalties: winner gets the win, both keep a clean sheet', () => {
  const ms = [m('r16', 'Spain', 'Brazil', 0, 0, { pen_winner: 'Spain' })];
  assert.equal(matchWinner(ms[0]), 'Spain');
  assert.equal(wentToPens(ms[0]), true);

  const sp = computePoints('Spain', [], ms);
  assert.equal(sp.wins, 1);            // shootout win counts as a win (3pts)
  assert.equal(sp.cleanSheets, 1);     // 0 conceded over 120 min
  assert.equal(sp.total, 3 + 2 + 2);   // win + clean sheet + r16 reach

  const br = computePoints('Brazil', [], ms);
  assert.equal(br.wins, 0);
  assert.equal(br.cleanSheets, 1);     // loser of the shootout still kept a clean sheet
  assert.equal(br.total, 0 + 2 + 2);

  // the shootout win shows in the Feed worth exactly 3
  const f = feed({ teams: [], players: [], assignments: [], matches: ms });
  const spainAward = f[0].awards.find(a => a.team === 'Spain');
  assert.deepEqual(spainAward.items.find(i => i.label === 'Win'), { label: 'Win', pts: 3 });
});

// =====================================================================
//  Underdog bonus: +3 per win
// =====================================================================
test('an underdog earns +3 per win on top of the win itself', () => {
  const teams = [{ name: 'Qatar', is_underdog: true }, { name: 'Mexico', is_underdog: false }];
  const ms = [m('group', 'Qatar', 'Mexico', 1, 0)];
  const q = computePoints('Qatar', teams, ms);
  assert.equal(q.wins, 1);
  assert.equal(q.underdog, 3);
  assert.equal(q.total, 3 + 2 + 3); // win + clean sheet + underdog bonus
  // a non-underdog winning the same game gets no bonus
  const ms2 = [m('group', 'Mexico', 'Qatar', 1, 0)];
  assert.equal(computePoints('Mexico', teams, ms2).underdog, 0);
});

// =====================================================================
//  Champion via a penalty final
// =====================================================================
test('the final won on penalties makes that team champion', () => {
  const ms = [m('final', 'Argentina', 'France', 0, 0, { pen_winner: 'Argentina' })];
  assert.equal(matchWinner(ms[0]), 'Argentina');
  const cp = computePoints('Argentina', [], ms);
  assert.equal(cp.champion, true);
  assert.equal(cp.runnerUp, false);
  // France reached the final but lost the shootout → runner-up, not champion
  const fr = computePoints('France', [], ms);
  assert.equal(fr.champion, false);
  assert.equal(fr.runnerUp, true);
  // Feed shows the Champion bonus (worth 3) only for the winner
  const f = feed({ teams: [], players: [], assignments: [], matches: ms });
  assert.ok(f[0].awards.find(a => a.team === 'Argentina').items.some(i => i.label === 'Champion' && i.pts === 3));
  assert.ok(!f[0].awards.find(a => a.team === 'France').items.some(i => i.label === 'Champion'));
});

// =====================================================================
//  Each team's Feed entries sum to its computed total
// =====================================================================
test("every team's Feed awards sum to its computePoints total", () => {
  // A champion run (groups + full knockout, final on pens) plus an underdog group win.
  const teams = [
    { name: 'France', is_underdog: false },
    { name: 'Qatar', is_underdog: true },
    { name: 'Mexico', is_underdog: false },
  ];
  const ms = [
    m('group', 'France', 'GA', 2, 0),
    m('group', 'France', 'GB', 1, 1),
    m('group', 'France', 'GC', 3, 1),
    m('r32', 'France', 'D', 2, 1),
    m('r16', 'France', 'E', 1, 0),
    m('qf', 'France', 'F', 0, 0, { pen_winner: 'France' }),
    m('sf', 'France', 'G', 2, 1),
    m('final', 'France', 'H', 0, 0, { pen_winner: 'France' }),
    m('group', 'Qatar', 'Mexico', 1, 0),
  ];
  const players = [], assignments = [];
  const f = feed({ teams, players, assignments, matches: ms });

  // aggregate every Feed award by team
  const feedTotal = {};
  for (const match of f)
    for (const a of match.awards)
      feedTotal[a.team] = (feedTotal[a.team] || 0) + a.total;

  const names = new Set(ms.flatMap(x => [x.home_team, x.away_team]));
  for (const name of names) {
    const cp = computePoints(name, teams, ms);
    assert.equal(feedTotal[name] ?? 0, cp.total, `${name}: Feed sum must equal total`);
  }
  // sanity: the champion's total is the full 48 we expect
  assert.equal(computePoints('France', teams, ms).total, 48);
});

// =====================================================================
//  Goals-scored tiebreaker on the league table
// =====================================================================
test('the leaderboard breaks ties on total goals scored', () => {
  const players = [{ id: 'p1', name: 'Alice' }, { id: 'p2', name: 'Bob' }];
  const teams = [
    { name: 'T1', is_underdog: false, fifa_rank: 1 },
    { name: 'T2', is_underdog: false, fifa_rank: 2 },
  ];
  const assignments = [{ team_name: 'T1', player_id: 'p1' }, { team_name: 'T2', player_id: 'p2' }];
  // both teams win a group game 3pts + clean sheet, but T2 scored more goals
  const matches = [m('group', 'T1', 'X', 1, 0), m('group', 'T2', 'Y', 4, 0)];
  const board = leaderboard({ teams, players, assignments, matches });
  assert.equal(board[0].points, board[1].points);  // tied on points
  assert.equal(board[0].name, 'Bob');               // more goals → ranked first
  assert.equal(board[1].name, 'Alice');
});

// =====================================================================
//  Best-thirds ordering
// =====================================================================
test('bestThirds ranks third-placed teams by points, then GD, GF, name', () => {
  const teams = [
    { name: 'A1', grp: 'A', is_underdog: false }, { name: 'A2', grp: 'A', is_underdog: false }, { name: 'A3', grp: 'A', is_underdog: false },
    { name: 'B1', grp: 'B', is_underdog: false }, { name: 'B2', grp: 'B', is_underdog: false }, { name: 'B3', grp: 'B', is_underdog: false },
    { name: 'C1', grp: 'C', is_underdog: false }, { name: 'C2', grp: 'C', is_underdog: false }, { name: 'C3', grp: 'C', is_underdog: false },
  ];
  const matches = [
    // Group A: A3 finishes last on 0 pts (GD -4)
    m('group', 'A1', 'A2', 1, 0), m('group', 'A1', 'A3', 1, 0), m('group', 'A2', 'A3', 2, 0),
    // Group B: all 0-0, third place (by name) is B3 on 2 pts
    m('group', 'B1', 'B2', 0, 0), m('group', 'B1', 'B3', 0, 0), m('group', 'B2', 'B3', 0, 0),
    // Group C: C3 finishes last on 0 pts (GD -4)
    m('group', 'C1', 'C2', 3, 0), m('group', 'C1', 'C3', 3, 0), m('group', 'C2', 'C3', 1, 0),
  ];
  const ranked = bestThirds(teams, matches);
  assert.equal(ranked[0].team, 'B3'); // 2 pts beats the 0-pointers
  assert.equal(ranked[1].team, 'A3'); // A3 & C3 tie on 0/-4/0 → name breaks it
  assert.equal(ranked[2].team, 'C3');
  assert.deepEqual(ranked.map(r => r.thirdRank), [1, 2, 3]);
  assert.ok(ranked.every(r => r.qualified)); // only three thirds → all within the 8
});

// =====================================================================
//  Rank movers vs the latest snapshot
// =====================================================================
test('movers reports +climb / -slide / 0 / null against the latest snapshot', () => {
  const board = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }]; // current ranks 1..4
  const snapshots = [
    // latest day (desc-ordered, so [0] is newest)
    { player_id: 'p2', rank: 1, captured_on: '2026-06-08' },
    { player_id: 'p1', rank: 2, captured_on: '2026-06-08' },
    { player_id: 'p3', rank: 3, captured_on: '2026-06-08' },
    // an older day that must be ignored
    { player_id: 'p1', rank: 1, captured_on: '2026-06-01' },
  ];
  const d = movers(board, snapshots);
  assert.equal(d.p1, 1);   // was 2nd, now 1st → climbed one
  assert.equal(d.p2, -1);  // was 1st, now 2nd → slid one
  assert.equal(d.p3, 0);   // unchanged
  assert.equal(d.p4, null); // not in the snapshot → no delta
  assert.deepEqual(movers(board, []), {}); // no snapshots → empty
});

// =====================================================================
//  Pot maths
// =====================================================================
test('pot totals only paid players and splits 70/20/10 across the standings', () => {
  const settings = { buy_in: 10, currency: '£', split_winner: 70, split_runner_up: 20, split_spoon: 10 };
  const players = [
    { id: 'p1', name: 'Alice', paid: true }, { id: 'p2', name: 'Bob', paid: true },
    { id: 'p3', name: 'Cara', paid: true }, { id: 'p4', name: 'Dan', paid: true },
    { id: 'p5', name: 'Eve', paid: false },
  ];
  const board = [{ name: 'Alice' }, { name: 'Bob' }, { name: 'Cara' }, { name: 'Dan' }, { name: 'Eve' }];
  const p = pot({ settings, players }, board);
  assert.equal(p.paidCount, 4);
  assert.equal(p.total, 40);                 // 4 paid × £10
  assert.equal(p.payouts.winner.amount, 28); // 70%
  assert.equal(p.payouts.runnerUp.amount, 8);// 20%
  assert.equal(p.payouts.spoon.amount, 4);   // 10%
  assert.equal(p.payouts.winner.name, 'Alice');
  assert.equal(p.payouts.spoon.name, 'Eve'); // wooden spoon = last on the board

  // defaults when settings is absent
  const d = pot({ settings: null, players }, board);
  assert.equal(d.buyIn, 0);
  assert.equal(d.currency, '£');
  assert.equal(d.total, 0);
  assert.equal(d.payouts.winner.pct, 70);
});
