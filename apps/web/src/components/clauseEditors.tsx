import { useMemo, useState } from 'react';

/** A tag/chip multi-value input with datalist suggestions, used by genre/country
 * clause editors (RecipeBuilder) and reused by Curator's own criteria form. */
export function ChipInput({
  values,
  onChange,
  suggestions,
  placeholder,
  labelFor,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  suggestions: string[];
  placeholder: string;
  /** Displays a friendlier label for a stored value (e.g. country code -> name) without changing what's stored. */
  labelFor?: (v: string) => string;
}) {
  const [draft, setDraft] = useState('');
  const listId = useMemo(() => `dl-${Math.random().toString(36).slice(2)}`, []);
  const add = (raw: string) => {
    const v = raw.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft('');
  };
  return (
    <div className="chipinput">
      <div className="chips">
        {values.map((v) => (
          <span key={v} className="chip">
            {labelFor ? labelFor(v) : v}
            <button type="button" onClick={() => onChange(values.filter((x) => x !== v))}>
              ×
            </button>
          </span>
        ))}
      </div>
      <input
        list={listId}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add(draft);
          }
        }}
        onBlur={() => draft && add(draft)}
      />
      <datalist id={listId}>
        {suggestions.map((s) => (
          // The option's value (what gets filled into the input on pick) stays
          // the raw code; its text content is the friendlier suggestion label.
          <option key={s} value={s}>
            {labelFor ? labelFor(s) : s}
          </option>
        ))}
      </datalist>
    </div>
  );
}

/** A number input with a slider above it, for filters where dragging beats typing. */
export function SliderField({
  label,
  value,
  onChange,
  min = 0,
  max,
  step = 1,
  allowEmpty,
  placeholder,
}: {
  label?: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  min?: number;
  max: number;
  step?: number;
  /** If true, an empty number input clears the value (for optional min/max bounds). */
  allowEmpty?: boolean;
  placeholder?: string;
}) {
  const clamped = Math.min(Math.max(value ?? min, min), max);
  return (
    <label className="inline slider-field">
      {label}
      <span className="slider-stack">
        <input type="range" min={min} max={max} step={step} value={clamped} onChange={(e) => onChange(Number(e.target.value))} />
        <input
          type="number"
          min={min}
          step={step}
          placeholder={placeholder}
          value={value ?? (allowEmpty ? '' : min)}
          onChange={(e) => onChange(e.target.value === '' && allowEmpty ? undefined : Number(e.target.value))}
        />
      </span>
    </label>
  );
}

const DAY_UNITS = { days: 1, months: 30, years: 365 } as const;
type DayUnit = keyof typeof DAY_UNITS;

/** A day-count input that also accepts months/years, with a slider scaled to the chosen unit. */
export function DaysInput({ days, onChange, maxDays = 3650 }: { days: number; onChange: (days: number) => void; maxDays?: number }) {
  const [unit, setUnit] = useState<DayUnit>(
    days > 0 && days % 365 === 0 ? 'years' : days > 0 && days % 30 === 0 ? 'months' : 'days',
  );
  const factor = DAY_UNITS[unit];
  const displayValue = Math.round(days / factor);
  const sliderMax = Math.max(1, Math.round(maxDays / factor));
  const set = (n: number) => onChange(Math.max(0, Math.round(n)) * factor);
  return (
    <div className="days-input">
      <input type="range" min={0} max={sliderMax} value={Math.min(displayValue, sliderMax)} onChange={(e) => set(Number(e.target.value))} />
      <span className="days-input-row">
        <input type="number" min={0} value={displayValue} onChange={(e) => set(Number(e.target.value))} />
        <select value={unit} onChange={(e) => setUnit(e.target.value as DayUnit)}>
          <option value="days">days</option>
          <option value="months">months</option>
          <option value="years">years</option>
        </select>
      </span>
    </div>
  );
}

/** A pair of date inputs for an inclusive after/before range (first/last listen, peak month, …). */
export function DateRangeInput({
  after,
  before,
  onChange,
  toDateValue,
}: {
  after: string | undefined;
  before: string | undefined;
  onChange: (after: string | undefined, before: string | undefined) => void;
  /** Transforms a stored value for display in the date input (e.g. padding a bare 'YYYY-MM'). */
  toDateValue?: (v?: string) => string;
}) {
  const display = toDateValue ?? ((v?: string) => v ?? '');
  return (
    <div className="daterange">
      <input type="date" value={display(after)} onChange={(e) => onChange(e.target.value || undefined, before)} />
      <span>→</span>
      <input type="date" value={display(before)} onChange={(e) => onChange(after, e.target.value || undefined)} />
    </div>
  );
}
