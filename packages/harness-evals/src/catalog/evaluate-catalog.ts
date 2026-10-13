import type { Catalog, CatalogEntry, Plugin } from 'ai-sdk-harness-plugins';

import type {
  EvalAgent,
  EvalCase,
  EvalReport,
  EvalSandboxes,
  EvaluateSettings,
} from '../definitions/eval.js';
import type { EvalComparison } from '../evaluate/compare-reports.js';

import { InvalidEvalError } from '../errors/invalid-eval-error.js';
import { compareReports } from '../evaluate/compare-reports.js';
import { concurrencyOf, evaluateOn, sandboxesOf } from '../evaluate/evaluate.js';
import { validate } from '../evaluate/validate.js';
import { Limiter } from '../utils/limiter.js';

/** The settings of `evaluateCatalog()`: those of `evaluate()`, the agent built for each entry. */
export interface EvaluateCatalogSettings extends Omit<
  EvaluateSettings,
  'agent' | 'cases' | 'plugins'
> {
  /** The marketplace: its plugins and items carry their eval cases (`evals`). */
  catalog: Pick<Catalog, 'entries' | 'resolve'>;
  /**
   * The agent with `plugins`: those an entry resolves to, what it requires included — none for the
   * baseline. `withPlugins()` of your settings, as your application builds its agents.
   */
  agent: (plugins: Plugin[]) => EvalAgent;
  /** The entries to evaluate, by catalog id. Every entry with eval cases when absent. */
  only?: readonly string[];
  /**
   * Whether each entry's cases also run on the agent without it, for the report to say what the
   * entry changes. Default: `true`.
   */
  baseline?: boolean;
  /** Called once an entry is over, with it and without it: to show progress. */
  onEntryEnd?: (report: CatalogEntryEvalReport) => void;
}

/** What `evaluateCatalog()` found of one plugin or item. */
export interface CatalogEntryEvalReport {
  /** Its catalog id: `plugin:<name>`, `<kind>:<name>`. */
  id: string;
  kind: CatalogEntry['kind'];
  /** Its cases on the agent with it. */
  report: EvalReport;
  /** Its cases on the agent without it, unless `baseline` is `false`. */
  baseline?: EvalReport;
  /** The two side by side: what the entry changes. */
  comparison?: EvalComparison;
}

/** The report of `evaluateCatalog()`. */
export interface CatalogEvalReport {
  /** Every case of every entry passed, on the agent with its entry. */
  passed: boolean;
  entries: CatalogEntryEvalReport[];
  durationMs: number;
}

/** An entry, with its cases as `evaluate()` takes them. */
type EntryWithCases = Omit<CatalogEntry, 'evals'> & { evals: EvalCase[] };

/** The entries to evaluate, each with its cases. */
function entriesOf(settings: EvaluateCatalogSettings): EntryWithCases[] {
  const all = settings.catalog.entries();
  const byId = new Map(all.map((entry) => [entry.id, entry]));
  const ids =
    settings.only ?? all.filter(({ evals }) => (evals?.length ?? 0) > 0).map(({ id }) => id);
  return ids.map((id) => {
    const entry = byId.get(id);
    if (entry === undefined) throw new InvalidEvalError(`The catalog has no ${id}.`);
    if (entry.evals === undefined || entry.evals.length === 0) {
      throw new InvalidEvalError(`${id} has no eval cases.`);
    }
    // Checked by `validate()`, before anything runs: they may come from JSON.
    return { ...entry, evals: entry.evals };
  });
}

/** What every run of a catalog's evaluation shares: its sandboxes, and how many trials at once. */
interface Shared {
  sandboxes: EvalSandboxes;
  limiter: Limiter;
  baselineAgent: EvalAgent | undefined;
}

/** Evaluates one entry: its cases with it, and without it, side by side. */
async function evaluateEntry(
  settings: EvaluateCatalogSettings,
  entry: EntryWithCases,
  { sandboxes, limiter, baselineAgent }: Shared,
): Promise<CatalogEntryEvalReport> {
  const {
    catalog,
    agent,
    only: _only,
    baseline: _baseline,
    onEntryEnd: _onEntryEnd,
    ...rest
  } = settings;
  const on = { sandboxes, limiter };
  const resolved = await catalog.resolve([entry.id]);
  try {
    const [report, baseline] = await Promise.all([
      evaluateOn(
        { ...rest, agent: agent(resolved.plugins), plugins: resolved.plugins, cases: entry.evals },
        on,
      ),
      baselineAgent && evaluateOn({ ...rest, agent: baselineAgent, cases: entry.evals }, on),
    ]);
    return {
      id: entry.id,
      kind: entry.kind,
      report,
      ...(baseline && { baseline, comparison: compareReports(baseline, report) }),
    };
  } finally {
    await resolved.close();
  }
}

/**
 * Evaluates a marketplace: the eval cases of each plugin and item (`evals`) on the agent with it —
 * and on the agent without it, to tell what it changes. Every trial of every entry waits for a
 * place among the `concurrency` the sandboxes allow: with one sandbox, one after the other.
 *
 * @throws {InvalidEvalError} before any case runs, when an entry or its cases cannot run.
 */
export async function evaluateCatalog(
  settings: EvaluateCatalogSettings,
): Promise<CatalogEvalReport> {
  const started = Date.now();
  const entries = entriesOf(settings);
  for (const entry of entries) {
    try {
      validate({ ...settings, cases: entry.evals });
    } catch (error) {
      if (!InvalidEvalError.isInstance(error)) throw error;
      throw new InvalidEvalError(`${entry.id}: ${error.message}`);
    }
  }
  const sandboxes = sandboxesOf(settings.sandbox);
  const shared: Shared = {
    sandboxes,
    limiter: new Limiter(concurrencyOf(settings, sandboxes)),
    baselineAgent: settings.baseline === false ? undefined : settings.agent([]),
  };
  const reports: CatalogEntryEvalReport[] = [];
  await Promise.all(
    entries.map(async (entry, index) => {
      reports[index] = await evaluateEntry(settings, entry, shared);
      settings.onEntryEnd?.(reports[index]);
    }),
  );
  return {
    passed: reports.every(({ report }) => report.passed),
    entries: reports,
    durationMs: Date.now() - started,
  };
}
