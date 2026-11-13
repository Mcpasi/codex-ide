#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { runAgentSessionBenchmark, agentSessionViolations } = require('../test/helpers/agent-session-benchmark');

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: node scripts/benchmark-agent-session.js [--duration-ms N] [--cycles N] [--checkpoint-cycles N] [--preload-cycles N] [--provider codex|antigravity] [--output report.json] [--source editor.js] [--styles editor.css] [--cpu-profile run.cpuprofile]\nDefault: 60 seconds, 24 changes, one guarded Chromium. Linux limits: 384 MiB browser RSS, 768 MiB available system memory.');
    return;
  }
  const options = { durationMs: 60000, cycles: 24, checkpointCycles: 12 };
  let output;
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index], value = process.argv[index + 1];
    if (!value) throw new Error('Missing value for ' + name);
    if (name === '--output') output = value;
    else if (name === '--source') options.source = fs.readFileSync(value, 'utf8');
    else if (name === '--styles') options.styles = fs.readFileSync(value, 'utf8');
    else if (name === '--cpu-profile') options.cpuProfile = value;
    else if (name === '--provider' && ['codex', 'antigravity'].includes(value)) options.provider = value;
    else if (['--duration-ms', '--cycles', '--checkpoint-cycles', '--preload-cycles'].includes(name)) {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < (['--duration-ms', '--preload-cycles'].includes(name) ? 0 : 1)) throw new Error('Invalid ' + name);
      options[{ '--duration-ms': 'durationMs', '--cycles': 'cycles', '--checkpoint-cycles': 'checkpointCycles', '--preload-cycles': 'preloadCycles' }[name]] = number;
    } else throw new Error('Unknown argument: ' + name);
  }
  console.error(`Agent/editor benchmark: ${options.durationMs} ms, ${options.cycles} cycles, native Chromium frames.`);
  let report;
  try {
    report = await runAgentSessionBenchmark({ ...options,
      onProgress: progress => console.error('Agent/editor progress: ' + JSON.stringify({
        cycle: progress.cycle, activities: progress.activities, eventP95Ms: progress.events?.p95Ms,
        activeFrameP95Ms: progress.activeFrames?.p95Ms,
        peakRssMiB: Math.round(progress.resources.peakRssBytes / 1024 ** 2),
        minAvailableMiB: Math.round(progress.resources.minimumAvailableBytes / 1024 ** 2)
      })) });
  } catch (error) {
    if (output) fs.writeFileSync(output, JSON.stringify({ status: 'aborted', error: error.message, resources: error.resources }, null, 2) + '\n');
    throw error;
  }
  report.violations = agentSessionViolations(report);
  report.status = report.violations.length ? 'regression' : 'passed';
  const json = JSON.stringify(report, null, 2) + '\n';
  if (output) {
    fs.writeFileSync(output, json);
    console.log(JSON.stringify({ status: report.status, output, elapsedMs: report.elapsedMs, cycles: report.cycles,
      saves: report.saves, activities: report.activities,
      firstActiveFrameP95Ms: report.checkpoints[0].activeFrames.p95Ms,
      lastActiveFrameP95Ms: report.checkpoints.at(-1).activeFrames.p95Ms,
      peakRssMiB: Math.round(report.resources.peakRssBytes / 1024 ** 2), violations: report.violations }));
  } else process.stdout.write(json);
  if (report.violations.length) process.exitCode = 1;
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
