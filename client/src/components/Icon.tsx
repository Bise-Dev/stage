type IconName = 'gh' | 'folder' | 'chevron-right' | 'chevron-left' | 'check' | 'arrow-right';

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
  }
}
