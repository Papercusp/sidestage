import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function option(name, fallback) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((argument) => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const workspace = option('workspace', process.env.PAPERCUSP_WORKSPACE ?? 'papercusp-workspace');
const harness = option('harness', 'sidestage');
const configuredPlanPrefix = option('prefix', null);
const planPrefix = typeof configuredPlanPrefix === 'string' && configuredPlanPrefix.length > 0
  ? configuredPlanPrefix
  : null;
const output = resolve(option(
  'output',
  join(repoRoot, 'apps/api/src/build-history/build-history.snapshot.ts'),
));

function runPtool(tool, args) {
  const result = spawnSync(
    'ptool',
    [tool, '--json', '-', `--workspace=${workspace}`],
    { cwd: repoRoot, encoding: 'utf8', input: `${JSON.stringify(args)}\n` },
  );
  if (result.status !== 0) {
    throw new Error(`${tool} failed (${result.status ?? 'signal'}): ${result.stderr || result.stdout}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (cause) {
    throw new Error(`${tool} returned invalid JSON`, { cause });
  }
}

function frontmatterFrom(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (!match) return {};
  return Object.fromEntries(match[1].split(/\r?\n/).flatMap((line) => {
    const parsed = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!parsed) return [];
    const value = parsed[2].replace(/^(['"])(.*)\1$/, '$2').trim();
    if (value === 'true') return [[parsed[1], true]];
    if (value === 'false') return [[parsed[1], false]];
    return [[parsed[1], value]];
  }));
}

function metadataValue(text, label, pattern = '[^\\s]+') {
  return new RegExp(`(?:^|\\s)${label}:\\s*(${pattern})(?=\\s|$)`).exec(text)?.[1] ?? null;
}

function itemsFrom(markdown) {
  const lines = markdown.split(/\r?\n/);
  const items = [];
  let phase = null;
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^##\s+(.+)$/.exec(lines[index]);
    if (heading) phase = heading[1].startsWith('Phase') ? heading[1] : null;
    const parsed = /^- \*\*(P-\d+)\*\* `([^`]+)`\s+(.+)$/.exec(lines[index]);
    if (!parsed) continue;
    const rawText = parsed[3].trim();
    const blockedMatch = /(?:^|\s)blocked-by:\s*(P-\d+(?:\s*,\s*P-\d+)*)/.exec(rawText);
    const blockedBy = blockedMatch?.[1].split(',').map((id) => id.trim()) ?? [];
    const importance = metadataValue(rawText, 'importance');
    const riskTier = metadataValue(rawText, 'risk-tier');
    const authority = metadataValue(rawText, 'authority');
    const text = rawText
      .replace(/(?:^|\s)blocked-by:\s*P-\d+(?:\s*,\s*P-\d+)*/g, '')
      .replace(/(?:^|\s)importance:\s*[^\s]+/g, '')
      .replace(/(?:^|\s)risk-tier:\s*[^\s]+/g, '')
      .replace(/(?:^|\s)authority:\s*[^\s]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    items.push({
      id: parsed[1],
      text,
      storedStatus: parsed[2],
      effectiveStatus: parsed[2],
      importance,
      riskTier,
      authority,
      blockedBy,
      phase,
      lineNumber: index + 1,
    });
  }

  const byId = new Map(items.map((item) => [item.id, item]));
  const terminal = new Set(['done', 'dropped']);
  const effectiveStatus = (item, seen = new Set()) => {
    if (item.storedStatus !== 'todo' || seen.has(item.id)) return item.storedStatus;
    const nextSeen = new Set(seen).add(item.id);
    return item.blockedBy.some((id) => {
      const blocker = byId.get(id);
      return !blocker || !terminal.has(effectiveStatus(blocker, nextSeen));
    }) ? 'blocked' : item.storedStatus;
  };
  for (const item of items) item.effectiveStatus = effectiveStatus(item);
  return items;
}

function decisionsFrom(markdown) {
  const lines = markdown.split(/\r?\n/);
  const decisions = [];
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = /^###\s+(D-\d+)\s+[—-]\s+(.+)$/.exec(lines[index]);
    if (!parsed) continue;
    let end = index + 1;
    while (end < lines.length && !/^#{1,3}\s+/.test(lines[end])) end += 1;
    const body = lines.slice(index + 1, end).join('\n').trim();
    const date = /^Date:\s*(.+)$/m.exec(body)?.[1].trim() ?? null;
    const itemRefs = /^Related:\s*(.+)$/m.exec(body)?.[1]
      .split(',')
      .map((id) => id.trim())
      .filter((id) => /^P-\d+$/.test(id)) ?? [];
    decisions.push({ id: parsed[1], title: parsed[2].trim(), body, date, itemRefs, lineNumber: index + 1 });
    index = end - 1;
  }
  return decisions;
}

function completedItemsFrom(plan, items) {
  const completed = new Map();
  for (const item of items) {
    const matches = item.text.matchAll(/←\s+((?:WI|EI|F)-\d+)\s+completed\b/g);
    for (const match of matches) {
      const title = item.text.split(/\s+—\s+note:/)[0].trim();
      completed.set(match[1], {
        id: match[1],
        kind: 'work-item',
        title,
        state: 'done',
        completedAt: plan.updatedAt,
        completionAuthority: 'plan-ledger',
        completionSummary: `Recorded complete by ${item.id} in the canonical plan ledger.`,
        completionEvidence: {
          source: 'canonical-plan-completion-marker',
          planItem: item.id,
          contentHash: plan.contentHash,
        },
      });
    }
  }
  return [...completed.values()];
}

function listRows(payload) {
  if (Array.isArray(payload.plans)) return payload.plans;
  const first = Array.isArray(payload.results) ? payload.results[0] : null;
  return Array.isArray(first?.plans) ? first.plans : [];
}

const exportDirectory = mkdtempSync(join(tmpdir(), 'sidestage-history-'));
try {
  const listed = listRows(runPtool('plans:list', {
    harness,
    compact: true,
    limit: 500,
    order: 'updated',
  })).filter((plan) => (
    typeof plan.slug === 'string'
    && (planPrefix === null || plan.slug.startsWith(planPrefix))
  ));
  runPtool('plans:export', { harness, toDir: exportDirectory });

  const plans = listed.map((listedPlan) => {
    const markdown = readFileSync(join(exportDirectory, `${listedPlan.slug}.md`), 'utf8');
    const frontmatter = frontmatterFrom(markdown);
    const contentHash = createHash('sha256').update(markdown).digest('hex');
    const plan = {
      slug: listedPlan.slug,
      title: listedPlan.title ?? frontmatter.title ?? listedPlan.slug,
      status: listedPlan.status ?? frontmatter.status ?? 'unknown',
      updatedAt: listedPlan.updated ?? frontmatter.updated ?? null,
      contentHash,
      markdown,
      frontmatter,
      items: itemsFrom(markdown),
      decisions: decisionsFrom(markdown),
      completedItems: [],
    };
    plan.completedItems = completedItemsFrom(plan, plan.items);
    return plan;
  });
  const generatedAt = new Date().toISOString();
  const snapshot = {
    schemaVersion: 2,
    source: {
      kind: 'papercusp-plan-export',
      workspace,
      harness,
      planPrefix,
      generatedAt,
      planCount: plans.length,
      generator: 'scripts/generate-build-history-snapshot.mjs',
    },
    plans,
  };
  const body = [
    '/* This file is generated by npm run history:snapshot. Do not edit by hand. */',
    `export const BUILD_HISTORY_SNAPSHOT = ${JSON.stringify(snapshot, null, 2)} as const;`,
    '',
  ].join('\n');
  writeFileSync(output, body);
  process.stdout.write(`Wrote ${plans.length} plans to ${output}\n`);
} finally {
  rmSync(exportDirectory, { recursive: true, force: true });
}
