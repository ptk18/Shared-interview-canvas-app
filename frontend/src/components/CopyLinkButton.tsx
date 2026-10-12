import { useEffect, useState } from 'react';
import { roomUrl } from '../router';
import { icons } from './icons';

export function CopyLinkButton({ roomId, compact = false }: { roomId: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(roomUrl(roomId));
      setCopied(true);
    } catch {
      window.prompt('Copy this room link:', roomUrl(roomId));
    }
  }

  return (
    <button type="button" className="btn" onClick={copy} aria-live="polite">
      {copied ? icons.check : icons.link}
      <span className={compact ? 'hide-narrow' : undefined}>{copied ? 'Copied' : 'Copy link'}</span>
    </button>
  );
}
