/** Company logo (frontend/public/logo.png) with the ublinox wordmark. */
export function Logo() {
  return (
    <span className="logo-lockup">
      <img src="/logo.png" alt="" width={30} height={36} className="logo-img" />
      <span className="wordmark">
        ublinox<span className="wordmark-dot">.</span>
      </span>
    </span>
  );
}
