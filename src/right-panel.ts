import { api } from './api';
import { el, numberControl } from './controls';
import { captureFlatThumbnail } from './viewport';
import { estimateSheetSeconds, estimateTotalSeconds } from './machine-time';
import { addSnapshot, currentJobStore, generationStore, machineTimeStore, paramsStore, uiStore } from './state';
import type { JobRecord, Manifest, SheetManifest } from './types';

function fmt(n: number, decimals: number): string {
  return n.toFixed(decimals);
}

function buildManufacturabilityTable(manifest: Manifest): HTMLElement {
  const wrap = el('div', 'manuf-table-wrap');
  const table = el('table', 'manuf-table');
  const thead = el('thead');
  const headRow = el('tr');
  for (const h of ['sheet', 'pieces', 'smallest', 'neck', 'cut', 'engrave', 'fill']) {
    headRow.appendChild(el('th', undefined, h));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  for (const s of [...manifest.sheets].sort((a, b) => a.index - b.index)) {
    const row = el('tr', s.flags.length > 0 ? 'flagged-row' : undefined);
    row.appendChild(el('td', 'cell-label', `${s.index.toString().padStart(2, '0')}_${s.name}`));
    row.appendChild(el('td', 'cell-num', String(s.piece_count)));
    row.appendChild(el('td', 'cell-num', fmt(s.smallest_piece_mm2, 1)));
    row.appendChild(el('td', 'cell-num', fmt(s.narrowest_neck_mm, 2)));
    row.appendChild(el('td', 'cell-num', fmt(s.cut_length_mm / 1000, 2)));
    row.appendChild(el('td', 'cell-num', fmt(s.engrave_outline_mm / 1000, 2)));
    row.appendChild(el('td', 'cell-num', fmt(s.engrave_fill_mm2 / 100, 1)));
    row.addEventListener('click', () => {
      uiStore.update((st) => ({
        ...st,
        selectedSheet: st.selectedSheet === s.index ? null : s.index,
      }));
    });
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function buildMachineTime(sheets: SheetManifest[]): HTMLElement {
  const wrap = el('div', 'machine-time');
  wrap.appendChild(el('p', 'estimate-label', 'Machine time — estimate, provisional until calibrated against the real machine.'));

  const settings = machineTimeStore.get();
  const fieldsRow = el('div', 'machine-time-fields');

  const addField = (label: string, value: number, unit: string, onChange: (v: number) => void) => {
    const f = el('div', 'mt-field');
    f.appendChild(el('span', 'field-label', label));
    f.appendChild(numberControl({ value, unit, onChange }));
    fieldsRow.appendChild(f);
  };

  addField('cut speed', settings.cutSpeedMmPerS, 'mm/s', (v) =>
    machineTimeStore.update((s) => ({ ...s, cutSpeedMmPerS: v })),
  );
  addField('engrave speed', settings.engraveSpeedMmPerS, 'mm/s', (v) =>
    machineTimeStore.update((s) => ({ ...s, engraveSpeedMmPerS: v })),
  );
  addField('line step', settings.lineStepMm, 'mm', (v) =>
    machineTimeStore.update((s) => ({ ...s, lineStepMm: v })),
  );
  addField('overhead/path', settings.perPathOverheadS, 's', (v) =>
    machineTimeStore.update((s) => ({ ...s, perPathOverheadS: v })),
  );
  wrap.appendChild(fieldsRow);

  const totalLine = el('div', 'mt-total');
  wrap.appendChild(totalLine);

  const render = () => {
    const cur = machineTimeStore.get();
    const total = estimateTotalSeconds(sheets, cur);
    const perSheet = sheets
      .map((s) => `${s.name} ${fmt(estimateSheetSeconds(s, cur) / 60, 1)}min`)
      .join(' · ');
    totalLine.textContent = `≈ ${fmt(total / 60, 1)} min total (${perSheet})`;
  };
  render();
  machineTimeStore.subscribe(render, false);

  return wrap;
}

function buildDownloads(job: JobRecord): HTMLElement {
  const wrap = el('div', 'downloads');
  for (const f of job.files.filter((f) => f.name.endsWith('.svg'))) {
    const a = el('a', 'download-link', f.name) as HTMLAnchorElement;
    a.href = api.fileUrl(job.job_id, f.name);
    a.download = f.name;
    wrap.appendChild(a);
  }
  const zip = el('a', 'download-link download-zip', 'download all (.zip)') as HTMLAnchorElement;
  zip.href = api.archiveUrl(job.job_id);
  wrap.appendChild(zip);
  return wrap;
}

function buildStdoutBlock(job: JobRecord): HTMLElement {
  const details = el('details', 'stdout-block');
  const summary = el('summary', undefined, 'raw stdout');
  details.appendChild(summary);
  const pre = el('pre', 'stdout-pre', job.stdout || '(empty)');
  details.appendChild(pre);
  return details;
}

function buildFailureBlock(job: JobRecord, kind: 'error' | 'timeout'): HTMLElement {
  const wrap = el('div', 'failure-block');
  wrap.appendChild(
    el(
      'p',
      'failure-heading',
      kind === 'timeout' ? 'Generation timed out' : 'Generation failed',
    ),
  );
  if (kind === 'timeout') {
    wrap.appendChild(
      el(
        'p',
        'failure-sub',
        `Parameters were: lat=${job.params.lat}, lng=${job.params.lng}, radius=${job.params.radius}, size=${job.params.size}`,
      ),
    );
  }
  const pre = el('pre', 'stderr-pre', job.stderr || '(no stderr captured)');
  wrap.appendChild(pre);
  return wrap;
}

export function mountRightPanel(root: HTMLElement): void {
  root.innerHTML = '';

  const scroll = el('div', 'right-scroll');
  root.appendChild(scroll);

  const snapshotBtn = el('button', 'btn btn-secondary snapshot-btn', 'Freeze snapshot') as HTMLButtonElement;
  snapshotBtn.addEventListener('click', () => {
    const thumb = captureFlatThumbnail();
    if (thumb) addSnapshot(thumb, paramsStore.get());
  });
  root.insertBefore(snapshotBtn, scroll);

  function render(): void {
    scroll.innerHTML = '';
    const gen = generationStore.get();
    const job = currentJobStore.get();

    if (gen.kind === 'error') {
      scroll.appendChild(buildFailureBlock(gen.job, 'error'));
      return;
    }
    if (gen.kind === 'timeout') {
      scroll.appendChild(
        buildFailureBlock(
          {
            job_id: '',
            status: 'timeout',
            params: gen.params as Record<string, unknown>,
            created_at: '',
            duration_s: 0,
            manifest: null,
            files: [],
            stdout: '',
            stderr: '',
            returncode: null,
          },
          'timeout',
        ),
      );
      return;
    }
    if (!job || !job.manifest) {
      scroll.appendChild(
        el('p', 'report-empty', 'No successful run yet. The manufacturability report appears here once a job completes.'),
      );
      return;
    }

    scroll.appendChild(el('h3', 'report-heading', 'Manufacturability'));
    scroll.appendChild(buildManufacturabilityTable(job.manifest));
    scroll.appendChild(buildMachineTime(job.manifest.sheets));
    scroll.appendChild(el('h3', 'report-heading', 'Downloads'));
    scroll.appendChild(buildDownloads(job));
    scroll.appendChild(buildStdoutBlock(job));
  }

  render();
  generationStore.subscribe(render);
}
