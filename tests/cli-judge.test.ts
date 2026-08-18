/**
 * CLI integration tests for the LLM judge stage.
 *
 * Spawns the real CLI with AGHAST_MOCK_AI=true and AGHAST_MOCK_JUDGE=<fixture>
 * to verify the judge pipeline end-to-end without live API calls.
 *
 * Coverage:
 * - Default off (no judge flags): identical output to pre-judge runs
 * - Enabled annotation only: issues get judge field, summary.judgedIssues populated
 * - --judge-drop-false-positives: FP issues removed, checks recomputed
 * - Uncertain → FLAG escalation: check becomes FLAG, flagSource:"judge"
 * - --judge-min-confidence: low-confidence TP demoted to uncertain → FLAG
 * - Per-check judge: false opt-out: issue skipped by judge
 * - Static-check issues judged (decision #3)
 * - Judge-stage failure (malformed response): verdict uncertain, check FLAG
 * - Mixed-provider mock: agentProvider.models scan-only, metadata.judge attribution
 * - Judge provider preflight: E8002 unknown provider, E8003 init/model failures,
 *   disabled-stage warning, mock-override warning
 * - SARIF output: properties.judge and flagSource surfaced
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fixtureRepo,
  singleCheckConfigDir,
  semgrepOnlyConfigDir,
  failFixtureRepo,
  cli3TargetsSarif,
  createScopedHelpers,
} from './cli-test-helpers.js';

const testDir = dirname(fileURLToPath(import.meta.url));

const judgeResponses = resolve(testDir, 'fixtures', 'judge-responses');
const judgeOptOutConfigDir = resolve(testDir, 'fixtures', 'cli-configs', 'judge-opt-out');

const judgeTpFixture = resolve(judgeResponses, 'judge-tp-response.json');
const judgeFpFixture = resolve(judgeResponses, 'judge-fp-response.json');
const judgeUncertainFixture = resolve(judgeResponses, 'judge-uncertain-response.json');
const judgeLowConfFixture = resolve(judgeResponses, 'judge-low-confidence-tp.json');
const judgeMalformedFixture = resolve(judgeResponses, 'judge-malformed.txt');

// Use scoped helpers so parallel test files don't collide on output files.
const { runCLI: scopedRun, cleanupOutput, readResults, sarifOutputFile, runCLISarif } =
  createScopedHelpers('judge');

// ─── Default off ─────────────────────────────────────────────────────────────

describe('CLI judge: default off (no judge flags)', () => {
  afterEach(cleanupOutput);

  it('PASS scan without judge produces no judge fields on issues', async () => {
    const { exitCode } = await scopedRun({ AGHAST_MOCK_AI: 'true' });
    assert.equal(exitCode, 0);
    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    assert.equal(issues.length, 0);
    const summary = results.summary as Record<string, unknown>;
    assert.equal(summary.judgedIssues, undefined);
  });

  it('FAIL scan without judge produces no judge field on issues', async () => {
    const { exitCode } = await scopedRun({ AGHAST_MOCK_AI: failFixtureRepo });
    assert.equal(exitCode, 0);
    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    assert.equal(issues.length, 1);
    assert.equal(issues[0].judge, undefined);
    assert.equal(issues[0].flagSource, undefined);
    const summary = results.summary as Record<string, unknown>;
    assert.equal(summary.judgedIssues, undefined);
  });
});

// ─── Enabled — annotation only ───────────────────────────────────────────────

describe('CLI judge: enabled (true_positive annotation)', () => {
  afterEach(cleanupOutput);

  it('FAIL scan with judge annotates issues with true_positive verdict', async () => {
    const { exitCode } = await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeTpFixture,
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--output', resolve(fixtureRepo, 'security_checks_results_judge.json'),
    ]);
    assert.equal(exitCode, 0);
    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    assert.equal(issues.length, 1, 'Issue should not be dropped (TP)');
    const judge = issues[0].judge as Record<string, unknown>;
    assert.ok(judge, 'Issue should have judge field');
    assert.equal(judge.verdict, 'true_positive');
    assert.equal(judge.model, 'claude-opus-4-7');
    const summary = results.summary as Record<string, unknown>;
    assert.equal(summary.judgedIssues, 1);
    assert.equal(summary.falsePositives, 0);
    assert.equal(summary.uncertainJudgements, 0);
  });

  it('check remains FAIL after true_positive judge verdict', async () => {
    const { exitCode } = await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeTpFixture,
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--output', resolve(fixtureRepo, 'security_checks_results_judge.json'),
    ]);
    assert.equal(exitCode, 0);
    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'FAIL');
  });

  it('banner includes judge summary line', async () => {
    const { stdout, stderr } = await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeTpFixture,
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--output', resolve(fixtureRepo, 'security_checks_results_judge.json'),
    ]);
    const combined = stdout + stderr;
    assert.ok(combined.includes('Judged:'), 'Banner should include Judged line');
    assert.ok(combined.includes('claude-opus-4-7'), 'Banner should include judge model');
  });
});

// ─── --judge-drop-false-positives ────────────────────────────────────────────

describe('CLI judge: --judge-drop-false-positives', () => {
  afterEach(cleanupOutput);

  it('drops false-positive issues from output', async () => {
    const { exitCode } = await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeFpFixture,
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--judge-drop-false-positives',
      '--output', resolve(fixtureRepo, 'security_checks_results_judge.json'),
    ]);
    assert.equal(exitCode, 0);
    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    assert.equal(issues.length, 0, 'FP issue should be dropped');
    const summary = results.summary as Record<string, unknown>;
    assert.equal(summary.totalIssues, 0);
    assert.equal(summary.falsePositives, 1);
  });

  it('check that loses all issues becomes PASS after drop', async () => {
    await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeFpFixture,
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--judge-drop-false-positives',
      '--output', resolve(fixtureRepo, 'security_checks_results_judge.json'),
    ]);
    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'PASS');
    const summary = results.summary as Record<string, unknown>;
    assert.equal(summary.passedChecks, 1);
    assert.equal(summary.failedChecks, 0);
  });

  it('keeps false-positive issue when drop flag is NOT set', async () => {
    await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeFpFixture,
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--output', resolve(fixtureRepo, 'security_checks_results_judge.json'),
    ]);
    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    assert.equal(issues.length, 1, 'FP issue should be retained without --judge-drop-false-positives');
  });
});

// ─── Uncertain → FLAG escalation ─────────────────────────────────────────────

describe('CLI judge: uncertain verdict → FLAG escalation', () => {
  afterEach(cleanupOutput);

  it('check whose only issues are uncertain becomes FLAG', async () => {
    await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeUncertainFixture,
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--output', resolve(fixtureRepo, 'security_checks_results_judge.json'),
    ]);
    const results = await readResults();
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'FLAG');
    const summary = results.summary as Record<string, unknown>;
    assert.equal(summary.flaggedChecks, 1);
    assert.equal(summary.failedChecks, 0);
  });

  it('uncertain issue has flagSource: "judge"', async () => {
    await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeUncertainFixture,
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--output', resolve(fixtureRepo, 'security_checks_results_judge.json'),
    ]);
    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    assert.equal(issues.length, 1);
    assert.equal(issues[0].flagSource, 'judge');
    assert.equal(summary(results).uncertainJudgements, 1);
  });
});

// ─── --judge-min-confidence ──────────────────────────────────────────────────

describe('CLI judge: --judge-min-confidence', () => {
  afterEach(cleanupOutput);

  it('true_positive below threshold is demoted to uncertain (→ FLAG)', async () => {
    await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeLowConfFixture,
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--judge-min-confidence', '0.5',
      '--output', resolve(fixtureRepo, 'security_checks_results_judge.json'),
    ]);
    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    assert.equal(issues.length, 1);
    const j = issues[0].judge as Record<string, unknown>;
    assert.equal(j.verdict, 'uncertain', 'Low-confidence TP should be demoted to uncertain');
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'FLAG', 'Check should escalate to FLAG');
  });

  it('true_positive above threshold is kept as true_positive', async () => {
    await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeTpFixture,
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--judge-min-confidence', '0.5',
      '--output', resolve(fixtureRepo, 'security_checks_results_judge.json'),
    ]);
    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    const j = issues[0].judge as Record<string, unknown>;
    assert.equal(j.verdict, 'true_positive');
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'FAIL');
  });
});

// ─── Per-check judge: false opt-out ──────────────────────────────────────────

describe('CLI judge: per-check judge: false opt-out', () => {
  afterEach(cleanupOutput);

  it('issues from a check with judge:false have no judge field', async () => {
    await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeTpFixture,
    }, [
      fixtureRepo, '--config-dir', judgeOptOutConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--output', resolve(fixtureRepo, 'security_checks_results_judge.json'),
    ]);
    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    assert.equal(issues.length, 1, 'Issue should still appear (not dropped)');
    assert.equal(issues[0].judge, undefined, 'No judge field for opt-out check');
    // Check stays FAIL (not escalated)
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'FAIL');
    const sum = results.summary as Record<string, unknown>;
    assert.equal(sum.judgedIssues, 0, 'judgedIssues should be 0 when all checks opt out');
  });
});

// ─── Static-check issues judged (decision #3) ────────────────────────────────

describe('CLI judge: static-check issues are judged', () => {
  afterEach(cleanupOutput);

  it('static check findings receive judge annotation', async () => {
    await scopedRun({
      AGHAST_MOCK_SARIF: cli3TargetsSarif,
      AGHAST_MOCK_JUDGE: judgeTpFixture,
    }, [
      fixtureRepo, '--config-dir', semgrepOnlyConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--output', resolve(fixtureRepo, 'security_checks_results_judge.json'),
    ]);
    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    assert.ok(issues.length > 0, 'Static findings should be present');
    for (const issue of issues) {
      const j = issue.judge as Record<string, unknown> | undefined;
      assert.ok(j, 'Each static issue should have a judge field');
      assert.equal(j.verdict, 'true_positive');
    }
    const sum = results.summary as Record<string, unknown>;
    assert.equal(sum.judgedIssues, issues.length);
  });
});

// ─── Judge failure → uncertain ───────────────────────────────────────────────

describe('CLI judge: malformed response → uncertain', () => {
  afterEach(cleanupOutput);

  it('malformed judge response results in verdict:uncertain', async () => {
    await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeMalformedFixture,
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--output', resolve(fixtureRepo, 'security_checks_results_judge.json'),
    ]);
    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    assert.equal(issues.length, 1, 'Issue should still appear');
    const j = issues[0].judge as Record<string, unknown>;
    assert.ok(j, 'Issue should have judge field even on failure');
    assert.equal(j.verdict, 'uncertain');
    assert.ok(
      (j.rationale as string).includes('judge failed:'),
      'Rationale should mention judge failed',
    );
    // Check should FLAG-escalate (decision #6)
    const checks = results.checks as Array<Record<string, unknown>>;
    assert.equal(checks[0].status, 'FLAG');
    assert.equal(issues[0].flagSource, 'judge');
  });
});

// ─── Mixed provider mock ─────────────────────────────────────────────────────

describe('CLI judge: mixed provider mock', () => {
  afterEach(cleanupOutput);

  it('agentProvider.models is scan-only; metadata.judge carries the judge pair', async () => {
    // The judge may run on a different provider than the scan, so its model no
    // longer joins agentProvider.models — the stage is attributed explicitly in
    // metadata.judge instead.
    await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeTpFixture,
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--model', 'claude-haiku-4-5',
      '--judge-model', 'claude-opus-4-7',
    ]);
    const results = await readResults();
    const ap = results.agentProvider as { name: string; models: string[] };
    assert.ok(ap.models.includes('claude-haiku-4-5'), 'Scan model should be listed');
    assert.ok(!ap.models.includes('claude-opus-4-7'), 'Judge model should NOT be folded into the scan provider models');
    const metadata = results.metadata as Record<string, unknown>;
    assert.deepEqual(metadata.judge, { provider: 'mock', model: 'claude-opus-4-7' });
  });

  it('metadata.judge is absent when no judge is configured', async () => {
    await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--model', 'claude-haiku-4-5',
    ]);
    const results = await readResults();
    const metadata = results.metadata as Record<string, unknown> | undefined;
    assert.equal(metadata?.judge, undefined);
  });

  it('metadata.judge is present but models excludes the judge model on PASS scan (judge never ran)', async () => {
    // metadata.judge records the stage *configuration*; the model lists record
    // actual usage. On a PASS scan the stage is enabled but never executes.
    await scopedRun({
      AGHAST_MOCK_AI: 'true',
      AGHAST_MOCK_JUDGE: 'true',
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--model', 'claude-haiku-4-5',
      '--judge-model', 'claude-opus-4-7',
    ]);
    const results = await readResults();
    const ap = results.agentProvider as { name: string; models: string[] };
    assert.ok(ap.models.includes('claude-haiku-4-5'), 'Scan model should be listed');
    assert.ok(!ap.models.includes('claude-opus-4-7'), 'Judge model should NOT be listed when judge never ran');
    const metadata = results.metadata as Record<string, unknown>;
    assert.deepEqual(metadata.judge, { provider: 'mock', model: 'claude-opus-4-7' });
  });

  it('history record carries judgeProvider/judgeModel, and models includes the judge model, when the judge ran', async () => {
    const { mkdtemp, rm, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmpDir = await mkdtemp(join(tmpdir(), 'aghast-judge-history-'));
    const historyFile = join(tmpDir, 'history.json');
    try {
      const { exitCode } = await scopedRun({
        AGHAST_MOCK_AI: failFixtureRepo,
        AGHAST_MOCK_JUDGE: judgeTpFixture,
        AGHAST_HISTORY_FILE: historyFile,
      }, [
        fixtureRepo, '--config-dir', singleCheckConfigDir,
        '--model', 'claude-haiku-4-5',
        '--judge-model', 'claude-opus-4-7',
      ]);
      assert.equal(exitCode, 0);
      const raw = await readFile(historyFile, 'utf-8');
      const file = JSON.parse(raw) as { records: Array<Record<string, unknown>> };
      assert.equal(file.records.length, 1);
      const rec = file.records[0];
      assert.equal(rec.judgeProvider, 'mock');
      assert.equal(rec.judgeModel, 'claude-opus-4-7');
      const models = rec.models as string[];
      assert.ok(models.includes('claude-haiku-4-5'), 'history models should include the scan model');
      assert.ok(models.includes('claude-opus-4-7'), 'history models should include the judge model (stats attribution)');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── Judge provider selection & preflight ────────────────────────────────────

describe('CLI judge: judge provider preflight', () => {
  afterEach(cleanupOutput);

  it('unknown judge provider exits 1 with E8002 before the scan starts', async () => {
    // Static-only config: no scan provider is needed, so the judge preflight is
    // the first provider-related gate hit. AGHAST_MOCK_SARIF bypasses the
    // Semgrep install requirement.
    const { exitCode, stdout, stderr } = await scopedRun({
      AGHAST_MOCK_SARIF: cli3TargetsSarif,
    }, [
      fixtureRepo, '--config-dir', semgrepOnlyConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--judge-provider', 'bogus',
    ]);
    assert.equal(exitCode, 1);
    assert.match(stderr, /E8002/);
    assert.match(stderr, /bogus/);
    assert.ok(!stdout.includes('Starting scan'), 'scan should not start with an unknown judge provider');
  });

  it('wrong-dialect judge model for opencode exits 1 with E8003 naming the judge', async () => {
    // opencode's parseModelString rejects "no-slash" before its binary check,
    // so this stays hermetic on machines without opencode installed.
    const { exitCode, stdout, stderr } = await scopedRun({
      AGHAST_MOCK_SARIF: cli3TargetsSarif,
    }, [
      fixtureRepo, '--config-dir', semgrepOnlyConfigDir,
      '--judge-model', 'no-slash-format',
      '--judge-provider', 'opencode',
    ]);
    assert.equal(exitCode, 1);
    assert.match(stderr, /E8003/);
    assert.match(stderr, /Judge provider "opencode" failed to initialize/);
    assert.match(stderr, /Invalid model format/);
    assert.ok(!stdout.includes('Starting scan'), 'scan should not start with a wrong-dialect judge model');
  });

  it('invalid judge model on the reused scan provider exits 1 with E8003 before scanning', async () => {
    // Same provider for scan and judge → the scan's instance is reused and the
    // judge model is preflighted against it (validateModel, hermetic via
    // AGHAST_MOCK_CLAUDE_MODELS + AGHAST_MOCK_LOCAL_LOGIN).
    const { exitCode, stdout, stderr } = await scopedRun({
      AGHAST_MOCK_AI: undefined,
      AGHAST_MOCK_LOCAL_LOGIN: 'true',
      AGHAST_MOCK_CLAUDE_MODELS: 'haiku,sonnet',
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--model', 'haiku',
      '--judge-model', 'junk',
    ]);
    assert.equal(exitCode, 1);
    assert.match(stderr, /E8003/);
    assert.match(stderr, /junk/);
    assert.ok(!stdout.includes('Starting scan'), 'scan should not start with an invalid judge model');
  });

  it('judge provider without a judge model warns that the stage is disabled', async () => {
    const { exitCode, stdout, stderr } = await scopedRun({
      AGHAST_MOCK_AI: 'true',
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-provider', 'claude-code',
    ]);
    assert.equal(exitCode, 0);
    const combined = stdout + stderr;
    assert.ok(combined.includes('the judge stage is disabled'), 'should warn about the disabled judge stage');
    const results = await readResults();
    const metadata = results.metadata as Record<string, unknown> | undefined;
    assert.equal(metadata?.judge, undefined, 'no judge metadata when the stage never enabled');
  });

  it('AGHAST_MOCK_AI names the judge provider it overrides', async () => {
    const { exitCode, stdout, stderr } = await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--judge-provider', 'opencode',
    ]);
    assert.equal(exitCode, 0);
    const combined = stdout + stderr;
    assert.ok(
      combined.includes('ignoring configured judge provider "opencode"'),
      'warning should name the overridden judge provider',
    );
    const results = await readResults();
    const metadata = results.metadata as Record<string, unknown>;
    assert.deepEqual(
      metadata.judge,
      { provider: 'mock', model: 'claude-opus-4-7' },
      'the report must attribute the judge to the provider that actually ran',
    );
  });
});

// ─── SARIF output ────────────────────────────────────────────────────────────

describe('CLI judge: SARIF output', () => {
  afterEach(cleanupOutput);

  it('SARIF results include properties.judge and kind for judged issues', async () => {
    await runCLISarif({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeTpFixture,
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--output-format', 'sarif',
    ]);

    const { readFile } = await import('node:fs/promises');
    const sarifText = await readFile(sarifOutputFile, 'utf-8');

    const sarif = JSON.parse(sarifText) as Record<string, unknown>;
    const runs = sarif.runs as Array<Record<string, unknown>>;
    const results = runs[0].results as Array<Record<string, unknown>>;
    assert.equal(results.length, 1);
    const sarifResult = results[0];
    assert.equal(sarifResult.kind, 'open', 'true_positive should map to kind:open');
    const props = sarifResult.properties as Record<string, unknown>;
    assert.ok(props, 'SARIF result should have properties');
    assert.ok(props.judge, 'properties.judge should be present');
    const judgeProps = props.judge as Record<string, unknown>;
    assert.equal(judgeProps.verdict, 'true_positive');
  });

  it('SARIF result for false_positive has kind:pass with a suppression', async () => {
    await runCLISarif({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeFpFixture,
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--output-format', 'sarif',
    ]);

    const { readFile } = await import('node:fs/promises');
    const sarifText = await readFile(sarifOutputFile, 'utf-8');

    const sarif = JSON.parse(sarifText) as Record<string, unknown>;
    const runs = sarif.runs as Array<Record<string, unknown>>;
    const results = runs[0].results as Array<Record<string, unknown>>;
    // "false" is not a member of the SARIF 2.1.0 kind enum, so it is mapped to
    // "pass" — the same representation this formatter already uses for
    // false-positive-validation dismissals — with the reason in a suppression.
    assert.equal(results[0].kind, 'pass', 'false_positive maps to kind:pass, not the invalid kind:false');
    const suppressions = results[0].suppressions as Array<Record<string, unknown>>;
    assert.equal(suppressions.length, 1);
    assert.equal(suppressions[0].kind, 'external');
    assert.ok(suppressions[0].justification, 'the judge rationale should be carried as the justification');
    assert.equal(results[0].level, undefined, 'level is meaningless alongside kind:pass');
  });

  it('SARIF result for uncertain has kind:review', async () => {
    await runCLISarif({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeUncertainFixture,
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--output-format', 'sarif',
    ]);

    const { readFile } = await import('node:fs/promises');
    const sarifText = await readFile(sarifOutputFile, 'utf-8');

    const sarif = JSON.parse(sarifText) as Record<string, unknown>;
    const runs = sarif.runs as Array<Record<string, unknown>>;
    const results = runs[0].results as Array<Record<string, unknown>>;
    assert.equal(results[0].kind, 'review', 'uncertain should map to kind:review');
  });
});

// ─── Budget abort during judge stage ─────────────────────────────────────────

describe('CLI judge: budget abort during judge stage', () => {
  afterEach(cleanupOutput);

  it('budget abort during judge: exits non-zero, issues retain scan results without judge field', async () => {
    // Strategy: use AGHAST_MOCK_TOKENS=1000000,0 so the scan records 1M tokens for
    // the check call. Set --budget-limit-tokens=500000 so that the per-issue
    // preflightBudget() call inside the judge worker sees 1M accumulated tokens
    // (> 500000 limit) and throws BudgetExceededError before executeCheck is called.
    // With only 1 issue in the fixture, the abort fires on the first (only) issue,
    // leaving it without a `judge` field.
    //
    // Verifies:
    //   - exit code is 1 (budget abort)
    //   - E7001 appears in stderr
    //   - output file was written (scan completed; 1 issue found)
    //   - the issue has no `judge` field (judge was aborted before running)
    const result = await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeTpFixture,
      AGHAST_MOCK_TOKENS: '1000000,0',
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--model', 'claude-haiku-4-5',
      '--budget-limit-tokens', '500000',
    ]);
    assert.equal(result.exitCode, 1, `expected exit 1 (budget abort), got ${result.exitCode}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /E7001/, 'stderr should include E7001 budget error code');

    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    assert.equal(issues.length, 1, 'scan should have completed with 1 issue before judge abort');
    assert.equal(issues[0].judge, undefined, 'issue should have no judge field (judge was aborted before running)');
  });
});

// ─── Judge retry ─────────────────────────────────────────────────────────────

describe('CLI judge: retry covers the judge stage', () => {
  afterEach(cleanupOutput);

  it('retries a transient judge failure when retry is enabled', async () => {
    // Two transient 503s from the judge provider against a budget of three
    // attempts. Before the judge was wired into withRetry these degraded the
    // verdict to `uncertain`, which escalates the check to FLAG — turning a
    // network blip into a flagged security finding.
    const { exitCode } = await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeTpFixture,
      AGHAST_MOCK_JUDGE_FAIL_TIMES: '2',
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
      '--retry-max-attempts', '3',
    ]);
    assert.equal(exitCode, 0);

    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    const judge = issues[0].judge as Record<string, unknown>;
    assert.ok(judge, 'issue should carry a judge verdict');
    assert.equal(
      judge.verdict,
      'true_positive',
      'a retried transient failure must yield the real verdict, not `uncertain`',
    );
  });

  it('does not retry the judge when retry is not enabled', async () => {
    // Same failure, no opt-in: the judge call fails and the verdict degrades.
    // Pins that judge retry follows the same opt-in switch as check analysis
    // rather than being silently always-on.
    const { exitCode } = await scopedRun({
      AGHAST_MOCK_AI: failFixtureRepo,
      AGHAST_MOCK_JUDGE: judgeTpFixture,
      AGHAST_MOCK_JUDGE_FAIL_TIMES: '2',
    }, [
      fixtureRepo, '--config-dir', singleCheckConfigDir,
      '--judge-model', 'claude-opus-4-7',
    ]);
    assert.equal(exitCode, 0);

    const results = await readResults();
    const issues = results.issues as Array<Record<string, unknown>>;
    const judge = issues[0].judge as Record<string, unknown>;
    assert.ok(judge, 'issue should still carry a judge field');
    assert.equal(judge.verdict, 'uncertain', 'unretried judge failure degrades to uncertain');
  });
});

// Helper to get summary as a typed Record
function summary(results: Record<string, unknown>): Record<string, unknown> {
  return results.summary as Record<string, unknown>;
}
