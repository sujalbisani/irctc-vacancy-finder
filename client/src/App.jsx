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

  const progressPct = job && job.toCheck > 0 ? Math.round((job.checked / job.toCheck) * 100) : 0;

  return (
    <div className="app">
      <header className="hero">
        <h1>IRCTC Vacant Seat Finder</h1>
        <p className="subtitle">
          Finds trains between two stations and checks IRCTC's official reservation charts for berths that are
          vacant for your exact journey segment — including seat combinations and the closest reachable option
          when no single seat covers your whole trip.
        </p>
      </header>

      <form className="search-form" onSubmit={handleSearch}>
        <div className="form-row">
          <StationInput label="From" value={from} onChange={setFrom} />
          <StationInput label="To" value={to} onChange={setTo} />
        </div>
        <div className="form-row">
          <div className="date-input">
            <label>Journey date</label>
            <input type="date" value={date} min={todayISO()} onChange={(e) => setDate(e.target.value)} />
          </div>
          <button type="submit" disabled={loading}>
            {loading ? 'Searching…' : 'Find vacant seats'}
          </button>
        </div>
      </form>

      {error && <div className="banner error">{error}</div>}

      {job && (
        <div className="results">
          <p className="results-meta">
            {job.query.from.name} ({job.query.from.code}) → {job.query.to.name} ({job.query.to.code}) on{' '}
            {job.query.date}. Found {job.totalCandidates} direct train(s) for this route.
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
    </div>
  );
}

function TrainCard({ t }) {
  const hasFull = t.usableVacancies?.length > 0;
  const hasSplit = t.splitOptions?.length > 0;
  const hasPartial = t.partialCoverageOnly?.length > 0;

  return (
    <div className={`train-card${hasFull ? ' train-card-hit' : ''}`}>
      <div className="train-header">
        <span className="train-name">
          {t.trainNumber} — {t.trainName}
        </span>
        <span className="train-times">
          {t.departureTime} → {t.arrivalTime} ({Math.floor(t.durationMinutes / 60)}h {t.durationMinutes % 60}m)
        </span>
      </div>

      {t.chartStatus === 'ok' && (
        <>
          <div className="chart-meta">
            First chart: {t.chartMeta?.firstChartCreation || 'n/a'}
            {t.chartMeta?.chartStatusAt && <> · Vacancy as of {t.chartMeta.chartStatusAt}</>}
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
                    <th>Vacant from</th>
                    <th>Vacant until</th>
                  </tr>
                </thead>
                <tbody>
                  {t.usableVacancies.map((v, i) => (
                    <tr key={i}>
                      <td>{v.classLabel || v.class}</td>
                      <td>{v.coach}</td>
                      <td>{v.berthNo}</td>
                      <td>{v.berthType}</td>
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
        {opt.classLabel || opt.class}
        {partialNote ? ` · ${partialNote}` : ''}
        {opt.seatChanges > 0 ? ` · ${opt.seatChanges} seat change${opt.seatChanges > 1 ? 's' : ''}` : ''}
      </div>
      <div className="split-chain">
        {opt.segments.map((seg, j) => (
          <span className="split-leg" key={j}>
            {j > 0 && <span className="split-arrow"> → </span>}
            {seg.vacantFrom} to {seg.vacantUntil}: Coach {seg.coach}, Berth {seg.berthNo}
            {seg.berthType ? ` (${seg.berthType})` : ''}
          </span>
        ))}
      </div>
    </div>
  );
}
