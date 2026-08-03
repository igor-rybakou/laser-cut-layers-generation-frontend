import {
  booleanControl,
  colorControl,
  el,
  enumControl,
  numberControl,
  textControl,
  type ColorControl,
} from './controls';
import { debounce } from './debounce';
import { deriveMinFeatureWidthMm } from './defects';
import { runGenerate, updateParams } from './generate';
import { mountMapPreview } from './map-preview';
import { paletteSheetColor, PALETTES, sheetColorCss, type SheetRole } from './materials';
import { getPath } from './paths';
import { searchPlace, type PlaceResult } from './place-search';
import { mountPresetsGallery } from './presets';
import { generationStore, paramsStore, schemaStore, uiStore } from './state';
import type { SchemaField } from './types';

const GROUP_ORDER = ['source', 'canvas', 'stack', 'manufacturability', 'roads', 'label'];
const GROUP_TITLES: Record<string, string> = {
  source: 'Source',
  canvas: 'Canvas',
  stack: 'Stack',
  manufacturability: 'Manufacturability',
  roads: 'Road widths',
  label: 'Label',
};

function fieldValue(field: SchemaField): unknown {
  const v = getPath(paramsStore.get(), field.path);
  return v === undefined ? field.default : v;
}

function setFieldValue(field: SchemaField, value: unknown): void {
  updateParams((draft) => {
    const parts = field.path.split('.');
    let cur: Record<string, unknown> = draft as unknown as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      const next = cur[key];
      if (next === null || typeof next !== 'object' || Array.isArray(next)) cur[key] = {};
      cur = cur[key] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]] = value;
  });
}

function buildFieldRow(field: SchemaField): HTMLElement {
  const row = el('div', 'field-row');
  const labelWrap = el('div', 'field-label-wrap');
  const label = el('label', 'field-label', field.name.replace(/_/g, ' '));
  label.title = field.description;
  labelWrap.appendChild(label);
  row.appendChild(labelWrap);

  const value = fieldValue(field);
  let ctl: HTMLElement;

  if (field.type === 'enum' && field.enum) {
    ctl = enumControl({
      value: String(value ?? field.enum[0]),
      options: field.enum,
      onChange: (v) => setFieldValue(field, v),
    });
  } else if (field.type === 'boolean') {
    ctl = booleanControl({
      value: Boolean(value),
      onChange: (v) => setFieldValue(field, v),
    });
  } else if (field.type === 'number' || field.type === 'integer') {
    const num = typeof value === 'number' ? value : field.type === 'integer' ? 0 : 0;
    ctl = numberControl({
      value: num,
      min: field.min,
      max: field.max,
      unit: field.unit,
      step: field.type === 'integer' ? 1 : undefined,
      onChange: (v) => setFieldValue(field, field.type === 'integer' ? Math.round(v) : v),
    });
  } else {
    ctl = textControl({
      value: value == null ? '' : String(value),
      onChange: (v) => setFieldValue(field, v === '' ? null : v),
    });
  }

  row.appendChild(ctl);
  row.dataset.fieldName = field.name;
  return row;
}

function refreshFieldRow(row: HTMLElement, field: SchemaField): void {
  const ctl = row.querySelector<HTMLElement & { setValue?: (v: unknown) => void }>(
    '.ctl-number, .ctl-toggle, .ctl-segmented, .ctl-text',
  );
  if (ctl?.setValue) ctl.setValue(fieldValue(field));
}

function buildPlaceSearch(): HTMLElement {
  const wrap = el('div', 'place-search');
  const input = el('input') as HTMLInputElement;
  input.type = 'text';
  input.placeholder = 'Search a place (e.g. Porto)…';
  input.className = 'place-search-input';
  const results = el('div', 'place-search-results');
  results.style.display = 'none';

  const doSearch = debounce(async (q: string) => {
    if (q.trim().length < 2) {
      results.style.display = 'none';
      results.innerHTML = '';
      return;
    }
    try {
      const hits = await searchPlace(q);
      renderResults(hits);
    } catch {
      results.innerHTML = '';
      results.appendChild(el('div', 'place-search-error', 'search failed'));
      results.style.display = 'block';
    }
  }, 600);

  function renderResults(hits: PlaceResult[]): void {
    results.innerHTML = '';
    if (hits.length === 0) {
      results.style.display = 'none';
      return;
    }
    for (const hit of hits.slice(0, 8)) {
      const item = el('div', 'place-search-item', hit.display_name);
      item.addEventListener('click', () => {
        updateParams((draft) => {
          draft.lat = parseFloat(hit.lat);
          draft.lng = parseFloat(hit.lon);
        });
        input.value = hit.display_name;
        results.style.display = 'none';
      });
      results.appendChild(item);
    }
    results.style.display = 'block';
  }

  input.addEventListener('input', () => doSearch(input.value));
  wrap.appendChild(input);
  wrap.appendChild(results);
  return wrap;
}

function fieldByName(fields: SchemaField[], name: string): SchemaField | undefined {
  return fields.find((f) => f.name === name);
}

interface StackRoleSpec {
  role: SheetRole;
  index: string;
  position: string;
  positionNote: string;
  cutRule: string;
  engraves: string;
}

// Cards are listed in *physical* assembly order, top sheet first -- NOT sheet
// index order. Mirrors three-view.ts's ROLE_ORDER (reversed) and the
// generator's own preview.py compositor: base carries every engrave, so it has
// to be the uncovered sheet; land sits at the bottom nearest an LED strip.
const STACK_ROLES: StackRoleSpec[] = [
  {
    role: 'base',
    index: '00',
    position: 'top',
    positionNote: 'the only uncovered sheet — carries all engraving',
    cutRule: 'boundary only',
    engraves: 'buildings, roads, label',
  },
  {
    role: 'green',
    index: '02',
    position: 'middle',
    positionNote: 'emitted only if park geometry survives filtering',
    cutRule: 'parks ∩ land',
    engraves: 'none',
  },
  {
    role: 'land',
    index: '01',
    position: 'bottom',
    positionNote: 'nearest an under-mounted LED strip',
    cutRule: 'land ∩ boundary − water',
    engraves: 'none',
  },
];

// Field names the stack editor renders itself -- buildGroupSection skips these
// so they don't also appear as generic rows underneath. Anything else the
// backend ever adds to the `stack` group still falls through to a generic row.
export function stackEditorOwnedFields(): Set<string> {
  return new Set([
    'include_green_layer',
    ...STACK_ROLES.map((s) => `thickness_mm_${s.role}`),
  ]);
}

function buildStackEditor(fields: SchemaField[]): HTMLElement {
  const wrap = el('div', 'stack-editor');
  wrap.appendChild(
    el(
      'p',
      'stack-editor-note',
      'Roles, cut rules and engrave sources are fixed by the generator. Only thickness, tint and whether the green sheet is emitted are adjustable — tint is a preview aid, it is never sent to the backend.',
    ),
  );

  const includeGreen = fieldByName(fields, 'include_green_layer');

  const head = el('div', 'stack-head');
  let sheetsSeg: (HTMLElement & { setValue?: (v: string) => void }) | null = null;
  if (includeGreen) {
    const quick = el('div', 'stack-quick');
    quick.appendChild(el('span', 'field-label', 'sheets'));
    sheetsSeg = enumControl({
      value: Boolean(fieldValue(includeGreen)) ? '3' : '2',
      options: ['2', '3'],
      onChange: (v) => setFieldValue(includeGreen, v === '3'),
    });
    quick.appendChild(sheetsSeg);
    head.appendChild(quick);
  }
  const total = el('span', 'stack-total');
  head.appendChild(total);
  wrap.appendChild(head);
  if (includeGreen) {
    wrap.appendChild(
      el('p', 'stack-editor-note', '2–3 sheets is the whole range — there is no --layers 2–5.'),
    );
  }

  const table = el('div', 'stack-table');
  wrap.appendChild(table);

  // Each card registers its own refresh closures; the two subscriptions at the
  // bottom drive them, so a preset load or snapshot restore updates the stack
  // editor exactly like it updates the generic rows. Params-driven and
  // ui-driven work are kept apart so dragging the explode slider (a uiStore
  // write per frame) does not re-read the whole params body.
  const paramRefreshers: (() => void)[] = [];
  const uiRefreshers: (() => void)[] = [];

  for (const spec of STACK_ROLES) {
    const card = el('div', 'stack-card');
    card.dataset.role = spec.role;

    const header = el('div', 'stack-card-head');
    const swatchSlot = el('div', 'stack-card-swatch');
    header.appendChild(swatchSlot);
    header.appendChild(el('span', 'stack-idx', spec.index));
    header.appendChild(el('span', 'stack-name', spec.role));
    const offTag = el('span', 'stack-off-tag', 'not emitted');
    header.appendChild(offTag);
    const posTag = el('span', 'stack-pos', spec.position);
    posTag.title = spec.positionNote;
    header.appendChild(posTag);
    card.appendChild(header);

    const meta = el('div', 'stack-card-meta');
    meta.appendChild(el('span', 'stack-meta-key', 'cuts'));
    meta.appendChild(el('span', 'stack-meta-val', spec.cutRule));
    meta.appendChild(el('span', 'stack-meta-key', 'engraves'));
    meta.appendChild(el('span', 'stack-meta-val', spec.engraves));
    card.appendChild(meta);

    const controls = el('div', 'stack-card-controls');
    card.appendChild(controls);

    // ---- tint swatch -----------------------------------------------------
    const swatch: ColorControl = colorControl({
      value: sheetColorCss(PALETTES[uiStore.get().materialPalette], spec.role, uiStore.get().sheetColors),
      overridden: uiStore.get().sheetColors[spec.role] != null,
      title: `${spec.role} material tint (preview only)`,
      onChange: (v) =>
        uiStore.update((s) => ({ ...s, sheetColors: { ...s.sheetColors, [spec.role]: v } })),
      onReset: () =>
        uiStore.update((s) => ({ ...s, sheetColors: { ...s.sheetColors, [spec.role]: null } })),
    });
    swatchSlot.appendChild(swatch);

    uiRefreshers.push(() => {
      const ui = uiStore.get();
      const palette = PALETTES[ui.materialPalette];
      const override = ui.sheetColors[spec.role];
      const effective = sheetColorCss(palette, spec.role, ui.sheetColors);
      card.style.borderLeftColor = effective;
      swatch.sync(
        effective,
        override != null,
        override
          ? `${spec.role} tint ${override} — overriding ${ui.materialPalette} ${paletteSheetColor(palette, spec.role)}`
          : `${spec.role} tint — ${ui.materialPalette} ${paletteSheetColor(palette, spec.role)} (preview only)`,
      );
    });

    // ---- thickness + derived neck threshold ------------------------------
    const thicknessField = fieldByName(fields, `thickness_mm_${spec.role}`);
    if (thicknessField) {
      const row = el('div', 'stack-thickness-row');
      row.appendChild(el('span', 'field-label', 'thickness'));
      const ctl = numberControl({
        value: Number(fieldValue(thicknessField) ?? 3),
        min: thicknessField.min,
        max: thicknessField.max,
        unit: thicknessField.unit,
        onChange: (v) => setFieldValue(thicknessField, v),
      }) as HTMLElement & { setValue?: (v: number) => void };
      row.appendChild(ctl);
      controls.appendChild(row);

      const neck = el('div', 'stack-derived');
      controls.appendChild(neck);

      paramRefreshers.push(() => {
        const t = Number(fieldValue(thicknessField) ?? 3);
        ctl.setValue?.(t);
        const explicit = getPath(paramsStore.get(), 'config.manufacturability.min_feature_width_mm');
        neck.textContent = `neck ≥ ${deriveMinFeatureWidthMm(explicit, t).toFixed(2)} mm`;
        neck.title =
          typeof explicit === 'number'
            ? 'pinned by manufacturability.min_feature_width_mm'
            : 'derived per-sheet: max(2.0, thickness × 0.85)';
      });
    }

    paramRefreshers.push(() => {
      const off = spec.role === 'green' && !!includeGreen && !fieldValue(includeGreen);
      card.classList.toggle('is-off', off);
      // `inert` keeps a card for a sheet that will not be emitted out of the
      // tab order, rather than merely dimming it.
      if (off) controls.setAttribute('inert', '');
      else controls.removeAttribute('inert');
      offTag.style.display = off ? '' : 'none';
    });

    table.appendChild(card);
  }

  paramRefreshers.push(() => {
    const greenOn = !includeGreen || Boolean(fieldValue(includeGreen));
    if (includeGreen) sheetsSeg?.setValue?.(greenOn ? '3' : '2');
    let sum = 0;
    for (const spec of STACK_ROLES) {
      if (spec.role === 'green' && !greenOn) continue;
      const f = fieldByName(fields, `thickness_mm_${spec.role}`);
      if (f) sum += Number(fieldValue(f) ?? 0);
    }
    total.textContent = `${sum.toFixed(1)} mm total`;
    total.title = 'sum of the thicknesses that will actually be emitted';
  });

  const runParams = () => paramRefreshers.forEach((r) => r());
  const runUi = () => uiRefreshers.forEach((r) => r());
  runParams();
  runUi();
  paramsStore.subscribe(runParams, false);
  uiStore.subscribe(runUi, false);

  return wrap;
}

function buildGroupSection(groupName: string, fields: SchemaField[]): HTMLElement {
  const details = el('details', 'group-section');
  details.open = !uiStore.get().collapsedGroups[groupName];
  const summary = el('summary', 'group-summary', GROUP_TITLES[groupName] ?? groupName);
  details.appendChild(summary);
  details.addEventListener('toggle', () => {
    uiStore.update((s) => ({
      ...s,
      collapsedGroups: { ...s.collapsedGroups, [groupName]: !details.open },
    }));
  });

  const body = el('div', 'group-body');
  if (groupName === 'source') {
    body.appendChild(buildPlaceSearch());
    mountMapPreview(body);
  }

  // Fields a custom editor above already renders. They must not also get a
  // generic row -- two live controls on one path drift apart the moment one
  // of them is the only one refreshed.
  let owned = new Set<string>();
  if (groupName === 'stack') {
    body.appendChild(buildStackEditor(fields));
    owned = stackEditorOwnedFields();
  }

  const genericFields = fields.filter((f) => !owned.has(f.name));
  const rowsByName = new Map<string, HTMLElement>();
  for (const field of genericFields) {
    const row = buildFieldRow(field);
    rowsByName.set(field.name, row);
    body.appendChild(row);
  }
  details.appendChild(body);

  paramsStore.subscribe(() => {
    for (const field of genericFields) {
      const row = rowsByName.get(field.name);
      if (row) refreshFieldRow(row, field);
    }
  }, false);

  return details;
}

function buildGenerateHeader(root: HTMLElement): void {
  const header = el('div', 'generate-header');

  const btnRow = el('div', 'generate-btn-row');
  const genBtn = el('button', 'btn btn-primary', 'Generate') as HTMLButtonElement;
  const forceBtn = el('button', 'btn btn-secondary', 'Force regenerate') as HTMLButtonElement;
  btnRow.appendChild(genBtn);
  btnRow.appendChild(forceBtn);
  header.appendChild(btnRow);

  const status = el('div', 'generate-status');
  header.appendChild(status);

  const autoRow = el('label', 'auto-regen-row');
  const autoToggle = booleanControl({
    value: uiStore.get().autoRegen,
    onChange: (v) => uiStore.update((s) => ({ ...s, autoRegen: v })),
  });
  autoRow.appendChild(autoToggle);
  autoRow.appendChild(el('span', 'auto-regen-label', 'auto-regenerate (1.5s debounce)'));
  header.appendChild(autoRow);

  genBtn.addEventListener('click', () => runGenerate(false));
  forceBtn.addEventListener('click', () => runGenerate(true));

  let timer: ReturnType<typeof setInterval> | null = null;
  generationStore.subscribe((s) => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (s.kind === 'running') {
      genBtn.disabled = true;
      forceBtn.disabled = true;
      const tick = () => {
        const elapsed = ((Date.now() - s.startedAt) / 1000).toFixed(1);
        status.textContent = `running… ${elapsed}s`;
      };
      tick();
      timer = setInterval(tick, 100);
    } else {
      genBtn.disabled = false;
      forceBtn.disabled = false;
      if (s.kind === 'done') {
        status.textContent = `done in ${s.job.duration_s.toFixed(1)}s${s.fromCache ? ' (cached)' : ''}`;
      } else if (s.kind === 'error') {
        status.textContent = 'generation failed — see report panel';
      } else if (s.kind === 'timeout') {
        status.textContent = 'timed out';
      } else {
        status.textContent = 'no run yet — press Generate';
      }
    }
  });

  const autoRegenDebounced = debounce(() => {
    if (uiStore.get().autoRegen) runGenerate(false);
  }, 1500);
  paramsStore.subscribe(() => {
    if (uiStore.get().autoRegen) autoRegenDebounced();
  }, false);

  root.appendChild(header);
}

export function mountLeftPanel(root: HTMLElement): void {
  root.innerHTML = '';
  buildGenerateHeader(root);

  const scroll = el('div', 'left-scroll');
  root.appendChild(scroll);

  mountPresetsGallery(scroll);
  const groupsContainer = el('div', 'groups-container');
  scroll.appendChild(groupsContainer);

  schemaStore.subscribe((fields) => {
    groupsContainer.innerHTML = '';
    if (fields.length === 0) return;
    const byGroup = new Map<string, SchemaField[]>();
    for (const f of fields) {
      if (!byGroup.has(f.group)) byGroup.set(f.group, []);
      byGroup.get(f.group)!.push(f);
    }
    const orderedGroups = [
      ...GROUP_ORDER.filter((g) => byGroup.has(g)),
      ...[...byGroup.keys()].filter((g) => !GROUP_ORDER.includes(g)),
    ];
    for (const g of orderedGroups) {
      groupsContainer.appendChild(buildGroupSection(g, byGroup.get(g)!));
    }
  });
}
