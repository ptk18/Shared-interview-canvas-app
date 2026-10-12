import type { SVGProps } from 'react';

const base: SVGProps<SVGSVGElement> = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
};

export const icons = {
  select: <svg {...base}><path d="M5 3.5l13 7.2-5.8 1.4-2.9 5.4z" /></svg>,
  pan: (
    <svg {...base}>
      <path d="M8 13V6.5a1.5 1.5 0 013 0V12M11 11V4.5a1.5 1.5 0 013 0V11M14 11V6a1.5 1.5 0 013 0v8a6 6 0 01-6 6h-.5a6 6 0 01-4.8-2.4L4 14.6a1.6 1.6 0 012.5-2L8 14" />
    </svg>
  ),
  rect: <svg {...base}><rect x="3.5" y="6" width="17" height="12" rx="2" /></svg>,
  ellipse: <svg {...base}><ellipse cx="12" cy="12" rx="8.5" ry="6.5" /></svg>,
  line: <svg {...base}><path d="M5 19L19 5" /></svg>,
  arrow: <svg {...base}><path d="M5 19L19 5M10 5h9v9" /></svg>,
  text: <svg {...base}><path d="M5 6V4.5h14V6M12 4.5v15M9 19.5h6" /></svg>,
  trash: <svg {...base}><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5" /></svg>,
  plus: <svg {...base}><path d="M12 5v14M5 12h14" /></svg>,
  minus: <svg {...base}><path d="M5 12h14" /></svg>,
  fit: <svg {...base}><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" /></svg>,
  link: (
    <svg {...base}>
      <path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" />
    </svg>
  ),
  download: <svg {...base}><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14" /></svg>,
  check: <svg {...base}><path d="M5 12.5l4.5 4.5L19 7" /></svg>,
};

export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#1f2328" />
      <rect x="6" y="7" width="9" height="7" rx="1.5" fill="none" stroke="#fbfaf7" strokeWidth="2" />
      <rect x="17" y="18" width="9" height="7" rx="1.5" fill="none" stroke="#fbfaf7" strokeWidth="2" />
      <path d="M10.5 14v7.5H17" fill="none" stroke="#fbfaf7" strokeWidth="2" />
    </svg>
  );
}

export function Brand() {
  return (
    <span className="brand">
      <BrandMark />
      Sketchroom
    </span>
  );
}
