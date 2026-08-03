import { computeDefects, computeRemovedBanners } from './defects';
import { el } from './controls';
import { FlatView } from './flat-view';
import { ThreeView } from './three-view';
import { currentJobStore, generationStore, parsedSheetsStore, threeStatsStore, uiStore } from './state';
import type { DefectMarker } from './types';

let activeFlatView: FlatView | null = null;

export function captureFlatThumbnail(): string | null {
  if (!activeFlatView) return null;
  try {
    return activeFlatView.canvasEl().toDataURL('image/png');
  } catch {
    return null;
  }
}

function toolbarToggle(label: string, get: () => boolean, set: (v: boolean) => void, colorClass?: string): HTMLElement {
  const btn = el('button', `viewport-toggle${colorClass ? ' ' + colorClass : ''}`, label) as HTMLButtonElement;
  btn.type = 'button';
  const sync = () => btn.classList.toggle('active', get());
  sync();
  btn.addEventListener('click', () => {
    set(!get());
    sync();
  });
  return btn;
}

export function mountViewport(root: HTMLElement): void {
  root.innerHTML = '';

  const toolbar = el('div', 'viewport-toolbar');
  root.appendChild(toolbar);

  const modeToggle = el('div', 'view-mode-toggle');
  const flatBtn = el('button', 'btn-mode', 'Flat') as HTMLButtonElement;
  const stackBtn = el('button', 'btn-mode', 'Stack') as HTMLButtonElement;
  flatBtn.type = 'button';
  stackBtn.type = 'button';
  modeToggle.appendChild(flatBtn);
  modeToggle.appendChild(stackBtn);
  toolbar.appendChild(modeToggle);

  const layerToggles = el('div', 'toolbar-group');
  layerToggles.appendChild(
    toolbarToggle('cuts', () => uiStore.get().showCuts, (v) => uiStore.update((s) => ({ ...s, showCuts: v }))),
  );
  layerToggles.appendChild(
    toolbarToggle('engraves', () => uiStore.get().showEngraves, (v) => uiStore.update((s) => ({ ...s, showEngraves: v }))),
  );
  toolbar.appendChild(layerToggles);

  const defectToggles = el('div', 'toolbar-group');
  defectToggles.appendChild(
    toolbarToggle('narrow neck', () => uiStore.get().showNarrowNeck, (v) => uiStore.update((s) => ({ ...s, showNarrowNeck: v })), 'tone-alert'),
  );
  defectToggles.appendChild(
    toolbarToggle('tiny piece', () => uiStore.get().showTinyPiece, (v) => uiStore.update((s) => ({ ...s, showTinyPiece: v })), 'tone-signal'),
  );
  defectToggles.appendChild(
    toolbarToggle('out of bounds', () => uiStore.get().showOutOfBounds, (v) => uiStore.update((s) => ({ ...s, showOutOfBounds: v })), 'tone-magenta'),
  );
  toolbar.appendChild(defectToggles);

  const paletteSel = el('select', 'palette-select') as HTMLSelectElement;
  for (const p of ['birch', 'walnut', 'dark'] as const) {
    const opt = el('option', undefined, p) as HTMLOptionElement;
    opt.value = p;
    paletteSel.appendChild(opt);
  }
  paletteSel.value = uiStore.get().materialPalette;
  paletteSel.addEventListener('change', () => {
    uiStore.update((s) => ({ ...s, materialPalette: paletteSel.value as 'birch' | 'walnut' | 'dark' }));
    rebuild();
  });
  toolbar.appendChild(paletteSel);

  const stackControls = el('div', 'toolbar-group stack-only');
  const explodeWrap = el('label', 'explode-wrap');
  explodeWrap.appendChild(el('span', 'ctl-unit', 'explode'));
  const explodeSlider = el('input') as HTMLInputElement;
  explodeSlider.type = 'range';
  explodeSlider.min = '0';
  explodeSlider.max = '3';
  explodeSlider.step = '0.01';
  explodeSlider.value = String(uiStore.get().explode);
  explodeSlider.addEventListener('input', () => {
    uiStore.update((s) => ({ ...s, explode: parseFloat(explodeSlider.value) }));
  });
  explodeWrap.appendChild(explodeSlider);
  stackControls.appendChild(explodeWrap);

  const backlightBtn = toolbarToggle(
    'backlight',
    () => uiStore.get().backlightOn,
    (v) => uiStore.update((s) => ({ ...s, backlightOn: v })),
    'tone-led',
  );
  stackControls.appendChild(backlightBtn);
  const backlightSlider = el('input') as HTMLInputElement;
  backlightSlider.type = 'range';
  backlightSlider.min = '0';
  backlightSlider.max = '1';
  backlightSlider.step = '0.01';
  backlightSlider.value = String(uiStore.get().backlightIntensity);
  backlightSlider.addEventListener('input', () => {
    uiStore.update((s) => ({ ...s, backlightIntensity: parseFloat(backlightSlider.value) }));
  });
  stackControls.appendChild(backlightSlider);

  const viewBtns = el('div', 'toolbar-group');
  const topBtn = el('button', 'btn-view', 'top') as HTMLButtonElement;
  const frontBtn = el('button', 'btn-view', 'front') as HTMLButtonElement;
  const isoBtn = el('button', 'btn-view', '3/4') as HTMLButtonElement;
  [topBtn, frontBtn, isoBtn].forEach((b) => {
    b.type = 'button';
    viewBtns.appendChild(b);
  });
  stackControls.appendChild(viewBtns);
  toolbar.appendChild(stackControls);

  const banner = el('div', 'removed-banner-stack');
  root.appendChild(banner);

  const viewArea = el('div', 'view-area');
  root.appendChild(viewArea);

  let flat: FlatView | null = null;
  let three: ThreeView | null = null;

  function ensureViews(): void {
    if (!flat) {
      flat = new FlatView(viewArea);
      activeFlatView = flat;
    }
    if (!three) three = new ThreeView(viewArea);
  }

  function syncModeVisibility(): void {
    const mode = uiStore.get().viewMode;
    flatBtn.classList.toggle('active', mode === 'flat');
    stackBtn.classList.toggle('active', mode === 'stack');
    stackControls.classList.toggle('hidden', mode !== 'stack');
    if (flat) flat.canvasEl().style.display = mode === 'flat' ? 'block' : 'none';
    if (three) three.canvasEl().style.display = mode === 'stack' ? 'block' : 'none';
  }

  flatBtn.addEventListener('click', () => {
    uiStore.update((s) => ({ ...s, viewMode: 'flat' }));
    syncModeVisibility();
  });
  stackBtn.addEventListener('click', () => {
    uiStore.update((s) => ({ ...s, viewMode: 'stack' }));
    syncModeVisibility();
  });
  topBtn.addEventListener('click', () => three?.setViewTop());
  frontBtn.addEventListener('click', () => three?.setViewFront());
  isoBtn.addEventListener('click', () => three?.setViewThreeQuarter());

  let currentDefects: DefectMarker[] = [];

  function rebuild(): void {
    ensureViews();
    const job = currentJobStore.get();
    const sheets = parsedSheetsStore.get();
    const manifest = job?.manifest ?? null;

    // Populate the removed-by-filter banners first -- they occupy vertical
    // space above the view area, and FlatView's first-load fit-to-boundary
    // must measure the container after that space is accounted for.
    banner.innerHTML = '';
    if (manifest) {
      for (const b of computeRemovedBanners(manifest)) {
        const row = el(
          'div',
          'removed-banner',
          `${b.sheetName} — ${b.pieces} pieces removed, ${b.area_mm2.toFixed(1)} mm²`,
        );
        banner.appendChild(row);
      }
    }

    currentDefects = manifest ? computeDefects(manifest, sheets) : [];
    flat!.setData(sheets, manifest, currentDefects);
    three!.setData(sheets, manifest, currentDefects);
    syncModeVisibility();
  }

  generationStore.subscribe((s) => {
    if (s.kind === 'done') rebuild();
  });
  uiStore.subscribe(() => {
    ensureViews();
    flat?.render();
    three?.refreshUi();
    syncModeVisibility();
  });

  ensureViews();
  syncModeVisibility();

  setInterval(() => {
    if (three && uiStore.get().viewMode === 'stack') threeStatsStore.set(three.getStats());
  }, 500);
}
