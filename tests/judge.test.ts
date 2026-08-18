/**
 * Unit tests for the judge stage (src/judge.ts).
 * Tests verdict parsing, per-check opt-out, minConfidence demotion,
 * dropFalsePositives filtering, and status recomputation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseJudgeResponse, applyJudgeResults, runJudge } from '../src/judge.js';
import type { AgentProvider, AgentResponse, ExecuteCheckOptions, SecurityIssue, CheckExecutionSummary } from '../src/types.js';
import { createCostTracker } from '../src/cost-tracker.js';
import { JUDGE_OUTPUT_SCHEMA } from '../src/provider-utils.js';

// ─── parseJudgeResponse ───────────────────────────────────────────────────────

describe('parseJudgeResponse', () => {
  it('parses a valid true_positive JSON response', () => {
    const raw = JSON.stringify({ verdict: 'true_positive', confidence: 0.9, rationale: 'Clearly a real issue' });
    const result = parseJudgeResponse(raw);
    assert.ok(result);
    assert.equal(result.verdict, 'true_positive');
    assert.equal(result.confidence, 0.9);
    assert.equal(result.rationale, 'Clearly a real issue');
  });

  it('parses false_positive', () => {
    const raw = JSON.stringify({ verdict: 'false_positive', confidence: 0.8, rationale: 'Not exploitable' });
    const result = parseJudgeResponse(raw);
    assert.ok(result);
    assert.equal(result.verdict, 'false_positive');
  });

  it('parses uncertain', () => {
    const raw = JSON.stringify({ verdict: 'uncertain', confidence: 0.5, rationale: 'Hard to tell' });
    const result = parseJudgeResponse(raw);
    assert.ok(result);
    assert.equal(result.verdict, 'uncertain');
  });

  it('parses from a fenced code block', () => {
    const raw = '```json\n{"verdict":"true_positive","confidence":1.0,"rationale":"Real"}\n```';
    const result = parseJudgeResponse(raw);
    assert.ok(result);
    assert.equal(result.verdict, 'true_positive');
  });

  it('parses from prose containing JSON object', () => {
    const raw = 'Based on my analysis: {"verdict":"false_positive","confidence":0.7,"rationale":"ok"}';
    const result = parseJudgeResponse(raw);
    assert.ok(result);
    assert.equal(result.verdict, 'false_positive');
  });

  it('returns undefined for missing verdict', () => {
    const raw = JSON.stringify({ confidence: 0.5, rationale: 'ok' });
    assert.equal(parseJudgeResponse(raw), undefined);
  });

  it('returns undefined for invalid verdict value', () => {
    const raw = JSON.stringify({ verdict: 'maybe', confidence: 0.5, rationale: 'ok' });
    assert.equal(parseJudgeResponse(raw), undefined);
  });

  it('returns undefined for missing confidence', () => {
    const raw = JSON.stringify({ verdict: 'true_positive', rationale: 'ok' });
    assert.equal(parseJudgeResponse(raw), undefined);
  });

  it('returns undefined for confidence out of range (>1)', () => {
    const raw = JSON.stringify({ verdict: 'true_positive', confidence: 1.5, rationale: 'ok' });
    assert.equal(parseJudgeResponse(raw), undefined);
  });

  it('returns undefined for missing rationale', () => {
    const raw = JSON.stringify({ verdict: 'true_positive', confidence: 0.5 });
    assert.equal(parseJudgeResponse(raw), undefined);
  });

  it('returns undefined for non-JSON input', () => {
    assert.equal(parseJudgeResponse('not json at all'), undefined);
  });

  it('returns undefined for empty string', () => {
    assert.equal(parseJudgeResponse(''), undefined);
  });
});

// ─── applyJudgeResults ────────────────────────────────────────────────────────

function makeIssue(overrides: Partial<SecurityIssue> = {}): SecurityIssue {
  return {
    checkId: 'check-1',
    checkName: 'Test Check',
    file: 'src/foo.ts',
    startLine: 10,
    endLine: 15,
    description: 'Test issue',
    ...overrides,
  };
}

function makeSummary(overrides: Partial<CheckExecutionSummary> = {}): CheckExecutionSummary {
  return {
    checkId: 'check-1',
    checkName: 'Test Check',
    status: 'FAIL',
    issuesFound: 1,
    executionTime: 100,
    ...overrides,
  };
}

describe('applyJudgeResults', () => {
  it('keeps true_positive issues unchanged', () => {
    const issue = makeIssue({
      judge: { verdict: 'true_positive', confidence: 0.9, rationale: 'Real', model: 'opus', provider: 'claude-code' },
    });
    const summary = makeSummary({ issuesFound: 1 });
    const { filteredIssues } = applyJudgeResults([issue], [summary], {});
    assert.equal(filteredIssues.length, 1);
    assert.equal(summary.status, 'FAIL');
  });

  it('keeps issues without judge verdict unchanged', () => {
    const issue = makeIssue();
    const summary = makeSummary();
    const { filteredIssues } = applyJudgeResults([issue], [summary], {});
    assert.equal(filteredIssues.length, 1);
    assert.equal(summary.status, 'FAIL');
  });

  it('does NOT drop false positives by default', () => {
    const issue = makeIssue({
      judge: { verdict: 'false_positive', confidence: 0.95, rationale: 'Not a bug', model: 'opus', provider: 'cc' },
    });
    const summary = makeSummary();
    const { filteredIssues } = applyJudgeResults([issue], [summary], {});
    assert.equal(filteredIssues.length, 1);
    assert.equal(summary.status, 'FAIL');
  });

  it('drops false positives when dropFalsePositives is true', () => {
    const issue = makeIssue({
      judge: { verdict: 'false_positive', confidence: 0.95, rationale: 'Not a bug', model: 'opus', provider: 'cc' },
    });
    const summary = makeSummary();
    const { filteredIssues, falsePositives } = applyJudgeResults([issue], [summary], { dropFalsePositives: true });
    assert.equal(filteredIssues.length, 0);
    assert.equal(falsePositives, 1);
    assert.equal(summary.status, 'PASS');
    assert.equal(summary.issuesFound, 0);
  });

  it('escalates check to FLAG when all remaining issues are uncertain', () => {
    const issue = makeIssue({
      judge: { verdict: 'uncertain', confidence: 0.5, rationale: 'Unclear', model: 'opus', provider: 'cc' },
    });
    const summary = makeSummary();
    const { filteredIssues } = applyJudgeResults([issue], [summary], {});
    assert.equal(filteredIssues.length, 1);
    assert.equal(summary.status, 'FLAG');
    assert.equal(issue.flagSource, 'judge');
  });

  it('does NOT escalate if only some issues are uncertain (mix with true_positive)', () => {
    const issue1 = makeIssue({
      judge: { verdict: 'uncertain', confidence: 0.4, rationale: 'Unclear', model: 'opus', provider: 'cc' },
    });
    const issue2 = makeIssue({
      judge: { verdict: 'true_positive', confidence: 0.9, rationale: 'Real', model: 'opus', provider: 'cc' },
    });
    const summary = makeSummary({ issuesFound: 2 });
    const { filteredIssues } = applyJudgeResults([issue1, issue2], [summary], {});
    assert.equal(filteredIssues.length, 2);
    assert.equal(summary.status, 'FAIL');
  });

  it('preserves flagSource:"check" over judge escalation (decision #9)', () => {
    const issue = makeIssue({
      flagSource: 'check',
      judge: { verdict: 'uncertain', confidence: 0.3, rationale: 'Unclear', model: 'opus', provider: 'cc' },
    });
    const summary = makeSummary();
    applyJudgeResults([issue], [summary], {});
    assert.equal(issue.flagSource, 'check');
  });

  it('counts judgedIssues, falsePositives, uncertainJudgements', () => {
    const tp = makeIssue({ judge: { verdict: 'true_positive', confidence: 0.9, rationale: 'r', model: 'm', provider: 'p' } });
    const fp = makeIssue({ checkId: 'check-2', judge: { verdict: 'false_positive', confidence: 0.9, rationale: 'r', model: 'm', provider: 'p' } });
    const unc = makeIssue({ checkId: 'check-3', judge: { verdict: 'uncertain', confidence: 0.5, rationale: 'r', model: 'm', provider: 'p' } });
    const noJudge = makeIssue({ checkId: 'check-4' });

    const summaries = [
      makeSummary({ checkId: 'check-1' }),
      makeSummary({ checkId: 'check-2' }),
      makeSummary({ checkId: 'check-3' }),
      makeSummary({ checkId: 'check-4' }),
    ];

    const { judgedIssues, falsePositives, uncertainJudgements } = applyJudgeResults(
      [tp, fp, unc, noJudge], summaries, {}
    );
    assert.equal(judgedIssues, 3);
    assert.equal(falsePositives, 1); // FP verdict counted (not dropped since dropFalsePositives not set)
    assert.equal(uncertainJudgements, 1);
  });

  it('counts falsePositives correctly when dropFalsePositives is true', () => {
    const fp = makeIssue({ judge: { verdict: 'false_positive', confidence: 0.9, rationale: 'r', model: 'm', provider: 'p' } });
    const summary = makeSummary();
    const { falsePositives } = applyJudgeResults([fp], [summary], { dropFalsePositives: true });
    assert.equal(falsePositives, 1);
  });

  it('handles empty issue list', () => {
    const { filteredIssues, judgedIssues } = applyJudgeResults([], [], {});
    assert.equal(filteredIssues.length, 0);
    assert.equal(judgedIssues, 0);
  });

  it('handles multiple checks — each check recomputed independently', () => {
    const issue1 = makeIssue({
      checkId: 'check-1',
      judge: { verdict: 'false_positive', confidence: 0.95, rationale: 'FP', model: 'm', provider: 'p' },
    });
    const issue2 = makeIssue({
      checkId: 'check-2',
      judge: { verdict: 'true_positive', confidence: 0.9, rationale: 'TP', model: 'm', provider: 'p' },
    });
    const summary1 = makeSummary({ checkId: 'check-1', issuesFound: 1 });
    const summary2 = makeSummary({ checkId: 'check-2', issuesFound: 1 });

    const { filteredIssues } = applyJudgeResults(
      [issue1, issue2], [summary1, summary2], { dropFalsePositives: true }
    );

    assert.equal(filteredIssues.length, 1);
    assert.equal(summary1.status, 'PASS');
    assert.equal(summary2.status, 'FAIL');
  });
});

// ─── runJudge ─────────────────────────────────────────────────────────────────

function makeStubProvider(respond: () => AgentResponse) {
  const calls: Array<{ prompt: string; options?: ExecuteCheckOptions }> = [];
  const events: string[] = [];
  const provider: AgentProvider = {
    async initialize() {},
    async executeCheck(instructions, _repositoryPath, _logPrefix, options) {
      events.push('executeCheck');
      calls.push({ prompt: instructions, options });
      return respond();
    },
    async validateConfig() {
      return true;
    },
    setModel(model: string) {
      events.push(`setModel:${model}`);
    },
  };
  return { provider, calls, events };
}

function makeChecksById(): Map<string, { check: { judge?: boolean }; instructions: string | undefined }> {
  return new Map([['check-1', { check: {}, instructions: undefined }]]);
}

describe('runJudge', () => {
  it('passes JUDGE_OUTPUT_SCHEMA to executeCheck and sets the judge model first', async () => {
    const { provider, calls, events } = makeStubProvider(() => ({
      raw: JSON.stringify({ verdict: 'true_positive', confidence: 0.9, rationale: 'real' }),
    }));
    const issue = makeIssue();

    await runJudge([issue], makeChecksById(), '/repo', {
      provider,
      providerName: 'stub',
      model: 'judge-model',
    }, createCostTracker({}));

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].options?.outputSchema, JUDGE_OUTPUT_SCHEMA);
    assert.equal(events[0], 'setModel:judge-model', 'judge model must be applied before the first call');
    assert.equal(issue.judge?.verdict, 'true_positive');
    assert.equal(issue.judge?.provider, 'stub');
    assert.equal(issue.judge?.model, 'judge-model');
  });

  it('parses the verdict from AgentResponse.structured when raw is empty prose', async () => {
    // OpenCode regression: in structured-output mode the JSON exists only in
    // `structured`; the text parts (raw) are empty.
    const { provider } = makeStubProvider(() => ({
      raw: '',
      structured: { verdict: 'false_positive', confidence: 0.8, rationale: 'validated upstream' },
    }));
    const issue = makeIssue();

    await runJudge([issue], makeChecksById(), '/repo', {
      provider,
      providerName: 'stub',
      model: 'judge-model',
    }, createCostTracker({}));

    assert.equal(issue.judge?.verdict, 'false_positive');
    assert.equal(issue.judge?.confidence, 0.8);
    assert.equal(issue.judge?.rationale, 'validated upstream');
  });

  it('falls back to raw when structured is absent', async () => {
    const { provider } = makeStubProvider(() => ({
      raw: 'Analysis: {"verdict":"uncertain","confidence":0.4,"rationale":"unclear"}',
    }));
    const issue = makeIssue();

    await runJudge([issue], makeChecksById(), '/repo', {
      provider,
      providerName: 'stub',
      model: 'judge-model',
    }, createCostTracker({}));

    assert.equal(issue.judge?.verdict, 'uncertain');
  });

  it('degrades to uncertain with an error rationale when nothing parses', async () => {
    const { provider } = makeStubProvider(() => ({
      raw: 'no json here',
    }));
    const issue = makeIssue();

    await runJudge([issue], makeChecksById(), '/repo', {
      provider,
      providerName: 'stub',
      model: 'judge-model',
    }, createCostTracker({}));

    assert.equal(issue.judge?.verdict, 'uncertain');
    assert.equal(issue.judge?.confidence, 0);
    assert.match(issue.judge?.rationale ?? '', /judge failed: malformed response/);
  });
});
