import './style.css';
import { api } from './api';
import { checkHealth } from './generate';
import { mountLeftPanel } from './left-panel';
import { mountRightPanel } from './right-panel';
import { mountStatusStrip } from './status-strip';
import { mountViewport } from './viewport';
import { schemaStore, uiStore } from './state';

function buildLayout(): {
  left: HTMLElement;
  center: HTMLElement;
  right: HTMLElement;
  strip: HTMLElement;
} {
  const app = document.getElementById('app')!;
  app.innerHTML = '';

  const body = document.createElement('div');
  body.className = 'app-body';
  app.appendChild(body);

  const left = document.createElement('aside');
  left.className = 'col-left';
  const leftToggle = document.createElement('button');
  leftToggle.className = 'col-toggle col-toggle-left';
  leftToggle.type = 'button';
  leftToggle.textContent = '‹';
  leftToggle.title = 'collapse parameters';

  const center = document.createElement('main');
  center.className = 'col-center';

  const right = document.createElement('aside');
  right.className = 'col-right';
  const rightToggle = document.createElement('button');
  rightToggle.className = 'col-toggle col-toggle-right';
  rightToggle.type = 'button';
  rightToggle.textContent = '›';
  rightToggle.title = 'collapse report';

  body.appendChild(left);
  body.appendChild(leftToggle);
  body.appendChild(center);
  body.appendChild(rightToggle);
  body.appendChild(right);

  const strip = document.createElement('footer');
  strip.className = 'status-strip';
  app.appendChild(strip);

  const applyCollapse = () => {
    const s = uiStore.get();
    left.classList.toggle('collapsed', s.leftCollapsed);
    right.classList.toggle('collapsed', s.rightCollapsed);
    leftToggle.textContent = s.leftCollapsed ? '›' : '‹';
    rightToggle.textContent = s.rightCollapsed ? '‹' : '›';
  };
  leftToggle.addEventListener('click', () =>
    uiStore.update((s) => ({ ...s, leftCollapsed: !s.leftCollapsed })),
  );
  rightToggle.addEventListener('click', () =>
    uiStore.update((s) => ({ ...s, rightCollapsed: !s.rightCollapsed })),
  );
  uiStore.subscribe(applyCollapse);

  return { left, center, right, strip };
}

async function bootstrap(): Promise<void> {
  const { left, center, right, strip } = buildLayout();

  mountLeftPanel(left);
  mountViewport(center);
  mountRightPanel(right);
  mountStatusStrip(strip);

  await checkHealth();
  try {
    const fields = await api.schema();
    schemaStore.set(fields);
  } catch {
    // Health check already surfaces "backend unreachable" in the status
    // strip; the schema fetch failing for the same reason needs no separate
    // report here.
  }
}

bootstrap();
