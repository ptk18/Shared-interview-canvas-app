import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { BackendContext, createBackend } from './services';
import './styles.css';

const backend = createBackend();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BackendContext.Provider value={backend}>
      <App />
    </BackendContext.Provider>
  </StrictMode>,
);
