// =====================================================================
//  import_fixtures.mjs
//  Loads exact kickoff times + venues for all 104 World Cup 2026 matches into
//  Supabase, straight from the official ICS calendar — no hand-typing, no guessing.
//
//  Why an importer and not a big SQL file of times? Kickoff times come from one
//  source of truth (the calendar), so they're always right and timezone-correct.
//
//  SETUP
//   1. Run schema.sql, then migration_fixtures.sql, in Supabase.
//   2. Download the official 2026 World Cup schedule as an .ics file (FIFA.com offers
//      "add to calendar" / a full-tournament .ics; most schedule sites do too).
//   3. npm i @supabase/supabase-js
//   4. Use your SERVICE ROLE key (Project Settings → API) — it can write and bypasses RLS.
//      Keep it OUT of your repo (it's only used locally here).
//
//      SUPABASE_URL="https://YOUR-PROJECT.supabase.co" \
//      SUPABASE_SERVICE_KEY="eyJ...service-role..." \
//      node import_fixtures.mjs worldcup2026.ics
//
//  What it does:
//   • Group games (already seeded by schema.sql) → matched by the two team names and
//     updated with kickoff, venue, match number.
//   • Knockout games → inserted as dated slots (slot_home / slot_away labels like
//     "Winner Group A"); you set the real teams later once the groups finish.
//
//  If your .ics names teams differently, extend the NAME map below.
// =====================================================================
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY, icsPath = process.argv[2];
if (!URL || !KEY || !icsPath) {
  console.error('Usage: SUPABASE_URL=.. SUPABASE_SERVICE_KEY=.. node import_fixtures.mjs <file.ics>');
  process.exit(1);
}
const supabase = createClient(URL, KEY);

// ICS spelling -> our teams.name
const NAME = {
  'Korea Republic':'South Korea','Republic of Korea':'South Korea',
  'United States':'USA','United States of America':'USA',
  'Türkiye':'Turkey','Turkiye':'Turkey',
  'Bosnia and Herzegovina':'Bosnia-Herzegovina','Bosnia & Herzegovina':'Bosnia-Herzegovina',
  "Côte d'Ivoire":'Ivory Coast',"Cote d'Ivoire":'Ivory Coast',
  'Curacao':'Curaçao',
  'Congo DR':'DR Congo','Democratic Republic of the Congo':'DR Congo',
  'Czech Republic':'Czechia',
  'IR Iran':'Iran',
  'Cabo Verde':'Cape Verde',
};
const norm = s => { s = (s || '').trim(); return NAME[s] || s; };

// match number -> our stage (standard 2026 numbering)
const stageFromNo = n => !n ? null : n <= 72 ? 'group' : n <= 88 ? 'r32' : n <= 96 ? 'r16'
                       : n <= 100 ? 'qf' : n <= 102 ? 'sf' : n === 103 ? 'third' : 'final';
const stageFromText = s => { s = s.toLowerCase();
  if (s.includes('round of 32')) return 'r32';
  if (s.includes('round of 16')) return 'r16';
  if (s.includes('quarter')) return 'qf';
  if (s.includes('semi')) return 'sf';
  if (s.includes('third') || s.includes('3rd')) return 'third';
  if (s.includes('final')) return 'final';
  return null;
};

// minimal ICS parser
function parseICS(text) {
  text = text.replace(/\r?\n[ \t]/g, '');                 // unfold wrapped lines
  const events = []; let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = line.indexOf(':'); if (i < 0) continue;
    cur[line.slice(0, i).split(';')[0]] = line.slice(i + 1);
  }
  return events;
}
function icsDate(v) {                                       // 20260611T190000Z -> ISO. Assumes UTC (trailing Z),
  const m = (v || '').match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?/);  // which the official FIFA .ics uses.
  if (!m) return null;                                      // (A TZID-only file would need its offset applied.)
  const [, Y, Mo, D, h, mi, s, z] = m;
  return z ? new Date(Date.UTC(+Y, +Mo - 1, +D, +h, +mi, +s)).toISOString()
           : `${Y}-${Mo}-${D}T${h}:${mi}:${s}`;
}

const events = parseICS(readFileSync(icsPath, 'utf8'));
console.log(`Parsed ${events.length} calendar events`);

const { data: teams, error: te } = await supabase.from('teams').select('name');
if (te) { console.error(te); process.exit(1); }
const known = new Set(teams.map(t => t.name));

let groupSet = 0, slots = 0, skipped = 0;
for (const ev of events) {
  const summary = ev.SUMMARY || '';
  const kickoff = icsDate(ev.DTSTART);
  const venue = ev.LOCATION || null;
  const noM = summary.match(/match\s*#?\s*(\d{1,3})/i);
  const matchNo = noM ? +noM[1] : null;

  // split "Team A vs Team B" (prefer vs/v; fall back to a dash), after any "Group X:" / "Match N:" prefix
  const body = summary.replace(/^.*?:\s*/, '');
  let parts = body.split(/\s+(?:vs?\.?|v)\s+/i);
  if (parts.length < 2) parts = body.split(/\s+[-–]\s+/);
  const home = norm(parts[0]);
  const away = norm((parts[1] || '').replace(/\s*\(.*$/, ''));

  if (known.has(home) && known.has(away)) {                // group game already seeded
    const { data, error } = await supabase.from('matches')
      .update({ kickoff, venue, match_no: matchNo })
      .eq('stage', 'group')
      .or(`and(home_team.eq.${home},away_team.eq.${away}),and(home_team.eq.${away},away_team.eq.${home})`)
      .select();
    if (error) { console.warn('update failed:', summary, '→', error.message); continue; }
    if (data?.length) groupSet++; else { skipped++; console.log('no group row for', home, 'vs', away); }
  } else {                                                  // knockout slot
    const stage = stageFromText(summary) || stageFromNo(matchNo);
    if (!stage || stage === 'third') { skipped++; continue; } // 3rd-place playoff isn't scored
    const { error } = await supabase.from('matches').insert({
      stage, match_no: matchNo, slot_home: parts[0] || 'TBD', slot_away: (parts[1] || 'TBD').trim(),
      kickoff, venue, played: false,
    });
    if (error) console.warn('insert failed:', summary, '→', error.message); else slots++;
  }
}
console.log(`Done. Group kickoffs set: ${groupSet} · knockout slots inserted: ${slots} · skipped: ${skipped}`);
