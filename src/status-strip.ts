import { checkHealth } from './generate';
import { el } from './controls';
import { pruneRetiredPaths } from './paths';
import type { GenerateParamsBody } from './types';
import {
  healthStore,
  lastFromCacheStore,
  lastJobDurationStore,
  paramsStore,
  snapshotsStore,
  threeStatsStore,
  uiStore,
} from './state';

export function mountStatusStrip(root: HTMLElement): void {
  root.innerHTML = '';

  const healthEl = el('div', 'status-health');
  const durationEl = el('div', 'status-duration');
  const cacheEl = el('div', 'status-cache');
  const fpsEl = el('div', 'status-fps');
  const filmstrip = el('div', 'filmstrip');

  root.appendChild(healthEl);
  root.appendChild(durationEl);
  root.appendChild(cacheEl);
  root.appendChild(fpsEl);
  root.appendChild(filmstrip);

  function renderHealth(): void {
    const h = healthStore.get();
    healthEl.innerHTML = '';
    if (h.kind === 'checking') {
      healthEl.appendChild(el('span', 'dot dot-checking'));
      healthEl.appendChild(el('span', undefined, 'checking backend…'));
    } else if (h.kind === 'ok') {
      healthEl.appendChild(el('span', 'dot dot-ok'));
      healthEl.appendChild(el('span', undefined, `backend ok — ${h.health.jobs_count} jobs cached`));
    } else {
      healthEl.appendChild(el('span', 'dot dot-bad'));
      healthEl.appendChild(el('span', undefined, `backend unreachable at ${location.origin}${h.url}`));
      const retry = el('button', 'btn-inline-retry', 'retry') as HTMLButtonElement;
      retry.type = 'button';
      retry.addEventListener('click', () => checkHealth());
      healthEl.appendChild(retry);
      healthEl.appendChild(
        el(
          'span',
          'status-hint',
          ' — start it with: python run.py (from the workbench API repo)',
        ),
      );
    }
  }

  function renderDuration(): void {
    const d = lastJobDurationStore.get();
    durationEl.textContent = d == null ? 'no run yet' : `last run ${d.toFixed(1)}s`;
  }

  function renderCache(): void {
    cacheEl.textContent = lastFromCacheStore.get() ? 'from cache' : '';
  }

  function renderFps(): void {
    const s = threeStatsStore.get();
    fpsEl.textContent =
      s && uiStore.get().viewMode === 'stack' ? `${s.fps.toFixed(0)} fps · ${s.drawCalls} draw calls` : '';
  }

  function renderFilmstrip(): void {
    filmstrip.innerHTML = '';
    for (const snap of snapshotsStore.get()) {
      const thumb = el('img', 'filmstrip-thumb') as HTMLImageElement;
      thumb.src = snap.thumbnail;
      thumb.title = new Date(snap.createdAt).toLocaleTimeString();
      thumb.addEventListener('click', () => {
        paramsStore.set(
          pruneRetiredPaths(JSON.parse(JSON.stringify(snap.params))) as GenerateParamsBody,
        );
      });
      filmstrip.appendChild(thumb);
    }
  }

  healthStore.subscribe(renderHealth);
  lastJobDurationStore.subscribe(renderDuration);
  lastFromCacheStore.subscribe(renderCache);
  threeStatsStore.subscribe(renderFps);
  uiStore.subscribe(renderFps, false);
  snapshotsStore.subscribe(renderFilmstrip);
}
