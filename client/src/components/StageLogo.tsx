import logoUrl from '../assets/logo_stage.png';

export function StageLogo({ size = 32 }: { size?: number }) {
  return (
    <img
      src={logoUrl}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      style={{ display: 'block', objectFit: 'contain' }}
    />
  );
}
