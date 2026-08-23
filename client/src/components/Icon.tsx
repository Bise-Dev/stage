export type IconName =
  | 'gh'
  | 'folder'
  | 'chevron-right'
  | 'chevron-left'
  | 'chevron-down'
  | 'check'
  | 'arrow-right'
  | 'plus'
  | 'branch'
  | 'worktree'
  | 'play'
  | 'doc-stack'
  | 'copy'
  | 'search'
  | 'eye'
  | 'grip'
  | 'sparkle'
  | 'comment-fill'
  | 'alert';

interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  className?: string;
}

export function Icon({ name, size = 14, color = 'currentColor', className }: IconProps) {
  const stroke = {
    stroke: color,
    strokeWidth: 1.4,
    fill: 'none' as const,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  switch (name) {
    case 'gh':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 16 16"
          fill={color}
          className={className}
          aria-hidden="true"
        >
          <path d="M8 0a8 8 0 0 0-2.5 15.6c.4.1.6-.2.6-.4v-1.4c-2.3.5-2.8-1-2.8-1-.4-1-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.2 1.9.9 2.4.7.1-.5.3-.9.5-1.1-1.8-.2-3.7-.9-3.7-4 0-.9.3-1.6.8-2.2-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.6 7.6 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.4 1.1.2 2 .1 2.1.5.6.8 1.3.8 2.2 0 3.1-1.9 3.8-3.7 4 .3.3.6.8.6 1.6v2.3c0 .2.1.5.6.4A8 8 0 0 0 8 0" />
        </svg>
      );
    case 'folder':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 14 14"
          {...stroke}
          className={className}
          aria-hidden="true"
        >
          <path d="M1.5 4V3a1 1 0 0 1 1-1h2.5l1.2 1.5h5.3a1 1 0 0 1 1 1V11a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" />
        </svg>
      );
    case 'chevron-right':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 14 14"
          {...stroke}
          className={className}
          aria-hidden="true"
        >
          <path d="M5 3l4 4-4 4" />
        </svg>
      );
    case 'chevron-left':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 14 14"
          {...stroke}
          className={className}
          aria-hidden="true"
        >
          <path d="M9 3L5 7l4 4" />
        </svg>
      );
    case 'chevron-down':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 14 14"
          {...stroke}
          className={className}
          aria-hidden="true"
        >
          <path d="M3 5l4 4 4-4" />
        </svg>
      );
    case 'check':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 14 14"
          {...stroke}
          className={className}
          aria-hidden="true"
        >
          <path d="M2.5 7.5l3 3 6-7" />
        </svg>
      );
    case 'arrow-right':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 14 14"
          {...stroke}
          className={className}
          aria-hidden="true"
        >
          <path d="M2.5 7h9M8 3.5L11.5 7 8 10.5" />
        </svg>
      );
    case 'plus':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 14 14"
          {...stroke}
          className={className}
          aria-hidden="true"
        >
          <path d="M7 2v10M2 7h10" />
        </svg>
      );
    case 'branch':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 14 14"
          {...stroke}
          className={className}
          aria-hidden="true"
        >
          <circle cx="3.5" cy="3" r="1.4" />
          <circle cx="3.5" cy="11" r="1.4" />
          <circle cx="10.5" cy="3" r="1.4" />
          <path d="M3.5 4.4v5.2M10.5 4.4v1.6a2 2 0 0 1-2 2H5.5" />
        </svg>
      );
    case 'worktree':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 14 14"
          {...stroke}
          className={className}
          aria-hidden="true"
        >
          <circle cx="2.8" cy="2.8" r="1.3" />
          <path d="M2.8 4.1v3.3a1.5 1.5 0 0 0 1.5 1.5h1.2" />
          <rect x="5.8" y="5.8" width="6.7" height="6.2" rx="1.2" />
        </svg>
      );
    case 'search':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 14 14"
          {...stroke}
          className={className}
          aria-hidden="true"
        >
          <circle cx="6" cy="6" r="4" />
          <path d="M9.2 9.2L12 12" />
        </svg>
      );
    case 'sparkle':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 14 14"
          {...stroke}
          className={className}
          aria-hidden="true"
        >
          <path d="M7 1.5v3M7 9.5v3M1.5 7h3M9.5 7h3M3.2 3.2l2 2M8.8 8.8l2 2M10.8 3.2l-2 2M5.2 8.8l-2 2" />
        </svg>
      );
    case 'eye':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 14 14"
          {...stroke}
          className={className}
          aria-hidden="true"
        >
          <path d="M1 7s2-4 6-4 6 4 6 4-2 4-6 4-6-4-6-4z" />
          <circle cx="7" cy="7" r="1.6" />
        </svg>
      );
    case 'doc-stack':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 14 14"
          {...stroke}
          className={className}
          aria-hidden="true"
        >
          <rect x="3" y="3" width="8" height="9" rx="1.2" />
          <path d="M5 1.5h6a1 1 0 0 1 1 1V10" />
        </svg>
      );
    case 'copy':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 14 14"
          {...stroke}
          className={className}
          aria-hidden="true"
        >
          <rect x="5" y="5" width="7.5" height="7.5" rx="1.2" />
          <path d="M9 3.2V2.7a1.2 1.2 0 0 0-1.2-1.2H2.7a1.2 1.2 0 0 0-1.2 1.2v5.1A1.2 1.2 0 0 0 2.7 9h.5" />
        </svg>
      );
    case 'play':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 14 14"
          fill={color}
          className={className}
          aria-hidden="true"
        >
          <path d="M4 3v8l7-4z" />
        </svg>
      );
    case 'grip':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 14 14"
          fill={color}
          className={className}
          aria-hidden="true"
        >
          <circle cx="5" cy="3.5" r="1" />
          <circle cx="9" cy="3.5" r="1" />
          <circle cx="5" cy="7" r="1" />
          <circle cx="9" cy="7" r="1" />
          <circle cx="5" cy="10.5" r="1" />
          <circle cx="9" cy="10.5" r="1" />
        </svg>
      );
    case 'comment-fill':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 14 14"
          fill={color}
          className={className}
          aria-hidden="true"
        >
          <path d="M2 4a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H6l-3 2v-2H4a2 2 0 0 1-2-2z" />
        </svg>
      );
    case 'alert':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 14 14"
          {...stroke}
          className={className}
          aria-hidden="true"
        >
          <path d="M7 1.8 12.8 12H1.2z" />
          <path d="M7 5.6v3" />
          <path d="M7 10.4h.01" />
        </svg>
      );
  }
}
