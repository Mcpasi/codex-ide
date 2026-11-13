'use strict';

const { chromium, runAgentSessionBenchmark, agentSessionViolations } = require('./helpers/agent-session-benchmark');
// Native frame collection is explicitly opt-in. It must never overlap another
// Chromium suite on a small development machine; the runner also holds a lock.
const browserTest = chromium && process.env.CODEX_IDE_AGENT_BROWSER_BENCHMARK === '1' ? test : test.skip;

browserTest('keeps native frames and agent UI work bounded while the complete turn history grows', async () => {
  const report = await runAgentSessionBenchmark();
  if (process.env.CODEX_IDE_PERF_REPORT === '1' || process.env.npm_lifecycle_event === 'test:performance') {
    console.log(JSON.stringify({ agentSessionPerformance: report }, null, 2));
  }
  expect(report).toMatchObject({ cycles: 24, saves: 24, aborts: 2, activities: 98, persistedActivities: 98, restored: true });
  expect(report.checkpoints).toHaveLength(2);
  expect(report.checkpoints.every(point => point.frames.samples > 10)).toBe(true);
  expect(agentSessionViolations(report)).toEqual([]);
}, 150000);
