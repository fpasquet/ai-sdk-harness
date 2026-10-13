import type { CatalogEvalReport } from './evaluate-catalog.js';

import { formatComparison, formatReport } from '../evaluate/format-report.js';

/**
 * A catalog's report as text: for each entry, its cases and, with a baseline, what it changes;
 * then the totals.
 */
export function formatCatalogReport(report: CatalogEvalReport): string {
  const blocks = report.entries.map(({ id, report: entry, comparison }) =>
    [
      `── ${id}`,
      formatReport(entry),
      ...(comparison === undefined
        ? []
        : ['', 'without it → with it', formatComparison(comparison)]),
    ].join('\n'),
  );
  const passed = report.entries.filter((entry) => entry.report.passed).length;
  const compared = report.entries.filter((entry) => entry.comparison !== undefined);
  const better = compared.filter((entry) => (entry.comparison?.scoreDelta ?? 0) > 0).length;
  const totals =
    `${passed}/${report.entries.length} entries passed` +
    (compared.length === 0 ? '' : ` · ${better}/${compared.length} better than without them`);
  return [...blocks, totals].join('\n\n');
}
