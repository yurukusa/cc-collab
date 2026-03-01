#!/usr/bin/env node
/**
 * cc-collab — Are you getting better at working with Claude Code?
 *
 * Combines session hours (from ~/.claude/ JSONL) with git commit data
 * to compute weekly efficiency: commits per CC hour.
 *
 * This answers: "Is my Claude Code collaboration improving over time?"
 *
 * Zero dependencies. Node.js 18+. ESM.
 */

import { readdir, stat, open } from 'node:fs/promises';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();

// ── Config ────────────────────────────────────────────────────────────────────
const MAX_SESSION_HOURS = 8; // filter out autonomous runs (cc-loop etc)
const SESSION_GAP_HOURS = 0.5;

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const helpFlag  = args.includes('--help') || args.includes('-h');
const jsonFlag  = args.includes('--json');
const weeksFlag = args.find(a => a.startsWith('--weeks='));
const WEEKS     = weeksFlag ? Math.max(2, Math.min(52, parseInt(weeksFlag.replace('--weeks=', '')) || 8)) : 8;

if (helpFlag) {
  console.log(`cc-collab — Measure your Claude Code collaboration efficiency over time

USAGE
  npx cc-collab [options]

OPTIONS
  --weeks=N   Number of weeks to analyze (default: 8, max: 52)
  --json      Output JSON for piping / other tools
  --help      Show this help

OUTPUT
  Weekly breakdown of: CC hours, commits, efficiency (commits/hour), lines/hour
  Trend indicator: improving / plateauing / declining

EXAMPLE
  npx cc-collab              # Last 8 weeks
  npx cc-collab --weeks=12   # Last 12 weeks
  npx cc-collab --json       # JSON output
`);
  process.exit(0);
}

// ── Helpers: JSONL session reading (same as cc-session-stats) ─────────────────
async function readFirstLastLine(filePath) {
  const fh = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, 8192, 0);
    if (bytesRead === 0) return null;
    const firstChunk = buf.toString('utf8', 0, bytesRead);
    const firstNewline = firstChunk.indexOf('\n');
    const firstLine = firstNewline >= 0 ? firstChunk.substring(0, firstNewline) : firstChunk;

    const fileStat = await fh.stat();
    const fileSize = fileStat.size;
    if (fileSize < 2) return { firstLine, lastLine: firstLine };

    const readSize = Math.min(65536, fileSize);
    const tailBuf = Buffer.alloc(readSize);
    const { bytesRead: tailBytes } = await fh.read(tailBuf, 0, readSize, fileSize - readSize);
    const tailChunk = tailBuf.toString('utf8', 0, tailBytes);
    const lines = tailChunk.split('\n').filter(l => l.trim());
    const lastLine = lines[lines.length - 1] || firstLine;
    return { firstLine, lastLine };
  } finally {
    await fh.close();
  }
}

function parseTimestamp(jsonLine) {
  try {
    const data = JSON.parse(jsonLine);
    const ts = data.timestamp || data.ts;
    if (ts) return new Date(ts);
  } catch {}
  return null;
}

// Returns Monday of the week containing `date`
function weekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day; // Monday=0
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function weekKey(date) {
  return weekStart(date).toISOString().slice(0, 10); // YYYY-MM-DD of Monday
}

// ── Scan CC sessions ──────────────────────────────────────────────────────────
async function scanSessions(claudeDir) {
  const projectsDir = join(claudeDir, 'projects');
  const sessions = [];

  let projectDirs;
  try { projectDirs = await readdir(projectsDir); } catch { return sessions; }

  async function addSession(filePath) {
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat || fileStat.size < 50) return;
    try {
      const result = await readFirstLastLine(filePath);
      if (!result) return;
      const startTs = parseTimestamp(result.firstLine);
      const endTs   = parseTimestamp(result.lastLine);
      if (startTs && endTs) {
        const durationMs = endTs - startTs;
        if (durationMs >= 0 && durationMs < 7 * 24 * 60 * 60 * 1000) {
          sessions.push({ start: startTs, end: endTs, durationHours: durationMs / (1000 * 60 * 60) });
        }
      }
    } catch {}
  }

  for (const projDir of projectDirs) {
    const projPath = join(projectsDir, projDir);
    const projStat = await stat(projPath).catch(() => null);
    if (!projStat?.isDirectory()) continue;
    let files;
    try { files = await readdir(projPath); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      await addSession(join(projPath, file));
    }
  }

  return sessions;
}

// ── Scan git repos (same as cc-impact) ───────────────────────────────────────
const SCAN_ROOTS = [
  join(HOME, 'projects'),
  join(HOME, 'aetheria'),
  join(HOME, 'draemorth'),
].filter(r => existsSync(r));

function findGitRepos(root, depth = 0) {
  if (depth > 2) return [];
  const repos = [];
  let entries;
  try { entries = readdirSync(root); } catch { return repos; }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const full = join(root, entry);
    try { if (!statSync(full).isDirectory()) continue; } catch { continue; }
    if (existsSync(join(full, '.git'))) {
      repos.push(full);
    } else {
      repos.push(...findGitRepos(full, depth + 1));
    }
  }
  return repos;
}

// Commits and insertions/deletions in a date range (YYYY-MM-DD)
function repoStatsForRange(repoPath, since, until) {
  try {
    const countResult = spawnSync(
      'git', ['log', `--since=${since}`, `--until=${until}`, '--oneline', '--no-merges'],
      { cwd: repoPath, encoding: 'utf8', timeout: 5000 }
    );
    const commits = (countResult.stdout || '').trim().split('\n').filter(Boolean).length;
    if (commits === 0) return { commits: 0, insertions: 0, deletions: 0 };

    const statResult = spawnSync(
      'git', ['log', `--since=${since}`, `--until=${until}`, '--no-merges', '--shortstat', '--format='],
      { cwd: repoPath, encoding: 'utf8', timeout: 8000 }
    );
    let insertions = 0, deletions = 0;
    for (const line of (statResult.stdout || '').split('\n')) {
      const im = line.match(/(\d+) insertion/);
      const dm = line.match(/(\d+) deletion/);
      if (im) insertions += parseInt(im[1]);
      if (dm) deletions += parseInt(dm[1]);
    }
    return { commits, insertions, deletions };
  } catch {
    return { commits: 0, insertions: 0, deletions: 0 };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
if (!jsonFlag) process.stdout.write(`  Scanning sessions and repos...  \r`);

const claudeDir = join(HOME, '.claude');
const allSessions = await scanSessions(claudeDir);
const allRepos = [];
for (const root of SCAN_ROOTS) allRepos.push(...findGitRepos(root));

// Build week buckets for last N weeks (starting from Monday N weeks ago)
const now = new Date();
const weekBuckets = [];
for (let w = WEEKS - 1; w >= 0; w--) {
  const mon = new Date(now);
  mon.setDate(mon.getDate() - 7 * w);
  const start = weekStart(mon);
  const end   = new Date(start);
  end.setDate(end.getDate() + 7);
  const key = start.toISOString().slice(0, 10);
  weekBuckets.push({ key, start, end, hours: 0, commits: 0, insertions: 0, deletions: 0 });
}

// Assign CC session hours to weeks (exclude autonomous sessions >8h)
for (const s of allSessions) {
  if (s.durationHours > MAX_SESSION_HOURS) continue;
  const k = weekKey(s.start);
  const bucket = weekBuckets.find(b => b.key === k);
  if (bucket) bucket.hours += s.durationHours;
}

// Collect git stats per week
if (!jsonFlag) process.stdout.write(`  Scanning ${allRepos.length} repos across ${WEEKS} weeks...  \r`);
for (const repo of allRepos) {
  for (const bucket of weekBuckets) {
    const since = bucket.start.toISOString().slice(0, 10);
    const until = bucket.end.toISOString().slice(0, 10);
    const st = repoStatsForRange(repo, since, until);
    bucket.commits     += st.commits;
    bucket.insertions  += st.insertions;
    bucket.deletions   += st.deletions;
  }
}

// Compute efficiency for each week
for (const b of weekBuckets) {
  b.efficiency = b.hours > 0 ? b.commits / b.hours : 0;    // commits/hour
  b.linesPerHour = b.hours > 0 ? (b.insertions - b.deletions) / b.hours : 0; // net lines/hour
}

// Totals
const totalHours    = weekBuckets.reduce((s, b) => s + b.hours, 0);
const totalCommits  = weekBuckets.reduce((s, b) => s + b.commits, 0);
const totalInsert   = weekBuckets.reduce((s, b) => s + b.insertions, 0);
const totalDelete   = weekBuckets.reduce((s, b) => s + b.deletions, 0);
const avgEfficiency = totalHours > 0 ? totalCommits / totalHours : 0;

// Trend: compare first 2 active weeks vs last 2 active weeks
const activeWeeks = weekBuckets.filter(b => b.hours > 0.5);
const firstTwo = activeWeeks.slice(0, 2);
const lastTwo  = activeWeeks.slice(-2);
const firstAvgEff = firstTwo.length > 0 ? firstTwo.reduce((s, b) => s + b.efficiency, 0) / firstTwo.length : 0;
const lastAvgEff  = lastTwo.length  > 0 ? lastTwo.reduce((s, b) => s + b.efficiency, 0) / lastTwo.length   : 0;
let trend, trendPct;
if (firstAvgEff > 0 && activeWeeks.length >= 2 && firstTwo.length >= 1 && lastTwo.length >= 1 && firstTwo[0].key !== lastTwo[lastTwo.length - 1].key) {
  trendPct = ((lastAvgEff - firstAvgEff) / firstAvgEff) * 100;
  trend = trendPct > 10 ? 'improving' : trendPct < -10 ? 'declining' : 'plateauing';
} else {
  trend = 'insufficient data';
  trendPct = 0;
}

const peakWeek = weekBuckets.reduce((m, b) => b.efficiency > m.efficiency ? b : m, weekBuckets[0]);

// ── JSON output ───────────────────────────────────────────────────────────────
if (jsonFlag) {
  console.log(JSON.stringify({
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    weeks: WEEKS,
    summary: {
      totalHours:      Math.round(totalHours * 10) / 10,
      totalCommits,
      totalNetLines:   totalInsert - totalDelete,
      avgEfficiency:   Math.round(avgEfficiency * 100) / 100,
      trend,
      trendPct:        Math.round(trendPct),
      peakWeek:        peakWeek.key,
      peakEfficiency:  Math.round(peakWeek.efficiency * 100) / 100,
    },
    weeklyData: weekBuckets.map(b => ({
      weekStart:    b.key,
      hours:        Math.round(b.hours * 10) / 10,
      commits:      b.commits,
      netLines:     b.insertions - b.deletions,
      efficiency:   Math.round(b.efficiency * 100) / 100,
      linesPerHour: Math.round(b.linesPerHour),
    })),
  }, null, 2));
  process.exit(0);
}

// ── Terminal output ───────────────────────────────────────────────────────────
const bold  = '\x1b[1m';
const dim   = '\x1b[2m';
const cyan  = '\x1b[36m';
const green = '\x1b[32m';
const yellow = '\x1b[33m';
const red   = '\x1b[31m';
const reset = '\x1b[0m';

function bar(pct, width = 24) {
  const filled = Math.round(Math.min(pct, 1) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}
function fmt1(n) { return n.toFixed(1); }
function fmtK(n) {
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(Math.round(n));
}

process.stdout.write('\x1b[2K\r'); // clear spinner line

console.log(`
${bold}  cc-collab v1.0.0${reset}
  ${'═'.repeat(45)}
  ${bold}Are you getting better at working with Claude Code?${reset}
  Last ${WEEKS} weeks.
`);

// Weekly efficiency chart
const maxEff = Math.max(...weekBuckets.map(b => b.efficiency), 0.1);
console.log(`${bold}  ▸ Weekly Efficiency  (commits per CC hour)${reset}`);
for (let i = 0; i < weekBuckets.length; i++) {
  const b = weekBuckets[i];
  const label = `Wk${String(i + 1).padStart(2, '0')}`;
  const pct   = b.efficiency / maxEff;
  const isPeak = b.key === peakWeek.key;
  const effStr = fmt1(b.efficiency).padStart(4);
  const hoursStr = fmt1(b.hours).padStart(5) + 'h';
  const barStr = bar(pct, 20);
  const peakMark = isPeak ? ` ${yellow}← peak${reset}` : '';
  console.log(`  ${dim}${label}${reset}  ${barStr}  ${bold}${effStr}${reset}/h  ${dim}${hoursStr}  ${b.commits} commits${reset}${peakMark}`);
}

// Summary stats
const trendColor = trend === 'improving' ? green : trend === 'declining' ? red : yellow;
const trendIcon  = trend === 'improving' ? '↑' : trend === 'declining' ? '↓' : '→';
const trendSign  = trendPct > 0 ? '+' : '';
console.log(`
${bold}  ▸ Summary${reset}
    Overall efficiency    ${bold}${fmt1(avgEfficiency)} commits/hour${reset}
    Net lines per hour    ${bold}${fmtK((totalInsert - totalDelete) / Math.max(totalHours, 0.1))}${reset}
    Total CC hours        ${bold}${fmt1(totalHours)}h${reset}
    Total commits         ${bold}${totalCommits}${reset}

${bold}  ▸ Trend${reset}
    ${trendColor}${bold}${trendIcon} ${trend}${reset}${trend !== 'insufficient data' ? `  (${trendSign}${Math.round(trendPct)}% from first to last 2 weeks)` : ''}
    Peak week: ${peakWeek.key}  (${fmt1(peakWeek.efficiency)} commits/h)
`);

// Insight
console.log(`${bold}  ▸ What this means${reset}`);
if (trend === 'improving') {
  console.log(`    You're getting ${green}more productive${reset} with Claude Code over time.`);
  console.log(`    Your recent output-per-hour is ${Math.abs(Math.round(trendPct))}% higher than when you started.`);
} else if (trend === 'declining') {
  console.log(`    Efficiency is ${red}lower${reset} than your earlier weeks.`);
  console.log(`    This can happen when taking on larger, slower projects — or burnout.`);
} else {
  console.log(`    Efficiency is ${yellow}consistent${reset} across these ${WEEKS} weeks.`);
  console.log(`    You've found a stable working rhythm with Claude Code.`);
}
console.log(`\n  Run ${bold}npx cc-collab --json${reset} to pipe data to other tools.\n`);
