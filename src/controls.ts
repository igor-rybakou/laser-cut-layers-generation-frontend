// Generic, type-driven form controls used by the schema-generated parameter
// panel. Each control is "uncontrolled" after creation -- it owns its own DOM
// value and only gets overwritten from the store when the store's value
// changes for a reason other than the user typing in it (e.g. a preset load),
// detected via `document.activeElement`.

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function numberControl(opts: {
  value: number;
  min?: number | null;
  max?: number | null;
  unit?: string | null;
  step?: number;
  onChange: (v: number) => void;
}): HTMLElement {
  const wrap = el('div', 'ctl ctl-number');
  const hasBounds = opts.min != null && opts.max != null;

  const numInput = el('input') as HTMLInputElement;
  numInput.type = 'number';
  numInput.className = 'ctl-num-input';
  numInput.value = String(opts.value);
  if (opts.min != null) numInput.min = String(opts.min);
  if (opts.max != null) numInput.max = String(opts.max);
  numInput.step = String(opts.step ?? guessStep(opts.min, opts.max));

  let slider: HTMLInputElement | null = null;
  if (hasBounds) {
    slider = el('input') as HTMLInputElement;
    slider.type = 'range';
    slider.className = 'ctl-slider';
    slider.min = String(opts.min);
    slider.max = String(opts.max);
    slider.step = String(opts.step ?? guessStep(opts.min, opts.max));
    slider.value = String(opts.value);
    slider.addEventListener('input', () => {
      numInput.value = slider!.value;
      opts.onChange(parseFloat(slider!.value));
    });
    wrap.appendChild(slider);
  }

  numInput.addEventListener('change', () => {
    const v = parseFloat(numInput.value);
    if (Number.isNaN(v)) return;
    if (slider) slider.value = String(v);
    opts.onChange(v);
  });

  wrap.appendChild(numInput);
  if (opts.unit) wrap.appendChild(el('span', 'ctl-unit', opts.unit));

  (wrap as HTMLElement & { setValue?: (v: number) => void }).setValue = (v: number) => {
    if (document.activeElement === numInput || document.activeElement === slider) return;
    numInput.value = String(v);
    if (slider) slider.value = String(v);
  };

  return wrap;
}

function guessStep(min?: number | null, max?: number | null): number {
  if (min != null && max != null) {
    const range = max - min;
    if (range <= 10) return 0.01;
    if (range <= 100) return 0.1;
  }
  return 0.01;
}

export function textControl(opts: {
  value: string;
  onChange: (v: string) => void;
}): HTMLElement {
  const input = el('input') as HTMLInputElement;
  input.type = 'text';
  input.className = 'ctl-text';
  input.value = opts.value;
  input.addEventListener('change', () => opts.onChange(input.value));
  (input as HTMLInputElement & { setValue?: (v: string) => void }).setValue = (v: string) => {
    if (document.activeElement === input) return;
    input.value = v;
  };
  return input;
}

export function booleanControl(opts: {
  value: boolean;
  onChange: (v: boolean) => void;
}): HTMLElement {
  const label = el('label', 'ctl-toggle');
  const input = el('input') as HTMLInputElement;
  input.type = 'checkbox';
  input.checked = opts.value;
  input.addEventListener('change', () => opts.onChange(input.checked));
  const knob = el('span', 'ctl-toggle-knob');
  label.appendChild(input);
  label.appendChild(knob);
  (label as HTMLElement & { setValue?: (v: boolean) => void }).setValue = (v: boolean) => {
    input.checked = v;
  };
  return label;
}

// A material-tint swatch: native color input plus a revert affordance that
// only appears once the value stops tracking its default. `sync` is called
// from outside whenever the underlying default moves (e.g. palette switch).
export type ColorControl = HTMLElement & {
  sync: (value: string, overridden: boolean, title?: string) => void;
};

export function colorControl(opts: {
  value: string;
  overridden: boolean;
  title?: string;
  onChange: (v: string) => void;
  onReset: () => void;
}): ColorControl {
  const wrap = el('div', 'ctl-color') as HTMLElement as ColorControl;

  const input = el('input') as HTMLInputElement;
  input.type = 'color';
  input.className = 'ctl-color-swatch';
  input.value = opts.value;
  if (opts.title) input.title = opts.title;
  input.addEventListener('input', () => opts.onChange(input.value));
  wrap.appendChild(input);

  const reset = el('button', 'ctl-color-reset', '↺') as HTMLButtonElement;
  reset.type = 'button';
  reset.title = 'revert to the palette tone';
  reset.addEventListener('click', () => opts.onReset());
  wrap.appendChild(reset);

  wrap.sync = (value: string, overridden: boolean, title?: string) => {
    if (document.activeElement !== input) input.value = value;
    wrap.classList.toggle('is-overridden', overridden);
    if (title !== undefined) input.title = title;
  };
  wrap.sync(opts.value, opts.overridden);

  return wrap;
}

// Multi-select over a fixed option list, for `enum_list` schema fields. The
// backend rejects an empty include_layers.roads outright, so `minSelected`
// locks the last remaining boxes instead of letting the UI compose a request
// that can only come back 422.
export function checklistControl(opts: {
  options: { value: string; label?: string; title?: string }[];
  value: string[];
  minSelected?: number;
  minTitle?: string;
  onChange: (v: string[]) => void;
}): HTMLElement & { setValue?: (v: string[]) => void } {
  const wrap = el('div', 'ctl ctl-checklist');
  const boxes = new Map<string, HTMLInputElement>();
  const min = opts.minSelected ?? 0;
  let current = [...opts.value];

  const sync = (): void => {
    const locked = current.length <= min;
    for (const [value, box] of boxes) {
      box.checked = current.includes(value);
      // Only the checked ones lock -- unchecked boxes must stay clickable.
      box.disabled = locked && box.checked;
      const row = box.closest('.ctl-check') as HTMLElement | null;
      row?.classList.toggle('is-locked', box.disabled);
      if (box.disabled && opts.minTitle) row?.setAttribute('title', opts.minTitle);
      else if (row) row.title = opts.options.find((o) => o.value === value)?.title ?? '';
    }
  };

  for (const opt of opts.options) {
    const row = el('label', 'ctl-check');
    const box = el('input') as HTMLInputElement;
    box.type = 'checkbox';
    box.value = opt.value;
    if (opt.title) row.title = opt.title;
    box.addEventListener('change', () => {
      current = opts.options
        .map((o) => o.value)
        .filter((v) => (v === opt.value ? box.checked : current.includes(v)));
      sync();
      opts.onChange([...current]);
    });
    boxes.set(opt.value, box);
    row.appendChild(box);
    row.appendChild(el('span', 'ctl-check-label', opt.label ?? opt.value));
    wrap.appendChild(row);
  }

  const out = wrap as HTMLElement & { setValue?: (v: string[]) => void };
  out.setValue = (v: string[]) => {
    current = [...v];
    sync();
  };
  sync();
  return out;
}

export function enumControl(opts: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
}): HTMLElement {
  const wrap = el('div', 'ctl-segmented');
  const buttons: HTMLButtonElement[] = [];
  for (const opt of opts.options) {
    const btn = el('button', 'ctl-seg-btn', opt) as HTMLButtonElement;
    btn.type = 'button';
    btn.dataset.value = opt;
    if (opt === opts.value) btn.classList.add('active');
    btn.addEventListener('click', () => {
      for (const b of buttons) b.classList.remove('active');
      btn.classList.add('active');
      opts.onChange(opt);
    });
    buttons.push(btn);
    wrap.appendChild(btn);
  }
  (wrap as HTMLElement & { setValue?: (v: string) => void }).setValue = (v: string) => {
    for (const b of buttons) b.classList.toggle('active', b.dataset.value === v);
  };
  return wrap;
}
