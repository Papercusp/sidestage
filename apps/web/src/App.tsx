export function App() {
  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="wordmark" href="/" aria-label="SideStage home">
          <span className="wordmark-mark" aria-hidden="true">✦</span>
          SideStage
        </a>
        <nav aria-label="Primary navigation">
          <a className="nav-link active" href="#events">Events</a>
          <a className="nav-link" href="#copilot">Copilot</a>
          <a className="nav-link" href="#test">Test</a>
        </nav>
        <span className="connection-pill"><span className="connection-dot" /> Ready for your next event</span>
      </header>

      <main className="content">
        <section className="hero" id="events">
          <div>
            <p className="eyebrow">Live commerce, with a second set of eyes</p>
            <h1>Turn live energy into<br /><span>confident action.</span></h1>
            <p className="hero-copy">
              SideStage keeps the stream, catalog, buyer questions, and guardrails
              together so sellers can stay in the moment.
            </p>
            <div className="hero-actions">
              <button className="button primary" type="button">Create an event</button>
              <button className="button secondary" type="button">Explore demo data</button>
            </div>
          </div>
          <aside className="hero-card" aria-label="Next event preview">
            <div className="card-heading"><span>Next on stage</span><span className="live-badge">LIVE SOON</span></div>
            <h2>Sunday vintage drop</h2>
            <p className="muted">No event scheduled yet</p>
            <div className="card-divider" />
            <div className="card-row"><span>Copilot</span><strong className="status-ready">Ready</strong></div>
            <div className="card-row"><span>Stream</span><strong className="status-muted">Not connected</strong></div>
            <div className="card-row"><span>Catalog</span><strong className="status-ready">0 items</strong></div>
          </aside>
        </section>

        <section className="feature-grid" id="copilot" aria-label="SideStage capabilities">
          <article className="feature-card"><span className="feature-icon cyan">◈</span><h3>Stay grounded</h3><p>Replies draw from your event catalog and policies, not guesses.</p></article>
          <article className="feature-card"><span className="feature-icon violet">⌁</span><h3>Hear the room</h3><p>Live transcript and product mentions keep the active item in view.</p></article>
          <article className="feature-card"><span className="feature-icon amber">◌</span><h3>Protect the moment</h3><p>Price, inventory, and tone guardrails sit between suggestion and send.</p></article>
        </section>

        <footer className="footer" id="test"><span>SideStage preview</span><span>Built for the live-selling floor</span></footer>
      </main>
    </div>
  );
}
