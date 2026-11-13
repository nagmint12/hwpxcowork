import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runScenarios } from '../scenarios.mjs';

test('deterministic workflows persist sentence, selected-guidance memo, table, figure replacement and report', { timeout: 120000 }, async () => {
  const report = await runScenarios();
  assert.equal(report.passed, true);
  assert.equal(report.paidApiCalls, 0);
  assert.equal(report.modelReasoningEvaluated, false);
  assert.equal(report.modelTokens, null);
  assert.equal(report.scenarios.length, 5);
  for (const scenario of report.scenarios) {
    assert.equal(scenario.status, 'passed', scenario.id);
    assert.equal(scenario.document.persisted, true);
    assert.ok(scenario.document.bytes > 1000);
    assert.match(scenario.document.sha256, /^[a-f0-9]{64}$/);
    assert.ok(scenario.metrics.toolCalls > 0);
    assert.equal(scenario.metrics.modelTokens, null);
    assert.ok(scenario.checks.length >= 3);
  }
  assert.ok(report.comparison.schemas.focusedTools < report.comparison.schemas.baselineTools);
  assert.ok(report.comparison.schemas.focusedChars < report.comparison.schemas.baselineChars);
  assert.ok(report.comparison.request.focusedChars < report.comparison.request.baselineChars);
  assert.equal(report.comparison.request.instructionPreserved, true);
  const review = report.scenarios.find(item => item.id === 'education_review');
  assert.match(review.guidance.source, /^fixture:/);
  assert.ok(review.guidance.fetchedPages >= 3);
  const figure = report.scenarios.find(item => item.id === 'figure_create_replace');
  assert.equal(figure.proposals, 2);
  assert.ok(figure.payload.avoidedRepeatedSourceChars > 0);
});

test('scenario output cannot be directed into production data', async () => {
  // npm --prefix runs scripts from the package directory. Resolve the forbidden
  // destination from this file so both root and package invocations test the
  // same production path. runScenarios must reject before any filesystem write.
  const productionOutput = fileURLToPath(new URL('../../../data/scenario-report.json', import.meta.url));
  await assert.rejects(runScenarios({ outputPath: productionOutput }), /inside experiments\/mcp-lab/);
});
