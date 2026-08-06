import {
  booleanControl,
  checklistControl,
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
import {
  engraveColorCss,
  paletteEngraveColor,
  paletteSheetColor,
  PALETTES,
  sheetColorCss,
  type EngraveKind,
} from './materials';
import { getPath } from './paths';
import { searchPlace, type PlaceResult } from './place-search';
import { mountPresetsGallery } from './presets';
import { generationStore, paramsStore, schemaStore, uiStore } from './state';
import type { SchemaField } from './types';

const GROUP_ORDER = ['source', 'canvas', 'stack', 'manufacturability', 'roads', 'label'];
const GROUP_TITLES: Record<string, string> = {
  source: 'Source',
  canvas: 'Canvas',
  stack: 'Layers & stack',
  manufacturability: 'Manufacturability',
  roads: 'Roads',
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
  } else if (field.type === 'enum_list' && field.enum) {
    // `min` on an enum_list is a minimum *count*, not a numeric bound.
    ctl = checklistControl({
      options: field.enum.map((v) => ({ value: v })),
      value: Array.isArray(value) ? (value as string[]) : (field.enum ?? []),
      minSelected: field.min ?? 0,
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
    '.ctl-number, .ctl-toggle, .ctl-segmented, .ctl-text, .ctl-checklist',
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

// Schema field names this editor owns. Kept as names, not paths, because
// buildGroupSection filters generic rows by name.
const F_GREEN = 'include_green_layer'; // config.layers.include_green_layer
const F_BUILDINGS = 'buildings_enabled'; // config.buildings.enabled
const F_BUILDINGS_RENDER = 'buildings_render';
const F_ROAD_SHEETS = 'road_sheets'; // include_layers.roads (enum_list)

interface LayerCardSpec {
  key: string;
  // The manifest's own name for this sheet -- the key both colour maps and
  // both views resolve tints by, so it has to match `manifest.sheets[].name`.
  sheetName: string;
  title: string;
  index: string;
  // A sheet shows up to two colours and gets a swatch for each it has: `plate`
  // is the body tone (only sheets with a body, i.e. operation "cut"), `engrave`
  // is the burn tone plus which palette tone it defaults to. `land` has both.
  plate: boolean;
  engraveKind: EngraveKind | null;
  cutRule: string;
  engraves: string;
  positionNote: string;
  // Which schema field turns this sheet on, if any. Absent = always emitted.
  toggle: 'green' | 'buildings' | { roadSheet: string } | null;
  thicknessField: string | null; // schema field name, or null when positional
  roadSheet?: string;
}

// Cards are listed bottom of the glued stack first, matching
// manifest.stack_index. The generator is explicit about this order and about
// why it matters (mapgen/layers.py): base is the BOTTOM backing plate and
// carries no engraving at all -- roads, buildings and the label were all moved
// off it precisely because anything burned there ends up under the land plate
// and cannot be seen in the finished object.
function layerCards(roadSheets: string[]): LayerCardSpec[] {
  return [
    {
      key: 'base',
      sheetName: 'base',
      title: 'base',
      index: '00',
      plate: true,
      engraveKind: null,
      cutRule: 'boundary only',
      engraves: 'none — it is the bottom of the stack',
      positionNote: 'the backing plate everything else is glued to',
      toggle: null,
      thicknessField: 'thickness_mm_base',
    },
    {
      key: 'land',
      sheetName: 'land',
      title: 'land',
      index: '01',
      plate: true,
      engraveKind: 'text',
      cutRule: 'land ∩ boundary − water',
      engraves: 'the place label',
      positionNote:
        'always emitted and always the full plate, which is why the label lives here',
      toggle: null,
      thicknessField: 'thickness_mm_land',
    },
    {
      key: 'green',
      sheetName: 'green',
      title: 'green',
      index: '02',
      plate: true,
      engraveKind: null,
      cutRule: 'parks ∩ land',
      engraves: 'none',
      positionNote: 'also dropped by the generator if no park geometry survives filtering',
      toggle: 'green',
      thicknessField: 'thickness_mm_green',
    },
    {
      key: 'buildings',
      sheetName: 'buildings',
      title: 'buildings',
      index: '03',
      plate: false,
      engraveKind: 'building',
      cutRule: 'outer frame only (engraved sheet)',
      engraves: 'building blocks',
      positionNote:
        'off means the OSM building query — the slowest request in a run — is never issued',
      toggle: 'buildings',
      thicknessField: 'thickness_mm_buildings',
    },
    ...roadSheets.map((name, i) => ({
      key: `road_${name}`,
      sheetName: name,
      title: `roads · ${name}`,
      index: `0${4 + i}`,
      plate: false,
      engraveKind: 'road' as EngraveKind,
      cutRule: 'outer frame only (engraved sheet)',
      engraves: `${name} road classes`,
      positionNote: 'the detail you actually look at, so it sits on top',
      toggle: { roadSheet: name },
      thicknessField: null, // positional -- see roadThicknessField
      roadSheet: name,
    })) as LayerCardSpec[],
  ];
}

// Field names the layers editor renders itself -- buildGroupSection skips these
// so they don't also appear as generic rows underneath. Anything else the
// backend ever adds to the `stack` group still falls through to a generic row.
export function stackEditorOwnedFields(fields: SchemaField[]): Set<string> {
  const owned = new Set([
    F_GREEN,
    F_BUILDINGS,
    F_BUILDINGS_RENDER,
    F_ROAD_SHEETS,
    'thickness_mm_base',
    'thickness_mm_land',
    'thickness_mm_green',
    'thickness_mm_buildings',
  ]);
  // Road thickness descriptors are positional and get rebuilt here against the
  // *current* selection, so their as-shipped rows must not appear as well.
  for (const f of fields) if (f.name.startsWith('thickness_mm_road_')) owned.add(f.name);
  return owned;
}

// ---- include_layers.roads -------------------------------------------------

function shippedRoadSheets(field: SchemaField | undefined): string[] {
  return field?.enum ?? [];
}

function selectedRoadSheets(field: SchemaField | undefined): string[] {
  const shipped = shippedRoadSheets(field);
  const raw = getPath(paramsStore.get(), 'include_layers.roads');
  if (!Array.isArray(raw)) return shipped; // omitted = all of them
  const picked = shipped.filter((n) => raw.includes(n));
  // An empty or unrecognisable selection is read as "all": the backend refuses
  // an empty roads list outright, so it can never have meant zero sheets.
  return picked.length > 0 ? picked : shipped;
}

function setSelectedRoadSheets(field: SchemaField | undefined, names: string[]): void {
  const shipped = shippedRoadSheets(field);
  const ordered = shipped.filter((n) => names.includes(n));
  if (ordered.length === 0) return;
  updateParams((draft) => {
    if (ordered.length === shipped.length) {
      // All of them is the default. Omitting the key rather than sending the
      // full list keeps the body byte-identical to one that never touched it,
      // so the backend's param hash still hits the same cache entry.
      if (draft.include_layers) {
        delete draft.include_layers.roads;
        if (Object.keys(draft.include_layers).length === 0) delete draft.include_layers;
      }
      return;
    }
    draft.include_layers = { ...(draft.include_layers ?? {}), roads: ordered };
  });
}

// A road sheet's output index is positional over the *selected* sheets, so
// `thickness_mm.4` means "whichever road sheet comes first", not "wide". The
// descriptors ship at the all-selected positions; rebuild the path against the
// live selection instead of trusting the shipped one.
function roadThicknessField(
  fields: SchemaField[],
  sheet: string,
  position: number,
): SchemaField | undefined {
  const shipped = fields.find((f) => f.name.startsWith('thickness_mm_road_'));
  if (!shipped) return undefined;
  const baseIndex = parseInt(shipped.path.split('.').pop() ?? '4', 10);
  const firstName = shipped.name.slice('thickness_mm_road_'.length);
  const shippedOffset = shippedRoadSheets(fields.find((f) => f.name === F_ROAD_SHEETS)).indexOf(
    firstName,
  );
  const zero = baseIndex - Math.max(0, shippedOffset);
  return {
    ...shipped,
    name: `thickness_mm_road_${sheet}`,
    path: `config.material.thickness_mm.${zero + position}`,
  };
}

// ---- green / buildings ----------------------------------------------------

// Both are spelled two ways in the API -- config.layers.include_green_layer /
// include_layers.green, config.buildings.enabled / include_layers.buildings --
// and sending both spellings in one request is a 422 rather than a precedence
// rule. This app always writes the config key, so it also has to clear the
// alias, which an imported preset or an older persisted params blob may carry.
function setLayerFlag(field: SchemaField, alias: 'green' | 'buildings', value: boolean): void {
  setFieldValue(field, value);
  updateParams((draft) => {
    if (!draft.include_layers || draft.include_layers[alias] === undefined) return;
    delete draft.include_layers[alias];
    if (Object.keys(draft.include_layers).length === 0) delete draft.include_layers;
  });
}

function buildStackEditor(fields: SchemaField[]): HTMLElement {
  const wrap = el('div', 'stack-editor');
  wrap.appendChild(
    el(
      'p',
      'stack-editor-note',
      'Which optional sheets to emit. Roles, cut rules and stacking order are fixed by the generator — only inclusion, thickness and colour are yours. The square swatch is the sheet material, the round one is what is burned into it; both are preview aids that are never sent to the backend, and ↺ puts a sheet back on the palette.',
    ),
  );

  const greenField = fieldByName(fields, F_GREEN);
  const buildingsField = fieldByName(fields, F_BUILDINGS);
  const buildingsRenderField = fieldByName(fields, F_BUILDINGS_RENDER);
  const roadSheetsField = fieldByName(fields, F_ROAD_SHEETS);
  const shippedRoads = shippedRoadSheets(roadSheetsField);

  const head = el('div', 'stack-head');
  const count = el('span', 'stack-count');
  const total = el('span', 'stack-total');
  head.appendChild(count);
  head.appendChild(total);
  wrap.appendChild(head);

  const table = el('div', 'stack-table');
  wrap.appendChild(table);

  // Each card registers its own refresh closures; the two subscriptions at the
  // bottom drive them, so a preset load or snapshot restore updates the stack
  // editor exactly like it updates the generic rows. Params-driven and
  // ui-driven work are kept apart so dragging the explode slider (a uiStore
  // write per frame) does not re-read the whole params body.
  const paramRefreshers: (() => void)[] = [];
  const uiRefreshers: (() => void)[] = [];

  // A card whose switch the schema does not offer is dropped rather than
  // rendered with a checkbox that writes nowhere -- which is what an older
  // backend (no config.buildings, no include_layers.roads) looks like from
  // here. Road cards disappear on their own: shippedRoads is empty without
  // the descriptor.
  const cards = layerCards(shippedRoads).filter((spec) => {
    if (spec.toggle === 'green') return !!greenField;
    if (spec.toggle === 'buildings') return !!buildingsField;
    return true;
  });
  // Is this sheet switched on? Answered from the params body, never cached.
  const isOn = (spec: LayerCardSpec): boolean => {
    if (spec.toggle === null) return true;
    if (spec.toggle === 'green') return !greenField || Boolean(fieldValue(greenField));
    if (spec.toggle === 'buildings') return !!buildingsField && Boolean(fieldValue(buildingsField));
    return selectedRoadSheets(roadSheetsField).includes(spec.toggle.roadSheet);
  };
  // The thickness path of a road sheet depends on how many road sheets before
  // it are selected, so it is resolved per refresh rather than once.
  const thicknessFieldFor = (spec: LayerCardSpec): SchemaField | undefined => {
    if (spec.thicknessField) return fieldByName(fields, spec.thicknessField);
    if (!spec.roadSheet) return undefined;
    const position = selectedRoadSheets(roadSheetsField).indexOf(spec.roadSheet);
    if (position < 0) return undefined;
    return roadThicknessField(fields, spec.roadSheet, position);
  };

  // Displayed top of the stack first: that is the order you meet the sheets in
  // when you look at the finished object. The specs themselves are bottom-first
  // (stack_index order), so this is a reversed copy, not a different truth.
  for (const spec of [...cards].reverse()) {
    const card = el('div', 'stack-card');
    card.dataset.role = spec.sheetName;

    const header = el('div', 'stack-card-head');

    // ---- the include checkbox -------------------------------------------
    let box: HTMLInputElement | null = null;
    if (spec.toggle === null) {
      const always = el('span', 'stack-always', 'always');
      always.title = 'not selectable: base is the plate the stack is glued to, land carries the label';
      header.appendChild(always);
    } else {
      const checkWrap = el('label', 'ctl-check stack-check');
      box = el('input') as HTMLInputElement;
      box.type = 'checkbox';
      const toggle = spec.toggle;
      box.addEventListener('change', () => {
        if (toggle === 'green' && greenField) setLayerFlag(greenField, 'green', box!.checked);
        else if (toggle === 'buildings' && buildingsField)
          setLayerFlag(buildingsField, 'buildings', box!.checked);
        else if (typeof toggle === 'object') {
          const current = selectedRoadSheets(roadSheetsField);
          const next = box!.checked
            ? [...current, toggle.roadSheet]
            : current.filter((n) => n !== toggle.roadSheet);
          setSelectedRoadSheets(roadSheetsField, next);
        }
      });
      checkWrap.appendChild(box);
      header.appendChild(checkWrap);
    }

    const swatchSlot = el('div', 'stack-card-swatch');
    header.appendChild(swatchSlot);
    header.appendChild(el('span', 'stack-idx', spec.index));
    header.appendChild(el('span', 'stack-name', spec.title));
    const offTag = el('span', 'stack-off-tag', 'not emitted');
    header.appendChild(offTag);
    card.appendChild(header);

    const meta = el('div', 'stack-card-meta');
    meta.appendChild(el('span', 'stack-meta-key', 'cuts'));
    meta.appendChild(el('span', 'stack-meta-val', spec.cutRule));
    meta.appendChild(el('span', 'stack-meta-key', 'engraves'));
    meta.appendChild(el('span', 'stack-meta-val', spec.engraves));
    card.appendChild(meta);
    const note = el('p', 'stack-card-note', spec.positionNote);
    card.appendChild(note);

    const controls = el('div', 'stack-card-controls');
    card.appendChild(controls);

    // ---- colour swatches -------------------------------------------------
    // One per visible contribution: a plate gets a body tone, anything that
    // engraves gets a burn tone, and `land` gets both. Writing straight to
    // uiStore is what makes them live -- viewport.ts re-renders the flat
    // canvas and retints the 3D materials on every uiStore write, and
    // `<input type=color>` fires `input` continuously while the OS picker is
    // open, so the change lands before the picker is even dismissed.
    const addSwatch = (
      kind: 'plate' | 'engrave',
      read: (ui: ReturnType<typeof uiStore.get>) => { effective: string; base: string; pinned: string | null },
      write: (v: string | null) => void,
    ): void => {
      const initial = read(uiStore.get());
      const swatch: ColorControl = colorControl({
        value: initial.effective,
        overridden: initial.pinned != null,
        onChange: (v) => write(v),
        onReset: () => write(null),
      });
      swatch.classList.add(kind === 'plate' ? 'swatch-plate' : 'swatch-engrave');
      swatchSlot.appendChild(swatch);

      uiRefreshers.push(() => {
        const ui = uiStore.get();
        const { effective, base, pinned } = read(ui);
        // The card's left edge tracks the plate tone, or the burn tone for a
        // sheet that has no plate -- so the list reads as a stack of colours.
        if (kind === 'plate' || !spec.plate) card.style.borderLeftColor = effective;
        const what = kind === 'plate' ? 'material tint' : 'burn colour';
        swatch.sync(
          effective,
          pinned != null,
          pinned
            ? `${spec.title} ${what} ${pinned} — overriding ${ui.materialPalette} ${base}`
            : `${spec.title} ${what} — ${ui.materialPalette} ${base} (preview only)`,
        );
      });
    };

    const name = spec.sheetName;
    if (spec.plate) {
      addSwatch(
        'plate',
        (ui) => {
          const palette = PALETTES[ui.materialPalette];
          return {
            effective: sheetColorCss(palette, name, ui.sheetColors),
            base: paletteSheetColor(palette, name),
            pinned: ui.sheetColors[name] ?? null,
          };
        },
        (v) => uiStore.update((s) => ({ ...s, sheetColors: { ...s.sheetColors, [name]: v } })),
      );
    }
    const engraveKind = spec.engraveKind;
    if (engraveKind) {
      addSwatch(
        'engrave',
        (ui) => {
          const palette = PALETTES[ui.materialPalette];
          return {
            effective: engraveColorCss(palette, engraveKind, name, ui.engraveColors),
            base: paletteEngraveColor(palette, engraveKind),
            pinned: ui.engraveColors[name] ?? null,
          };
        },
        (v) => uiStore.update((s) => ({ ...s, engraveColors: { ...s.engraveColors, [name]: v } })),
      );
    }

    // ---- buildings render mode -------------------------------------------
    if (spec.key === 'buildings' && buildingsRenderField) {
      const row = el('div', 'stack-thickness-row');
      const label = el('span', 'field-label', 'render');
      label.title = buildingsRenderField.description;
      row.appendChild(label);
      const seg = enumControl({
        value: String(fieldValue(buildingsRenderField) ?? buildingsRenderField.enum?.[0] ?? 'fill'),
        options: buildingsRenderField.enum ?? ['fill', 'outline'],
        onChange: (v) => setFieldValue(buildingsRenderField, v),
      }) as HTMLElement & { setValue?: (v: string) => void };
      row.appendChild(seg);
      controls.appendChild(row);
      paramRefreshers.push(() => {
        seg.setValue?.(String(fieldValue(buildingsRenderField) ?? 'fill'));
      });
    }

    // ---- thickness + derived neck threshold ------------------------------
    const initialThickness = thicknessFieldFor(spec);
    if (initialThickness) {
      const row = el('div', 'stack-thickness-row');
      row.appendChild(el('span', 'field-label', 'thickness'));
      const ctl = numberControl({
        value: Number(fieldValue(initialThickness) ?? 3),
        min: initialThickness.min,
        max: initialThickness.max,
        unit: initialThickness.unit,
        // Resolved again on write: a road sheet's index moves when an earlier
        // road sheet is unchecked, and the value must follow it.
        onChange: (v) => {
          const f = thicknessFieldFor(spec);
          if (f) setFieldValue(f, v);
        },
      }) as HTMLElement & { setValue?: (v: number) => void };
      row.appendChild(ctl);
      controls.appendChild(row);

      const neck = el('div', 'stack-derived');
      controls.appendChild(neck);

      paramRefreshers.push(() => {
        const f = thicknessFieldFor(spec);
        const t = Number((f ? fieldValue(f) : undefined) ?? 3);
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
      const on = isOn(spec);
      card.classList.toggle('is-off', !on);
      // `inert` keeps a card for a sheet that will not be emitted out of the
      // tab order, rather than merely dimming it.
      if (on) controls.removeAttribute('inert');
      else controls.setAttribute('inert', '');
      offTag.style.display = on ? 'none' : '';

      if (!box) return;
      box.checked = on;
      // The backend refuses an empty include_layers.roads, so the last checked
      // road sheet locks instead of composing a request that can only 422.
      const lastRoad =
        typeof spec.toggle === 'object' && on && selectedRoadSheets(roadSheetsField).length <= 1;
      box.disabled = lastRoad;
      const checkWrap = box.parentElement;
      checkWrap?.classList.toggle('is-locked', lastRoad);
      if (checkWrap) {
        checkWrap.title = lastRoad
          ? 'at least one road sheet is required — the generator refuses an empty roads.sheets block'
          : '';
      }
    });

    table.appendChild(card);
  }

  paramRefreshers.push(() => {
    let sum = 0;
    let emitted = 0;
    for (const spec of cards) {
      if (!isOn(spec)) continue;
      emitted++;
      const f = thicknessFieldFor(spec);
      if (f) sum += Number(fieldValue(f) ?? 0);
    }
    count.textContent = `${emitted} of ${cards.length} sheets`;
    count.title =
      'green and buildings are dropped by the generator anyway when the site has no park / no building geometry, so this is an upper bound';
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
    owned = stackEditorOwnedFields(fields);
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
