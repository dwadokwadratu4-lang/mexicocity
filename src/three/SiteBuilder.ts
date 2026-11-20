import * as THREE from 'three';
import type {
  BimObject,
  CommissioningPhase,
  HarmonogramData,
  LayerVisibility,
  ObjectProgressState,
} from '../types/bim';
import { calcRangeProgress, evaluateObjectState, parseDateMs } from '../utils/schedule';

export const GRID_TO_MARKER_SCALE = 0.06;

// Reusable scratch math objects (zero GC in animation loop)
const _projVec = new THREE.Vector3();

function bounceOut(t: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) {
    return n1 * t * t;
  } else if (t < 2 / d1) {
    const u = t - 1.5 / d1;
    return n1 * u * u + 0.75;
  } else if (t < 2.5 / d1) {
    const u = t - 2.25 / d1;
    return n1 * u * u + 0.9375;
  } else {
    const u = t - 2.625 / d1;
    return n1 * u * u + 0.984375;
  }
}

function createVoxelGridTexture(widthUnits: number, depthUnits: number): THREE.CanvasTexture {
  const pxPerUnit = 32;
  const canvas = document.createElement('canvas');
  canvas.width = widthUnits * pxPerUnit;
  canvas.height = depthUnits * pxPerUnit;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#474f48';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let gx = 0; gx < widthUnits; gx++) {
    for (let gz = 0; gz < depthUnits; gz++) {
      const checker = (gx + gz) % 2 === 0;
      ctx.fillStyle = checker ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.04)';
      ctx.fillRect(gx * pxPerUnit, gz * pxPerUnit, pxPerUnit, pxPerUnit);
    }
  }

  ctx.strokeStyle = 'rgba(226, 232, 240, 0.14)';
  ctx.lineWidth = 1;
  for (let gx = 0; gx <= widthUnits; gx++) {
    const x = gx * pxPerUnit + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  for (let gz = 0; gz <= depthUnits; gz++) {
    const y = gz * pxPerUnit + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

interface VehicleSim {
  group: THREE.Group;
  headLightMat: THREE.MeshStandardMaterial;
  mode: 'municipal' | 'internal_loop' | 'internal_spur';
  progress: number;
  speed: number;
  direction: 1 | -1;
  laneOffset: number;
  hornFlashRemaining: number;
}

export interface BuildingEntry {
  data: BimObject;
  root: THREE.Group;
  dropGroup: THREE.Group;
  shellGroup: THREE.Group;
  shellMeshes: THREE.Mesh[];
  shellMaterial: THREE.MeshStandardMaterial;
  baseShellColor: number;
  edgeMaterial: THREE.LineBasicMaterial;
  techColumn: THREE.Mesh;
  elecColumn: THREE.Mesh;
  hitBox: THREE.Mesh;
  footprintMesh: THREE.Mesh;
  selectionRing: THREE.LineLoop;
  indicatorGroup: THREE.Group;
  orangeArrow: THREE.Group;
  redArrow: THREE.Group;
  greenBeacon: THREE.Group;
  wasStarted: boolean;
  wasBudStarted: boolean;
  wasTechStarted: boolean;
  wasElecStarted: boolean;
  dropActive: boolean;
  dropElapsed: number;
  lastCommissioning: CommissioningPhase;
  arrowDropActive: boolean;
  arrowDropElapsed: number;
  flashRemaining: number;
  lastState: ObjectProgressState;
}

export interface ScreenLabelCoord {
  id: string;
  x: number;
  y: number;
  visible: boolean;
  overallPct: number;
  commissioning: CommissioningPhase;
}

export class BimSiteScene {
  public readonly root: THREE.Group;
  public readonly buildings: Map<string, BuildingEntry> = new Map();
  public readonly clickableMeshes: THREE.Object3D[] = [];

  private readonly data: HarmonogramData;
  private fenceSegments: THREE.Mesh[] = [];
  private roadSegments: THREE.Mesh[] = [];
  private roadMarkings: THREE.Mesh[] = [];
  private vehicles: VehicleSim[] = [];
  private vehicleGroup: THREE.Group;
  private disposables: Array<{ dispose: () => void }> = [];

  private currentOpacity = 0.7;
  private selectedId: string | null = null;
  private onDropCallback?: () => void;
  private onWorkStartCallback?: () => void;

  private readonly loopWaypoints: THREE.Vector2[] = [
    new THREE.Vector2(-9.5, -5.5),
    new THREE.Vector2(11.5, -5.5),
    new THREE.Vector2(11.5, 2.5),
    new THREE.Vector2(-9.5, 2.5),
  ];

  constructor(
    data: HarmonogramData,
    maxAnisotropy: number,
    onObjectDrop?: () => void,
    onWorkStart?: () => void,
  ) {
    this.data = data;
    this.onDropCallback = onObjectDrop;
    this.onWorkStartCallback = onWorkStart;
    this.root = new THREE.Group();
    this.vehicleGroup = new THREE.Group();

    this.buildTerrain(maxAnisotropy);
    this.buildVoxelForest();
    this.buildFence();
    this.buildRoads();
    this.buildVehicles();
    this.buildObjects();
  }

  private track<T extends { dispose: () => void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }

  private buildTerrain(maxAnisotropy: number) {
    const w = this.data.teren.siatkaSzerokosc;
    const d = this.data.teren.siatkaGlebokosc;

    const outerGeo = this.track(new THREE.BoxGeometry(w + 18, 0.24, d + 16));
    const outerMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x355232,
        roughness: 0.92,
        metalness: 0.02,
      }),
    );
    const outerBase = new THREE.Mesh(outerGeo, outerMat);
    outerBase.position.set(0, -0.16, 0);
    outerBase.receiveShadow = true;
    this.root.add(outerBase);

    const gridTex = this.track(createVoxelGridTexture(w, d));
    gridTex.anisotropy = maxAnisotropy;

    const siteGeo = this.track(new THREE.BoxGeometry(w, 0.18, d));
    const siteSideMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x333b37,
        roughness: 0.88,
        metalness: 0.05,
      }),
    );
    const siteTopMat = this.track(
      new THREE.MeshStandardMaterial({
        map: gridTex,
        roughness: 0.86,
        metalness: 0.04,
      }),
    );
    const siteSlab = new THREE.Mesh(siteGeo, [
      siteSideMat,
      siteSideMat,
      siteTopMat,
      siteSideMat,
      siteSideMat,
      siteSideMat,
    ]);
    siteSlab.position.set(0, -0.09, 0);
    siteSlab.receiveShadow = true;
    this.root.add(siteSlab);
  }

  private buildVoxelForest() {
    const treePositions: Array<{ x: number; z: number; scale: number; tint: number }> = [];

    let seed = 42197;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };

    const isInsideProtectedZone = (x: number, z: number) => {
      if (x >= -19.6 && x <= 19.8 && z >= -9.3 && z <= 9.3) return true;
      if (x >= 16.4 && x <= 19.6 && Math.abs(z) <= 10.2) return true;
      return false;
    };

    for (let gx = -27; gx <= 27; gx += 1.65) {
      for (let gz = -15.5; gz <= 15.5; gz += 1.65) {
        const jx = gx + (rand() - 0.5) * 0.9;
        const jz = gz + (rand() - 0.5) * 0.9;
        if (isInsideProtectedZone(jx, jz)) continue;
        if (rand() < 0.16) continue;
        treePositions.push({
          x: jx,
          z: jz,
          scale: 0.8 + rand() * 0.55,
          tint: rand(),
        });
      }
    }

    const count = treePositions.length;
    if (count === 0) return;

    const trunkGeo = this.track(new THREE.BoxGeometry(0.38, 1.0, 0.38));
    trunkGeo.translate(0, 0.5, 0);
    const trunkMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x6f4e37,
        roughness: 0.92,
        metalness: 0.0,
      }),
    );
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
    trunks.castShadow = true;
    trunks.receiveShadow = true;

    const cubeLeafGeo = this.track(new THREE.BoxGeometry(1.25, 1.05, 1.25));
    cubeLeafGeo.translate(0, 1.4, 0);
    const leafMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.82,
        metalness: 0.02,
      }),
    );
    const cubeLeaves = new THREE.InstancedMesh(cubeLeafGeo, leafMat, count);
    cubeLeaves.castShadow = true;
    cubeLeaves.receiveShadow = true;

    const pyramidGeo = this.track(new THREE.ConeGeometry(0.92, 1.35, 4));
    pyramidGeo.rotateY(Math.PI / 4);
    pyramidGeo.translate(0, 2.45, 0);
    const pyramidLeaves = new THREE.InstancedMesh(pyramidGeo, leafMat, count);
    pyramidLeaves.castShadow = true;
    pyramidLeaves.receiveShadow = true;

    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    const greens = [0x2d6a4f, 0x3b7a57, 0x40916c, 0x4c956c, 0x2a5c43];

    treePositions.forEach((p, i) => {
      dummy.position.set(p.x, -0.04, p.z);
      dummy.scale.set(p.scale, p.scale * (0.9 + p.tint * 0.25), p.scale);
      dummy.rotation.y = Math.floor(p.tint * 4) * (Math.PI / 2);
      dummy.updateMatrix();

      trunks.setMatrixAt(i, dummy.matrix);
      cubeLeaves.setMatrixAt(i, dummy.matrix);
      pyramidLeaves.setMatrixAt(i, dummy.matrix);

      const paletteHex = greens[Math.floor(p.tint * greens.length) % greens.length];
      color.setHex(paletteHex);
      cubeLeaves.setColorAt(i, color);
      color.offsetHSL(0, 0.02, 0.05);
      pyramidLeaves.setColorAt(i, color);
    });

    trunks.instanceMatrix.needsUpdate = true;
    cubeLeaves.instanceMatrix.needsUpdate = true;
    pyramidLeaves.instanceMatrix.needsUpdate = true;
    if (cubeLeaves.instanceColor) cubeLeaves.instanceColor.needsUpdate = true;
    if (pyramidLeaves.instanceColor) pyramidLeaves.instanceColor.needsUpdate = true;

    trunks.computeBoundingSphere();
    cubeLeaves.computeBoundingSphere();
    pyramidLeaves.computeBoundingSphere();

    this.root.add(trunks, cubeLeaves, pyramidLeaves);
  }

  private buildFence() {
    const h = this.data.teren.ogrodzenie.wysokosc;
    const fenceMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0xcbd5e1,
        roughness: 0.65,
        metalness: 0.25,
      }),
    );

    const addFenceSpan = (x: number, z: number, w: number, d: number) => {
      const geo = this.track(new THREE.BoxGeometry(w, h, d));
      geo.translate(0, h / 2, 0);
      const mesh = new THREE.Mesh(geo, fenceMat);
      mesh.position.set(x, 0, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.root.add(mesh);
      this.fenceSegments.push(mesh);
    };

    addFenceSpan(-1.1, -8.6, 35.4, 0.16);
    addFenceSpan(-1.1, 8.6, 35.4, 0.16);
    addFenceSpan(-18.8, 0, 0.16, 17.2);
    addFenceSpan(16.6, -5.4, 0.16, 6.4);
    addFenceSpan(16.6, 3.9, 0.16, 9.4);
  }

  private buildRoads() {
    const roadMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x374151,
        roughness: 0.88,
        metalness: 0.06,
      }),
    );
    const markingMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0xe2e8f0,
        roughness: 0.6,
        metalness: 0.05,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      }),
    );

    for (const road of this.data.teren.drogi) {
      const h = road.wysokosc;
      for (const seg of road.segmenty) {
        const geo = this.track(new THREE.BoxGeometry(seg.w, h, seg.d));
        geo.translate(0, h / 2, 0);
        const mesh = new THREE.Mesh(geo, roadMat);
        mesh.position.set(seg.x, 0, seg.z);
        mesh.receiveShadow = true;
        mesh.userData.roadStart = road.budowlane.start;
        mesh.userData.roadEnd = road.budowlane.koniec;
        this.root.add(mesh);
        this.roadSegments.push(mesh);

        const alongX = seg.w >= seg.d;
        const length = alongX ? seg.w : seg.d;
        const dashCount = Math.max(1, Math.floor(length / 1.4));
        for (let i = 0; i < dashCount; i++) {
          const offset = -length / 2 + ((i + 0.5) / dashCount) * length;
          const dashGeo = this.track(
            new THREE.BoxGeometry(alongX ? 0.6 : 0.1, 0.02, alongX ? 0.1 : 0.6),
          );
          const dash = new THREE.Mesh(dashGeo, markingMat);
          dash.position.set(
            seg.x + (alongX ? offset : 0),
            h + 0.01,
            seg.z + (alongX ? 0 : offset),
          );
          dash.userData.roadStart = road.budowlane.start;
          dash.userData.roadEnd = road.budowlane.koniec;
          this.root.add(dash);
          this.roadMarkings.push(dash);
        }
      }
    }
  }

  private createVoxelVehicle(
    bodyColorHex: number,
    vehicleIndex: number,
  ): { group: THREE.Group; headLightMat: THREE.MeshStandardMaterial } {
    const group = new THREE.Group();

    const bodyMat = this.track(
      new THREE.MeshStandardMaterial({
        color: bodyColorHex,
        roughness: 0.45,
        metalness: 0.2,
      }),
    );
    const cabMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0xf8fafc,
        roughness: 0.35,
        metalness: 0.15,
      }),
    );
    const wheelMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x111827,
        roughness: 0.9,
      }),
    );
    const headLightMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0xfef9c3,
        emissive: 0xfef08a,
        emissiveIntensity: 1.8,
        roughness: 0.2,
      }),
    );
    const tailLightMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0xfca5a5,
        emissive: 0xef4444,
        emissiveIntensity: 1.5,
        roughness: 0.2,
      }),
    );

    const chassis = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.42, 0.18, 0.78)),
      bodyMat,
    );
    chassis.position.set(0, 0.14, 0);
    chassis.castShadow = true;
    group.add(chassis);

    const cab = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.36, 0.15, 0.38)),
      cabMat,
    );
    cab.position.set(0, 0.3, 0.06);
    cab.castShadow = true;
    group.add(cab);

    const wheelGeo = this.track(new THREE.BoxGeometry(0.08, 0.12, 0.16));
    const wheelCoords: Array<[number, number]> = [
      [-0.21, 0.24],
      [0.21, 0.24],
      [-0.21, -0.24],
      [0.21, -0.24],
    ];
    for (const [wx, wz] of wheelCoords) {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.position.set(wx, 0.06, wz);
      group.add(wheel);
    }

    const lightGeo = this.track(new THREE.BoxGeometry(0.09, 0.06, 0.04));
    for (const lx of [-0.13, 0.13]) {
      const hl = new THREE.Mesh(lightGeo, headLightMat);
      hl.position.set(lx, 0.15, 0.4);
      group.add(hl);

      const tl = new THREE.Mesh(lightGeo, tailLightMat);
      tl.position.set(lx, 0.15, -0.4);
      group.add(tl);
    }

    // Generous invisible touch hit-box for tapping moving cars on mobile
    const hitGeo = this.track(new THREE.BoxGeometry(1.05, 0.75, 1.3));
    hitGeo.translate(0, 0.32, 0);
    const hitMat = this.track(new THREE.MeshBasicMaterial({ visible: false }));
    const hitBox = new THREE.Mesh(hitGeo, hitMat);
    hitBox.userData.kind = 'vehicle';
    hitBox.userData.vehicleIndex = vehicleIndex;
    group.add(hitBox);
    this.clickableMeshes.push(hitBox);

    return { group, headLightMat };
  }

  private buildVehicles() {
    this.root.add(this.vehicleGroup);

    const municipalSpecs: Array<{
      color: number;
      progress: number;
      speed: number;
      direction: 1 | -1;
      laneOffset: number;
    }> = [
      { color: 0xf59e0b, progress: 0.15, speed: 0.16, direction: 1, laneOffset: -0.45 },
      { color: 0x3b82f6, progress: 0.65, speed: 0.14, direction: 1, laneOffset: -0.45 },
      { color: 0xe11d48, progress: 0.4, speed: 0.18, direction: -1, laneOffset: 0.45 },
    ];
    for (const spec of municipalSpecs) {
      const idx = this.vehicles.length;
      const { group, headLightMat } = this.createVoxelVehicle(spec.color, idx);
      this.vehicleGroup.add(group);
      this.vehicles.push({
        group,
        headLightMat,
        mode: 'municipal',
        ...spec,
        hornFlashRemaining: 0,
      });
    }

    const internalSpecs: Array<{
      color: number;
      mode: 'internal_loop' | 'internal_spur';
      progress: number;
      speed: number;
    }> = [
      { color: 0xfacc15, mode: 'internal_loop', progress: 0.05, speed: 0.065 },
      { color: 0xf97316, mode: 'internal_loop', progress: 0.52, speed: 0.055 },
      { color: 0x38bdf8, mode: 'internal_spur', progress: 0.2, speed: 0.22 },
    ];
    for (const spec of internalSpecs) {
      const idx = this.vehicles.length;
      const { group, headLightMat } = this.createVoxelVehicle(spec.color, idx);
      this.vehicleGroup.add(group);
      this.vehicles.push({
        group,
        headLightMat,
        mode: spec.mode,
        progress: spec.progress,
        speed: spec.speed,
        direction: 1,
        laneOffset: 0,
        hornFlashRemaining: 0,
      });
    }
  }

  private createArrowMesh(colorHex: number): THREE.Group {
    const group = new THREE.Group();
    const mat = this.track(
      new THREE.MeshStandardMaterial({
        color: colorHex,
        emissive: colorHex,
        emissiveIntensity: 0.55,
        roughness: 0.3,
        metalness: 0.1,
      }),
    );

    const headGeo = this.track(new THREE.ConeGeometry(0.32, 0.45, 4));
    headGeo.rotateX(Math.PI);
    headGeo.rotateY(Math.PI / 4);
    const head = new THREE.Mesh(headGeo, mat);
    head.position.y = 0.22;
    group.add(head);

    const shaftGeo = this.track(new THREE.BoxGeometry(0.18, 0.42, 0.18));
    const shaft = new THREE.Mesh(shaftGeo, mat);
    shaft.position.y = 0.62;
    group.add(shaft);

    return group;
  }

  private createGreenBeacon(): THREE.Group {
    const group = new THREE.Group();
    const mat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x22c55e,
        emissive: 0x16a34a,
        emissiveIntensity: 0.5,
        roughness: 0.25,
        metalness: 0.15,
      }),
    );

    const shortArm = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.16, 0.34, 0.16)),
      mat,
    );
    shortArm.position.set(-0.14, 0.24, 0);
    shortArm.rotation.z = Math.PI / 4;

    const longArm = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.16, 0.62, 0.16)),
      mat,
    );
    longArm.position.set(0.12, 0.36, 0);
    longArm.rotation.z = -Math.PI / 4;

    group.add(shortArm, longArm);
    return group;
  }

  private buildObjects() {
    const techMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x2563eb,
        emissive: 0x1d4ed8,
        emissiveIntensity: 0.28,
        roughness: 0.35,
        metalness: 0.15,
      }),
    );

    const elecMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x16a34a,
        emissive: 0x15803d,
        emissiveIntensity: 0.28,
        roughness: 0.35,
        metalness: 0.15,
      }),
    );

    const footprintMat = this.track(
      new THREE.MeshBasicMaterial({
        color: 0x94a3b8,
        transparent: true,
        opacity: 0.2,
        depthWrite: false,
      }),
    );

    // 0.46 x 0.46 interior columns (normalized height 1.0, bottom at y = 0)
    const colGeo = this.track(new THREE.BoxGeometry(0.46, 1, 0.46));
    colGeo.translate(0, 0.5, 0);

    for (const obj of this.data.obiekty) {
      const objRoot = new THREE.Group();
      objRoot.position.set(obj.x, 0, obj.z);

      const fpGeo = this.track(new THREE.PlaneGeometry(obj.w * 0.98, obj.d * 0.98));
      fpGeo.rotateX(-Math.PI / 2);
      const footprintMesh = new THREE.Mesh(fpGeo, footprintMat);
      footprintMesh.position.y = 0.012;
      objRoot.add(footprintMesh);

      const hw = obj.w / 2 + 0.12;
      const hd = obj.d / 2 + 0.12;
      const ringGeo = this.track(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(-hw, 0.04, -hd),
          new THREE.Vector3(hw, 0.04, -hd),
          new THREE.Vector3(hw, 0.04, hd),
          new THREE.Vector3(-hw, 0.04, hd),
        ]),
      );
      const ringMat = this.track(
        new THREE.LineBasicMaterial({ color: 0xf59e0b }),
      );
      const selectionRing = new THREE.LineLoop(ringGeo, ringMat);
      selectionRing.visible = false;
      objRoot.add(selectionRing);

      const dropGroup = new THREE.Group();
      objRoot.add(dropGroup);

      const isOffice = obj.id === 'BIURO';
      const baseShellColor = isOffice
        ? 0xe2e8f0
        : obj.typ === 'container'
          ? 0xd9cbb5
          : 0xe4d5bc;

      const shellMaterial = this.track(
        new THREE.MeshStandardMaterial({
          color: baseShellColor,
          roughness: 0.72,
          metalness: 0.05,
          transparent: true,
          opacity: this.currentOpacity,
          depthWrite: this.currentOpacity >= 0.98,
        }),
      );
      const edgeMaterial = this.track(
        new THREE.LineBasicMaterial({
          color: obj.typ === 'container' ? 0x334155 : 0x78716c,
          transparent: true,
          opacity: 0.85,
        }),
      );

      const shellGroup = new THREE.Group();
      const shellMeshes: THREE.Mesh[] = [];

      if (obj.typ === 'container') {
        // Modular container cubes normalized so total unscaled height of shellGroup = 1.0
        const nx = Math.max(1, Math.round(obj.w));
        const nz = Math.max(1, Math.round(obj.d));
        const unitW = obj.w / nx;
        const unitD = obj.d / nz;
        const ny = obj.h >= 1.0 ? Math.round(obj.h / 0.5) : 1;
        const normUnitH = 1.0 / ny;

        const modGeo = this.track(
          new THREE.BoxGeometry(unitW * 0.96, normUnitH, unitD * 0.96),
        );
        const modEdges = this.track(new THREE.EdgesGeometry(modGeo));

        for (let ix = 0; ix < nx; ix++) {
          for (let iz = 0; iz < nz; iz++) {
            for (let iy = 0; iy < ny; iy++) {
              const cx = -obj.w / 2 + (ix + 0.5) * unitW;
              const cz = -obj.d / 2 + (iz + 0.5) * unitD;
              const cy = (iy + 0.5) * normUnitH;

              const modMesh = new THREE.Mesh(modGeo, shellMaterial);
              modMesh.position.set(cx, cy, cz);
              modMesh.castShadow = true;
              modMesh.receiveShadow = true;

              const lines = new THREE.LineSegments(modEdges, edgeMaterial);
              modMesh.add(lines);

              shellGroup.add(modMesh);
              shellMeshes.push(modMesh);
            }
          }
        }
      } else if (obj.typ === 'chimney') {
        const cylGeo = this.track(new THREE.CylinderGeometry(0.32, 0.45, 1.0, 8));
        cylGeo.translate(0, 0.5, 0);
        const cylMesh = new THREE.Mesh(cylGeo, shellMaterial);
        cylMesh.castShadow = true;
        cylMesh.receiveShadow = true;

        const edges = new THREE.LineSegments(
          this.track(new THREE.EdgesGeometry(cylGeo, 20)),
          edgeMaterial,
        );
        cylMesh.add(edges);

        const baseGeo = this.track(new THREE.BoxGeometry(0.95, 0.14, 0.95));
        baseGeo.translate(0, 0.07, 0);
        const baseMesh = new THREE.Mesh(baseGeo, shellMaterial);
        baseMesh.add(
          new THREE.LineSegments(
            this.track(new THREE.EdgesGeometry(baseGeo)),
            edgeMaterial,
          ),
        );

        shellGroup.add(cylMesh, baseMesh);
        shellMeshes.push(cylMesh, baseMesh);
      } else {
        const boxGeo = this.track(new THREE.BoxGeometry(obj.w, 1.0, obj.d));
        boxGeo.translate(0, 0.5, 0);
        const boxMesh = new THREE.Mesh(boxGeo, shellMaterial);
        boxMesh.castShadow = true;
        boxMesh.receiveShadow = true;

        const edges = new THREE.LineSegments(
          this.track(new THREE.EdgesGeometry(boxGeo)),
          edgeMaterial,
        );
        boxMesh.add(edges);

        shellGroup.add(boxMesh);
        shellMeshes.push(boxMesh);
      }

      dropGroup.add(shellGroup);

      // Two adjacent interior columns at exact floor center (0.5 x 0.5 footprint each)
      const techColumn = new THREE.Mesh(colGeo, techMat);
      techColumn.position.set(-0.24, 0, 0);
      techColumn.castShadow = true;

      const elecColumn = new THREE.Mesh(colGeo, elecMat);
      elecColumn.position.set(0.24, 0, 0);
      elecColumn.castShadow = true;

      if (!isOffice) {
        dropGroup.add(techColumn, elecColumn);
      }

      const hitGeo = this.track(
        new THREE.BoxGeometry(
          Math.max(obj.w, 1.1),
          Math.max(obj.h, 0.9),
          Math.max(obj.d, 1.1),
        ),
      );
      hitGeo.translate(0, Math.max(obj.h, 0.9) / 2, 0);
      const hitMat = this.track(new THREE.MeshBasicMaterial({ visible: false }));
      const hitBox = new THREE.Mesh(hitGeo, hitMat);
      hitBox.userData.kind = 'building';
      hitBox.userData.objectId = obj.id;
      objRoot.add(hitBox);
      this.clickableMeshes.push(hitBox);

      const indicatorGroup = new THREE.Group();
      indicatorGroup.position.set(0, obj.h + 0.6, 0);
      const orangeArrow = this.createArrowMesh(0xf97316);
      const redArrow = this.createArrowMesh(0xef4444);
      const greenBeacon = this.createGreenBeacon();
      orangeArrow.visible = false;
      redArrow.visible = false;
      greenBeacon.visible = false;
      indicatorGroup.add(orangeArrow, redArrow, greenBeacon);
      dropGroup.add(indicatorGroup);

      this.root.add(objRoot);

      this.buildings.set(obj.id, {
        data: obj,
        root: objRoot,
        dropGroup,
        shellGroup,
        shellMeshes,
        shellMaterial,
        baseShellColor,
        edgeMaterial,
        techColumn,
        elecColumn,
        hitBox,
        footprintMesh,
        selectionRing,
        indicatorGroup,
        orangeArrow,
        redArrow,
        greenBeacon,
        wasStarted: false,
        wasBudStarted: false,
        wasTechStarted: false,
        wasElecStarted: false,
        dropActive: false,
        dropElapsed: 0,
        lastCommissioning: 'none',
        arrowDropActive: false,
        arrowDropElapsed: 0,
        flashRemaining: 0,
        lastState: {
          budPct: 0,
          techPct: 0,
          elecPct: 0,
          overallPct: 0,
          hasStarted: false,
          commissioning: 'none',
        },
      });
    }
  }

  public setSelectedObject(id: string | null) {
    this.selectedId = id;
    for (const [key, entry] of this.buildings.entries()) {
      entry.selectionRing.visible = key === id;
    }
  }

  public triggerOfficeAlarm(id: string) {
    const entry = this.buildings.get(id);
    if (!entry) return;
    entry.flashRemaining = 1.0;
  }

  public triggerVehicleHorn(vehicleIndex: number) {
    const v = this.vehicles[vehicleIndex];
    if (!v) return;
    v.hornFlashRemaining = 0.4;
  }

  public setBuildingTransparency(transparencyPct: number) {
    const opacity = THREE.MathUtils.clamp(1 - transparencyPct / 100, 0, 1);
    this.currentOpacity = opacity;
    for (const entry of this.buildings.values()) {
      entry.shellMaterial.opacity = opacity;
      entry.shellMaterial.depthWrite = opacity >= 0.96;
      entry.edgeMaterial.opacity = Math.max(0.28, opacity * 0.9);
    }
  }

  public updateSchedule(
    currentMs: number,
    layers: LayerVisibility,
    allowDropFeedback: boolean,
  ) {
    const fencePct = calcRangeProgress(currentMs, this.data.teren.ogrodzenie.budowlane);
    for (const seg of this.fenceSegments) {
      seg.visible = fencePct > 0;
      seg.scale.y = Math.max(0.01, fencePct);
    }

    let roadsFinished = true;
    for (const road of this.data.teren.drogi) {
      if (currentMs <= parseDateMs(road.budowlane.koniec)) {
        roadsFinished = false;
      }
    }
    for (const seg of this.roadSegments) {
      const pct = calcRangeProgress(currentMs, {
        start: seg.userData.roadStart,
        koniec: seg.userData.roadEnd,
      });
      seg.visible = pct > 0;
      seg.scale.y = Math.max(0.01, pct);
    }
    for (const dash of this.roadMarkings) {
      const pct = calcRangeProgress(currentMs, {
        start: dash.userData.roadStart,
        koniec: dash.userData.roadEnd,
      });
      dash.visible = pct >= 0.85;
    }

    const roadsBuiltAfterMs = parseDateMs('2027-01-22');
    this.vehicleGroup.visible = currentMs > roadsBuiltAfterMs && roadsFinished;

    let triggeredAnyDrop = false;
    let triggeredAnyWorkStart = false;

    for (const entry of this.buildings.values()) {
      const state = evaluateObjectState(entry.data, currentMs, this.data);
      entry.lastState = state;

      // Track individual discipline starts for light chime
      const budActive = state.budPct > 0;
      const techActive = state.techPct > 0;
      const elecActive = state.elecPct > 0;

      if (
        (budActive && !entry.wasBudStarted) ||
        (techActive && !entry.wasTechStarted) ||
        (elecActive && !entry.wasElecStarted)
      ) {
        triggeredAnyWorkStart = true;
      }
      entry.wasBudStarted = budActive;
      entry.wasTechStarted = techActive;
      entry.wasElecStarted = elecActive;

      // Detect initial building appearance for drop-from-sky bounce
      if (state.hasStarted && !entry.wasStarted) {
        entry.wasStarted = true;
        if (allowDropFeedback) {
          entry.dropActive = true;
          entry.dropElapsed = 0;
          entry.dropGroup.position.y = 7.0;
          triggeredAnyDrop = true;
        } else {
          entry.dropActive = false;
          entry.dropGroup.position.y = 0;
        }
      } else if (!state.hasStarted) {
        entry.wasStarted = false;
        entry.dropActive = false;
        entry.dropGroup.position.y = 0;
      }

      // Detect commissioning arrow activation to smoothly drop from sky
      if (state.commissioning !== entry.lastCommissioning) {
        entry.lastCommissioning = state.commissioning;
        if (
          state.commissioning === 'rozruch_zimny' ||
          state.commissioning === 'rozruch_goracy'
        ) {
          entry.arrowDropActive = true;
          entry.arrowDropElapsed = 0;
          entry.indicatorGroup.position.y = entry.data.h + 0.6 + 10.5;
        } else {
          entry.arrowDropActive = false;
          entry.indicatorGroup.position.y = entry.data.h + 0.6;
        }
      }

      entry.root.visible =
        state.hasStarted || !(entry.data.demontaz && currentMs >= parseDateMs(entry.data.demontaz));
      entry.dropGroup.visible = state.hasStarted;
      entry.footprintMesh.visible =
        state.hasStarted
          ? entry.data.id === this.selectedId
          : !(entry.data.demontaz && currentMs >= parseDateMs(entry.data.demontaz));

      const showShell =
        layers.budowlane && state.budPct > 0 && this.currentOpacity > 0.015;
      for (const m of entry.shellMeshes) {
        m.visible = showShell;
      }
      entry.shellGroup.visible = layers.budowlane && state.budPct > 0;
      entry.shellGroup.scale.y = Math.max(0.005, state.budPct * entry.data.h);

      // Strictly clamp interior columns <= building height h (minus 0.004 to prevent roof z-fighting/protrusion)
      const maxColHeight = Math.max(0.01, entry.data.h - 0.004);
      const isOffice = entry.data.id === 'BIURO';

      entry.techColumn.visible = !isOffice && layers.technologia && state.techPct > 0;
      entry.techColumn.scale.y = Math.min(
        maxColHeight,
        Math.max(0.005, state.techPct * maxColHeight),
      );

      entry.elecColumn.visible = !isOffice && layers.elektryka && state.elecPct > 0;
      entry.elecColumn.scale.y = Math.min(
        maxColHeight,
        Math.max(0.005, state.elecPct * maxColHeight),
      );

      entry.orangeArrow.visible = state.commissioning === 'rozruch_zimny';
      entry.redArrow.visible = state.commissioning === 'rozruch_goracy';
      entry.greenBeacon.visible = state.commissioning === 'zakonczenie';
    }

    if (allowDropFeedback) {
      if (triggeredAnyDrop) {
        this.onDropCallback?.();
      }
      if (triggeredAnyWorkStart) {
        this.onWorkStartCallback?.();
      }
    }
  }

  public tickAnimations(delta: number, elapsed: number) {
    for (const entry of this.buildings.values()) {
      // 1. Building drop-from-sky bounce
      if (entry.dropActive) {
        entry.dropElapsed += delta;
        const duration = 0.58;
        const t = Math.min(1, entry.dropElapsed / duration);
        const eased = bounceOut(t);
        entry.dropGroup.position.y = (1 - eased) * 7.0;
        if (t >= 1) {
          entry.dropActive = false;
          entry.dropGroup.position.y = 0;
        }
      }

      // 2. BIURO 1-second bright red siren pulse
      if (entry.flashRemaining > 0) {
        entry.flashRemaining = Math.max(0, entry.flashRemaining - delta);
        if (entry.flashRemaining > 0) {
          const pulse = 0.55 + 0.45 * Math.sin(elapsed * 26);
          entry.shellMaterial.color.setHex(0xff2424);
          entry.shellMaterial.emissive.setHex(0xef4444);
          entry.shellMaterial.emissiveIntensity = 0.45 + pulse * 0.75;
        } else {
          entry.shellMaterial.color.setHex(entry.baseShellColor);
          entry.shellMaterial.emissive.setHex(0x000000);
          entry.shellMaterial.emissiveIntensity = 0;
        }
      }

      // 3. Commissioning arrows smooth descent from sky + hover pulse
      if (
        entry.orangeArrow.visible ||
        entry.redArrow.visible ||
        entry.greenBeacon.visible
      ) {
        if (entry.arrowDropActive) {
          const arrowDropDuration = 1.35;
          entry.arrowDropElapsed += delta;
          const t = Math.min(1, entry.arrowDropElapsed / arrowDropDuration);
          // Smooth cubic ease-out braking right above the roof
          const eased = 1 - Math.pow(1 - t, 3);
          entry.indicatorGroup.position.y =
            entry.data.h + 0.6 + (1 - eased) * 10.5;
          entry.indicatorGroup.scale.setScalar(1.0);
          if (t >= 1) {
            entry.arrowDropActive = false;
          }
        } else {
          const bob = Math.sin(elapsed * 4.2 + entry.data.x * 0.5) * 0.14;
          const pulse = 1 + Math.sin(elapsed * 5.0 + entry.data.z) * 0.08;
          entry.indicatorGroup.position.y = entry.data.h + 0.6 + bob;
          entry.indicatorGroup.scale.setScalar(pulse);
          if (entry.greenBeacon.visible) {
            entry.greenBeacon.rotation.y = elapsed * 1.4;
          }
        }
      }
    }

    // 4. Vehicles movement + horn headlight flash
    if (this.vehicleGroup.visible) {
      for (const v of this.vehicles) {
        v.progress = (v.progress + delta * v.speed) % 1;

        if (v.hornFlashRemaining > 0) {
          v.hornFlashRemaining = Math.max(0, v.hornFlashRemaining - delta);
          v.headLightMat.emissiveIntensity =
            v.hornFlashRemaining > 0 ? 4.5 : 1.8;
        }

        if (v.mode === 'municipal') {
          const zStart = v.direction === 1 ? -8.5 : 8.5;
          const zEnd = v.direction === 1 ? 8.5 : -8.5;
          const z = THREE.MathUtils.lerp(zStart, zEnd, v.progress);
          v.group.position.set(18.0 + v.laneOffset, 0.25, z);
          v.group.rotation.y = v.direction === 1 ? 0 : Math.PI;
        } else if (v.mode === 'internal_spur') {
          const ping = v.progress < 0.5 ? v.progress * 2 : (1 - v.progress) * 2;
          const goingEast = v.progress < 0.5;
          const x = THREE.MathUtils.lerp(11.5, 17.2, ping);
          v.group.position.set(x, 0.25, -1.5 + (goingEast ? 0.18 : -0.18));
          v.group.rotation.y = goingEast ? Math.PI / 2 : -Math.PI / 2;
        } else {
          const pts = this.loopWaypoints;
          const totalLen = 58;
          let dist = v.progress * totalLen;
          let segIdx = 0;
          const segLens = [21, 8, 21, 8];
          for (let i = 0; i < 4; i++) {
            if (dist <= segLens[i] || i === 3) {
              segIdx = i;
              break;
            }
            dist -= segLens[i];
          }
          const p0 = pts[segIdx];
          const p1 = pts[(segIdx + 1) % 4];
          const t = THREE.MathUtils.clamp(dist / segLens[segIdx], 0, 1);
          const x = THREE.MathUtils.lerp(p0.x, p1.x, t);
          const z = THREE.MathUtils.lerp(p0.y, p1.y, t);
          v.group.position.set(x, 0.25, z);
          v.group.rotation.y = Math.atan2(p1.x - p0.x, p1.y - p0.y);
        }
      }
    }
  }

  public projectLabels(
    camera: THREE.Camera,
    canvasW: number,
    canvasH: number,
    viewportW: number,
    viewportH: number,
    out: ScreenLabelCoord[],
  ) {
    const offsetX = (viewportW - canvasW) * 0.5;
    const offsetY = (viewportH - canvasH) * 0.5;

    let idx = 0;
    for (const entry of this.buildings.values()) {
      const target = out[idx] ?? {
        id: entry.data.id,
        x: 0,
        y: 0,
        visible: false,
        overallPct: 0,
        commissioning: 'none' as CommissioningPhase,
      };
      out[idx] = target;
      idx++;

      target.id = entry.data.id;
      target.overallPct = Math.round(entry.lastState.overallPct * 100);
      target.commissioning = entry.lastState.commissioning;

      if (!entry.lastState.hasStarted) {
        target.visible = false;
        continue;
      }

      _projVec.set(0, entry.data.h + 0.3, 0);
      entry.dropGroup.localToWorld(_projVec);
      _projVec.project(camera);

      if (_projVec.z > 1 || _projVec.z < -1) {
        target.visible = false;
        continue;
      }

      const sx = offsetX + ((_projVec.x + 1) / 2) * canvasW;
      const sy = offsetY + ((-_projVec.y + 1) / 2) * canvasH;

      target.x = sx;
      target.y = sy;
      target.visible =
        sx >= -30 && sx <= viewportW + 30 && sy >= 40 && sy <= viewportH - 40;
    }
  }

  public dispose() {
    for (const item of this.disposables) {
      item.dispose();
    }
    this.disposables = [];
    this.buildings.clear();
  }
}
