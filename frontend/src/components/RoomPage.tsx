import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { toShapeMap } from '../canvas/ops';
import { rememberedName } from '../room/identity';
import { useRoomSession } from '../room/useRoomSession';
import { roomUrl } from '../router';
import { ApiError, useBackend } from '../services';
import { MAX_NAME_LENGTH, type RoomDetail } from '../services/protocol';
import { CopyLinkButton } from './CopyLinkButton';
import { Editor } from './Editor';
import { Brand } from './icons';
import { MessagePage } from './MessagePage';

type Load =
  | { status: 'loading' }
  | { status: 'ready'; detail: RoomDetail }
  | { status: 'not_found' }
  | { status: 'error'; message: string };

export function RoomPage({ roomId }: { roomId: string }) {
  const backend = useBackend();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    backend.getRoom(roomId).then(
      (detail) => !cancelled && setLoad({ status: 'ready', detail }),
      (error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 404) setLoad({ status: 'not_found' });
        else setLoad({ status: 'error', message: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [backend, roomId, reloadKey]);

  useEffect(() => {
    if (load.status === 'ready') document.title = `${load.detail.title} · Sketchroom`;
  }, [load]);

  switch (load.status) {
    case 'loading':
      return <LoadingCard label="Opening room…" />;
    case 'not_found':
      return <NotFound />;
    case 'error':
      return (
        <MessagePage
          eyebrow="Connection problem"
          title="Couldn’t open this room"
          body={load.message}
          actions={
            <button type="button" className="btn btn-primary" onClick={() => setReloadKey((k) => k + 1)}>
              Try again
            </button>
          }
        />
      );
    case 'ready': {
      const { detail } = load;
      if (detail.status === 'completed') return <ReviewRoom detail={detail} />;
      if (!name) return <JoinForm detail={detail} onJoin={setName} />;
      return (
        <LiveRoom
          // A fresh session after every refetch: e.g. a join refused while the
          // session was ending, then the ending failed and the room is still active.
          key={reloadKey}
          detail={detail}
          name={name}
          onInvalidName={() => setName(null)}
          onCompleted={() => setReloadKey((k) => k + 1)}
        />
      );
    }
  }
}

function LoadingCard({ label }: { label: string }) {
  return (
    <main className="center-page" aria-busy="true">
      <p className="mono" style={{ color: 'var(--muted)' }}>
        {label}
      </p>
    </main>
  );
}

function NotFound() {
  return (
    <MessagePage
      eyebrow="404"
      title="Room not found"
      body="This link doesn’t match any interview room. Check that you copied the whole URL."
    />
  );
}

function ReviewRoom({ detail }: { detail: RoomDetail }) {
  const shapes = useMemo(() => toShapeMap(detail.canvas.shapes), [detail]);
  return <Editor room={detail} shapes={shapes} />;
}

export function JoinForm({ detail, onJoin }: { detail: RoomDetail; onJoin(name: string): void }) {
  const [name, setName] = useState(rememberedName.get);
  const [error, setError] = useState<string | null>(null);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Enter the name your interview partner will see.');
      return;
    }
    rememberedName.set(trimmed);
    onJoin(trimmed);
  }

  return (
    <main className="center-page">
      <section className="card" aria-labelledby="join-title">
        <Brand />
        <p className="card-eyebrow">Interview room</p>
        <h1 id="join-title">{detail.title}</h1>
        <p>Share this link with your interview partner. Up to two people can draw together.</p>
        <div className="share-box">
          <input className="input" readOnly value={roomUrl(detail.id)} aria-label="Room link" onFocus={(e) => e.target.select()} />
          <CopyLinkButton roomId={detail.id} />
        </div>
        <form className="join-form" onSubmit={onSubmit} noValidate>
          <div className="field">
            <label className="field-label" htmlFor="display-name">
              Your display name
            </label>
            <input
              id="display-name"
              className="input"
              value={name}
              maxLength={MAX_NAME_LENGTH}
              placeholder="e.g. Ada"
              onChange={(e) => setName(e.target.value)}
              aria-invalid={!!error}
              aria-describedby={error ? 'name-error' : undefined}
              autoFocus
            />
            {error && (
              <p id="name-error" className="field-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <button type="submit" className="btn btn-primary btn-lg">
            Join room
          </button>
        </form>
      </section>
    </main>
  );
}

function LiveRoom({
  detail,
  name,
  onInvalidName,
  onCompleted,
}: {
  detail: RoomDetail;
  name: string;
  onInvalidName(): void;
  onCompleted(): void;
}) {
  const backend = useBackend();
  const [generation, setGeneration] = useState(0);
  const { session, state } = useRoomSession(backend, detail.id, name, generation);
  const fatal = state?.fatal ?? null;
  const callbacks = useRef({ onInvalidName, onCompleted });
  callbacks.current = { onInvalidName, onCompleted };

  useEffect(() => {
    if (fatal === 'invalid_name') callbacks.current.onInvalidName();
    // A completed room is shown from the REST snapshot in review mode.
    if (fatal === 'room_completed') callbacks.current.onCompleted();
  }, [fatal]);

  const rejoin = () => setGeneration((g) => g + 1);

  if (fatal === 'room_full') {
    return (
      <MessagePage
        eyebrow={detail.title}
        title="This room is full"
        body="Two people are already in this interview. If one of them just left, their seat frees up within about 30 seconds."
        actions={
          <button type="button" className="btn btn-primary" onClick={rejoin}>
            Try again
          </button>
        }
      />
    );
  }
  if (fatal === 'replaced') {
    return (
      <MessagePage
        eyebrow={detail.title}
        title="Opened in another tab"
        body="You joined this room from another tab, so this one was disconnected."
        actions={
          <button type="button" className="btn btn-primary" onClick={rejoin}>
            Use this tab instead
          </button>
        }
      />
    );
  }
  if (fatal === 'room_not_found') return <NotFound />;
  if (session && state && !state.room && state.connection === 'disconnected' && !fatal) {
    return (
      <MessagePage
        eyebrow={detail.title}
        title="Couldn’t connect to the room"
        body="The server isn’t responding. Check that the backend is running, then try again."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => session.retry()}>
            Try again
          </button>
        }
      />
    );
  }
  if (!session || !state || !state.room || fatal) {
    return <LoadingCard label={state?.connection === 'reconnecting' ? 'Waiting for the server…' : 'Joining room…'} />;
  }

  return <Editor room={state.room} shapes={state.shapes} live={{ session, state }} />;
}
