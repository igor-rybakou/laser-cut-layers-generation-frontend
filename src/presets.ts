import { api } from './api';
import { el } from './controls';
import { paramsStore } from './state';
import { captureFlatThumbnail } from './viewport';
import type { GenerateParamsBody, PresetMap } from './types';

const THUMB_KEY = 'workbench.presetThumbnails';

function loadThumbs(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(THUMB_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveThumb(name: string, dataUrl: string): void {
  const thumbs = loadThumbs();
  thumbs[name] = dataUrl;
  try {
    localStorage.setItem(THUMB_KEY, JSON.stringify(thumbs));
  } catch {
    /* best effort */
  }
}

export function mountPresetsGallery(root: HTMLElement): void {
  const wrap = el('details', 'presets-gallery');
  wrap.open = true;
  wrap.appendChild(el('summary', 'group-summary', 'Presets'));

  const body = el('div', 'group-body');
  const grid = el('div', 'preset-grid');
  body.appendChild(grid);

  const saveRow = el('div', 'preset-save-row');
  const nameInput = el('input') as HTMLInputElement;
  nameInput.type = 'text';
  nameInput.placeholder = 'preset name';
  nameInput.className = 'ctl-text';
  const saveBtn = el('button', 'btn btn-secondary', 'Save current') as HTMLButtonElement;
  saveBtn.type = 'button';
  saveRow.appendChild(nameInput);
  saveRow.appendChild(saveBtn);
  body.appendChild(saveRow);

  wrap.appendChild(body);
  root.appendChild(wrap);

  async function refresh(): Promise<void> {
    grid.innerHTML = '';
    let presets: PresetMap = {};
    try {
      presets = await api.listPresets();
    } catch {
      grid.appendChild(el('p', 'preset-error', 'could not load presets'));
      return;
    }
    const thumbs = loadThumbs();
    const names = Object.keys(presets).sort();
    if (names.length === 0) {
      grid.appendChild(el('p', 'preset-empty', 'no presets saved yet'));
      return;
    }
    for (const name of names) {
      const card = el('div', 'preset-card');
      const img = el('div', 'preset-thumb') as HTMLDivElement;
      if (thumbs[name]) {
        img.style.backgroundImage = `url(${thumbs[name]})`;
      }
      card.appendChild(img);
      card.appendChild(el('div', 'preset-name', name));
      card.addEventListener('click', () => {
        paramsStore.set(JSON.parse(JSON.stringify(presets[name])) as GenerateParamsBody);
      });

      const delBtn = el('button', 'preset-delete', '×') as HTMLButtonElement;
      delBtn.type = 'button';
      delBtn.title = `delete ${name}`;
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await api.deletePreset(name);
        refresh();
      });
      card.appendChild(delBtn);

      grid.appendChild(card);
    }
  }

  saveBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) return;
    await api.putPreset(name, paramsStore.get());
    const thumb = captureFlatThumbnail();
    if (thumb) saveThumb(name, thumb);
    nameInput.value = '';
    refresh();
  });

  refresh();
}
