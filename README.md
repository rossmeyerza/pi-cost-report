# pi-cost-report

An extension for the [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) that adds a **`/costs`** slash command: an interactive terminal UI that reports what you've spent across your Pi sessions, with ASCII charts broken down by day and by model.

It reads the cost data Pi already records in your session logs — no extra tracking, no network calls, no API keys.

```
╭────────────────────────────────────────────────────────────╮
│  Pi Cost Report  All time                                    │
│  [ Overview ]   Daily   Weekly   Models   Projects           │
├────────────────────────────────────────────────────────────┤
│  Total Spend:     $204.13                                    │
│  Cost Split:      in $12.40 · out $58.91 · cache read ...    │
│  Sessions:        61                                         │
│  Billed Messages: 338                                        │
│  Date Range:      2026-02-23 to 2026-04-30                   │
│                                                              │
│  Daily Trend (max: $48.10)                                   │
│   $48.10 ┤                              ╭─╮                  │
│   ...    ┤            ╭──╮      ╭───╮ ╭─╯ ╰                  │
│      ▲                                                       │
├────────────────────────────────────────────────────────────┤
│  ←/→ section · ↑/↓ select date · Home/End jump · q/Esc close │
╰────────────────────────────────────────────────────────────╯
```

## Install

This is a standard Pi package. Add it to the `packages` array in your Pi
settings (`~/.pi/agent/settings.json`):

```jsonc
{
  "packages": [
    "git:github.com/rossmeyerza/pi-cost-report"
  ]
}
```

Or, for local development, clone it into your extensions directory:

```bash
git clone https://github.com/rossmeyerza/pi-cost-report \
  ~/.pi/agent/extensions/pi-cost-report
```

Pi loads the extension declared in `package.json` under `pi.extensions`
(`./index.ts`). Restart Pi and run `/costs`.

## Usage

```
/costs              all-time costs
/costs all          all-time costs
/costs today        today only
/costs 7            last 7 days (any number works: /costs 30)
/costs week         last 7 days
/costs month        the current calendar month
/costs 2026-04      a specific month (YYYY-MM)
```

### Navigating the UI

| Key            | Action                          |
| -------------- | ------------------------------- |
| `←` / `→`      | switch section (Overview / Daily / Weekly / Models / Projects) |
| `Tab` / `Shift+Tab` | switch section             |
| `↑` / `↓`      | select a day / week / model / directory |
| `↵` / `Space`  | expand or collapse a directory (Projects section) |
| `Home` / `End` | jump to first / last            |
| `q` / `Esc`    | close                           |

### Sections

- **Overview** — total spend, input/output/cache cost split, session and billed-message counts, date range, and a daily cost trend line chart.
- **Daily** — a block-character bar chart of daily costs; selecting a day shows that day's cost split and per-model breakdown.
- **Weekly** — the same bar chart rolled up into Monday-based weeks; selecting a week shows its date range, cost split, average spend per day, and per-model breakdown.
- **Models** — cost by model with proportional bars and percent-of-total; selecting a model shows its daily spend trend.
- **Projects** — a directory tree of spend, grouped by each session's working directory (`cwd`). Costs roll up the tree, so a parent folder shows the combined spend of everything beneath it. Expand/collapse directories with `↵`/`Space`; selecting one shows its cost split, top models, and a daily trend across that subtree. Pure pass-through directories are collapsed into a single row for readability.

## How it works

The extension scans `~/.pi/agent/sessions/**/*.jsonl` (overridable via the
`PI_CODING_AGENT_DIR` environment variable). For each assistant message it reads
`message.usage.cost` and `message.model`, buckets the spend by day and model,
and renders the charts.

Notes:

- Zero-cost messages are skipped (e.g. proxy sessions that report all costs as zero).
- Branched/copied session history is de-duplicated on timestamp + token count so totals stay accurate.

## License

MIT © Ross Meyer
