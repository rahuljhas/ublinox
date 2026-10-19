/** Ublinox mark: a rounded tile with a looping "u" and a spark, in the brand pink gradient. */
export function LogoMark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" role="img" aria-label="Ublinox logo">
      <defs>
        <linearGradient id="ublinox-tile" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff8fb8" />
          <stop offset="1" stopColor="#d63a74" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="12" fill="url(#ublinox-tile)" />
      <path d="M12 11v9.5a8 8 0 0 0 16 0V11" fill="none" stroke="#fff" strokeWidth="4.4" strokeLinecap="round" />
      <circle cx="20" cy="20.5" r="2.4" fill="#fff" opacity="0.9" />
      <path d="M31 6.5l1 2.3 2.3 1-2.3 1-1 2.3-1-2.3-2.3-1 2.3-1z" fill="#fff" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="logo-lockup">
      <LogoMark />
      <span className="wordmark">
        ublinox<span className="wordmark-dot">.</span>
      </span>
    </span>
  );
}
