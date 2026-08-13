import { useState, type FormEvent } from 'react';
import { TabHeader } from './components/TabHeader';
import { JUDGE_DIMENSIONS, dimensionLabel, runJudgeRehearsal, scorePercent, type JudgeReport } from './judge';
import { simulateLoad, type LoadSimulationResult } from './load-simulator';

export function TestTab() {
  const checks = [
    ['Catalog connection', 'Ready', 'success'],
    ['Copilot grounding', 'Ready', 'success'],
    ['Stream input', 'Not connected', 'muted'],
    ['Reply approval', 'Required', 'warning'],
  ] as const;
  const [users, setUsers] = useState('3');
  const [messagesPerSecond, setMessagesPerSecond] = useState('2');
  const [durationSeconds, setDurationSeconds] = useState('4');
  const [simulation, setSimulation] = useState<LoadSimulationResult | null>(null);
  const [simulationError, setSimulationError] = useState<string | null>(null);
  const [judgeReport, setJudgeReport] = useState<JudgeReport | null>(null);
  const [judgeError, setJudgeError] = useState<string | null>(null);
  const [judgeRunning, setJudgeRunning] = useState(false);

  const runLoadRehearsal = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const result = simulateLoad({
        users: Number(users),
        messagesPerSecond: Number(messagesPerSecond),
        durationSeconds: Number(durationSeconds),
      });
      setSimulation(result);
      setSimulationError(null);
    } catch (error) {
      setSimulation(null);
      setSimulationError(error instanceof Error ? error.message : 'Enter positive whole numbers for each field.');
    }
  };

  const runJudge = async () => {
    setJudgeRunning(true);
    setJudgeError(null);
    try {
      setJudgeReport(await runJudgeRehearsal(import.meta.env.VITE_API_URL));
    } catch (error) {
      setJudgeReport(null);
      setJudgeError(error instanceof Error ? error.message : 'The reply judge could not be reached.');
    } finally {
      setJudgeRunning(false);
    }
  };

  return (
    <div className="tab-layout">
      <TabHeader
        eyebrow="Test / launch readiness"
        title="Know before you go live."
        copy="Run a quick rehearsal of the hand-offs that matter. A green check means the seam is ready for a real event."
      />
      <section className="readiness-panel" aria-labelledby="readiness-title">
        <div className="panel-kicker">Preflight <span className="panel-status">3 of 4 ready</span></div>
        <h2 id="readiness-title">Sunday vintage drop</h2>
        <div className="readiness-list">
          {checks.map(([label, value, tone]) => <div className="readiness-row" key={label}><span>{label}</span><strong className={`status-${tone}`}>{value}</strong></div>)}
        </div>
        <button className="button secondary" type="button">Run rehearsal</button>
      </section>
      <section className="load-simulator-panel" aria-labelledby="load-simulator-title">
        <div className="panel-kicker">Load rehearsal <span className="panel-status">{simulation ? 'Completed' : 'Not run'}</span></div>
        <h2 id="load-simulator-title">Pressure-test the copilot seam.</h2>
        <p className="load-simulator-copy">Schedule deterministic websocket-client traffic locally before you open the room. This rehearsal checks the scripted price, shipping, policy, variant, stock, offer, and bid prompts without sending anything to buyers.</p>
        <form className="load-simulator-form" onSubmit={runLoadRehearsal}>
          <div className="load-simulator-fields">
            <label className="field-label" htmlFor="load-users">Simulated users
              <input id="load-users" className="text-input" type="number" min="1" step="1" inputMode="numeric" value={users} onChange={(event) => setUsers(event.target.value)} />
            </label>
            <label className="field-label" htmlFor="load-messages-per-second">Messages / user / sec
              <input id="load-messages-per-second" className="text-input" type="number" min="1" step="1" inputMode="numeric" value={messagesPerSecond} onChange={(event) => setMessagesPerSecond(event.target.value)} />
            </label>
            <label className="field-label" htmlFor="load-duration">Duration (seconds)
              <input id="load-duration" className="text-input" type="number" min="1" step="1" inputMode="numeric" value={durationSeconds} onChange={(event) => setDurationSeconds(event.target.value)} />
            </label>
          </div>
          <button className="button primary" type="submit">Run load rehearsal</button>
        </form>
        {simulationError ? <p className="load-simulator-error" role="alert">{simulationError}</p> : null}
        {simulation ? (
          <div className="load-simulator-result" aria-live="polite">
            <div className="load-simulator-stats">
              <div><strong>{simulation.totalMessages}</strong><span>scheduled messages</span></div>
              <div><strong>{simulation.clients.length}</strong><span>simulated clients</span></div>
              <div><strong>{simulation.request.durationSeconds}s</strong><span>rehearsal duration</span></div>
            </div>
            <div className="load-coverage">
              <div className="load-coverage-heading"><span>Scripted corpus coverage</span><strong>{simulation.coverage.observedKinds.length}/{simulation.coverage.expectedKinds.length} scenarios</strong></div>
              <div className="load-coverage-list">
                {simulation.coverage.expectedKinds.map((kind) => <span className={'coverage-chip' + (simulation.coverage.observedKinds.includes(kind) ? ' covered' : '')} key={kind}>{kind} · {simulation.coverage.counts[kind] ?? 0}</span>)}
              </div>
            </div>
          </div>
        ) : null}
      </section>
      <section className="judge-panel" aria-labelledby="judge-title">
        <div className="panel-kicker">Reply judge <span className="panel-status">{judgeReport ? (judgeReport.passed ? 'Passed' : 'Needs review') : judgeRunning ? 'Running' : 'Not run'}</span></div>
        <h2 id="judge-title">Grade the copilot before buyers do.</h2>
        <p className="judge-copy">Run the deterministic four-dimension rehearsal against the same grounding, policy, price, and tone seam the API exposes. It stays local to this test surface and sends no reply to buyers.</p>
        <button className="button secondary" type="button" onClick={() => void runJudge()} disabled={judgeRunning}>
          {judgeRunning ? 'Running judge…' : 'Run judge rehearsal'}
        </button>
        {judgeError ? <p className="judge-error" role="alert">{judgeError}</p> : null}
        {judgeReport ? (
          <div className="judge-report" aria-live="polite">
            <div className="judge-report-summary">
              <div><strong>{scorePercent(judgeReport.overallScore)}</strong><span>overall score</span></div>
              <div><strong>{judgeReport.passedCases}/{judgeReport.totalCases}</strong><span>cases passed</span></div>
              <div><strong>{judgeReport.latencyMs}ms</strong><span>judge latency</span></div>
            </div>
            <div className="judge-dimensions">
              <div className="judge-section-heading"><span>Dimension scores</span><strong>Threshold {scorePercent(judgeReport.passThreshold)}</strong></div>
              <div className="judge-dimension-grid">
                {JUDGE_DIMENSIONS.map((dimension) => {
                  const result = judgeReport.dimensions[dimension];
                  return (
                    <div className="judge-dimension" key={dimension}>
                      <span>{dimensionLabel(dimension)}</span>
                      <strong className={result.passed ? 'status-success' : 'status-warning'}>{scorePercent(result.score)}</strong>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="judge-case-list">
              {judgeReport.cases.map((testCase) => (
                <article className={`judge-case ${testCase.passed ? 'is-passed' : 'is-failed'}`} key={testCase.caseId}>
                  <div className="judge-case-heading">
                    <div><span className="judge-case-label">{testCase.caseId}</span><strong>{testCase.question}</strong></div>
                    <span className={testCase.passed ? 'status-success' : 'status-warning'}>{scorePercent(testCase.overallScore)} · {testCase.passed ? 'Pass' : 'Review'}</span>
                  </div>
                  <p className="judge-case-reply">“{testCase.reply}”</p>
                  <div className="judge-case-dimensions">
                    {JUDGE_DIMENSIONS.map((dimension) => {
                      const result = testCase.dimensions[dimension];
                      return (
                        <div className="judge-case-dimension" key={dimension}>
                          <span>{dimensionLabel(dimension)}</span>
                          <strong className={result.passed ? 'status-success' : 'status-warning'}>{scorePercent(result.score)}</strong>
                          <small>{result.rationale}</small>
                        </div>
                      );
                    })}
                  </div>
                </article>
              ))}
            </div>
          </div>
        ) : null}
      </section>
      <div className="test-note"><span className="feature-icon cyan">⌁</span><p>Tip: connect your stream when you are ready. You can still rehearse catalog and copilot flows without a camera.</p></div>
    </div>
  );
}
