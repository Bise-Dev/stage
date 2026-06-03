import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from './Icon';

export type DropdownOption = { value: string; label: string };

/**
 * A custom select styled with the app's own tokens (hairline trigger, `--sh-pop`
 * popover menu, blue-tint hover) instead of the native `<select>` chrome, which
 * renders as dated OS widgetry inside the webview. Closes on outside click,
 * Escape, or selection; Arrow keys move the highlight, Enter commits.
 */
export function Dropdown({
  value,
  options,
  onChange,
  ariaLabel,
  title,
  mono,
  className,
  style,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  title?: string;
  /** Render the value/options in the monospace face (for refs, paths, etc.). */
  mono?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const selected = options.find((o) => o.value === value);
  const label = selected?.label ?? value;

  // Close on any click outside the component.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);

  // When opening, highlight the currently-selected option.
  const openMenu = () => {
    const i = options.findIndex((o) => o.value === value);
    setActive(i < 0 ? 0 : i);
    setOpen(true);
  };

  const commit = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!open) openMenu();
      else commit(options[active]?.value ?? value);
    } else if (e.key === 'Escape') {
      setOpen(false);
    } else if (open && e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (open && e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(options.length - 1, i + 1));
    }
  };

  return (
    <div className={`dropdown${className ? ` ${className}` : ''}`} ref={rootRef} style={style}>
      <button
        type="button"
        className={`dropdown-trigger${mono ? ' mono' : ''}`}
        aria-label={ariaLabel}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onTriggerKey}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
        <Icon name="chevron-down" size={11} color="var(--gray-500)" className="dropdown-caret" />
      </button>
      {open && (
        <div
          className={`dropdown-menu${mono ? ' mono' : ''}`}
          // biome-ignore lint/a11y/useSemanticElements: a native <select> renders dated OS chrome in the webview — the whole point of this component is to replace it with a styled popup. tabIndex=-1 keeps the listbox out of the tab order; the trigger owns keyboard interaction.
          role="listbox"
          id={listId}
          tabIndex={-1}
        >
          {options.map((o, i) => (
            <button
              type="button"
              key={o.value}
              // biome-ignore lint/a11y/useSemanticElements: see the listbox above — <option> can't exist outside a native <select>; this is the styled equivalent.
              role="option"
              aria-selected={o.value === value}
              className={`dropdown-option${i === active ? ' active' : ''}`}
              onPointerEnter={() => setActive(i)}
              onClick={() => commit(o.value)}
            >
              <span className="dropdown-check">
                {o.value === value && <Icon name="check" size={12} color="var(--blue-press)" />}
              </span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
