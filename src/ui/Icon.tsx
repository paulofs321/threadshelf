import type { ComponentProps } from 'react';

const paths = {
  shelf: 'M3 11a9 9 0 1 0 3-6.7L3 7m0-5v5h5M12 7v5l3 2',
  search: 'm21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  close: 'm6 6 12 12M6 18 18 6',
  settings:
    'M4 7h3m4 0h9M4 17h9m4 0h3M11 7a2 2 0 1 1-4 0 2 2 0 0 1 4 0m6 10a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
  open: 'M7 17 17 7M7 7h10v10',
  refresh: 'M20 7a9 9 0 0 0-15-2L2 8m0-5v5h5m-3 9a9 9 0 0 0 15 2l3-3m0 5v-5h-5',
  chat: 'M21 11.5a8.5 8.5 0 0 1-12.6 7.4L3 21l2.1-5.4A8.5 8.5 0 1 1 21 11.5',
};

export function Icon({ name, ...props }: ComponentProps<'svg'> & { name: keyof typeof paths }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={paths[name]} />
    </svg>
  );
}
