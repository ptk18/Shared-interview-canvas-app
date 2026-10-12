import { type FormEvent, useEffect, useState } from 'react';
import { navigate, roomPath } from '../router';
import { ApiError, useBackend } from '../services';
import { MAX_TITLE_LENGTH } from '../services/protocol';
import { Brand } from './icons';

export function HomePage() {
  const backend = useBackend();
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = 'Sketchroom · system design interviews';
  }, []);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) {
      setError('Give the interview a title, e.g. “Design a URL shortener”.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const room = await backend.createRoom(trimmed);
      navigate(roomPath(room.id));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
      setBusy(false);
    }
  }

  return (
    <div className="home">
      <header>
        <Brand />
      </header>

      <main className="home-main">
        <section>
          <p className="home-kicker">One-on-one · real time · no sign-up</p>
          <h1>The whiteboard for system design interviews.</h1>
          <p className="home-lede">
            Name the problem, share the link, and sketch the architecture together. Both of you draw on the same
            canvas, see each other’s cursor, and keep the finished diagram as a read-only record.
          </p>

          <form className="create-form" onSubmit={onSubmit} noValidate>
            <label className="field-label" htmlFor="title">
              Interview title
            </label>
            <div className="create-row">
              <input
                id="title"
                className="input"
                placeholder="Design a URL shortener"
                value={title}
                maxLength={MAX_TITLE_LENGTH}
                onChange={(e) => setTitle(e.target.value)}
                aria-invalid={!!error}
                aria-describedby={error ? 'title-error' : undefined}
                autoFocus
              />
              <button type="submit" className="btn btn-primary btn-lg" disabled={busy}>
                {busy ? 'Creating…' : 'Create room'}
              </button>
            </div>
            {error && (
              <p id="title-error" className="field-error" role="alert">
                {error}
              </p>
            )}
          </form>

          <ul className="home-facts">
            <li>Two participants per room</li>
            <li>Autosaved as you draw</li>
            <li>Export the whole diagram as PNG</li>
          </ul>
        </section>

        <HeroDiagram />
      </main>

      <footer className="home-footer">
        {backend.kind === 'mock'
          ? 'Demo mode: running on the in-browser mock backend, so rooms live in this browser only.'
          : 'Rooms are reachable only through their link.'}
      </footer>
    </div>
  );
}

/** A hand-placed sample diagram: what the product makes, instead of a stock illustration. */
function HeroDiagram() {
  const box = { fill: '#fff', stroke: '#1f2328', strokeWidth: 2, rx: 6 };
  const label = { fontFamily: 'IBM Plex Sans, sans-serif', fontSize: 14, fill: '#1f2328', textAnchor: 'middle' as const };
  const edge = { stroke: '#1f2328', strokeWidth: 2, fill: 'none', markerEnd: 'url(#hero-arrow)' };
  return (
    <svg className="home-art" viewBox="0 0 440 330" role="img" aria-label="Example diagram: client, load balancer, API servers, cache and database">
      <defs>
        <marker id="hero-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" fill="#1f2328" />
        </marker>
      </defs>
      <rect x="30" y="40" width="96" height="46" {...box} fill="#d0ebff" />
      <text x="78" y="68" {...label}>Client</text>
      <rect x="172" y="40" width="112" height="46" {...box} />
      <text x="228" y="68" {...label}>Load balancer</text>
      <rect x="152" y="136" width="70" height="42" {...box} fill="#fff3bf" />
      <text x="187" y="162" {...label}>API</text>
      <rect x="236" y="136" width="70" height="42" {...box} fill="#fff3bf" />
      <text x="271" y="162" {...label}>API</text>
      <ellipse cx="368" cy="157" rx="48" ry="26" fill="#d3f9d8" stroke="#1f2328" strokeWidth={2} />
      <text x="368" y="162" {...label}>Cache</text>
      <rect x="182" y="238" width="96" height="50" {...box} fill="#e5dbff" />
      <text x="230" y="268" {...label}>Postgres</text>
      <path d="M126 63H168" {...edge} />
      <path d="M212 86L194 132" {...edge} />
      <path d="M244 86L262 132" {...edge} />
      <path d="M306 157H316" {...edge} />
      <path d="M190 178L216 234" {...edge} />
      <path d="M268 178L244 234" {...edge} />
      <g fontFamily="IBM Plex Mono, monospace" fontSize="11">
        <path d="M330 222l0 15 4-4 3 7 3-1-3-7h6z" fill="#e8590c" stroke="#fff" strokeWidth="1" />
        <rect x="342" y="240" width="40" height="18" rx="4" fill="#e8590c" />
        <text x="362" y="253" fill="#fff" textAnchor="middle">Ada</text>
        <path d="M80 200l0 15 4-4 3 7 3-1-3-7h6z" fill="#1c7ed6" stroke="#fff" strokeWidth="1" />
        <rect x="92" y="218" width="40" height="18" rx="4" fill="#1c7ed6" />
        <text x="112" y="231" fill="#fff" textAnchor="middle">Sam</text>
      </g>
    </svg>
  );
}
