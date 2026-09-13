import { useEffect, useRef, useState } from 'react';

export default function StationInput({ label, value, onChange }) {
  const [query, setQuery] = useState(value ? `${value.name} (${value.code})` : '');
  const [options, setOptions] = useState([]);
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => {
    function onClickOutside(e) {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  useEffect(() => {
    if (!query || query.length < 2 || (value && query === `${value.name} (${value.code})`)) {
      setOptions([]);
      return;
    }
    const handle = setTimeout(() => {
      fetch(`/api/stations?q=${encodeURIComponent(query)}`)
        .then((r) => r.json())
        .then((d) => setOptions(d.results || []))
        .catch(() => setOptions([]));
    }, 200);
    return () => clearTimeout(handle);
  }, [query]);

  return (
    <div className="station-input" ref={boxRef}>
      <label>{label}</label>
      <input
        type="text"
        value={query}
        placeholder="Station name or code"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          onChange(null);
        }}
        onFocus={() => setOpen(true)}
      />
      {open && options.length > 0 && (
        <ul className="station-options">
          {options.map((s) => (
            <li
              key={s.code}
              onClick={() => {
                onChange(s);
                setQuery(`${s.name} (${s.code})`);
                setOpen(false);
              }}
            >
              {s.name} <span className="code">({s.code})</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
