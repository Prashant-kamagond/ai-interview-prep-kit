/** A busy indicator that is announced to screen readers and calm for people who reduce motion. */
export function Spinner({
  label = 'Loading…',
  showLabel = false,
}: {
  label?: string;
  showLabel?: boolean;
}) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-slate-700">
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="size-5 animate-spin motion-reduce:animate-none"
        fill="none"
      >
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
        <path
          d="M21 12a9 9 0 0 0-9-9"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
      <span className={showLabel ? '' : 'sr-only'}>{label}</span>
    </span>
  );
}
