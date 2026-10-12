import { useEffect, useRef } from 'react';

export function EndSessionDialog({ onConfirm, onCancel }: { onConfirm(): void; onCancel(): void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="end-title" aria-describedby="end-body">
        <h2 id="end-title">End this session?</h2>
        <p id="end-body">
          This can’t be undone. The diagram is saved and becomes permanently read-only for both participants. The
          link keeps working for review.
        </p>
        <div className="dialog-actions">
          <button ref={cancelRef} type="button" className="btn" onClick={onCancel}>
            Keep editing
          </button>
          <button type="button" className="btn btn-danger-solid" onClick={onConfirm}>
            End session
          </button>
        </div>
      </div>
    </div>
  );
}
