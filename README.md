# cc-collab

> Are you getting better at working with Claude Code?

Combines your Claude Code session hours with your actual git commits to compute weekly **collaboration efficiency**: commits per CC hour.

```
  cc-collab v1.0.0
  ═════════════════════════════════════════════
  Are you getting better at working with Claude Code?
  Last 8 weeks.

  ▸ Weekly Efficiency  (commits per CC hour)
  Wk01  ░░░░░░░░░░░░░░░░░░░░   0.0/h    0.0h  0 commits
  Wk02  ███░░░░░░░░░░░░░░░░░   4.2/h   12.5h  52 commits
  Wk03  ████████░░░░░░░░░░░░   9.1/h   18.2h  165 commits
  Wk04  ████████████░░░░░░░░  13.8/h   22.1h  305 commits
  Wk05  ████████████████░░░░  18.3/h   19.6h  358 commits
  Wk06  ████████████████████  22.4/h   16.4h  367 commits  ← peak
  Wk07  ████████████████████  21.3/h   17.3h  367 commits
  Wk08  ████████████░░░░░░░░  14.5/h    4.8h   69 commits

  ▸ Summary
    Overall efficiency    15.2 commits/hour
    Net lines per hour    9.4k
    Total CC hours        130.9h
    Total commits         1683

  ▸ Trend
    ↑ improving  (+19% from first to last 2 weeks)
    Peak week: 2026-02-16  (22.4 commits/h)

  ▸ What this means
    You're getting more productive with Claude Code over time.
    Your recent output-per-hour is 19% higher than when you started.
```

## Usage

```bash
npx cc-collab              # Last 8 weeks
npx cc-collab --weeks=12   # Last 12 weeks
npx cc-collab --json       # JSON output for piping
```

## Why this exists

cc-session-stats answers "how much time?"
cc-impact answers "what did I build?"
cc-collab answers "**am I getting more efficient?**"

The learning curve of working with AI is invisible unless you measure it. This tool makes it visible.

## How it works

1. Reads `~/.claude/projects/` session transcripts to get weekly CC hours
2. Scans git repos under `~/projects/`, `~/aetheria/`, `~/draemorth/`
3. Computes `efficiency = commits / CC_hours` for each week
4. Shows trend: improving / plateauing / declining

Sessions >8 hours are excluded (likely autonomous background runs).

## Part of cc-toolkit

One of [35 free tools](https://yurukusa.github.io/cc-toolkit/) for understanding your Claude Code usage.

## License

MIT
