import { useEffect, useRef, useState } from 'react';
import StationInput from './StationInput';
import './App.css';

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const STATUS_LABEL = {
  unavailable: 'Could not check chart',
  route_mismatch: 'Route data mismatch',
};

export default function App() {
  const [from, setFrom] = useState(null);
  const [to, setTo] = useState(null);
  const [date, setDate] = useState(todayISO());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [job, setJob] = useState(null);
  const pollRef = useRef(null);

  useEffect(() => () => clearInterval(pollRef.current), []);

  async function pollJob(jobId) {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/search/${jobId}`);
        const data = await res.json();
        if (!res.ok) {
          setError(data.message || 'Search failed.');
          setLoading(false);
          clearInterval(pollRef.current);
          return;
        }
        setJob(data);
        if (data.status !== 'running') {
          setLoading(false);
          clearInterval(pollRef.current);
        }
      } catch {
        setError('Lost connection to the server while checking trains.');
        setLoading(false);
        clearInterval(pollRef.current);
      }
    }, 1500);
  }

  async function handleSearch(e) {
    e.preventDefault();
    setError(null);
    setJob(null);

    if (!from || !to) {
      setError('Please pick both From and To stations from the suggestions list.');
      return;
    }
    if (from.code === to.code) {
      setError('From and To stations must be different.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: from.code, to: to.code, date }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || 'Search failed.');
        setLoading(false);
        return;
      }
      pollJob(data.jobId);
    } catch {
      setError('Could not reach the server. Is it running?');
      setLoading(false);
    }
  }

  function swapStations() {
    setFrom(to);
    setTo(from);
  }

  const progressPct = job && job.toCheck > 0 ? Math.round((job.checked / job.toCheck) * 100) : 0;

  return (
    <div className="app">
      <div className="hero-banner">
        <div className="hero-streaks" aria-hidden="true">
          <span className="hero-streak s1" />
          <span className="hero-streak s2" />
          <span className="hero-streak s3" />
          <span className="hero-streak s4" />
          <span className="hero-glow" />
        </div>

        <nav className="hero-nav">
          <span className="hero-nav-brand">
            <TrainIcon /> Vacant Seat Finder
          </span>
          <a
            className="hero-nav-link"
            href="https://irctc.co.in/online-charts"
            target="_blank"
            rel="noreferrer"
          >
            Official IRCTC charts ↗
          </a>
        </nav>

        <div className="hero-content">
          <h1>
            FIND VACANT
            <br />
            TRAIN SEATS
          </h1>
          <p className="subtitle">
            Live IRCTC reservation-chart scanning — full seats, seat combinations along the way, and the closest
            reachable point when nothing covers your whole trip.
          </p>

          <form className="search-form search-form-steps" onSubmit={handleSearch}>
            <div className="step-field step-from">
              <StationInput
                label={
                  <>
                    <span className="step-num">1</span>From
                  </>
                }
                value={from}
                onChange={setFrom}
                placeholder="e.g. New Delhi"
              />
            </div>
            <button
              type="button"
              className="swap-btn"
              onClick={swapStations}
              disabled={!from && !to}
              aria-label="Swap stations"
              title="Swap stations"
            >
              <SwapIcon />
            </button>
            <div className="step-field step-to">
              <StationInput
                label={
                  <>
                    <span className="step-num">2</span>To
                  </>
                }
                value={to}
                onChange={setTo}
                placeholder="e.g. Mumbai Central"
              />
            </div>
            <div className="step-field date-input">
              <label>
                <span className="step-num">3</span>When to go
              </label>
              <input type="date" value={date} min={todayISO()} onChange={(e) => setDate(e.target.value)} />
            </div>
            <button type="submit" className="submit-btn glow-btn" disabled={loading}>
              {loading ? (
                <>
                  <span className="spinner" /> Searching…
                </>
              ) : (
                <>
                  <SearchIcon /> Find seats
                </>
              )}
            </button>
          </form>

          <div className="feature-row">
            <span>
              <LiveIcon /> Live IRCTC data
            </span>
            <span>
              <SplitIcon /> Split &amp; nearest-seat fallback
            </span>
            <span>
              <FreeIcon /> No login, no fees
            </span>
          </div>
        </div>
      </div>

      {error && (
        <div className="banner error">
          <WarnIcon /> {error}
        </div>
      )}

      {job && (
        <div className="results">
          <p className="results-meta">
            <span className="route-pill">
              {job.query.from.name} <span className="code">{job.query.from.code}</span>
            </span>
            <ArrowIcon />
            <span className="route-pill">
              {job.query.to.name} <span className="code">{job.query.to.code}</span>
            </span>
            <span className="results-meta-date">on {job.query.date}</span>
          </p>
          <p className="results-count">
            Found {job.totalCandidates} direct train{job.totalCandidates === 1 ? '' : 's'} for this route.
          </p>

          {job.status === 'running' && (
            <div className="progress">
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${progressPct}%` }} />
              </div>
              <span className="progress-label">
                Checking live IRCTC charts… {job.checked} of {job.toCheck}
              </span>
            </div>
          )}

          {job.status === 'done' && job.toCheck === 0 && (
            <div className="banner">No trains found for this route and date.</div>
          )}

          {job.trains.map((t) => (
            <TrainCard key={t.trainNumber} t={t} />
          ))}

          {job.trainsNotRunningOnDate?.length > 0 && (
            <details className="not-running">
              <summary>
                {job.trainsNotRunningOnDate.length} train(s) found but don't run on {date}
              </summary>
              <ul>
                {job.trainsNotRunningOnDate.map((t) => (
                  <li key={t.trainNumber}>
                    {t.trainNumber} — {t.trainName}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      <footer className="footer">Not affiliated with IRCTC · Vacancy data read live from official reservation charts</footer>
    </div>
  );
}

function StatusBadge({ status }) {
  if (status === 'ok') return <span className="status-badge status-ok">Chart ready</span>;
  if (status === 'route_mismatch') return <span className="status-badge status-warn">Route mismatch</span>;
  return <span className="status-badge status-bad">Unavailable</span>;
}

function TrainCard({ t }) {
  const hasFull = t.usableVacancies?.length > 0;
  const hasSplit = t.splitOptions?.length > 0;
  const hasPartial = t.partialCoverageOnly?.length > 0;

  return (
    <div className={`train-card${hasFull ? ' train-card-hit' : ''}`}>
      <div className="train-header">
        <span className="train-name">
          <span className="train-number">{t.trainNumber}</span> {t.trainName}
        </span>
        <span className="train-times">
          {t.departureTime} <ArrowIcon small /> {t.arrivalTime}
          <span className="train-duration">
            {Math.floor(t.durationMinutes / 60)}h {t.durationMinutes % 60}m
          </span>
        </span>
      </div>

      {t.chartStatus === 'ok' && (
        <>
          <div className="chart-meta">
            <StatusBadge status={t.chartStatus} />
            {t.chartMeta?.chartStatusAt && <span>Vacancy as of {t.chartMeta.chartStatusAt}</span>}
          </div>

          {hasFull && (
            <div className="vacancy-table-wrap">
              <table className="vacancy-table">
                <thead>
                  <tr>
                    <th>Class</th>
                    <th>Coach</th>
                    <th>Berth</th>
                    <th>Type</th>
                    <th>From</th>
                    <th>Until</th>
                  </tr>
                </thead>
                <tbody>
                  {t.usableVacancies.map((v, i) => (
                    <tr key={i}>
                      <td>
                        <span className={`class-pill class-${(v.class || '').toLowerCase()}`}>{v.class}</span>
                      </td>
                      <td>{v.coach}</td>
                      <td>{v.berthNo}</td>
                      <td>{v.berthType || '—'}</td>
                      <td>{v.vacantFrom}</td>
                      <td>{v.vacantUntil}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!hasFull && hasSplit && (
            <div className="split-options">
              <div className="split-heading">
                No single seat covers your full journey — but you could switch seats along the way:
              </div>
              {t.splitOptions.map((opt, i) => (
                <SplitChain key={i} opt={opt} />
              ))}
            </div>
          )}

          {!hasFull && !hasSplit && hasPartial && (
            <div className="split-options">
              <div className="split-heading">
                No seat (or combination) covers your full journey right now — closest reachable point, per class:
              </div>
              {t.partialCoverageOnly.map((p, i) => (
                <SplitChain
                  key={i}
                  opt={p}
                  partialNote={`gets you to ${p.reachedStationName} · ${p.stationsShortOfDestination} station${
                    p.stationsShortOfDestination === 1 ? '' : 's'
                  } short of your destination`}
                />
              ))}
            </div>
          )}

          {!hasFull && !hasSplit && !hasPartial && (
            <div className="no-vacancy">No vacant berths currently cover any part of your journey.</div>
          )}
        </>
      )}

      {t.chartStatus !== 'ok' && (
        <div className="chart-meta">
          <StatusBadge status={t.chartStatus} />
        </div>
      )}
      {t.chartStatus !== 'ok' && (
        <div className="banner warn">
          {STATUS_LABEL[t.chartStatus] || t.chartStatus}: {t.message}
        </div>
      )}
    </div>
  );
}

function SplitChain({ opt, partialNote }) {
  return (
    <div className="split-option">
      <div className="split-option-label">
        <span className={`class-pill class-${(opt.class || '').toLowerCase()}`}>{opt.class}</span>
        {partialNote ? ` ${partialNote}` : ''}
        {opt.seatChanges > 0 ? ` · ${opt.seatChanges} seat change${opt.seatChanges > 1 ? 's' : ''}` : ''}
      </div>
      <div className="split-chain">
        {opt.segments.map((seg, j) => (
          <span className="split-leg" key={j}>
            {j > 0 && <span className="split-arrow">→</span>}
            {seg.vacantFrom} to {seg.vacantUntil}: Coach {seg.coach}, Berth {seg.berthNo}
            {seg.berthType ? ` (${seg.berthType})` : ''}
          </span>
        ))}
      </div>
    </div>
  );
}

function TrainIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" width="26" height="26" aria-hidden="true">
      <rect x="5" y="3" width="14" height="13" rx="4" stroke="currentColor" strokeWidth="1.6" />
      <path d="M5 11h14" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="8.5" cy="13.5" r="0.9" fill="currentColor" />
      <circle cx="15.5" cy="13.5" r="0.9" fill="currentColor" />
      <path d="M8 16.5 6 20M16 16.5l2 3.5M4.5 20h15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function SwapIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" width="18" height="18" aria-hidden="true">
      <path
        d="M6 4.5 3 7.5m0 0 3 3M3 7.5h11M14 15.5l3-3m0 0-3-3m3 3H6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" width="17" height="17" aria-hidden="true">
      <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.8" />
      <path d="m17 17-3.5-3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function WarnIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" width="16" height="16" aria-hidden="true">
      <path
        d="M10 3 1.5 17h17L10 3Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M10 8.3v3.3M10 14.2h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function ArrowIcon({ small }) {
  return (
    <svg
      viewBox="0 0 20 12"
      fill="none"
      width={small ? 14 : 16}
      height={small ? 9 : 10}
      className="arrow-icon"
      aria-hidden="true"
    >
      <path d="M1 6h16M13 1l5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LiveIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" width="15" height="15" aria-hidden="true">
      <circle cx="10" cy="10" r="2.4" fill="currentColor" />
      <path
        d="M5.5 5.5a6.4 6.4 0 0 0 0 9M14.5 5.5a6.4 6.4 0 0 1 0 9M3 3a10 10 0 0 0 0 14M17 3a10 10 0 0 1 0 14"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SplitIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" width="15" height="15" aria-hidden="true">
      <path
        d="M3 5h5.5l3 10H17M3 15h5.5l1.2-4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="m14.5 2.5 2.5 2.5-2.5 2.5M14.5 12.5l2.5 2.5-2.5 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FreeIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" width="15" height="15" aria-hidden="true">
      <path
        d="m10 2.5 2.06 4.18 4.61.67-3.33 3.25.78 4.6L10 13.02l-4.12 2.18.78-4.6-3.33-3.25 4.61-.67L10 2.5Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}
