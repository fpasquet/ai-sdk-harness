export type {
  CatalogEntryEvalReport,
  CatalogEvalReport,
  EvaluateCatalogSettings,
} from './catalog/evaluate-catalog.js';
export { evaluateCatalog } from './catalog/evaluate-catalog.js';
export { formatCatalogReport } from './catalog/format-catalog-report.js';
export { DEFAULT_JUDGE_THRESHOLD } from './checks/judge.js';
export type {
  CheckOutcome,
  EvalAgent,
  EvalApprovals,
  EvalCase,
  EvalCaseReport,
  EvalCheck,
  EvalExpectations,
  EvalReport,
  EvalRun,
  EvalSandboxes,
  EvalSandboxLease,
  EvalStreamResult,
  EvalToolCall,
  EvalToolCallStatus,
  EvalTurn,
  EvaluateSettings,
  JudgeCriterion,
  TextPattern,
} from './definitions/eval.js';

export { InvalidEvalError } from './errors/invalid-eval-error.js';
export type {
  EvalCaseComparison,
  EvalCaseResults,
  EvalComparison,
} from './evaluate/compare-reports.js';
export { compareReports } from './evaluate/compare-reports.js';
export { DEFAULT_TIMEOUT_MS, evaluate } from './evaluate/evaluate.js';
export { formatComparison, formatReport } from './evaluate/format-report.js';
