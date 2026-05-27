const COLORS = [
  '#FF9500',
  '#34C759',
  '#5AC8FA',
  '#AF52DE',
  '#FF2D55',
  '#007AFF',
  '#FF3B30',
  '#FFCC00',
];

function hashHue(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return COLORS[Math.abs(h) % COLORS.length];
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

interface AvatarProps {
  name: string;
  size?: 'sm' | 'md' | 'lg';
}

export function Avatar({ name, size = 'md' }: AvatarProps) {
  const cls = size === 'sm' ? 'avatar sm' : size === 'lg' ? 'avatar lg' : 'avatar';
  return (
    <div className={cls} style={{ background: hashHue(name) }}>
      {initials(name)}
    </div>
  );
}
