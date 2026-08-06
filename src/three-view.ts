import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { engraveColorHex, PALETTES, sheetColorHex, type EngraveKind } from './materials';
import { uiStore } from './state';
import type { DefectMarker, Manifest, ParsedPath, ParsedSheet } from './types';

// Physical assembly order is `manifest.sheets[].stack_index` (0 = bottom of
// the glued stack) and nothing else -- not the filename, not `index`, and not
// a role list kept here. mapgen/layers.py states it outright ("Anything that
// composites sheets -- preview.py, the workbench -- must read this, not the
// filename") and the generator's own preview.py sorts by it. Getting it wrong
// buries engraving under an opaque plate, which has already shipped once.
//
// The current stack, for orientation only: base(0) is the BOTTOM backing
// plate the rest is glued to and carries no engraving at all; land(1) carries
// the label; green(2) the parks; buildings(3) and the road sheets(4+) are
// engraved sheets on top, where the detail is actually visible.
function stackOrder(manifest: Manifest, sheets: ParsedSheet[]): ParsedSheet[] {
  const positionOf = (s: ParsedSheet): number => {
    const sm = manifest.sheets.find((m) => m.index === s.index);
    return sm?.stack_index ?? sm?.index ?? s.index;
  };
  return [...sheets].sort((a, b) => positionOf(a) - positionOf(b));
}

const EXPLODE_GAP_MM = 25;
const ENGRAVE_DEPTH_MM = 0.4;
const ENGRAVE_LIFT_MM = 0.01;

interface SheetGroupEntry {
  sheet: ParsedSheet;
  // Which palette burn tone this sheet's merged engrave mesh defaults to.
  // Null when the sheet engraves nothing.
  engraveKind: EngraveKind | null;
  group: THREE.Group;
  bodyMesh: THREE.Mesh | null;
  engraveMesh: THREE.Mesh | null;
  bodyGeoms: THREE.BufferGeometry[];
  engraveGeoms: THREE.BufferGeometry[];
  baseZ: number; // cumulative real thickness (explode=0 position)
  thickness: number;
}

function pathToShape(path: ParsedPath, half: number): THREE.Shape {
  const toPt = (p: [number, number]) => new THREE.Vector2(p[0] - half, half - p[1]);
  const exterior = path.rings[0].points.map(toPt);
  const shape = new THREE.Shape(exterior);
  for (let i = 1; i < path.rings.length; i++) {
    shape.holes.push(new THREE.Path(path.rings[i].points.map(toPt)));
  }
  return shape;
}

function extrudeMerged(paths: ParsedPath[], half: number, depth: number): THREE.BufferGeometry[] {
  const geoms: THREE.BufferGeometry[] = [];
  for (const p of paths) {
    if (p.rings.length === 0) continue;
    const shape = pathToShape(p, half);
    geoms.push(new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 }));
  }
  return geoms;
}

// One merged engrave mesh per sheet means one tone per sheet, so pick the
// tone of whatever kind dominates it. In practice each sheet is single-kind
// (buildings sheet -> buildings, road sheets -> roads, land -> the label), and
// this stays honest if that ever stops being true.
function dominantEngraveKind(paths: ParsedPath[]): EngraveKind {
  const counts = { building: 0, road: 0, text: 0 };
  for (const p of paths) {
    if (p.group === 'engraves_building') counts.building++;
    else if (p.group === 'engraves_road') counts.road++;
    else if (p.group === 'engraves_text') counts.text++;
  }
  if (counts.building >= counts.road && counts.building >= counts.text) return 'building';
  return counts.road >= counts.text ? 'road' : 'text';
}

function markerTexture(color: string, label: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.beginPath();
  ctx.arc(20, 32, 12, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.font = '24px monospace';
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 40, 32);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

export class ThreeView {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private stackGroup: THREE.Group;
  private hemiLight: THREE.HemisphereLight;
  private dirLight: THREE.DirectionalLight;
  private backLight: THREE.PointLight;
  private groundPlane: THREE.Mesh;
  private ro: ResizeObserver;
  private raf = 0;

  private entries: SheetGroupEntry[] = [];
  private markerSprites: THREE.Sprite[] = [];
  private manifest: Manifest | null = null;
  private lastDrawCalls = 0;
  private lastFps = 0;
  private frameTimes: number[] = [];

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x101215);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    this.camera.position.set(250, 250, 250);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.49; // never view from below
    this.controls.minDistance = 20;
    this.controls.maxDistance = 2000;

    this.stackGroup = new THREE.Group();
    // Stacking axis is local Z while sheets are built; rotate -90 deg about X
    // so that stacking axis becomes world +Y (up). Negative scale is never
    // used anywhere in this class -- see brief's warning about winding.
    this.stackGroup.rotation.x = -Math.PI / 2;
    this.scene.add(this.stackGroup);

    this.hemiLight = new THREE.HemisphereLight(0xffffff, 0x30281c, 0.9);
    this.scene.add(this.hemiLight);

    this.dirLight = new THREE.DirectionalLight(0xffffff, 1.4);
    this.dirLight.position.set(150, 220, 150);
    this.dirLight.castShadow = true;
    this.dirLight.shadow.mapSize.set(1024, 1024);
    const d = 220;
    this.dirLight.shadow.camera.left = -d;
    this.dirLight.shadow.camera.right = d;
    this.dirLight.shadow.camera.top = d;
    this.dirLight.shadow.camera.bottom = -d;
    this.dirLight.shadow.camera.near = 10;
    this.dirLight.shadow.camera.far = 800;
    this.scene.add(this.dirLight);

    this.backLight = new THREE.PointLight(0x6fd8e8, 0, 800);
    this.scene.add(this.backLight);

    const groundGeom = new THREE.PlaneGeometry(2000, 2000);
    const groundMat = new THREE.ShadowMaterial({ opacity: 0.35 });
    this.groundPlane = new THREE.Mesh(groundGeom, groundMat);
    this.groundPlane.rotation.x = -Math.PI / 2;
    this.groundPlane.position.y = -1;
    this.groundPlane.receiveShadow = true;
    this.scene.add(this.groundPlane);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();

    uiStore.subscribe(() => this.applyUiState(), false);
    this.tick = this.tick.bind(this);
    this.tick();
  }

  private resize(): void {
    const rect = this.container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this.renderer.setSize(rect.width, rect.height);
    this.camera.aspect = rect.width / rect.height;
    this.camera.updateProjectionMatrix();
  }

  private tick(): void {
    this.raf = requestAnimationFrame(this.tick);
    const t0 = performance.now();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    const t1 = performance.now();
    this.frameTimes.push(t1 - t0);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
    const avgMs = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.lastFps = avgMs > 0 ? 1000 / avgMs : 0;
    this.lastDrawCalls = this.renderer.info.render.calls;
  }

  getStats(): { fps: number; drawCalls: number } {
    return { fps: this.lastFps, drawCalls: this.lastDrawCalls };
  }

  canvasEl(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  setViewTop(): void {
    this.animateCameraTo(new THREE.Vector3(0, 400, 0.01));
  }
  setViewFront(): void {
    this.animateCameraTo(new THREE.Vector3(0, 40, 400));
  }
  setViewThreeQuarter(): void {
    this.animateCameraTo(new THREE.Vector3(250, 250, 250));
  }

  private animateCameraTo(target: THREE.Vector3): void {
    const start = this.camera.position.clone();
    const startTime = performance.now();
    const duration = 400;
    const step = () => {
      const t = Math.min(1, (performance.now() - startTime) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      this.camera.position.lerpVectors(start, target, eased);
      this.controls.target.set(0, 0, 0);
      if (t < 1) requestAnimationFrame(step);
    };
    step();
  }

  private disposeEntries(): void {
    for (const e of this.entries) {
      e.bodyGeoms.forEach((g) => g.dispose());
      e.engraveGeoms.forEach((g) => g.dispose());
      e.bodyMesh?.geometry.dispose();
      (e.bodyMesh?.material as THREE.Material | undefined)?.dispose();
      e.engraveMesh?.geometry.dispose();
      (e.engraveMesh?.material as THREE.Material | undefined)?.dispose();
      this.stackGroup.remove(e.group);
    }
    this.entries = [];
    for (const s of this.markerSprites) {
      s.material.map?.dispose();
      s.material.dispose();
      s.parent?.remove(s);
    }
    this.markerSprites = [];
  }

  setData(sheets: ParsedSheet[], manifest: Manifest | null, defects: DefectMarker[]): void {
    this.disposeEntries();
    this.manifest = manifest;
    if (!manifest || sheets.length === 0) return;

    const half = manifest.canvas.size_mm / 2;
    const palette = PALETTES[uiStore.get().materialPalette];

    let cumulative = 0;
    for (const sheet of stackOrder(manifest, sheets)) {
      const sm = manifest.sheets.find((s) => s.index === sheet.index);
      const thickness = sm?.thickness_mm ?? 3;

      const cutsPaths = sheet.paths.filter((p) => p.group === 'cuts');
      const enginePaths = sheet.paths.filter((p) => p.group.startsWith('engraves_'));
      const engraveKind = enginePaths.length > 0 ? dominantEngraveKind(enginePaths) : null;

      // An `operation: "engrave"` sheet (buildings, roads) is a real sheet
      // with real thickness -- it keeps its slot in the stack -- but its
      // `cuts` group is only the sheet's outer frame. Extruding that frame
      // would put a solid disc over everything below it and there is nothing
      // cut through it to see the stack by, so it gets no body: same choice
      // the generator's preview.py makes by filling only land and green.
      const isEngraveSheet = (sm?.operation ?? 'cut') === 'engrave';
      const bodyGeoms = isEngraveSheet ? [] : extrudeMerged(cutsPaths, half, thickness);
      const engraveGeoms = extrudeMerged(enginePaths, half, ENGRAVE_DEPTH_MM);

      const group = new THREE.Group();
      group.position.z = cumulative;

      let bodyMesh: THREE.Mesh | null = null;
      if (bodyGeoms.length > 0) {
        const merged = mergeGeometries(bodyGeoms, false);
        const mat = new THREE.MeshStandardMaterial({
          color: sheetColorHex(palette, sheet.name, uiStore.get().sheetColors),
          roughness: 0.85,
          metalness: 0,
        });
        bodyMesh = new THREE.Mesh(merged, mat);
        bodyMesh.castShadow = true;
        bodyMesh.receiveShadow = true;
        group.add(bodyMesh);
      }

      let engraveMesh: THREE.Mesh | null = null;
      if (engraveGeoms.length > 0) {
        const merged = mergeGeometries(engraveGeoms, false);
        const mat = new THREE.MeshStandardMaterial({
          color: engraveColorHex(
            palette,
            engraveKind ?? 'building',
            sheet.name,
            uiStore.get().engraveColors,
          ),
          roughness: 0.85,
          metalness: 0,
        });
        engraveMesh = new THREE.Mesh(merged, mat);
        engraveMesh.position.z = thickness + ENGRAVE_LIFT_MM;
        engraveMesh.receiveShadow = true;
        group.add(engraveMesh);
      }

      this.stackGroup.add(group);
      this.entries.push({
        sheet,
        engraveKind,
        group,
        bodyMesh,
        engraveMesh,
        bodyGeoms,
        engraveGeoms,
        baseZ: cumulative,
        thickness,
      });

      cumulative += thickness;
    }

    this.buildMarkers(defects, half);
    this.applyUiState();
    this.applyExplode(uiStore.get().explode);
  }

  private buildMarkers(defects: DefectMarker[], half: number): void {
    for (const d of defects) {
      const entry = this.entries.find((e) => e.sheet.index === d.sheetIndex);
      if (!entry) continue;
      const color = d.kind === 'narrow_neck' ? '#ff5c47' : d.kind === 'tiny_piece' ? '#e8a33d' : '#e34fe0';
      const tex = markerTexture(color, d.label);
      const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(18, 4.5, 1);
      const topZ = entry.thickness + ENGRAVE_LIFT_MM * 2;
      sprite.position.set(d.x - half, half - d.y, topZ);
      sprite.userData.defectKind = d.kind;
      entry.group.add(sprite);
      this.markerSprites.push(sprite);
    }
  }

  applyExplode(explode: number): void {
    let cumulative = 0;
    for (const e of this.entries) {
      e.group.position.z = cumulative;
      cumulative += e.thickness + explode * EXPLODE_GAP_MM;
    }
  }

  private applyUiState(): void {
    const ui = uiStore.get();
    const palette = PALETTES[ui.materialPalette];
    for (const e of this.entries) {
      if (e.bodyMesh) {
        e.bodyMesh.visible = ui.showCuts;
        // Retint in place -- a palette switch or a layers-editor swatch change
        // must not force a re-extrude of the merged geometry. This runs on
        // every uiStore write, which is what makes the swatches live while the
        // OS colour picker is still open.
        (e.bodyMesh.material as THREE.MeshStandardMaterial).color.setHex(
          sheetColorHex(palette, e.sheet.name, ui.sheetColors),
        );
      }
      if (e.engraveMesh) {
        e.engraveMesh.visible = ui.showEngraves;
        (e.engraveMesh.material as THREE.MeshStandardMaterial).color.setHex(
          engraveColorHex(palette, e.engraveKind ?? 'building', e.sheet.name, ui.engraveColors),
        );
      }
      const dim = ui.selectedSheet != null && ui.selectedSheet !== e.sheet.index;
      const opacity = dim ? 0.25 : 1;
      const setOpacity = (mesh: THREE.Mesh | null) => {
        if (!mesh) return;
        const mat = mesh.material as THREE.MeshStandardMaterial;
        mat.transparent = dim;
        mat.opacity = opacity;
      };
      setOpacity(e.bodyMesh);
      setOpacity(e.engraveMesh);
    }
    for (const s of this.markerSprites) {
      const kind = s.userData.defectKind as DefectMarker['kind'];
      const visible =
        (kind === 'narrow_neck' && ui.showNarrowNeck) ||
        (kind === 'tiny_piece' && ui.showTinyPiece) ||
        (kind === 'out_of_bounds' && ui.showOutOfBounds);
      s.visible = visible;
    }
    this.applyExplode(ui.explode);
    this.backLight.intensity = ui.backlightOn ? ui.backlightIntensity * 4 : 0;
    this.hemiLight.intensity = ui.backlightOn ? 0.35 : 0.9;
    this.backLight.position.set(0, 60, -180);
  }

  refreshUi(): void {
    this.applyUiState();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.disposeEntries();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
