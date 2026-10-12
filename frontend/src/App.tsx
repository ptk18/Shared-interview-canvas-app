import { lazy, Suspense } from 'react';
import { HomePage } from './components/HomePage';
import { MessagePage } from './components/MessagePage';
import { matchRoute, usePathname } from './router';

// The canvas stack (Konva) is only needed inside a room.
const RoomPage = lazy(() => import('./components/RoomPage').then((m) => ({ default: m.RoomPage })));

export function App() {
  const route = matchRoute(usePathname());
  switch (route.name) {
    case 'home':
      return <HomePage />;
    case 'room':
      return (
        <Suspense
          fallback={
            <main className="center-page" aria-busy="true">
              <p className="mono" style={{ color: 'var(--muted)' }}>
                Opening room…
              </p>
            </main>
          }
        >
          <RoomPage key={route.roomId} roomId={route.roomId} />
        </Suspense>
      );
    case 'not_found':
      return <MessagePage title="Page not found" body="There's nothing at this address." />;
  }
}
