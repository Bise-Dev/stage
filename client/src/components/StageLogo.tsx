export function StageLogo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#007aff" />
      <rect x="14.5" y="6" width="3" height="20" rx="1.5" fill="rgba(255,255,255,0.32)" />
      <rect x="14.5" y="6" width="3" height="11" rx="1.5" fill="#ffffff" />
      <circle cx="16" cy="9" r="3.6" fill="#ffffff" />
      <circle cx="16" cy="16" r="3.6" fill="#ffffff" />
      <circle cx="16" cy="23" r="3.6" fill="none" stroke="#ffffff" strokeWidth="1.6" />
    </svg>
  );
}
