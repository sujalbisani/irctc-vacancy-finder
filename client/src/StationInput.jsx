import { useEffect, useRef, useState } from 'react';

// Shared across both From/To instances and across the whole session -- once
// any field has looked up "new delhi", the other field (or a later search)
// gets it instantly instead of re-hitting the network.
const clientCache = new Map();

const POPULAR_STATIONS = [
  { code: 'NDLS', name: 'NEW DELHI' },
  { code: 'MMCT', name: 'MUMBAI CENTRAL' },
  { code: 'CSMT', name: 'MUMBAI CST' },
  { code: 'HWH', name: 'HOWRAH JN' },
  { code: 'MAS', name: 'CHENNAI CENTRAL' },
  { code: 'SBC', name: 'BENGALURU CITY' },
  { code: 'ADI', name: 'AHMEDABAD JN' },
  { code: 'PUNE', name: 'PUNE JN' },
];

function labelOf(s) {
  return `${s.name} (${s.code})`;
}

export default function StationInput({ label, value, onChange, placeholder }) {
  const [query, setQuery] = useState(value ? labelOf(value) : '');
  const [options, setOptions] = useState([]);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const boxRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => {
    setQuery(value ? labelOf(value) : '');
  }, [value]);

  useEffect(() => {
    function onClickOutside(e) {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  useEffect(() => {
    if (!query || query.length < 2 || (value && query === labelOf(value))) {
      setOptions([]);
      setPending(false);
      return;
    }

    const key = query.trim().toLowerCase();
    const cached = clientCache.get(key);
    if (cached) {
      setOptions(cached);
      setPending(false);
      return;
    }

    setPending(true);
    const handle = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      fetch(`/api/stations?q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then((r) => r.json())
        .then((d) => {
          const results = d.results || [];
          clientCache.set(key, results);
          setOptions(results);
          setPending(false);
        })
        .catch((err) => {
          if (err.name === 'AbortError') return;
          setOptions([]);
          setPending(false);
        });
    }, 120);
    return () => clearTimeout(handle);
  }, [query]);

  useEffect(() => setHighlight(-1), [options]);

  function pick(s) {
    onChange(s);
    setQuery(labelOf(s));
    setOpen(false);
  }

  function onKeyDown(e) {
    if (!open || options.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => (h + 1) % options.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => (h <= 0 ? options.length - 1 : h - 1));
    } else if (e.key === 'Enter' && highlight >= 0) {
      e.preventDefault();
      pick(options[highlight]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  const showChips = open && (!query || query.length < 2) && !value;

  return (
    <div className="station-input" ref={boxRef}>
      <label>{label}</label>
      <div className="station-input-box">
        <svg className="station-input-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path
            d="M10 18s6-5.5 6-10.5A6 6 0 0 0 4 7.5C4 12.5 10 18 10 18Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <circle cx="10" cy="7.5" r="2.25" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        <input
          type="text"
          value={query}
          placeholder={placeholder || 'Station name or code'}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            if (value) onChange(null);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          autoComplete="off"
        />
        {pending && <span className="station-input-spinner" aria-hidden="true" />}
        {!pending && value && (
          <button
            type="button"
            className="station-input-clear"
            aria-label="Clear"
            onClick={() => {
              onChange(null);
              setQuery('');
              setOpen(false);
            }}
          >
            ×
          </button>
        )}
      </div>

      {open && options.length > 0 && (
        <ul className="station-options">
          {options.map((s, i) => (
            <li
              key={s.code}
              className={i === highlight ? 'is-highlighted' : ''}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(s)}
            >
              <span className="station-name">{s.name}</span>
              <span className="code">{s.code}</span>
            </li>
          ))}
        </ul>
      )}

      {showChips && (
        <div className="station-chips">
          <span className="station-chips-label">Popular</span>
          <div className="station-chips-row">
            {POPULAR_STATIONS.map((s) => (
              <button type="button" key={s.code} className="station-chip" onClick={() => pick(s)}>
                {s.code}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
