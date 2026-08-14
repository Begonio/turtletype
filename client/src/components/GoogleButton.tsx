import { loginUrl } from '../lib/api';

interface Props {
  label?: string;
  next?: string;
  className?: string;
}

/** Full-page navigation, not fetch: OAuth has to leave the SPA. */
export default function GoogleButton({ label = 'Sign in with Google', next = '/app', className = '' }: Props) {
  return (
    <a
      href={loginUrl(next)}
      className={`inline-flex items-center justify-center gap-3 rounded-lg bg-white px-5 py-3 text-sm font-medium text-ink-950 transition hover:bg-ink-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950 ${className}`}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="#4285F4"
          d="M23.06 12.25c0-.85-.08-1.67-.22-2.45H12v4.64h6.2a5.3 5.3 0 0 1-2.3 3.48v2.9h3.72c2.18-2 3.44-4.96 3.44-8.57Z"
        />
        <path
          fill="#34A853"
          d="M12 24c3.1 0 5.7-1.03 7.62-2.78l-3.72-2.9c-1.03.7-2.35 1.1-3.9 1.1-3 0-5.55-2.02-6.46-4.74H1.7v2.98A12 12 0 0 0 12 24Z"
        />
        <path
          fill="#FBBC05"
          d="M5.54 14.68a7.2 7.2 0 0 1 0-4.6V7.1H1.7a12 12 0 0 0 0 10.56l3.84-2.98Z"
        />
        <path
          fill="#EA4335"
          d="M12 4.75c1.69 0 3.2.58 4.4 1.72l3.3-3.3C17.7 1.2 15.1 0 12 0A12 12 0 0 0 1.7 7.1l3.84 2.98C6.45 7.36 9 4.75 12 4.75Z"
        />
      </svg>
      {label}
    </a>
  );
}
