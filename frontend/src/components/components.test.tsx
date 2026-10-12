import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackendContext } from '../services';
import type { BackendService } from '../services/types';
import { ApiError } from '../services/types';
import { createHarness, type Harness } from '../test/mockHarness';
import { EndSessionDialog } from './EndSessionDialog';
import { HomePage } from './HomePage';
import { StatusPills } from './Panels';
import { RoomPage } from './RoomPage';

let h: Harness;
let backend: BackendService;

beforeEach(() => {
  h = createHarness();
  backend = h.client();
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => h.close());

const withBackend = (ui: ReactNode, b: BackendService = backend) =>
  render(<BackendContext.Provider value={b}>{ui}</BackendContext.Provider>);

describe('HomePage', () => {
  it('creates a room and navigates to its URL', async () => {
    withBackend(<HomePage />);
    await userEvent.type(screen.getByLabelText('Interview title'), 'Design a URL shortener');
    await userEvent.click(screen.getByRole('button', { name: 'Create room' }));
    await waitFor(() => expect(window.location.pathname).toMatch(/^\/r\/[A-Za-z0-9_-]{22}$/));
    const roomId = window.location.pathname.slice(3);
    expect((await backend.getRoom(roomId)).title).toBe('Design a URL shortener');
  });

  it('requires a title before calling the backend', async () => {
    const spy = vi.spyOn(backend, 'createRoom');
    withBackend(<HomePage />);
    await userEvent.click(screen.getByRole('button', { name: 'Create room' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/title/i);
    expect(spy).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/');
  });

  it('shows the server error when creation fails', async () => {
    const failing: BackendService = { ...backend, createRoom: async () => Promise.reject(new ApiError(0, 'network_error', 'Could not reach the server.')) };
    withBackend(<HomePage />, failing);
    await userEvent.type(screen.getByLabelText('Interview title'), 'X');
    await userEvent.click(screen.getByRole('button', { name: 'Create room' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server.');
    expect(screen.getByRole('button', { name: 'Create room' })).toBeEnabled();
  });
});

describe('RoomPage', () => {
  it('shows a not-found page for an unknown room', async () => {
    withBackend(<RoomPage roomId="does-not-exist" />);
    expect(await screen.findByRole('heading', { name: 'Room not found' })).toBeInTheDocument();
  });

  it('asks for a display name, with the shareable link, before joining', async () => {
    const room = await backend.createRoom('Design Twitter');
    withBackend(<RoomPage roomId={room.id} />);
    expect(await screen.findByRole('heading', { name: 'Design Twitter' })).toBeInTheDocument();
    expect(screen.getByLabelText('Room link')).toHaveValue(`${window.location.origin}/r/${room.id}`);
    await userEvent.click(screen.getByRole('button', { name: 'Join room' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/name/i);
  });

  it('pre-fills the name used last time', async () => {
    localStorage.setItem('sdi:name', 'Ada');
    const room = await backend.createRoom('T');
    withBackend(<RoomPage roomId={room.id} />);
    expect(await screen.findByLabelText('Your display name')).toHaveValue('Ada');
  });

  it('tells a third participant the room is full', async () => {
    const room = await backend.createRoom('Busy');
    const seat = (name: string) =>
      new Promise<void>((resolve) =>
        h.client().connectRoom(room.id, { name }, { onOpen() {}, onMessage: (m) => m.type === 'welcome' && resolve(), onClose() {} }),
      );
    await seat('Ada');
    await seat('Bo');
    withBackend(<RoomPage roomId={room.id} />);
    await userEvent.type(await screen.findByLabelText('Your display name'), 'Cy');
    await userEvent.click(screen.getByRole('button', { name: 'Join room' }));
    expect(await screen.findByRole('heading', { name: 'This room is full' })).toBeInTheDocument();
  });

  it('offers a retry when the server cannot be reached', async () => {
    const down: BackendService = { ...backend, getRoom: async () => Promise.reject(new ApiError(0, 'network_error', 'Could not reach the server.')) };
    withBackend(<RoomPage roomId="x" />, down);
    expect(await screen.findByRole('heading', { name: 'Couldn’t open this room' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('EndSessionDialog', () => {
  it('warns that ending is permanent and only confirms on the explicit button', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<EndSessionDialog onConfirm={onConfirm} onCancel={onCancel} />);
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/can’t be undone/);
    expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'End session' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('StatusPills', () => {
  it.each([
    ['connected', 'saved', 'Connection: Connected', 'Save status: Saved'],
    ['reconnecting', 'saving', 'Connection: Reconnecting', 'Save status: Saving'],
    ['disconnected', 'error', 'Connection: Disconnected', 'Save status: Save failed'],
  ] as const)('labels %s / %s', (connection, save, c, s) => {
    render(<StatusPills connection={connection} save={save} />);
    expect(screen.getByRole('status', { name: c })).toBeInTheDocument();
    expect(screen.getByRole('status', { name: s })).toBeInTheDocument();
  });
});
