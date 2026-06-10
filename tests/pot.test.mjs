// tests/pot.test.mjs — side-pot payouts + conservation
// Runs under the same loader as the other tests (npm test). Imports the real pot() from db.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pot } from '../db.js';

const settings = { buy_in: 20, currency: '£', split_winner: 70, split_runner_up: 20, split_spoon: 10 };

// 6 players; "s" buys in for £10, everyone else the standard £20.
const players = [
  { id: 's', name: 'Short', paid: true, buy_in: 10 },
  { id: 'a', name: 'A', paid: true, buy_in: null },
  { id: 'b', name: 'B', paid: true, buy_in: null },
  { id: 'c', name: 'C', paid: true, buy_in: null },
  { id: 'd', name: 'D', paid: true, buy_in: null },
  { id: 'e', name: 'E', paid: true, buy_in: null },
];

const boardOf = order => order.map(id => ({ id, name: players.find(p => p.id === id).name }));
const near = (a, b) => Math.abs(a - b) < 1e-6;
const win = (P, id) => P.rows.find(r => r.id === id).winnings;
const net = (P, id) => P.rows.find(r => r.id === id).net;

function assertConserves(P) {
  const stakes  = P.rows.reduce((s, r) => s + r.contribution, 0);
  const payouts = P.rows.reduce((s, r) => s + r.winnings, 0);
  const netSum  = P.rows.reduce((s, r) => s + r.net, 0);
  assert.ok(near(payouts, P.total), `payouts (${payouts}) should equal pot (${P.total})`);
  assert.ok(near(stakes,  P.total), `stakes (${stakes}) should equal pot (${P.total})`);
  assert.ok(near(netSum, 0),        `net positions should sum to zero (got ${netSum})`);
}

test('pot total includes the short stake', () => {
  const P = pot({ settings, players }, boardOf(['s', 'a', 'b', 'c', 'd', 'e']));
  assert.equal(P.total, 110);            // 5×20 + 10
  assert.equal(P.shorts.length, 1);
  assert.equal(P.shorts[0].buyIn, 10);
});

test('short player 1st is capped to the main pot; rest cascades to 2nd and 3rd', () => {
  const P = pot({ settings, players }, boardOf(['s', 'a', 'b', 'c', 'd', 'e']));
  assert.ok(near(win(P, 's'), 42), 'short capped at main-layer winner share (not 0.7×110)');
  assert.ok(near(win(P, 'a'), 47), '2nd: main runner-up 12 + side winner 35');
  assert.ok(near(win(P, 'b'), 10), '3rd: side runner-up');
  assertConserves(P);
});

test('short player 2nd is capped; rest cascades to 3rd', () => {
  const P = pot({ settings, players }, boardOf(['a', 's', 'b', 'c', 'd', 'e']));
  assert.ok(near(win(P, 's'), 12), 'short capped at main-layer runner-up share');
  assert.ok(near(win(P, 'a'), 77), '1st takes winner across both layers');
  assert.ok(near(win(P, 'b'), 10), 'side runner-up cascades to 3rd');
  assertConserves(P);
});

test('short player last is capped; rest cascades to second-last', () => {
  const P = pot({ settings, players }, boardOf(['a', 'b', 'c', 'd', 'e', 's']));
  assert.ok(near(win(P, 's'), 6), 'short capped at main-layer spoon share');
  assert.ok(near(win(P, 'e'), 5), 'side spoon cascades to second-last');
  assert.ok(near(win(P, 'a'), 77));
  assertConserves(P);
});

test('short player mid-table wins nothing and simply staked less', () => {
  const P = pot({ settings, players }, boardOf(['a', 'b', 's', 'c', 'd', 'e']));
  assert.ok(near(win(P, 's'), 0));
  assert.ok(near(net(P, 's'), -10));
  assertConserves(P);
});

test('with everyone equal it behaves as a normal pot', () => {
  const equal = players.map(p => ({ ...p, buy_in: null }));   // no short stake
  const P = pot({ settings, players: equal }, boardOf(['a', 'b', 'c', 'd', 'e', 's']));
  assert.equal(P.total, 120);
  assert.ok(near(win(P, 'a'), 84), 'winner 70% of 120');
  assert.ok(near(win(P, 'b'), 24), 'runner-up 20%');
  assert.ok(near(win(P, 's'), 12), 'spoon 10% (last place)');
  assert.equal(P.shorts.length, 0);
  assertConserves(P);
});

test('unpaid players are excluded from the pot', () => {
  const withUnpaid = players.map(p => (p.id === 'e' ? { ...p, paid: false } : p));
  const P = pot({ settings, players: withUnpaid }, boardOf(['a', 'b', 'c', 'd', 'e', 's']));
  assert.equal(P.total, 90);             // short £10 + A,B,C,D £20 each; E not in
  assert.ok(near(win(P, 'e'), 0));
  assert.ok(near(net(P, 'e'), 0));
  assertConserves(P);
});

test('conserves regardless of where the short player finishes', () => {
  const ids = ['s', 'a', 'b', 'c', 'd', 'e'];
  for (let i = 0; i < ids.length; i++) {                       // short player in every position
    const order = [...ids.slice(i), ...ids.slice(0, i)];
    assertConserves(pot({ settings, players }, boardOf(order)));
  }
});
