import type { ReactNode } from 'react';
import { navigate } from '../router';
import { Brand } from './icons';

interface MessagePageProps {
  eyebrow?: string;
  title: string;
  body: ReactNode;
  actions?: ReactNode;
}

/** A centred card for dead ends: missing rooms, full rooms, connection errors. */
export function MessagePage({ eyebrow, title, body, actions }: MessagePageProps) {
  return (
    <main className="center-page">
      <section className="card" aria-labelledby="message-title">
        <Brand />
        {eyebrow && <p className="card-eyebrow">{eyebrow}</p>}
        <h1 id="message-title">{title}</h1>
        <p>{body}</p>
        <div className="card-actions">
          {actions}
          <button type="button" className="btn" onClick={() => navigate('/')}>
            Start a new interview
          </button>
        </div>
      </section>
    </main>
  );
}
