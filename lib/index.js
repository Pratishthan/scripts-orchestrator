import { Orchestrator, MEMORY_ABORT_EXIT_CODE } from './orchestrator.js';
import { MemoryGovernor, resolveMemoryGuard, MEMORY_GUARD_DEFAULTS } from './memory-governor.js';
import {
  availableMemoryRatio,
  parseLinuxMeminfo,
  parseDarwinVmStat,
} from './host-memory.js';
import { ProcessManager } from './process-manager.js';
import { HealthCheck } from './health-check.js';
import { Logger } from './logger.js';
import { GitCache } from './git-cache.js';
import { renderReportHtml } from './report-html.js';
import {
  recommendPhases,
  decideVerdict,
  formatRecommendationReport,
  computeBudget,
  usableSteps,
  observedTimeline,
  packPhases,
  stepCores,
  effectiveMemoryKb,
  effectiveBytes,
  isHeavy,
  resolveFanout,
} from './recommend-phases.js';
import {
  findRepoRoot,
  discoverWorkspaceDirs,
  aggregateWorkspacesReport,
  writeAggregateReport,
} from './workspaces.js';

export {
  Orchestrator,
  MEMORY_ABORT_EXIT_CODE,
  MemoryGovernor,
  resolveMemoryGuard,
  MEMORY_GUARD_DEFAULTS,
  availableMemoryRatio,
  parseLinuxMeminfo,
  parseDarwinVmStat,
  ProcessManager,
  HealthCheck,
  Logger,
  GitCache,
  renderReportHtml,
  recommendPhases,
  decideVerdict,
  formatRecommendationReport,
  computeBudget,
  usableSteps,
  observedTimeline,
  packPhases,
  stepCores,
  effectiveMemoryKb,
  effectiveBytes,
  isHeavy,
  resolveFanout,
  findRepoRoot,
  discoverWorkspaceDirs,
  aggregateWorkspacesReport,
  writeAggregateReport,
};
export default Orchestrator;