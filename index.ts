import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

interface DayCost {
  date: string;
  cost: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  inputTokens: number;
  outputTokens: number;
  messageCount: number;
}

interface ModelCost {
  model: string;
  cost: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  inputTokens: number;
  outputTokens: number;
  messageCount: number;
}

interface ProjectCost {
  project: string; // absolute working directory (cwd) the session ran in
  cost: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  inputTokens: number;
  outputTokens: number;
  messageCount: number;
  sessionCount: number;
}

// A node in the directory-cost tree. Costs are rolled up: a node's cost is the
// sum of every session at or beneath its path.
interface ProjectTreeNode {
  label: string; // display segment(s); single-child chains are compressed into one label
  path: string; // full absolute path of this node
  cost: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  inputTokens: number;
  outputTokens: number;
  messageCount: number;
  projectCount: number; // number of leaf projects (distinct cwds) under this node
  isProject: boolean; // true if a session ran directly in this directory
  children: ProjectTreeNode[];
}

interface CostData {
  daily: DayCost[];
  byModel: ModelCost[];
  dailyModels: Record<string, ModelCost[]>;
  byProject: ProjectCost[];
  projectDaily: Record<string, DayCost[]>;
  projectModels: Record<string, ModelCost[]>;
  total: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  inputTokens: number;
  outputTokens: number;
  sessionCount: number;
  messageCount: number;
}

interface PeriodFilter {
  from: string;
  to?: string;
  label: string;
}

function parsePeriod(args: string): PeriodFilter {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  if (!args || args.trim() === "" || args.trim() === "all") {
    return { from: "0000-01-01", label: "All time" };
  }

  const a = args.trim().toLowerCase();

  if (a === "today") {
    return { from: today, to: today, label: "Today" };
  }

  if (a === "week") {
    const d = new Date(now);
    d.setDate(d.getDate() - 6);
    return { from: d.toISOString().slice(0, 10), label: "Last 7 days" };
  }

  if (a === "month") {
    const from = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const next = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 1));
    next.setUTCDate(next.getUTCDate() - 1);
    return { from, to: next.toISOString().slice(0, 10), label: "This month" };
  }

  // numeric days: /costs 7 or /costs 30
  const days = parseInt(a, 10);
  if (!isNaN(days) && days > 0) {
    const d = new Date(now);
    d.setDate(d.getDate() - (days - 1));
    return { from: d.toISOString().slice(0, 10), label: `Last ${days} days` };
  }

  // YYYY-MM format: /costs 2026-04
  if (/^\d{4}-\d{2}$/.test(a)) {
    const [year, month] = a.split("-").map((v) => Number.parseInt(v, 10));
    const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    return { from: `${a}-01`, to: end, label: a };
  }

  return { from: "0000-01-01", label: "All time" };
}

function emptyCostData(): CostData {
  return {
    daily: [],
    byModel: [],
    dailyModels: {},
    byProject: [],
    projectDaily: {},
    projectModels: {},
    total: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    sessionCount: 0,
    messageCount: 0,
  };
}

function getSessionsDir(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME || "", ".pi", "agent");
  return path.join(agentDir, "sessions");
}

function collectSessionFiles(dir: string, files: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSessionFiles(entryPath, files);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(entryPath);
    }
  }
}

async function scanSessions(fromDate = "0000-01-01", toDate?: string): Promise<CostData> {
  const sessionsDir = getSessionsDir();
  type MutableCost = Omit<DayCost, "date">;
  const newMutableCost = (): MutableCost => ({
    cost: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    messageCount: 0,
  });
  const daily: Record<string, MutableCost> = {};
  const byModel: Record<string, MutableCost> = {};
  const dailyModels: Record<string, Record<string, MutableCost>> = {};
  const byProject: Record<string, MutableCost> = {};
  const projectDays: Record<string, Record<string, MutableCost>> = {};
  const projectModels: Record<string, Record<string, MutableCost>> = {};
  const projectSessions: Record<string, Set<string>> = {};
  let total = 0;
  let inputCost = 0;
  let outputCost = 0;
  let cacheReadCost = 0;
  let cacheWriteCost = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let messageCount = 0;
  const billedSessions = new Set<string>();
  const seenHashes = new Set<string>();

  if (!fs.existsSync(sessionsDir)) {
    return emptyCostData();
  }

  const files: string[] = [];
  collectSessionFiles(sessionsDir, files);
  files.sort();

  for (const filePath of files) {
    let sessionId = filePath;
    let sessionCwd = "unknown";
    const fileStream = fs.createReadStream(filePath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      if (!line.includes('"message"') && !line.includes('"session"')) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.type === "session") {
          if (entry.id) sessionId = entry.id;
          if (typeof entry.cwd === "string" && entry.cwd) sessionCwd = entry.cwd;
          continue;
        }
        if (entry?.type !== "message") continue;
        if (!line.includes('"cost"')) continue;
        const msg = entry?.message;
        if (msg?.role !== "assistant") continue;
        if (!msg?.usage?.cost) continue;

        const usage = msg.usage;
        const usageCost = usage.cost;
        const usageInputTokens = Number(usage.input || usage.inputTokens || 0);
        const usageOutputTokens = Number(usage.output || usage.outputTokens || 0);
        const usageCacheReadTokens = Number(usage.cacheRead || 0);
        const usageCacheWriteTokens = Number(usage.cacheWrite || 0);

        // Match /usage: copied history can appear in branched session files.
        // Deduplicate on timestamp + total token count so totals remain comparable.
        const fallbackTs = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
        const timestamp = msg.timestamp || (Number.isNaN(fallbackTs) ? 0 : fallbackTs);
        const hash = `${timestamp}:${usageInputTokens + usageOutputTokens + usageCacheReadTokens + usageCacheWriteTokens}`;
        if (seenHashes.has(hash)) continue;
        seenHashes.add(hash);

        const usageInputCost = Number(usageCost.input || 0);
        const usageOutputCost = Number(usageCost.output || 0);
        const usageCacheReadCost = Number(usageCost.cacheRead || 0);
        const usageCacheWriteCost = Number(usageCost.cacheWrite || 0);
        const cost = Number(usageCost.total ?? (usageInputCost + usageOutputCost + usageCacheReadCost + usageCacheWriteCost));
        if (!cost || cost <= 0) continue;

        const model = msg.model || "unknown";
        let day = "unknown";
        const ts = msg.timestamp || entry.timestamp;
        if (typeof ts === "number") {
          day = new Date(ts).toISOString().slice(0, 10);
        } else if (typeof ts === "string") {
          day = ts.slice(0, 10);
        }

        if (day < fromDate || (toDate && day > toDate)) continue;
        daily[day] ||= newMutableCost();
        daily[day].cost += cost;
        daily[day].inputCost += usageInputCost;
        daily[day].outputCost += usageOutputCost;
        daily[day].cacheReadCost += usageCacheReadCost;
        daily[day].cacheWriteCost += usageCacheWriteCost;
        daily[day].inputTokens += usageInputTokens;
        daily[day].outputTokens += usageOutputTokens;
        daily[day].messageCount += 1;
        byModel[model] ||= newMutableCost();
        byModel[model].cost += cost;
        byModel[model].inputCost += usageInputCost;
        byModel[model].outputCost += usageOutputCost;
        byModel[model].cacheReadCost += usageCacheReadCost;
        byModel[model].cacheWriteCost += usageCacheWriteCost;
        byModel[model].inputTokens += usageInputTokens;
        byModel[model].outputTokens += usageOutputTokens;
        byModel[model].messageCount += 1;
        dailyModels[day] ||= {};
        dailyModels[day][model] ||= newMutableCost();
        dailyModels[day][model].cost += cost;
        dailyModels[day][model].inputCost += usageInputCost;
        dailyModels[day][model].outputCost += usageOutputCost;
        dailyModels[day][model].cacheReadCost += usageCacheReadCost;
        dailyModels[day][model].cacheWriteCost += usageCacheWriteCost;
        dailyModels[day][model].inputTokens += usageInputTokens;
        dailyModels[day][model].outputTokens += usageOutputTokens;
        dailyModels[day][model].messageCount += 1;
        byProject[sessionCwd] ||= newMutableCost();
        byProject[sessionCwd].cost += cost;
        byProject[sessionCwd].inputCost += usageInputCost;
        byProject[sessionCwd].outputCost += usageOutputCost;
        byProject[sessionCwd].cacheReadCost += usageCacheReadCost;
        byProject[sessionCwd].cacheWriteCost += usageCacheWriteCost;
        byProject[sessionCwd].inputTokens += usageInputTokens;
        byProject[sessionCwd].outputTokens += usageOutputTokens;
        byProject[sessionCwd].messageCount += 1;
        projectDays[sessionCwd] ||= {};
        projectDays[sessionCwd][day] ||= newMutableCost();
        projectDays[sessionCwd][day].cost += cost;
        projectDays[sessionCwd][day].inputCost += usageInputCost;
        projectDays[sessionCwd][day].outputCost += usageOutputCost;
        projectDays[sessionCwd][day].cacheReadCost += usageCacheReadCost;
        projectDays[sessionCwd][day].cacheWriteCost += usageCacheWriteCost;
        projectDays[sessionCwd][day].inputTokens += usageInputTokens;
        projectDays[sessionCwd][day].outputTokens += usageOutputTokens;
        projectDays[sessionCwd][day].messageCount += 1;
        projectModels[sessionCwd] ||= {};
        projectModels[sessionCwd][model] ||= newMutableCost();
        projectModels[sessionCwd][model].cost += cost;
        projectModels[sessionCwd][model].inputCost += usageInputCost;
        projectModels[sessionCwd][model].outputCost += usageOutputCost;
        projectModels[sessionCwd][model].cacheReadCost += usageCacheReadCost;
        projectModels[sessionCwd][model].cacheWriteCost += usageCacheWriteCost;
        projectModels[sessionCwd][model].inputTokens += usageInputTokens;
        projectModels[sessionCwd][model].outputTokens += usageOutputTokens;
        projectModels[sessionCwd][model].messageCount += 1;
        (projectSessions[sessionCwd] ||= new Set()).add(sessionId);
        total += cost;
        inputCost += usageInputCost;
        outputCost += usageOutputCost;
        cacheReadCost += usageCacheReadCost;
        cacheWriteCost += usageCacheWriteCost;
        inputTokens += usageInputTokens;
        outputTokens += usageOutputTokens;
        messageCount++;
        billedSessions.add(sessionId);
      } catch {
        // skip malformed lines
      }
    }
  }

  const dailyArr = Object.entries(daily)
    .map(([date, cost]) => ({ date, ...cost }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const modelArr = Object.entries(byModel)
    .map(([model, cost]) => ({ model, ...cost }))
    .sort((a, b) => b.cost - a.cost);

  const dailyModelArr: Record<string, ModelCost[]> = {};
  for (const [day, models] of Object.entries(dailyModels)) {
    dailyModelArr[day] = Object.entries(models)
      .map(([model, value]) => ({ model, ...value }))
      .sort((a, b) => b.cost - a.cost);
  }

  const projectArr: ProjectCost[] = Object.entries(byProject)
    .map(([project, cost]) => ({ project, ...cost, sessionCount: projectSessions[project]?.size || 0 }))
    .sort((a, b) => b.cost - a.cost);

  const projectDailyArr: Record<string, DayCost[]> = {};
  for (const [project, days] of Object.entries(projectDays)) {
    projectDailyArr[project] = Object.entries(days)
      .map(([date, value]) => ({ date, ...value }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  const projectModelArr: Record<string, ModelCost[]> = {};
  for (const [project, models] of Object.entries(projectModels)) {
    projectModelArr[project] = Object.entries(models)
      .map(([model, value]) => ({ model, ...value }))
      .sort((a, b) => b.cost - a.cost);
  }

  return {
    daily: dailyArr,
    byModel: modelArr,
    dailyModels: dailyModelArr,
    byProject: projectArr,
    projectDaily: projectDailyArr,
    projectModels: projectModelArr,
    total,
    inputCost,
    outputCost,
    cacheReadCost,
    cacheWriteCost,
    inputTokens,
    outputTokens,
    sessionCount: billedSessions.size,
    messageCount,
  };
}

function formatUsd(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return "$0.00";
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(4)}`;
}

function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(Math.round(tokens));
}

function costSplitLine(costs: {
  inputCost: number;
  outputCost: number;
  cacheReadCost?: number;
  cacheWriteCost?: number;
  inputTokens?: number;
  outputTokens?: number;
}): string {
  const parts = [
    `in ${formatUsd(costs.inputCost)}`,
    `out ${formatUsd(costs.outputCost)}`,
  ];
  if ((costs.cacheReadCost || 0) > 0) parts.push(`cache read ${formatUsd(costs.cacheReadCost || 0)}`);
  if ((costs.cacheWriteCost || 0) > 0) parts.push(`cache write ${formatUsd(costs.cacheWriteCost || 0)}`);
  const tokens = costs.inputTokens || costs.outputTokens
    ? ` · tokens ${formatTokens(costs.inputTokens || 0)} in / ${formatTokens(costs.outputTokens || 0)} out`
    : "";
  return `${parts.join(" · ")}${tokens}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function moveIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return clamp(current + delta, 0, length - 1);
}

function sliceAround<T>(items: T[], selectedIndex: number, maxItems: number): { items: T[]; offset: number } {
  if (items.length <= maxItems) return { items, offset: 0 };
  const half = Math.floor(maxItems / 2);
  const offset = clamp(selectedIndex - half, 0, items.length - maxItems);
  return { items: items.slice(offset, offset + maxItems), offset };
}

type ChartColors = {
  accent: (s: string) => string;
  dim: (s: string) => string;
  muted: (s: string) => string;
  success: (s: string) => string;
  heat: (s: string, ratio: number) => string;
};

const plainChartColors: ChartColors = {
  accent: (s) => s,
  dim: (s) => s,
  muted: (s) => s,
  success: (s) => s,
  heat: (s) => s,
};

function rgb(text: string, r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

function heatColor(text: string, ratio: number): string {
  const t = clamp(Number.isFinite(ratio) ? ratio : 0, 0, 1);
  // Low usage is green, mid usage is amber, high usage is red.
  if (t < 0.5) {
    const p = t / 0.5;
    const r = Math.round(34 + (245 - 34) * p);
    const g = Math.round(197 + (158 - 197) * p);
    const b = Math.round(94 + (11 - 94) * p);
    return rgb(text, r, g, b);
  }
  const p = (t - 0.5) / 0.5;
  const r = Math.round(245 + (220 - 245) * p);
  const g = Math.round(158 + (38 - 158) * p);
  const b = Math.round(11 + (38 - 11) * p);
  return rgb(text, r, g, b);
}

function verticalBarChart(data: DayCost[], width: number, selectedDate?: string, colors = plainChartColors): string[] {
  if (data.length === 0) return ["  No cost data found."];

  // Braille block characters for bar heights (8 levels)
  const blocks = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const maxCost = Math.max(...data.map((d) => d.cost));
  if (maxCost === 0) return ["  All costs are zero."];

  // Determine how many bars we can fit
  const labelWidth = 12; // "YYYY-MM-DD  "
  const chartWidth = Math.min(data.length, Math.max(10, width - labelWidth - 4));

  // If more data points than chart width, bucket them
  let buckets: { label: string; cost: number }[];
  if (data.length <= chartWidth) {
    buckets = data.map((d) => ({ label: d.date, cost: d.cost }));
  } else {
    // Show most recent N days
    const selectedIndex = selectedDate ? data.findIndex((d) => d.date === selectedDate) : data.length - 1;
    const { items } = sliceAround(data, Math.max(0, selectedIndex), chartWidth);
    buckets = items.map((d) => ({ label: d.date, cost: d.cost }));
  }

  const maxVal = Math.max(...buckets.map((b) => b.cost));
  const chartHeight = 8;
  const lines: string[] = [];

  // Header
  lines.push(`  Daily Costs ${colors.dim(`(max: ${formatUsd(maxVal)})`)}`);
  lines.push("");

  // Build vertical bar chart (rendered as horizontal rows from top to bottom)
  for (let row = chartHeight; row >= 1; row--) {
    let rowStr = "  ";
    for (const bucket of buckets) {
      const level = Math.round((bucket.cost / maxVal) * 8);
      if (level >= row) {
        rowStr += colors.heat(bucket.label === selectedDate ? "▓" : "█", bucket.cost / maxVal);
      } else if (level === row - 1 && bucket.cost > 0) {
        const frac = Math.round(((bucket.cost / maxVal) * 8 - (row - 1)) * 8);
        rowStr += colors.heat(blocks[Math.max(0, Math.min(8, frac))], bucket.cost / maxVal);
      } else {
        rowStr += " ";
      }
    }
    lines.push(rowStr);
  }

  // X-axis
  lines.push("  " + colors.dim("─".repeat(buckets.length)));

  // Date labels (show first, middle, last)
  if (buckets.length >= 3) {
    const first = buckets[0].label.slice(5); // MM-DD
    const last = buckets[buckets.length - 1].label.slice(5);
    const pad = buckets.length - first.length - last.length;
    lines.push("  " + colors.dim(first + " ".repeat(Math.max(1, pad)) + last));
  } else if (buckets.length > 0) {
    lines.push("  " + colors.dim(buckets.map((b) => b.label.slice(5)).join(" ")));
  }

  return lines;
}

function lineChart(data: DayCost[], width: number, selectedDate?: string, colors = plainChartColors): string[] {
  if (data.length === 0) return ["  No cost data found."];

  const labelWidth = 9;
  const pointCount = Math.max(2, width - labelWidth - 2);
  const plotWidth = Math.max(2, Math.min(data.length, pointCount));
  const selectedIndex = selectedDate ? data.findIndex((d) => d.date === selectedDate) : data.length - 1;
  const { items, offset } = sliceAround(data, Math.max(0, selectedIndex), plotWidth);
  const maxCost = Math.max(...items.map((d) => d.cost), 0);
  const minCost = Math.min(...items.map((d) => d.cost), 0);
  if (maxCost === 0) return ["  All costs are zero."];

  const height = 8;
  const range = maxCost - minCost;
  const scaleRange = range || 1;
  const rows = height - 1;
  const values = items.map((item) => Math.round(((item.cost - minCost) / scaleRange) * rows));
  const grid = Array.from({ length: height }, () => Array.from({ length: items.length }, () => ({ char: " ", tone: "plain" as "plain" | "axis" | "line" | "selected" })));

  for (let row = 0; row < height; row++) {
    grid[row][0] = { char: row === height - 1 ? "┼" : "┤", tone: "axis" };
  }

  for (let x = 0; x < items.length - 1; x++) {
    const y0 = values[x];
    const y1 = values[x + 1];
    const row0 = rows - y0;
    const row1 = rows - y1;
    const selectedSegment = items[x].date === selectedDate || items[x + 1].date === selectedDate;
    const tone = selectedSegment ? "selected" : "line";

    if (y0 === y1) {
      grid[row0][x + 1] = { char: "─", tone };
    } else {
      grid[row1][x + 1] = { char: y0 > y1 ? "╰" : "╭", tone };
      grid[row0][x + 1] = { char: y0 > y1 ? "╮" : "╯", tone };
      const from = Math.min(y0, y1);
      const to = Math.max(y0, y1);
      for (let y = from + 1; y < to; y++) {
        grid[rows - y][x + 1] = { char: "│", tone };
      }
    }
  }

  const localSelected = selectedDate ? items.findIndex((item) => item.date === selectedDate) : -1;
  if (localSelected >= 0) {
    const selectedRow = rows - values[localSelected];
    grid[selectedRow][localSelected] = { char: "●", tone: "selected" };
  }

  const paint = (cell: { char: string; tone: "plain" | "axis" | "line" | "selected" }) => {
    if (cell.tone === "selected") return colors.accent(cell.char);
    if (cell.tone === "line") return colors.success(cell.char);
    if (cell.tone === "axis") return colors.dim(cell.char);
    return cell.char;
  };

  const lines = [`  Daily Trend ${colors.dim(`(max: ${formatUsd(maxCost)})`)}`, ""];
  for (let row = 0; row < grid.length; row++) {
    const labelValue = range === 0 ? maxCost : maxCost - (row / rows) * range;
    const label = formatUsd(labelValue).padStart(labelWidth - 1);
    lines.push(colors.dim(label) + " " + grid[row].map(paint).join(""));
  }

  const first = items[0]?.date.slice(5) || "";
  const last = items[items.length - 1]?.date.slice(5) || "";
  const selectedLocal = selectedIndex >= offset ? selectedIndex - offset : -1;
  if (selectedLocal >= 0 && selectedLocal < items.length) {
    const marker = " ".repeat(labelWidth + 1 + selectedLocal) + colors.accent("▲");
    lines.push(marker);
  }
  const pad = items.length - first.length - last.length;
  lines.push(" ".repeat(labelWidth + 1) + colors.dim(first + " ".repeat(Math.max(1, pad)) + last));
  return lines;
}

function modelTable(models: ModelCost[], total: number, selectedIndex = -1, colors = plainChartColors): string[] {
  const lines: string[] = [];
  lines.push("  Cost by Model");
  lines.push("");

  const maxBar = 20;
  const maxCost = models.length > 0 ? models[0].cost : 1;

  const { items, offset } = sliceAround(models, Math.max(0, selectedIndex), 10);
  for (let i = 0; i < items.length; i++) {
    const m = items[i];
    const pct = total > 0 ? (m.cost / total) * 100 : 0;
    const barLen = Math.max(1, Math.round((m.cost / maxCost) * maxBar));
    const bar = colors.heat("█".repeat(barLen), m.cost / maxCost);
    const marker = offset + i === selectedIndex ? ">" : " ";
    const name = m.model.padEnd(20).slice(0, 20);
    lines.push(` ${marker} ${name} ${bar} ${formatUsd(m.cost)} (${pct.toFixed(0)}%)`);
  }

  return lines;
}

// --- Per-project (directory) tree -------------------------------------------

type RawTreeNode = {
  seg: string;
  full: string;
  cost: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  inputTokens: number;
  outputTokens: number;
  messageCount: number;
  projectCount: number;
  isProject: boolean;
  children: Map<string, RawTreeNode>;
};

function commonPrefixSegments(paths: string[][]): string[] {
  if (paths.length === 0) return [];
  let prefix = paths[0].slice();
  for (let i = 1; i < paths.length && prefix.length > 0; i++) {
    const segs = paths[i];
    let j = 0;
    while (j < prefix.length && j < segs.length && prefix[j] === segs[j]) j++;
    prefix = prefix.slice(0, j);
  }
  return prefix;
}

// Build a cost tree from session working directories. Each node's cost is the
// sum of every session at or beneath it; pure pass-through directories (one
// child, no sessions of their own) are compressed into a single labelled row.
function buildProjectTree(projects: ProjectCost[]): ProjectTreeNode | null {
  const known = projects.filter((p) => p.project && p.project !== "unknown");
  if (known.length === 0) return null;

  const segLists = known.map((p) => p.project.split("/").filter(Boolean));
  const prefix = commonPrefixSegments(segLists);
  const rootPath = "/" + prefix.join("/");

  const makeNode = (seg: string, full: string): RawTreeNode => ({
    seg,
    full,
    cost: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    messageCount: 0,
    projectCount: 0,
    isProject: false,
    children: new Map(),
  });

  const addInto = (node: RawTreeNode, p: ProjectCost) => {
    node.cost += p.cost;
    node.inputCost += p.inputCost;
    node.outputCost += p.outputCost;
    node.cacheReadCost += p.cacheReadCost;
    node.cacheWriteCost += p.cacheWriteCost;
    node.inputTokens += p.inputTokens;
    node.outputTokens += p.outputTokens;
    node.messageCount += p.messageCount;
    node.projectCount += 1;
  };

  const root = makeNode(prefix.length ? "/" + prefix.join("/") : "/", rootPath || "/");

  for (let k = 0; k < known.length; k++) {
    const p = known[k];
    const rest = segLists[k].slice(prefix.length);
    addInto(root, p);
    if (rest.length === 0) {
      root.isProject = true;
      continue;
    }
    let node = root;
    let acc = root.full;
    for (let i = 0; i < rest.length; i++) {
      const seg = rest[i];
      acc = acc === "/" ? "/" + seg : acc + "/" + seg;
      let child = node.children.get(seg);
      if (!child) {
        child = makeNode(seg, acc);
        node.children.set(seg, child);
      }
      addInto(child, p);
      if (i === rest.length - 1) child.isProject = true;
      node = child;
    }
  }

  const compress = (node: RawTreeNode): ProjectTreeNode => {
    let cur = node;
    let label = node.seg;
    while (cur.children.size === 1 && !cur.isProject) {
      const only = [...cur.children.values()][0];
      label = label === "/" ? "/" + only.seg : `${label}/${only.seg}`;
      cur = only;
    }
    const children = [...cur.children.values()].map(compress).sort((a, b) => b.cost - a.cost);
    return {
      label,
      path: cur.full,
      cost: cur.cost,
      inputCost: cur.inputCost,
      outputCost: cur.outputCost,
      cacheReadCost: cur.cacheReadCost,
      cacheWriteCost: cur.cacheWriteCost,
      inputTokens: cur.inputTokens,
      outputTokens: cur.outputTokens,
      messageCount: cur.messageCount,
      projectCount: cur.projectCount,
      isProject: cur.isProject,
      children,
    };
  };

  return compress(root);
}

type ProjectRow = { node: ProjectTreeNode; depth: number };

function flattenProjectTree(root: ProjectTreeNode, expanded: Set<string>): ProjectRow[] {
  const rows: ProjectRow[] = [];
  const walk = (node: ProjectTreeNode, depth: number) => {
    rows.push({ node, depth });
    if (node.children.length > 0 && expanded.has(node.path)) {
      for (const child of node.children) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

type ThemeLike = {
  fg(name: string, text: string): string;
  bold(text: string): string;
};

class CostsComponent implements Component {
  private sections = ["Overview", "Daily", "Models", "Projects"];
  private sectionIndex = 0;
  private dailyIndex: number;
  private modelIndex = 0;
  private projectIndex = 0;
  private readonly projectTree: ProjectTreeNode | null;
  private readonly expandedProjects: Set<string>;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private readonly data: CostData,
    private readonly periodLabel: string,
    private readonly tui: TUI,
    private readonly theme: ThemeLike,
    private readonly onClose: () => void,
  ) {
    this.dailyIndex = Math.max(0, data.daily.length - 1);
    this.projectTree = buildProjectTree(data.byProject);
    // Start with the root expanded so its immediate directories are visible.
    this.expandedProjects = new Set(this.projectTree ? [this.projectTree.path] : []);
  }

  private visibleProjectRows(): ProjectRow[] {
    if (!this.projectTree) return [];
    return flattenProjectTree(this.projectTree, this.expandedProjects);
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  private refresh(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "q") {
      this.onClose();
      return;
    }

    if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) {
      this.sectionIndex = (this.sectionIndex - 1 + this.sections.length) % this.sections.length;
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      this.sectionIndex = (this.sectionIndex + 1) % this.sections.length;
      this.refresh();
      return;
    }

    if (matchesKey(data, Key.home)) {
      if (this.sectionIndex === 2) this.modelIndex = 0;
      else if (this.sectionIndex === 3) this.projectIndex = 0;
      else this.dailyIndex = 0;
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.end)) {
      if (this.sectionIndex === 2) this.modelIndex = Math.max(0, this.data.byModel.length - 1);
      else if (this.sectionIndex === 3) this.projectIndex = Math.max(0, this.visibleProjectRows().length - 1);
      else this.dailyIndex = Math.max(0, this.data.daily.length - 1);
      this.refresh();
      return;
    }

    // In the Projects tree, Enter/Space expands or collapses the selected directory.
    if (this.sectionIndex === 3 && (matchesKey(data, Key.enter) || matchesKey(data, Key.return) || matchesKey(data, Key.space))) {
      const row = this.visibleProjectRows()[this.projectIndex];
      if (row && row.node.children.length > 0) {
        if (this.expandedProjects.has(row.node.path)) this.expandedProjects.delete(row.node.path);
        else this.expandedProjects.add(row.node.path);
        this.refresh();
      }
      return;
    }

    if (matchesKey(data, Key.up)) {
      if (this.sectionIndex === 2) this.modelIndex = moveIndex(this.modelIndex, -1, this.data.byModel.length);
      else if (this.sectionIndex === 3) this.projectIndex = moveIndex(this.projectIndex, -1, this.visibleProjectRows().length);
      else this.dailyIndex = moveIndex(this.dailyIndex, -1, this.data.daily.length);
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.down)) {
      if (this.sectionIndex === 2) this.modelIndex = moveIndex(this.modelIndex, 1, this.data.byModel.length);
      else if (this.sectionIndex === 3) this.projectIndex = moveIndex(this.projectIndex, 1, this.visibleProjectRows().length);
      else this.dailyIndex = moveIndex(this.dailyIndex, 1, this.data.daily.length);
      this.refresh();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const boxWidth = Math.max(20, Math.min(width, 120));
    const contentWidth = boxWidth - 4;
    const lines: string[] = [];
    const pad = (line: string) => {
      const extra = Math.max(0, width - visibleWidth(line));
      return line + " ".repeat(extra);
    };
    const boxLine = (content = "") => {
      const clipped = truncateToWidth(content, contentWidth);
      const rightPad = Math.max(0, contentWidth - visibleWidth(clipped));
      return pad(this.theme.fg("borderMuted", "│") + "  " + clipped + " ".repeat(rightPad) + "  " + this.theme.fg("borderMuted", "│"));
    };
    const rule = (left: string, right: string) => pad(this.theme.fg("borderMuted", left + "─".repeat(boxWidth - 2) + right));

    lines.push("");
    lines.push(rule("╭", "╮"));
    lines.push(boxLine(`${this.theme.bold(this.theme.fg("accent", "Pi Cost Report"))} ${this.theme.fg("dim", this.periodLabel)}`));
    lines.push(boxLine(this.renderTabs()));
    lines.push(rule("├", "┤"));

    if (this.sectionIndex === 0) {
      lines.push(...this.renderOverview(contentWidth).map(boxLine));
    } else if (this.sectionIndex === 1) {
      lines.push(...this.renderDaily(contentWidth).map(boxLine));
    } else if (this.sectionIndex === 2) {
      lines.push(...this.renderModels(contentWidth).map(boxLine));
    } else {
      lines.push(...this.renderProjects(contentWidth).map(boxLine));
    }

    lines.push(rule("├", "┤"));
    let where = "select date";
    if (this.sectionIndex === 2) where = "select model";
    else if (this.sectionIndex === 3) where = "select dir";
    const expandHint = this.sectionIndex === 3 ? ` · ${this.theme.fg("dim", "↵/Space")} expand` : "";
    lines.push(boxLine(`${this.theme.fg("dim", "←/→")} section · ${this.theme.fg("dim", "↑/↓")} ${where}${expandHint} · ${this.theme.fg("dim", "Home/End")} jump · ${this.theme.fg("dim", "q/Esc")} close`));
    lines.push(rule("╰", "╯"));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private renderTabs(): string {
    return this.sections
      .map((section, index) => {
        const label = ` ${section} `;
        return index === this.sectionIndex
          ? this.theme.fg("accent", this.theme.bold(`[${label}]`))
          : this.theme.fg("dim", ` ${label} `);
      })
      .join(" ");
  }

  private renderSummary(): string[] {
    const first = this.data.daily[0]?.date || "n/a";
    const last = this.data.daily[this.data.daily.length - 1]?.date || "n/a";
    return [
      `Total Spend:     ${formatUsd(this.data.total)}`,
      `Cost Split:      ${costSplitLine(this.data)}`,
      `Sessions:        ${this.data.sessionCount}`,
      `Billed Messages: ${this.data.messageCount}`,
      `Date Range:      ${first} to ${last}`,
    ];
  }

  private chartColors(): ChartColors {
    return {
      accent: (s) => this.theme.fg("accent", s),
      dim: (s) => this.theme.fg("dim", s),
      muted: (s) => this.theme.fg("muted", s),
      success: (s) => this.theme.fg("success", s),
      heat: heatColor,
    };
  }

  private renderOverview(width: number): string[] {
    const selectedDay = this.data.daily[this.dailyIndex];
    const lines = ["", ...this.renderSummary(), ""];
    lines.push(...lineChart(this.data.daily, width, selectedDay?.date, this.chartColors()));
    if (selectedDay) {
      lines.push("");
      lines.push(`Selected: ${selectedDay.date} · ${formatUsd(selectedDay.cost)} · ${selectedDay.messageCount} billed messages`);
      lines.push(`          ${costSplitLine(selectedDay)}`);
    }
    return lines;
  }

  private renderDaily(width: number): string[] {
    const selectedDay = this.data.daily[this.dailyIndex];
    const lines: string[] = ["", ...verticalBarChart(this.data.daily, width, selectedDay?.date, this.chartColors()), ""];

    if (!selectedDay) return [...lines, "No daily data."];
    lines.push(`${selectedDay.date} · ${formatUsd(selectedDay.cost)} · ${selectedDay.messageCount} billed messages`);
    lines.push(costSplitLine(selectedDay));
    lines.push("");

    const models = this.data.dailyModels[selectedDay.date] || [];
    if (models.length === 0) {
      lines.push("No model data for this date.");
      return lines;
    }
    lines.push("Models on selected date");
    lines.push("");
    for (const model of models.slice(0, 8)) {
      const pct = selectedDay.cost > 0 ? (model.cost / selectedDay.cost) * 100 : 0;
      lines.push(`  ${model.model.padEnd(22).slice(0, 22)} ${formatUsd(model.cost).padStart(9)}  ${pct.toFixed(0).padStart(3)}%`);
    }
    return lines;
  }

  private renderModels(width: number): string[] {
    const selected = this.data.byModel[this.modelIndex];
    const lines: string[] = ["", ...modelTable(this.data.byModel, this.data.total, this.modelIndex, this.chartColors()), ""];
    if (!selected) return [...lines, "No model data."];

    const series = this.data.daily
      .map((day) => ({
        date: day.date,
        cost: (this.data.dailyModels[day.date] || []).find((m) => m.model === selected.model)?.cost || 0,
        messageCount: (this.data.dailyModels[day.date] || []).find((m) => m.model === selected.model)?.messageCount || 0,
      }))
      .filter((day) => day.cost > 0);

    lines.push(`${selected.model} · ${formatUsd(selected.cost)} · ${selected.messageCount} billed messages`);
    lines.push(costSplitLine(selected));
    lines.push("");
    lines.push(...lineChart(series, width, series[series.length - 1]?.date, this.chartColors()));
    return lines;
  }

  // Every leaf project (cwd) at or beneath a directory path.
  private projectsUnder(dir: string): ProjectCost[] {
    const prefix = dir.endsWith("/") ? dir : `${dir}/`;
    return this.data.byProject.filter((p) => p.project === dir || p.project.startsWith(prefix));
  }

  private modelsUnder(dir: string): ModelCost[] {
    const acc: Record<string, ModelCost> = {};
    for (const proj of this.projectsUnder(dir)) {
      for (const m of this.data.projectModels[proj.project] || []) {
        const e = (acc[m.model] ||= {
          model: m.model,
          cost: 0,
          inputCost: 0,
          outputCost: 0,
          cacheReadCost: 0,
          cacheWriteCost: 0,
          inputTokens: 0,
          outputTokens: 0,
          messageCount: 0,
        });
        e.cost += m.cost;
        e.inputCost += m.inputCost;
        e.outputCost += m.outputCost;
        e.cacheReadCost += m.cacheReadCost;
        e.cacheWriteCost += m.cacheWriteCost;
        e.inputTokens += m.inputTokens;
        e.outputTokens += m.outputTokens;
        e.messageCount += m.messageCount;
      }
    }
    return Object.values(acc).sort((a, b) => b.cost - a.cost);
  }

  private dailyUnder(dir: string): DayCost[] {
    const acc: Record<string, DayCost> = {};
    for (const proj of this.projectsUnder(dir)) {
      for (const d of this.data.projectDaily[proj.project] || []) {
        const e = (acc[d.date] ||= {
          date: d.date,
          cost: 0,
          inputCost: 0,
          outputCost: 0,
          cacheReadCost: 0,
          cacheWriteCost: 0,
          inputTokens: 0,
          outputTokens: 0,
          messageCount: 0,
        });
        e.cost += d.cost;
        e.inputCost += d.inputCost;
        e.outputCost += d.outputCost;
        e.cacheReadCost += d.cacheReadCost;
        e.cacheWriteCost += d.cacheWriteCost;
        e.inputTokens += d.inputTokens;
        e.outputTokens += d.outputTokens;
        e.messageCount += d.messageCount;
      }
    }
    return Object.values(acc).sort((a, b) => a.date.localeCompare(b.date));
  }

  private renderProjects(width: number): string[] {
    if (!this.projectTree) return ["", "  No per-project cost data found."];

    const colors = this.chartColors();
    const rows = this.visibleProjectRows();
    this.projectIndex = clamp(this.projectIndex, 0, Math.max(0, rows.length - 1));

    const lines: string[] = ["", "  Cost by Project (directory)", ""];
    const maxCost = this.projectTree.cost || 1;
    const maxBar = 14;
    const { items, offset } = sliceAround(rows, this.projectIndex, 12);

    for (let i = 0; i < items.length; i++) {
      const { node, depth } = items[i];
      const selected = offset + i === this.projectIndex;
      const marker = selected ? ">" : " ";
      const twisty = node.children.length > 0 ? (this.expandedProjects.has(node.path) ? "▾ " : "▸ ") : "  ";
      const name = `${"  ".repeat(depth)}${twisty}${node.label}`;
      const left = truncateToWidth(name, 32);
      const leftPadded = left + " ".repeat(Math.max(0, 32 - visibleWidth(left)));
      const pct = this.data.total > 0 ? (node.cost / this.data.total) * 100 : 0;
      const barLen = Math.max(1, Math.round((node.cost / maxCost) * maxBar));
      const bar = colors.heat("█".repeat(barLen), node.cost / maxCost);
      lines.push(`${marker} ${leftPadded} ${bar} ${formatUsd(node.cost)} (${pct.toFixed(0)}%)`);
    }

    const sel = rows[this.projectIndex]?.node;
    if (!sel) return lines;

    lines.push("");
    lines.push(sel.path);
    lines.push(
      `${formatUsd(sel.cost)} · ${sel.projectCount} ${sel.projectCount === 1 ? "project" : "projects"} · ${sel.messageCount} billed messages`,
    );
    lines.push(costSplitLine(sel));

    const models = this.modelsUnder(sel.path);
    if (models.length > 0) {
      lines.push("");
      lines.push("Top models here");
      for (const m of models.slice(0, 5)) {
        const pct = sel.cost > 0 ? (m.cost / sel.cost) * 100 : 0;
        lines.push(`  ${m.model.padEnd(22).slice(0, 22)} ${formatUsd(m.cost).padStart(9)}  ${pct.toFixed(0).padStart(3)}%`);
      }
    }

    const series = this.dailyUnder(sel.path);
    if (series.length >= 2) {
      lines.push("");
      lines.push(...lineChart(series, width, series[series.length - 1]?.date, colors));
    }

    return lines;
  }
}

async function showCostsUI(data: CostData, ctx: ExtensionCommandContext, periodLabel = "All time") {
  if (!ctx.hasUI) {
    return;
  }

  await ctx.ui.custom((_tui, theme, _kb, done) => {
    return new CostsComponent(data, periodLabel, _tui, theme, () => done(undefined));
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("costs", {
    description: "Show all-time Pi session costs with charts",
    handler: async (args, ctx) => {
      const { from, to, label } = parsePeriod(args || "");

      if (ctx.hasUI) {
        ctx.ui.notify(`Scanning costs (${label})...`, "info");
      }

      const data = await scanSessions(from, to);

      if (data.messageCount === 0) {
        if (ctx.hasUI) {
          ctx.ui.notify(`No cost data found for: ${label}`, "warning");
        }
        return;
      }

      await showCostsUI(data, ctx, label);
    },
  });
}
