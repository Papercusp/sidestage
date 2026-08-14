import { describe, expect, it } from 'vitest';
import {
  SYSTEM_TEST_CONTRACT_VERSION,
  SYSTEM_TEST_SUITE_IDS,
  SYSTEM_TEST_SUITE_MANIFESTS,
  SystemTestContractError,
  type SystemTestRunResult,
  parseSystemTestRunRequest,
  parseSystemTestRunResult,
  parseSystemTestSuiteManifest,
} from './index';

const SHA = 'a'.repeat(40);
const NOW = '2026-08-14T20:00:00.000Z';

function passingResult(): SystemTestRunResult {
  const manifest = SYSTEM_TEST_SUITE_MANIFESTS.actions;
  return {
    contractVersion: SYSTEM_TEST_CONTRACT_VERSION,
    runId: 'run-actions-1',
    suiteId: 'actions',
    suiteVersion: manifest.suiteVersion,
    profile: 'smoke',
    status: 'passed',
    actor: { id: 'operator-1', role: 'operator' },
    requestedSha: SHA,
    deployedSha: SHA,
    imageDigests: { api: `sha256:${'b'.repeat(64)}` },
    configurationProvenance: [{ name: 'compose', fingerprint: 'sha256:compose-fixture' }],
    productionProtocol: true,
    isolated: true,
    substitutions: [],
    startedAt: NOW,
    finishedAt: '2026-08-14T20:01:00.000Z',
    transitions: [
      { state: 'queued', at: NOW },
      { state: 'running', at: '2026-08-14T20:00:10.000Z' },
      { state: 'cleaning', at: '2026-08-14T20:00:50.000Z' },
      { state: 'finished', at: '2026-08-14T20:01:00.000Z' },
    ],
    cases: manifest.cases.map((testCase) => ({
      caseId: testCase.caseId,
      status: 'passed',
      summary: 'Observed through the isolated deployment.',
      evidence: testCase.requiredEvidence.map((kind, index) => ({
        id: `${testCase.caseId}-evidence-${index}`,
        kind,
        ref: `artifact://${testCase.caseId}/${kind}`,
        summary: `${kind} evidence captured`,
        capturedAt: '2026-08-14T20:00:30.000Z',
        deployedSha: SHA,
      })),
    })),
    blockedReasons: [],
    cleanup: {
      status: 'succeeded',
      finishedAt: '2026-08-14T20:00:59.000Z',
      summary: 'Per-run resources removed.',
    },
    retentionExpiresAt: '2026-09-13T20:01:00.000Z',
  };
}

describe('system-test suite manifest', () => {
  it('defines exactly the six versioned allow-listed suites with stable unique case IDs', () => {
    expect(Object.keys(SYSTEM_TEST_SUITE_MANIFESTS)).toEqual(SYSTEM_TEST_SUITE_IDS);
    for (const suiteId of SYSTEM_TEST_SUITE_IDS) {
      const manifest = parseSystemTestSuiteManifest(SYSTEM_TEST_SUITE_MANIFESTS[suiteId]);
      expect(manifest.id).toBe(suiteId);
      expect(manifest.contractVersion).toBe(SYSTEM_TEST_CONTRACT_VERSION);
      expect(new Set(manifest.cases.map((entry) => entry.caseId)).size).toBe(manifest.cases.length);
    }
  });

  it('rejects a manifest for an unknown suite', () => {
    expect(() => parseSystemTestSuiteManifest({
      ...SYSTEM_TEST_SUITE_MANIFESTS.actions,
      id: 'arbitrary-command',
    })).toThrow(/allow-listed suite ID/);
  });
});

describe('system-test launch request', () => {
  it('accepts only a versioned suite/profile pair and a commit SHA', () => {
    expect(parseSystemTestRunRequest({
      contractVersion: SYSTEM_TEST_CONTRACT_VERSION,
      suiteId: 'actions',
      suiteVersion: 1,
      profile: 'smoke',
      requestedSha: SHA,
      eventId: 'fixture-event-1',
    })).toMatchObject({ suiteId: 'actions', requestedSha: SHA });
  });

  it('rejects unknown suites and command-like launch fields', () => {
    expect(() => parseSystemTestRunRequest({
      contractVersion: SYSTEM_TEST_CONTRACT_VERSION,
      suiteId: 'shell',
      suiteVersion: 1,
      profile: 'smoke',
      requestedSha: SHA,
      command: 'npm test',
    })).toThrow(/suiteId must be one of|command is not allowed/);
  });
});

describe('system-test result parser', () => {
  it('accepts same-commit, fully evidenced, isolated real-system proof', () => {
    expect(parseSystemTestRunResult(passingResult())).toMatchObject({
      status: 'passed',
      requestedSha: SHA,
      deployedSha: SHA,
    });
  });

  it('rejects a synthetic green from a mock, fake, or fallback', () => {
    for (const kind of ['mock', 'fake', 'fallback'] as const) {
      const result = passingResult();
      result.substitutions = [{ kind, component: 'payment-provider', reason: 'credential unavailable' }];
      expect(() => parseSystemTestRunResult(result)).toThrow(/cannot contain mock, fake, or fallback/);
    }
  });

  it('rejects a green result for a different deployed SHA', () => {
    const result = passingResult();
    result.deployedSha = 'c'.repeat(40);
    expect(() => parseSystemTestRunResult(result)).toThrow(/requestedSha to equal deployedSha|must match result.deployedSha/);
  });

  it('rejects a passed case with missing required evidence', () => {
    const result = passingResult();
    result.cases[1]!.evidence = [];
    expect(() => parseSystemTestRunResult(result)).toThrow(/missing required/);
  });

  it('rejects unknown or omitted case IDs', () => {
    const result = passingResult();
    result.cases[0]!.caseId = 'unknown.case';
    expect(() => parseSystemTestRunResult(result)).toThrow(/unknown caseId|is missing/);
  });

  it('requires blocked prerequisites to be explicit instead of green', () => {
    const result = passingResult();
    result.status = 'blocked';
    result.cases = result.cases.map((entry) => ({ ...entry, status: 'not-run', evidence: [] }));
    result.imageDigests = {};
    result.deployedSha = null;
    result.productionProtocol = false;
    result.cleanup = { status: 'not-started', summary: 'Provisioning did not begin.' };
    result.blockedReasons = [];
    expect(() => parseSystemTestRunResult(result)).toThrow(/blocked reason/);

    result.blockedReasons = ['Required sandbox credential was unavailable.'];
    expect(parseSystemTestRunResult(result).status).toBe('blocked');
  });

  it('returns structured issues for callers that need renderable refusal detail', () => {
    try {
      parseSystemTestRunResult({});
      throw new Error('expected parser to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(SystemTestContractError);
      expect((error as SystemTestContractError).issues.length).toBeGreaterThan(5);
    }
  });
});
