import * as THREE from 'three';
import type {
  BimObject,
  CommissioningPhase,
  HarmonogramData,
  LayerVisibility,
  ObjectProgressState,
} from '../types/bim';
import {
  calcRangeProgress,
  evaluateObjectState,
  isHolidaySeason,
  isJacarandaBloomSeason,
  parseDateMs,
} from '../utils/schedule';

export const GRID_TO_MARKER_SCALE = 0.06;

// Reusable scratch math objects (zero GC in animation loop)
const _projVec = new THREE.Vector3();
const _tempColor = new THREE.Color();
const _axolotlPos = new THREE.Vector3();

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

  // Warm CDMX dusty earth / volcanic stone yard tone
  ctx.fillStyle = '#53493f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let gx = 0; gx < widthUnits; gx++) {
    for (let gz = 0; gz < depthUnits; gz++) {
      const checker = (gx + gz) % 2 === 0;
      ctx.fillStyle = checker ? 'rgba(255,235,205,0.035)' : 'rgba(20,12,6,0.045)';
      ctx.fillRect(gx * pxPerUnit, gz * pxPerUnit, pxPerUnit, pxPerUnit);
    }
  }

  ctx.strokeStyle = 'rgba(245, 222, 190, 0.15)';
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

function createTortilleriaTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 192;
  const ctx = canvas.getContext('2d')!;

  // Warm Mexican terracotta-cream signboard
  ctx.fillStyle = '#fffbeb';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Decorative Mexican flag-inspired top & bottom accent bars
  ctx.fillStyle = '#15803d';
  ctx.fillRect(0, 0, canvas.width, 20);
  ctx.fillStyle = '#dc2626';
  ctx.fillRect(0, canvas.height - 20, canvas.width, 20);

  // Warm inner frame
  ctx.strokeStyle = '#d97706';
  ctx.lineWidth = 8;
  ctx.strokeRect(14, 26, canvas.width - 28, canvas.height - 52);

  // Crisp bold text (un-mirrored!)
  ctx.fillStyle = '#7c2d12';
  ctx.font = '900 62px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('TORTILLERIA', canvas.width / 2, canvas.height / 2 + 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
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

interface JacarandaTreeMeta {
  greenHex: number;
  bloomHex1: number;
  bloomHex2: number;
}

interface PetalSim {
  baseX: number;
  baseZ: number;
  phase: number;
  fallSpeed: number;
  swayAmp: number;
  heightSpan: number;
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
  tinacoGroup?: THREE.Group;
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
  private tortilleriaSign: THREE.Group | null = null;
  private roadFinishMs: number;
  private vehicles: VehicleSim[] = [];
  private vehicleGroup: THREE.Group;
  private disposables: Array<{ dispose: () => void }> = [];

  // CDMX Vegetation & Jacaranda seasonal bloom
  private jacarandaCrownLow: THREE.InstancedMesh | null = null;
  private jacarandaCrownHigh: THREE.InstancedMesh | null = null;
  private jacarandaMeta: JacarandaTreeMeta[] = [];
  private targetJacarandaBloom = 0;
  private currentJacarandaBloom = 0;
  private lastAppliedBloom = -1;

  private petalsMesh: THREE.InstancedMesh | null = null;
  private petalSims: PetalSim[] = [];
  private petalDummy = new THREE.Object3D();

  // Living World & Easter Eggs
  private axolotlGroup: THREE.Group | null = null;
  private axolotlLegs: THREE.Mesh[] = [];
  private axolotlTail: THREE.Group | null = null;
  private axolotlActive = false;
  private axolotlTimer = 14; // first crossing 8s after launch (triggers when >= 22)
  private axolotlProgress = 0;
  private axolotlRouteFlip = false;

  private eagleGroup: THREE.Group | null = null;
  private eagleLeftWing: THREE.Group | null = null;
  private eagleRightWing: THREE.Group | null = null;
  private eagleActive = false;
  private eagleTimer = 18; // first glide ~12s after launch
  private eagleProgress = 0;
  private eagleReverse = false;

  private ufoGroup: THREE.Group | null = null;
  private ufoActive = false;
  private ufoElapsed = 0;
  private ufoReverse = false;

  // European Spruce next to TAQUERIA (Polish Christmas ornaments in Dec/Jan)
  private spruceOrnamentsGroup: THREE.Group | null = null;
  private spruceStar: THREE.Group | null = null;
  private spruceLights: Array<{ mat: THREE.MeshStandardMaterial; phase: number }> = [];
  private isHoliday = false;

  // Santa Claus on American Harley-Davidson chopper (Dec/Jan)
  private santaGroup: THREE.Group | null = null;
  private santaHeadLightMat: THREE.MeshStandardMaterial | null = null;
  private santaActive = false;
  private santaTimer = 8.5;
  private santaProgress = 0;
  private santaFlashRemaining = 0;
  private readonly santaRouteWaypoints: THREE.Vector2[] = [
    new THREE.Vector2(18.0, 8.5),
    new THREE.Vector2(18.0, 1.5),
    new THREE.Vector2(11.5, 1.5),
    new THREE.Vector2(11.5, -2.5),
    new THREE.Vector2(-9.5, -2.5),
    new THREE.Vector2(-9.5, 5.5),
    new THREE.Vector2(11.5, 5.5),
    new THREE.Vector2(11.5, 1.5),
    new THREE.Vector2(18.0, 1.5),
    new THREE.Vector2(18.0, -8.5),
  ];

  private currentOpacity = 0.7;
  private selectedId: string | null = null;
  private onDropCallback?: () => void;
  private onWorkStartCallback?: () => void;

  // Mirrored (z -> -z) internal road loop waypoints
  private readonly loopWaypoints: THREE.Vector2[] = [
    new THREE.Vector2(-9.5, 5.5),
    new THREE.Vector2(11.5, 5.5),
    new THREE.Vector2(11.5, -2.5),
    new THREE.Vector2(-9.5, -2.5),
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

    this.roadFinishMs = Math.max(
      ...this.data.teren.drogi.map((r) => parseDateMs(r.budowlane.koniec)),
    );

    this.buildTerrain(maxAnisotropy);
    this.buildCdmxFlora();
    this.buildEuropeanSpruce();
    this.buildFence();
    this.buildRoads();
    this.buildTortilleriaSign(maxAnisotropy);
    this.buildVehicles();
    this.buildObjects();
    this.buildAxolotl();
    this.buildEagleWithSnake();
    this.buildUfo();
    this.buildSantaHarley();
  }

  private track<T extends { dispose: () => void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }

  private buildTerrain(maxAnisotropy: number) {
    const w = this.data.teren.siatkaSzerokosc;
    const d = this.data.teren.siatkaGlebokosc;

    // Warm Mexican dusty terracotta/arid olive earth around perimeter
    const outerGeo = this.track(new THREE.BoxGeometry(w + 18, 0.24, d + 16));
    const outerMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x6f583e,
        roughness: 0.94,
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
        color: 0x453b31,
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

  private buildCdmxFlora() {
    const jacarandaSpots: Array<{ x: number; z: number; scale: number; tint: number }> = [];
    const saguaroSpots: Array<{ x: number; z: number; scale: number; rot: number }> = [];
    const opuntiaSpots: Array<{ x: number; z: number; scale: number; rot: number }> = [];
    const agaveSpots: Array<{ x: number; z: number; scale: number; rot: number }> = [];

    let seed = 84217;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };

    const isInsideProtectedZone = (x: number, z: number) => {
      if (x >= -19.6 && x <= 19.8 && z >= -9.3 && z <= 9.3) return true;
      if (x >= 16.4 && x <= 19.6 && Math.abs(z) <= 10.2) return true;
      return false;
    };

    for (let gx = -27; gx <= 27; gx += 1.75) {
      for (let gz = -15.5; gz <= 15.5; gz += 1.75) {
        const jx = gx + (rand() - 0.5) * 0.95;
        const jz = gz + (rand() - 0.5) * 0.95;
        if (isInsideProtectedZone(jx, jz)) continue;

        const r = rand();
        if (r < 0.14) continue;
        if (r < 0.56) {
          jacarandaSpots.push({
            x: jx,
            z: jz,
            scale: 0.85 + rand() * 0.45,
            tint: rand(),
          });
        } else if (r < 0.72) {
          saguaroSpots.push({
            x: jx,
            z: jz,
            scale: 0.8 + rand() * 0.5,
            rot: rand() * Math.PI * 2,
          });
        } else if (r < 0.85) {
          opuntiaSpots.push({
            x: jx,
            z: jz,
            scale: 0.8 + rand() * 0.4,
            rot: rand() * Math.PI * 2,
          });
        } else {
          agaveSpots.push({
            x: jx,
            z: jz,
            scale: 0.85 + rand() * 0.45,
            rot: rand() * Math.PI * 2,
          });
        }
      }
    }

    const dummy = new THREE.Object3D();

    // 1. Spreading CDMX Jacarandas (trunks + 2-tier wide crowns)
    if (jacarandaSpots.length > 0) {
      const count = jacarandaSpots.length;
      const trunkGeo = this.track(new THREE.BoxGeometry(0.32, 1.35, 0.32));
      trunkGeo.translate(0, 0.675, 0);
      const trunkMat = this.track(
        new THREE.MeshStandardMaterial({ color: 0x6b4f3b, roughness: 0.92 }),
      );
      const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
      trunks.castShadow = true;
      trunks.receiveShadow = true;

      const crownMat = this.track(
        new THREE.MeshStandardMaterial({
          color: 0xffffff,
          roughness: 0.82,
          metalness: 0.02,
        }),
      );

      const lowGeo = this.track(new THREE.BoxGeometry(1.75, 0.72, 1.75));
      lowGeo.translate(0, 1.65, 0);
      const lowCrowns = new THREE.InstancedMesh(lowGeo, crownMat, count);
      lowCrowns.castShadow = true;
      lowCrowns.receiveShadow = true;

      const highGeo = this.track(new THREE.BoxGeometry(1.22, 0.58, 1.22));
      highGeo.translate(0.12, 2.18, -0.08);
      const highCrowns = new THREE.InstancedMesh(highGeo, crownMat, count);
      highCrowns.castShadow = true;
      highCrowns.receiveShadow = true;

      const greens = [0x3f7d47, 0x4d8b55, 0x377240, 0x569658];
      const blooms1 = [0xa855f7, 0x9333ea, 0xc084fc, 0xb968f7];
      const blooms2 = [0xd946ef, 0xc084fc, 0xe879f9, 0xa855f7];

      jacarandaSpots.forEach((p, i) => {
        dummy.position.set(p.x, -0.04, p.z);
        dummy.scale.set(p.scale, p.scale * (0.92 + p.tint * 0.2), p.scale);
        dummy.rotation.set(0, p.tint * Math.PI * 2, 0);
        dummy.updateMatrix();

        trunks.setMatrixAt(i, dummy.matrix);
        lowCrowns.setMatrixAt(i, dummy.matrix);
        highCrowns.setMatrixAt(i, dummy.matrix);

        const greenHex = greens[Math.floor(p.tint * greens.length) % greens.length];
        const bloomHex1 = blooms1[Math.floor(p.tint * blooms1.length) % blooms1.length];
        const bloomHex2 = blooms2[Math.floor((1 - p.tint) * blooms2.length) % blooms2.length];
        this.jacarandaMeta.push({ greenHex, bloomHex1, bloomHex2 });

        _tempColor.setHex(greenHex);
        lowCrowns.setColorAt(i, _tempColor);
        _tempColor.offsetHSL(0, 0.02, 0.04);
        highCrowns.setColorAt(i, _tempColor);
      });

      trunks.instanceMatrix.needsUpdate = true;
      lowCrowns.instanceMatrix.needsUpdate = true;
      highCrowns.instanceMatrix.needsUpdate = true;
      if (lowCrowns.instanceColor) lowCrowns.instanceColor.needsUpdate = true;
      if (highCrowns.instanceColor) highCrowns.instanceColor.needsUpdate = true;

      trunks.computeBoundingSphere();
      lowCrowns.computeBoundingSphere();
      highCrowns.computeBoundingSphere();

      this.jacarandaCrownLow = lowCrowns;
      this.jacarandaCrownHigh = highCrowns;
      this.root.add(trunks, lowCrowns, highCrowns);

      // Falling violet-pink petals during bloom season
      const petalCount = Math.min(110, jacarandaSpots.length * 2);
      const petalGeo = this.track(new THREE.BoxGeometry(0.12, 0.025, 0.12));
      const petalMat = this.track(
        new THREE.MeshStandardMaterial({
          color: 0xd8b4fe,
          emissive: 0xa855f7,
          emissiveIntensity: 0.2,
          roughness: 0.65,
        }),
      );
      const petals = new THREE.InstancedMesh(petalGeo, petalMat, petalCount);
      for (let i = 0; i < petalCount; i++) {
        const tree = jacarandaSpots[i % jacarandaSpots.length];
        this.petalSims.push({
          baseX: tree.x + (rand() - 0.5) * 1.4,
          baseZ: tree.z + (rand() - 0.5) * 1.4,
          phase: rand() * Math.PI * 2,
          fallSpeed: 0.35 + rand() * 0.35,
          swayAmp: 0.25 + rand() * 0.25,
          heightSpan: 1.85 * tree.scale,
        });
        dummy.position.set(tree.x, -5, tree.z);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        petals.setMatrixAt(i, dummy.matrix);
      }
      petals.instanceMatrix.needsUpdate = true;
      petals.computeBoundingSphere();
      petals.visible = false;
      this.petalsMesh = petals;
      this.root.add(petals);
    }

    // 2. Saguaro Cacti (tall column + bent voxel arms)
    if (saguaroSpots.length > 0) {
      const cCount = saguaroSpots.length;
      const cactusMat = this.track(
        new THREE.MeshStandardMaterial({ color: 0x3b7a3e, roughness: 0.78 }),
      );
      const stemGeo = this.track(new THREE.BoxGeometry(0.32, 1.65, 0.32));
      stemGeo.translate(0, 0.825, 0);
      const stems = new THREE.InstancedMesh(stemGeo, cactusMat, cCount);
      stems.castShadow = true;

      const armLeftGeo = this.track(new THREE.BoxGeometry(0.24, 0.68, 0.24));
      armLeftGeo.translate(-0.32, 1.05, 0);
      const armsL = new THREE.InstancedMesh(armLeftGeo, cactusMat, cCount);
      armsL.castShadow = true;

      const armConnLGeo = this.track(new THREE.BoxGeometry(0.26, 0.22, 0.22));
      armConnLGeo.translate(-0.22, 0.82, 0);
      const connsL = new THREE.InstancedMesh(armConnLGeo, cactusMat, cCount);

      const armRightGeo = this.track(new THREE.BoxGeometry(0.22, 0.54, 0.22));
      armRightGeo.translate(0.3, 1.24, 0);
      const armsR = new THREE.InstancedMesh(armRightGeo, cactusMat, cCount);
      armsR.castShadow = true;

      const armConnRGeo = this.track(new THREE.BoxGeometry(0.24, 0.2, 0.2));
      armConnRGeo.translate(0.2, 1.04, 0);
      const connsR = new THREE.InstancedMesh(armConnRGeo, cactusMat, cCount);

      saguaroSpots.forEach((p, i) => {
        dummy.position.set(p.x, -0.04, p.z);
        dummy.scale.setScalar(p.scale);
        dummy.rotation.set(0, p.rot, 0);
        dummy.updateMatrix();
        stems.setMatrixAt(i, dummy.matrix);
        armsL.setMatrixAt(i, dummy.matrix);
        connsL.setMatrixAt(i, dummy.matrix);
        armsR.setMatrixAt(i, dummy.matrix);
        connsR.setMatrixAt(i, dummy.matrix);
      });

      for (const m of [stems, armsL, connsL, armsR, connsR]) {
        m.instanceMatrix.needsUpdate = true;
        m.computeBoundingSphere();
        this.root.add(m);
      }
    }

    // 3. Prickly Pear (Opuntia / Nopal) with red tuna buds
    if (opuntiaSpots.length > 0) {
      const oCount = opuntiaSpots.length;
      const nopalMat = this.track(
        new THREE.MeshStandardMaterial({ color: 0x4d8c40, roughness: 0.78 }),
      );
      const fruitMat = this.track(
        new THREE.MeshStandardMaterial({ color: 0xe11d48, roughness: 0.55 }),
      );
      const pad1Geo = this.track(new THREE.BoxGeometry(0.42, 0.52, 0.14));
      pad1Geo.translate(0, 0.26, 0);
      const pad2Geo = this.track(new THREE.BoxGeometry(0.34, 0.42, 0.12));
      pad2Geo.rotateZ(0.25);
      pad2Geo.translate(-0.22, 0.62, 0.04);
      const pad3Geo = this.track(new THREE.BoxGeometry(0.32, 0.38, 0.12));
      pad3Geo.rotateZ(-0.28);
      pad3Geo.translate(0.22, 0.56, -0.03);
      const fruitGeo = this.track(new THREE.BoxGeometry(0.11, 0.12, 0.11));
      fruitGeo.translate(-0.26, 0.87, 0.04);

      const pads1 = new THREE.InstancedMesh(pad1Geo, nopalMat, oCount);
      const pads2 = new THREE.InstancedMesh(pad2Geo, nopalMat, oCount);
      const pads3 = new THREE.InstancedMesh(pad3Geo, nopalMat, oCount);
      const fruits = new THREE.InstancedMesh(fruitGeo, fruitMat, oCount);
      pads1.castShadow = true;

      opuntiaSpots.forEach((p, i) => {
        dummy.position.set(p.x, -0.04, p.z);
        dummy.scale.setScalar(p.scale);
        dummy.rotation.set(0, p.rot, 0);
        dummy.updateMatrix();
        pads1.setMatrixAt(i, dummy.matrix);
        pads2.setMatrixAt(i, dummy.matrix);
        pads3.setMatrixAt(i, dummy.matrix);
        fruits.setMatrixAt(i, dummy.matrix);
      });

      for (const m of [pads1, pads2, pads3, fruits]) {
        m.instanceMatrix.needsUpdate = true;
        m.computeBoundingSphere();
        this.root.add(m);
      }
    }

    // 4. Blue-Green Agave Rosettes
    if (agaveSpots.length > 0) {
      const aCount = agaveSpots.length;
      const agaveMat = this.track(
        new THREE.MeshStandardMaterial({ color: 0x2f8f83, roughness: 0.74 }),
      );
      const leafAGeo = this.track(new THREE.BoxGeometry(0.95, 0.18, 0.22));
      leafAGeo.rotateZ(0.18);
      leafAGeo.translate(0, 0.18, 0);

      const leafBGeo = this.track(new THREE.BoxGeometry(0.22, 0.18, 0.95));
      leafBGeo.rotateX(-0.18);
      leafBGeo.translate(0, 0.18, 0);

      const coreGeo = this.track(new THREE.ConeGeometry(0.2, 0.62, 4));
      coreGeo.translate(0, 0.31, 0);

      const leavesA = new THREE.InstancedMesh(leafAGeo, agaveMat, aCount);
      const leavesB = new THREE.InstancedMesh(leafBGeo, agaveMat, aCount);
      const cores = new THREE.InstancedMesh(coreGeo, agaveMat, aCount);
      cores.castShadow = true;

      agaveSpots.forEach((p, i) => {
        dummy.position.set(p.x, -0.04, p.z);
        dummy.scale.setScalar(p.scale);
        dummy.rotation.set(0, p.rot, 0);
        dummy.updateMatrix();
        leavesA.setMatrixAt(i, dummy.matrix);
        leavesB.setMatrixAt(i, dummy.matrix);
        cores.setMatrixAt(i, dummy.matrix);
      });

      for (const m of [leavesA, leavesB, cores]) {
        m.instanceMatrix.needsUpdate = true;
        m.computeBoundingSphere();
        this.root.add(m);
      }
    }
  }

  private buildFence() {
    const h = this.data.teren.ogrodzenie.wysokosc;
    const fenceMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0xd6cfc2,
        roughness: 0.65,
        metalness: 0.22,
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

    // North & South spans (symmetric)
    addFenceSpan(-1.1, -8.6, 35.4, 0.16);
    addFenceSpan(-1.1, 8.6, 35.4, 0.16);
    // West span
    addFenceSpan(-18.8, 0, 0.16, 17.2);
    // East spans mirrored (gate opening moved from z in [-2.2,-0.8] to z in [0.8, 2.2])
    addFenceSpan(16.6, 5.4, 0.16, 6.4);
    addFenceSpan(16.6, -3.9, 0.16, 9.4);
  }

  private buildRoads() {
    const roadMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x3b3834,
        roughness: 0.88,
        metalness: 0.06,
      }),
    );
    const markingMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0xfef3c7,
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
        // Explicit z -> -z mirror (never negative scale!)
        const mirroredZ = -seg.z;
        const geo = this.track(new THREE.BoxGeometry(seg.w, h, seg.d));
        geo.translate(0, h / 2, 0);
        const mesh = new THREE.Mesh(geo, roadMat);
        mesh.position.set(seg.x, 0, mirroredZ);
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
            mirroredZ + (alongX ? 0 : offset),
          );
          dash.userData.roadStart = road.budowlane.start;
          dash.userData.roadEnd = road.budowlane.koniec;
          this.root.add(dash);
          this.roadMarkings.push(dash);
        }
      }
    }
  }

  private buildTortilleriaSign(maxAnisotropy: number) {
    const signGroup = new THREE.Group();
    // Placed right at the internal road fork around mirrored (x: 11.5, z: 3.5), clear of road lane
    signGroup.position.set(12.45, 0, 3.5);
    signGroup.rotation.y = -0.35;

    const postMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x57534e,
        roughness: 0.7,
        metalness: 0.35,
      }),
    );
    const postGeo = this.track(new THREE.BoxGeometry(0.1, 1.55, 0.1));
    postGeo.translate(0, 0.775, 0);

    const leftPost = new THREE.Mesh(postGeo, postMat);
    leftPost.position.set(-0.68, 0, 0);
    leftPost.castShadow = true;

    const rightPost = new THREE.Mesh(postGeo, postMat);
    rightPost.position.set(0.68, 0, 0);
    rightPost.castShadow = true;

    const frameMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x7c2d12,
        roughness: 0.6,
        metalness: 0.15,
      }),
    );
    const signTex = this.track(createTortilleriaTexture(maxAnisotropy));
    const faceMat = this.track(
      new THREE.MeshStandardMaterial({
        map: signTex,
        roughness: 0.45,
        metalness: 0.05,
      }),
    );

    const boardGeo = this.track(new THREE.BoxGeometry(1.75, 0.66, 0.08));
    // BoxGeometry material order: +x, -x, +y, -y, +z (front), -z (back)
    const board = new THREE.Mesh(boardGeo, [
      frameMat,
      frameMat,
      frameMat,
      frameMat,
      faceMat,
      faceMat,
    ]);
    board.position.set(0, 1.24, 0);
    board.castShadow = true;

    signGroup.add(leftPost, rightPost, board);
    signGroup.visible = false;
    this.tortilleriaSign = signGroup;
    this.root.add(signGroup);
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
        color: 0xfef9f2,
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

  private createTinacoMesh(): THREE.Group {
    const tinaco = new THREE.Group();

    const bodyMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x111827,
        roughness: 0.52,
        metalness: 0.12,
      }),
    );
    const ribMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x0f172a,
        roughness: 0.45,
        metalness: 0.18,
      }),
    );

    // Main ribbed cylinder tank
    const tankGeo = this.track(new THREE.CylinderGeometry(0.24, 0.24, 0.38, 14));
    tankGeo.translate(0, 0.19, 0);
    const tankMesh = new THREE.Mesh(tankGeo, bodyMat);
    tankMesh.castShadow = true;
    tinaco.add(tankMesh);

    // 3 horizontal reinforcing ribs
    const ribGeo = this.track(new THREE.CylinderGeometry(0.256, 0.256, 0.032, 14));
    for (const ry of [0.09, 0.19, 0.29]) {
      const rib = new THREE.Mesh(ribGeo, ribMat);
      rib.position.y = ry;
      tinaco.add(rib);
    }

    // Tapered shoulder + screw-on lid
    const shoulderGeo = this.track(new THREE.CylinderGeometry(0.15, 0.24, 0.07, 14));
    shoulderGeo.translate(0, 0.415, 0);
    const shoulder = new THREE.Mesh(shoulderGeo, bodyMat);
    tinaco.add(shoulder);

    const lidGeo = this.track(new THREE.CylinderGeometry(0.11, 0.12, 0.045, 12));
    lidGeo.translate(0, 0.47, 0);
    const lid = new THREE.Mesh(lidGeo, ribMat);
    tinaco.add(lid);

    return tinaco;
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
        color: 0xa8a29e,
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
      // Full mirror across X-axis: z -> -z
      objRoot.position.set(obj.x, 0, -obj.z);

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

      const isTaqueria = obj.id === 'TAQUERIA' || obj.id === 'BIURO';
      const baseShellColor = isTaqueria
        ? 0xf4c07a
        : obj.typ === 'container'
          ? 0xdccbb2
          : 0xe6d4b7;

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
          color: isTaqueria ? 0x9a3412 : obj.typ === 'container' ? 0x3f3a36 : 0x78716c,
          transparent: true,
          opacity: 0.85,
        }),
      );

      const shellGroup = new THREE.Group();
      const shellMeshes: THREE.Mesh[] = [];

      if (obj.typ === 'container') {
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

      // Characteristic roof-mounted Mexican Tinaco water tank on TAQUERIA
      let tinacoGroup: THREE.Group | undefined;
      if (isTaqueria) {
        tinacoGroup = this.createTinacoMesh();
        tinacoGroup.position.set(0.55, obj.h, 0);
        dropGroup.add(tinacoGroup);
      }

      // Two adjacent interior columns at exact floor center (0.5 x 0.5 footprint each)
      const techColumn = new THREE.Mesh(colGeo, techMat);
      techColumn.position.set(-0.24, 0, 0);
      techColumn.castShadow = true;

      const elecColumn = new THREE.Mesh(colGeo, elecMat);
      elecColumn.position.set(0.24, 0, 0);
      elecColumn.castShadow = true;

      if (!isTaqueria) {
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
        tinacoGroup,
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

  private buildAxolotl() {
    const group = new THREE.Group();

    const bodyMat = this.track(
      new THREE.MeshStandardMaterial({ color: 0xf9a8d4, roughness: 0.5 }),
    );
    const bellyMat = this.track(
      new THREE.MeshStandardMaterial({ color: 0xfce7f3, roughness: 0.55 }),
    );
    const gillMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0xec4899,
        emissive: 0xdb2777,
        emissiveIntensity: 0.2,
        roughness: 0.45,
      }),
    );
    const eyeMat = this.track(
      new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.25 }),
    );

    const torso = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.32, 0.22, 0.62)),
      bodyMat,
    );
    torso.position.set(0, 0.16, 0);
    torso.castShadow = true;
    group.add(torso);

    const head = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.38, 0.22, 0.3)),
      bellyMat,
    );
    head.position.set(0, 0.18, 0.36);
    head.castShadow = true;
    group.add(head);

    const eyeGeo = this.track(new THREE.BoxGeometry(0.06, 0.06, 0.05));
    for (const ex of [-0.11, 0.11]) {
      const eye = new THREE.Mesh(eyeGeo, eyeMat);
      eye.position.set(ex, 0.22, 0.5);
      group.add(eye);
    }

    // Feathery pink gill tufts on both sides of head
    const gillGeo = this.track(new THREE.BoxGeometry(0.18, 0.05, 0.05));
    for (const side of [-1, 1]) {
      for (let g = 0; g < 3; g++) {
        const gill = new THREE.Mesh(gillGeo, gillMat);
        gill.position.set(side * 0.25, 0.14 + g * 0.055, 0.31);
        gill.rotation.z = side * (g - 1) * 0.32;
        group.add(gill);
      }
    }

    // Articulated tail
    const tailPivot = new THREE.Group();
    tailPivot.position.set(0, 0.16, -0.31);
    const tailCore = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.14, 0.16, 0.48)),
      bodyMat,
    );
    tailCore.position.set(0, 0, -0.22);
    const tailFin = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.05, 0.26, 0.44)),
      gillMat,
    );
    tailFin.position.set(0, 0.02, -0.24);
    tailPivot.add(tailCore, tailFin);
    group.add(tailPivot);

    // Four little animated legs
    const legGeo = this.track(new THREE.BoxGeometry(0.09, 0.12, 0.09));
    legGeo.translate(0, -0.04, 0);
    const legCoords: Array<[number, number]> = [
      [-0.18, 0.18],
      [0.18, 0.18],
      [-0.18, -0.18],
      [0.18, -0.18],
    ];
    for (const [lx, lz] of legCoords) {
      const leg = new THREE.Mesh(legGeo, bodyMat);
      leg.position.set(lx, 0.1, lz);
      group.add(leg);
      this.axolotlLegs.push(leg);
    }

    group.scale.setScalar(1.05);
    group.visible = false;
    this.axolotlGroup = group;
    this.axolotlTail = tailPivot;
    this.root.add(group);
  }

  private buildEagleWithSnake() {
    const group = new THREE.Group();

    const featherMat = this.track(
      new THREE.MeshStandardMaterial({ color: 0x5c3a21, roughness: 0.78 }),
    );
    const headMat = this.track(
      new THREE.MeshStandardMaterial({ color: 0x854d27, roughness: 0.72 }),
    );
    const beakMat = this.track(
      new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.45 }),
    );
    const tailMat = this.track(
      new THREE.MeshStandardMaterial({ color: 0xfef3c7, roughness: 0.75 }),
    );
    const snakeMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x22c55e,
        emissive: 0x15803d,
        emissiveIntensity: 0.2,
        roughness: 0.45,
      }),
    );

    const body = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.45, 0.32, 0.95)),
      featherMat,
    );
    body.castShadow = true;
    group.add(body);

    const head = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.32, 0.28, 0.36)),
      headMat,
    );
    head.position.set(0, 0.12, 0.56);
    group.add(head);

    const beak = new THREE.Mesh(
      this.track(new THREE.ConeGeometry(0.11, 0.26, 4)),
      beakMat,
    );
    beak.rotation.x = Math.PI / 2;
    beak.position.set(0, 0.08, 0.82);
    group.add(beak);

    // Green snake clutched in beak
    const snakeHead = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.08, 0.08, 0.36)),
      snakeMat,
    );
    snakeHead.position.set(0.08, 0.0, 0.92);
    snakeHead.rotation.y = 0.5;
    const snakeTail = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.07, 0.07, 0.42)),
      snakeMat,
    );
    snakeTail.position.set(-0.08, -0.14, 0.98);
    snakeTail.rotation.x = 0.55;
    snakeTail.rotation.y = -0.4;
    group.add(snakeHead, snakeTail);

    const tailFan = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.56, 0.06, 0.45)),
      tailMat,
    );
    tailFan.position.set(0, 0.02, -0.62);
    group.add(tailFan);

    // Wing pivots
    const wingGeo = this.track(new THREE.BoxGeometry(1.45, 0.07, 0.55));
    const leftWingPivot = new THREE.Group();
    leftWingPivot.position.set(-0.22, 0.08, 0.08);
    const leftWingMesh = new THREE.Mesh(wingGeo, featherMat);
    leftWingMesh.position.set(-0.72, 0, 0);
    leftWingMesh.castShadow = true;
    leftWingPivot.add(leftWingMesh);

    const rightWingPivot = new THREE.Group();
    rightWingPivot.position.set(0.22, 0.08, 0.08);
    const rightWingMesh = new THREE.Mesh(wingGeo, featherMat);
    rightWingMesh.position.set(0.72, 0, 0);
    rightWingMesh.castShadow = true;
    rightWingPivot.add(rightWingMesh);

    group.add(leftWingPivot, rightWingPivot);
    group.visible = false;

    this.eagleGroup = group;
    this.eagleLeftWing = leftWingPivot;
    this.eagleRightWing = rightWingPivot;
    this.root.add(group);
  }

  private buildUfo() {
    const group = new THREE.Group();

    const hullMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0xcbd5e1,
        metalness: 0.75,
        roughness: 0.25,
      }),
    );
    const domeMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0x38bdf8,
        emissive: 0x0ea5e9,
        emissiveIntensity: 0.95,
        roughness: 0.15,
        transparent: true,
        opacity: 0.88,
      }),
    );
    const rimLightMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0xa5f3fc,
        emissive: 0x22d3ee,
        emissiveIntensity: 2.2,
        roughness: 0.2,
      }),
    );

    const saucer = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(0.95, 1.15, 0.22, 16)),
      hullMat,
    );
    group.add(saucer);

    const dome = new THREE.Mesh(
      this.track(new THREE.SphereGeometry(0.52, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.5)),
      domeMat,
    );
    dome.position.y = 0.08;
    group.add(dome);

    const bulbGeo = this.track(new THREE.BoxGeometry(0.14, 0.09, 0.14));
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2;
      const bulb = new THREE.Mesh(bulbGeo, rimLightMat);
      bulb.position.set(Math.cos(ang) * 0.92, -0.02, Math.sin(ang) * 0.92);
      group.add(bulb);
    }

    group.visible = false;
    this.ufoGroup = group;
    this.root.add(group);
  }

  private buildEuropeanSpruce() {
    const spruceGroup = new THREE.Group();
    // Placed right beside TAQUERIA (13.2, -3.0) to the left of the Tinaco (13.75, -3.0),
    // near the corner of the internal road (11.5, -2.5) and perimeter fence.
    spruceGroup.position.set(12.2, 0, -4.4);

    const trunkMat = this.track(
      new THREE.MeshStandardMaterial({ color: 0x5c3a21, roughness: 0.92 }),
    );
    const trunkGeo = this.track(new THREE.CylinderGeometry(0.16, 0.23, 0.72, 8));
    trunkGeo.translate(0, 0.36, 0);
    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
    trunk.castShadow = true;
    trunk.receiveShadow = true;
    spruceGroup.add(trunk);

    const tierConfigs = [
      { r: 1.05, h: 1.05, y: 0.95, color: 0x14532d, rotY: 0 },
      { r: 0.86, h: 0.95, y: 1.52, color: 0x166534, rotY: 0.35 },
      { r: 0.66, h: 0.85, y: 2.04, color: 0x15803d, rotY: 0.7 },
      { r: 0.44, h: 0.75, y: 2.52, color: 0x16a34a, rotY: 1.05 },
    ];

    for (const tc of tierConfigs) {
      const coneGeo = this.track(new THREE.ConeGeometry(tc.r, tc.h, 8));
      const coneMat = this.track(
        new THREE.MeshStandardMaterial({
          color: tc.color,
          roughness: 0.84,
          metalness: 0.02,
        }),
      );
      const cone = new THREE.Mesh(coneGeo, coneMat);
      cone.position.y = tc.y;
      cone.rotation.y = tc.rotY;
      cone.castShadow = true;
      cone.receiveShadow = true;
      spruceGroup.add(cone);
    }

    // Polish Christmas decorations (baubles, twinkling lights, golden Star of Bethlehem)
    const ornaments = new THREE.Group();
    const baubleGeo = this.track(new THREE.SphereGeometry(0.082, 8, 8));
    const baubleMats = [
      this.track(
        new THREE.MeshStandardMaterial({
          color: 0xdc2626,
          emissive: 0x991b1b,
          emissiveIntensity: 0.25,
          roughness: 0.2,
          metalness: 0.55,
        }),
      ),
      this.track(
        new THREE.MeshStandardMaterial({
          color: 0xfacc15,
          emissive: 0xca8a04,
          emissiveIntensity: 0.25,
          roughness: 0.2,
          metalness: 0.65,
        }),
      ),
      this.track(
        new THREE.MeshStandardMaterial({
          color: 0x2563eb,
          emissive: 0x1d4ed8,
          emissiveIntensity: 0.25,
          roughness: 0.2,
          metalness: 0.55,
        }),
      ),
    ];

    let bIdx = 0;
    for (let ti = 0; ti < tierConfigs.length; ti++) {
      const tc = tierConfigs[ti];
      const count = 6 - ti;
      for (let i = 0; i < count; i++) {
        const ang = (i / count) * Math.PI * 2 + ti * 0.65;
        const bauble = new THREE.Mesh(baubleGeo, baubleMats[bIdx % baubleMats.length]);
        bauble.position.set(
          Math.cos(ang) * tc.r * 0.78,
          tc.y - tc.h * 0.22,
          Math.sin(ang) * tc.r * 0.78,
        );
        ornaments.add(bauble);
        bIdx++;
      }
    }

    // Twinkling colorful fairy lights
    const lightGeo = this.track(new THREE.BoxGeometry(0.075, 0.075, 0.075));
    const lightColors = [0xfef08a, 0xf87171, 0x38bdf8, 0x4ade80];
    for (let li = 0; li < 14; li++) {
      const tNorm = li / 13;
      const tier = tierConfigs[Math.min(3, Math.floor(tNorm * 3.8))];
      const ang = li * 1.85;
      const r = tier.r * (0.68 + (li % 2) * 0.14);
      const y = 0.7 + tNorm * 1.9;
      const cHex = lightColors[li % lightColors.length];
      const lMat = this.track(
        new THREE.MeshStandardMaterial({
          color: cHex,
          emissive: cHex,
          emissiveIntensity: 1.4,
          roughness: 0.2,
        }),
      );
      const bulb = new THREE.Mesh(lightGeo, lMat);
      bulb.position.set(Math.cos(ang) * r, y, Math.sin(ang) * r);
      ornaments.add(bulb);
      this.spruceLights.push({ mat: lMat, phase: li * 0.9 });
    }

    // Golden Star of Bethlehem at crown
    const starGroup = new THREE.Group();
    starGroup.position.set(0, 3.02, 0);
    const starMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0xfde047,
        emissive: 0xf59e0b,
        emissiveIntensity: 1.35,
        roughness: 0.2,
        metalness: 0.5,
      }),
    );
    const starOctaGeo = this.track(new THREE.OctahedronGeometry(0.2, 0));
    const starA = new THREE.Mesh(starOctaGeo, starMat);
    starA.scale.set(1.0, 1.35, 0.4);
    const starB = new THREE.Mesh(starOctaGeo, starMat);
    starB.scale.set(1.35, 0.55, 0.4);
    starGroup.add(starA, starB);
    ornaments.add(starGroup);

    ornaments.visible = false;
    this.spruceOrnamentsGroup = ornaments;
    this.spruceStar = starGroup;
    spruceGroup.add(ornaments);
    this.root.add(spruceGroup);
  }

  private buildSantaHarley() {
    const group = new THREE.Group();

    const tireMat = this.track(
      new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.9 }),
    );
    const chromeMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0xe5e7eb,
        metalness: 0.9,
        roughness: 0.18,
      }),
    );
    const frameMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0xb91c1c,
        metalness: 0.45,
        roughness: 0.35,
      }),
    );
    const santaRedMat = this.track(
      new THREE.MeshStandardMaterial({ color: 0xdc2626, roughness: 0.65 }),
    );
    const whiteMat = this.track(
      new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.7 }),
    );
    const skinMat = this.track(
      new THREE.MeshStandardMaterial({ color: 0xfdba74, roughness: 0.65 }),
    );
    const goldMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0xfacc15,
        metalness: 0.7,
        roughness: 0.25,
      }),
    );
    const headLightMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0xfef9c3,
        emissive: 0xfef08a,
        emissiveIntensity: 2.2,
        roughness: 0.15,
      }),
    );
    const tailLightMat = this.track(
      new THREE.MeshStandardMaterial({
        color: 0xfca5a5,
        emissive: 0xef4444,
        emissiveIntensity: 1.6,
        roughness: 0.2,
      }),
    );

    // Rear fat tire & front chopper wheel (forward = +Z)
    const rearWheelGeo = this.track(new THREE.CylinderGeometry(0.18, 0.18, 0.15, 12));
    rearWheelGeo.rotateZ(Math.PI / 2);
    const rearWheel = new THREE.Mesh(rearWheelGeo, tireMat);
    rearWheel.position.set(0, 0.18, -0.34);
    rearWheel.castShadow = true;

    const frontWheelGeo = this.track(new THREE.CylinderGeometry(0.19, 0.19, 0.09, 12));
    frontWheelGeo.rotateZ(Math.PI / 2);
    const frontWheel = new THREE.Mesh(frontWheelGeo, tireMat);
    frontWheel.position.set(0, 0.19, 0.46);
    frontWheel.castShadow = true;
    group.add(rearWheel, frontWheel);

    // Low chopper frame & teardrop fuel tank
    const chassis = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.18, 0.13, 0.62)),
      tireMat,
    );
    chassis.position.set(0, 0.22, -0.04);
    const tank = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.22, 0.15, 0.28)),
      frameMat,
    );
    tank.position.set(0, 0.34, 0.11);
    tank.castShadow = true;
    group.add(chassis, tank);

    // Chrome V-Twin cylinders
    const cylGeo = this.track(new THREE.CylinderGeometry(0.055, 0.055, 0.16, 8));
    const cylFront = new THREE.Mesh(cylGeo, chromeMat);
    cylFront.position.set(0, 0.26, 0.08);
    cylFront.rotation.x = 0.42;
    const cylRear = new THREE.Mesh(cylGeo, chromeMat);
    cylRear.position.set(0, 0.26, -0.02);
    cylRear.rotation.x = -0.42;
    group.add(cylFront, cylRear);

    // Long raked front chopper forks & wide cruiser handlebars
    const forkGeo = this.track(new THREE.CylinderGeometry(0.024, 0.024, 0.48, 8));
    for (const fx of [-0.065, 0.065]) {
      const fork = new THREE.Mesh(forkGeo, chromeMat);
      fork.position.set(fx, 0.36, 0.35);
      fork.rotation.x = -0.52;
      group.add(fork);
    }
    const handlebar = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.46, 0.035, 0.035)),
      chromeMat,
    );
    handlebar.position.set(0, 0.56, 0.21);
    group.add(handlebar);

    // Twin chrome exhaust pipes + glowing headlight + taillight
    const pipeGeo = this.track(new THREE.CylinderGeometry(0.028, 0.028, 0.55, 8));
    pipeGeo.rotateX(Math.PI / 2);
    for (const px of [-0.11, 0.11]) {
      const pipe = new THREE.Mesh(pipeGeo, chromeMat);
      pipe.position.set(px, 0.16, -0.22);
      group.add(pipe);
    }

    const headLight = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.11, 0.1, 0.1)),
      headLightMat,
    );
    headLight.position.set(0, 0.44, 0.36);
    const tailLight = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.09, 0.07, 0.06)),
      tailLightMat,
    );
    tailLight.position.set(0, 0.32, -0.44);
    group.add(headLight, tailLight);

    // Santa Claus seated on the Harley
    const torso = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.28, 0.28, 0.22)),
      santaRedMat,
    );
    torso.position.set(0, 0.48, -0.06);
    torso.rotation.x = 0.15;
    torso.castShadow = true;

    const belt = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.29, 0.05, 0.23)),
      tireMat,
    );
    belt.position.set(0, 0.4, -0.06);
    const buckle = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.08, 0.06, 0.04)),
      goldMat,
    );
    buckle.position.set(0, 0.4, 0.05);

    const head = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.19, 0.19, 0.19)),
      skinMat,
    );
    head.position.set(0, 0.7, -0.03);
    const beard = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.2, 0.15, 0.13)),
      whiteMat,
    );
    beard.position.set(0, 0.62, 0.04);

    const hatBrim = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.22, 0.06, 0.22)),
      whiteMat,
    );
    hatBrim.position.set(0, 0.8, -0.03);
    const hatCone = new THREE.Mesh(
      this.track(new THREE.ConeGeometry(0.11, 0.24, 6)),
      santaRedMat,
    );
    hatCone.position.set(0, 0.92, -0.06);
    hatCone.rotation.x = -0.35;
    const pom = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(0.07, 0.07, 0.07)),
      whiteMat,
    );
    pom.position.set(0, 0.99, -0.14);

    const armGeo = this.track(new THREE.BoxGeometry(0.08, 0.08, 0.28));
    for (const ax of [-0.17, 0.17]) {
      const arm = new THREE.Mesh(armGeo, santaRedMat);
      arm.position.set(ax, 0.54, 0.08);
      arm.rotation.y = ax < 0 ? 0.15 : -0.15;
      group.add(arm);
    }

    group.add(torso, belt, buckle, head, beard, hatBrim, hatCone, pom);

    // Generous touch hitbox for mobile tapping
    const hitGeo = this.track(new THREE.BoxGeometry(1.15, 1.25, 1.45));
    hitGeo.translate(0, 0.55, 0);
    const hitMat = this.track(new THREE.MeshBasicMaterial({ visible: false }));
    const hitBox = new THREE.Mesh(hitGeo, hitMat);
    hitBox.userData.kind = 'santa_harley';
    group.add(hitBox);
    this.clickableMeshes.push(hitBox);

    group.visible = false;
    this.santaGroup = group;
    this.santaHeadLightMat = headLightMat;
    this.root.add(group);
  }

  public setSelectedObject(id: string | null) {
    this.selectedId = id;
    for (const [key, entry] of this.buildings.entries()) {
      entry.selectionRing.visible = key === id;
    }
  }

  public triggerTaqueriaCelebration(id: string) {
    const entry = this.buildings.get(id);
    if (!entry) return;
    entry.flashRemaining = 1.6;
  }

  public triggerVehicleHorn(vehicleIndex: number) {
    const v = this.vehicles[vehicleIndex];
    if (!v) return;
    v.hornFlashRemaining = 0.4;
  }

  public triggerSantaTap() {
    this.santaFlashRemaining = 0.85;
  }

  public triggerUfoFlyby(reverse = false) {
    this.ufoActive = true;
    this.ufoElapsed = 0;
    this.ufoReverse = reverse;
    if (this.ufoGroup) {
      this.ufoGroup.visible = true;
    }
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
    this.targetJacarandaBloom = isJacarandaBloomSeason(currentMs) ? 1 : 0;
    this.isHoliday = isHolidaySeason(currentMs);
    if (this.spruceOrnamentsGroup) {
      this.spruceOrnamentsGroup.visible = this.isHoliday;
    }
    if (!this.isHoliday && this.santaGroup) {
      this.santaActive = false;
      this.santaGroup.visible = false;
      this.santaTimer = 8.5;
    }

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

    if (this.tortilleriaSign) {
      this.tortilleriaSign.visible = currentMs >= this.roadFinishMs;
    }

    const roadsBuiltAfterMs = parseDateMs('2027-01-22');
    this.vehicleGroup.visible = currentMs > roadsBuiltAfterMs && roadsFinished;

    let triggeredAnyDrop = false;
    let triggeredAnyWorkStart = false;

    for (const entry of this.buildings.values()) {
      const state = evaluateObjectState(entry.data, currentMs, this.data);
      entry.lastState = state;

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
        state.hasStarted ||
        !(entry.data.demontaz && currentMs >= parseDateMs(entry.data.demontaz));
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

      if (entry.tinacoGroup) {
        entry.tinacoGroup.visible = layers.budowlane && state.budPct > 0.5;
        entry.tinacoGroup.position.y = Math.max(0.01, state.budPct * entry.data.h);
      }

      const maxColHeight = Math.max(0.01, entry.data.h - 0.004);
      const isTaqueria = entry.data.id === 'TAQUERIA' || entry.data.id === 'BIURO';

      entry.techColumn.visible = !isTaqueria && layers.technologia && state.techPct > 0;
      entry.techColumn.scale.y = Math.min(
        maxColHeight,
        Math.max(0.005, state.techPct * maxColHeight),
      );

      entry.elecColumn.visible = !isTaqueria && layers.elektryka && state.elecPct > 0;
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

  private updateJacarandaColors(delta: number, elapsed: number) {
    this.currentJacarandaBloom = THREE.MathUtils.damp(
      this.currentJacarandaBloom,
      this.targetJacarandaBloom,
      4.5,
      delta,
    );

    if (
      this.jacarandaCrownLow &&
      this.jacarandaCrownHigh &&
      Math.abs(this.currentJacarandaBloom - this.lastAppliedBloom) > 0.004
    ) {
      this.lastAppliedBloom = this.currentJacarandaBloom;
      const b = this.currentJacarandaBloom;
      const colA = new THREE.Color();
      const colB = new THREE.Color();

      for (let i = 0; i < this.jacarandaMeta.length; i++) {
        const meta = this.jacarandaMeta[i];
        colA.setHex(meta.greenHex);
        colB.setHex(meta.bloomHex1);
        colA.lerp(colB, b);
        this.jacarandaCrownLow.setColorAt(i, colA);

        colA.setHex(meta.greenHex).offsetHSL(0, 0.02, 0.04);
        colB.setHex(meta.bloomHex2);
        colA.lerp(colB, b);
        this.jacarandaCrownHigh.setColorAt(i, colA);
      }

      if (this.jacarandaCrownLow.instanceColor) {
        this.jacarandaCrownLow.instanceColor.needsUpdate = true;
      }
      if (this.jacarandaCrownHigh.instanceColor) {
        this.jacarandaCrownHigh.instanceColor.needsUpdate = true;
      }
    }

    if (this.petalsMesh) {
      const showPetals = this.currentJacarandaBloom > 0.18;
      this.petalsMesh.visible = showPetals;
      if (showPetals) {
        const petalScale = THREE.MathUtils.clamp(
          (this.currentJacarandaBloom - 0.18) / 0.82,
          0.1,
          1,
        );
        for (let i = 0; i < this.petalSims.length; i++) {
          const p = this.petalSims[i];
          const cyc = ((elapsed * p.fallSpeed + p.phase) % 1 + 1) % 1;
          const py = p.heightSpan * (1 - cyc) + 0.05;
          const px = p.baseX + Math.sin(elapsed * 2.1 + p.phase) * p.swayAmp;
          const pz = p.baseZ + Math.cos(elapsed * 1.7 + p.phase) * p.swayAmp;
          this.petalDummy.position.set(px, py, pz);
          this.petalDummy.rotation.set(
            elapsed * 1.6 + p.phase,
            elapsed * 2.2,
            p.phase,
          );
          this.petalDummy.scale.setScalar(petalScale);
          this.petalDummy.updateMatrix();
          this.petalsMesh.setMatrixAt(i, this.petalDummy.matrix);
        }
        this.petalsMesh.instanceMatrix.needsUpdate = true;
      }
    }
  }

  public tickAnimations(delta: number, elapsed: number) {
    // 0. CDMX Jacaranda seasonal bloom & petals
    this.updateJacarandaColors(delta, elapsed);

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

      // 2. TAQUERIA warm golden-orange celebration pulse
      if (entry.flashRemaining > 0) {
        entry.flashRemaining = Math.max(0, entry.flashRemaining - delta);
        if (entry.flashRemaining > 0) {
          const pulse = 0.55 + 0.45 * Math.sin(elapsed * 18);
          entry.shellMaterial.color.setHex(0xffb703);
          entry.shellMaterial.emissive.setHex(0xf97316);
          entry.shellMaterial.emissiveIntensity = 0.45 + pulse * 0.8;
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

    // 4. Pink Axolotl periodic crossing across site & internal road
    if (this.axolotlGroup) {
      if (!this.axolotlActive) {
        this.axolotlTimer += delta;
        if (this.axolotlTimer >= 22) {
          this.axolotlActive = true;
          this.axolotlProgress = 0;
          this.axolotlTimer = 0;
          this.axolotlRouteFlip = !this.axolotlRouteFlip;
          this.axolotlGroup.visible = true;
        }
      } else {
        this.axolotlProgress += delta / 6.5; // ~6.5s brisk trot across site & roads
        if (this.axolotlProgress >= 1) {
          this.axolotlActive = false;
          this.axolotlGroup.visible = false;
        } else {
          const t = this.axolotlProgress;
          const startZ = this.axolotlRouteFlip ? -7.2 : 7.2;
          const endZ = this.axolotlRouteFlip ? 7.2 : -7.2;
          const ax = 2.6 + Math.sin(t * Math.PI * 2) * 0.65;
          const az = THREE.MathUtils.lerp(startZ, endZ, t);
          const nextZ = THREE.MathUtils.lerp(startZ, endZ, Math.min(1, t + 0.02));
          const nextX = 2.6 + Math.sin(Math.min(1, t + 0.02) * Math.PI * 2) * 0.65;

          // Hop slightly higher over the road deck (y=0.25) so it stays clearly visible
          const onRoad =
            Math.abs(az - 5.5) < 0.7 || Math.abs(az - -2.5) < 0.7;
          const baseY = onRoad ? 0.27 : 0.02;
          const trotBob = Math.abs(Math.sin(elapsed * 16)) * 0.06;

          this.axolotlGroup.position.set(ax, baseY + trotBob, az);
          this.axolotlGroup.rotation.y = Math.atan2(nextX - ax, nextZ - az);

          if (this.axolotlTail) {
            this.axolotlTail.rotation.y = Math.sin(elapsed * 18) * 0.35;
          }
          for (let i = 0; i < this.axolotlLegs.length; i++) {
            const sign = i % 2 === 0 ? 1 : -1;
            this.axolotlLegs[i].rotation.x = Math.sin(elapsed * 18) * 0.55 * sign;
          }
        }
      }
    }

    // 5. Vehicles movement + Axolotl yield stop + horn headlight flash
    if (this.vehicleGroup.visible) {
      if (this.axolotlActive && this.axolotlGroup) {
        _axolotlPos.copy(this.axolotlGroup.position);
      }

      for (const v of this.vehicles) {
        // Any vehicle on DROGA_WEWNETRZNA immediately brakes & waits while Axolotl crosses near it
        let yieldStop = false;
        if (
          this.axolotlActive &&
          (v.mode === 'internal_loop' || v.mode === 'internal_spur')
        ) {
          const dx = v.group.position.x - _axolotlPos.x;
          const dz = v.group.position.z - _axolotlPos.z;
          const distSq = dx * dx + dz * dz;
          if (distSq < 2.2 * 2.2) {
            yieldStop = true;
          }
        }

        if (!yieldStop) {
          v.progress = (v.progress + delta * v.speed) % 1;
        }

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
          // Mirrored (z = +1.5 instead of -1.5)
          v.group.position.set(x, 0.25, 1.5 + (goingEast ? 0.18 : -0.18));
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

    // 6. Majestic Eagle with green snake gliding periodically overhead
    if (this.eagleGroup && this.eagleLeftWing && this.eagleRightWing) {
      if (!this.eagleActive) {
        this.eagleTimer += delta;
        if (this.eagleTimer >= 30) {
          this.eagleActive = true;
          this.eagleProgress = 0;
          this.eagleTimer = 0;
          this.eagleReverse = !this.eagleReverse;
          this.eagleGroup.visible = true;
        }
      } else {
        this.eagleProgress += delta / 7.2;
        if (this.eagleProgress >= 1) {
          this.eagleActive = false;
          this.eagleGroup.visible = false;
        } else {
          const t = this.eagleProgress;
          const sx = this.eagleReverse ? 24 : -24;
          const ex = this.eagleReverse ? -24 : 24;
          const sz = this.eagleReverse ? 10 : -11;
          const ez = this.eagleReverse ? -9 : 11;

          const x = THREE.MathUtils.lerp(sx, ex, t);
          const z = THREE.MathUtils.lerp(sz, ez, t) + Math.sin(t * Math.PI * 2) * 2.4;
          const y = 6.8 + Math.sin(t * Math.PI) * 1.4;

          const nx = THREE.MathUtils.lerp(sx, ex, Math.min(1, t + 0.02));
          const nz =
            THREE.MathUtils.lerp(sz, ez, Math.min(1, t + 0.02)) +
            Math.sin(Math.min(1, t + 0.02) * Math.PI * 2) * 2.4;

          this.eagleGroup.position.set(x, y, z);
          this.eagleGroup.rotation.y = Math.atan2(nx - x, nz - z);
          this.eagleGroup.rotation.z = Math.cos(t * Math.PI * 2) * 0.14;

          const flap = Math.sin(elapsed * 7.5) * 0.48;
          this.eagleLeftWing.rotation.z = -flap;
          this.eagleRightWing.rotation.z = flap;
        }
      }
    }

    // 7. Small glowing UFO rapid flyby (triggered at 35% & 80% timeline progress)
    if (this.ufoGroup && this.ufoActive) {
      this.ufoElapsed += delta;
      const ufoDur = 1.65;
      const t = Math.min(1, this.ufoElapsed / ufoDur);
      if (t >= 1) {
        this.ufoActive = false;
        this.ufoGroup.visible = false;
      } else {
        const sx = this.ufoReverse ? 25 : -25;
        const ex = this.ufoReverse ? -25 : 25;
        const sz = this.ufoReverse ? -9 : 8;
        const ez = this.ufoReverse ? 9 : -8;

        const x = THREE.MathUtils.lerp(sx, ex, t);
        const z = THREE.MathUtils.lerp(sz, ez, t) + Math.sin(t * Math.PI) * 3.0;
        const y = 5.4 + Math.sin(t * Math.PI * 2) * 0.7;

        this.ufoGroup.position.set(x, y, z);
        this.ufoGroup.rotation.y = elapsed * 8.5;
        this.ufoGroup.rotation.z = 0.18;
      }
    }

    // 8. Polish Christmas Spruce twinkling lights & rotating Star (Dec/Jan)
    if (this.isHoliday && this.spruceOrnamentsGroup) {
      for (const l of this.spruceLights) {
        l.mat.emissiveIntensity = 0.7 + 0.9 * (0.5 + 0.5 * Math.sin(elapsed * 5.2 + l.phase));
      }
      if (this.spruceStar) {
        this.spruceStar.rotation.y = elapsed * 1.3;
      }
    }

    // 9. Santa Claus on Harley-Davidson chopper cruising roads in Dec/Jan
    if (this.isHoliday && this.santaGroup) {
      if (this.santaFlashRemaining > 0) {
        this.santaFlashRemaining = Math.max(0, this.santaFlashRemaining - delta);
      }
      if (this.santaHeadLightMat) {
        this.santaHeadLightMat.emissiveIntensity =
          this.santaFlashRemaining > 0 ? 5.2 : 2.2;
      }

      if (!this.santaActive) {
        this.santaTimer += delta;
        if (this.santaTimer >= 10) {
          this.santaActive = true;
          this.santaProgress = 0;
          this.santaTimer = 0;
          this.santaGroup.visible = true;
        }
      } else {
        let yieldStop = false;
        if (this.axolotlActive && this.axolotlGroup) {
          const dx = this.santaGroup.position.x - this.axolotlGroup.position.x;
          const dz = this.santaGroup.position.z - this.axolotlGroup.position.z;
          if (dx * dx + dz * dz < 2.2 * 2.2) {
            yieldStop = true;
          }
        }

        if (!yieldStop) {
          this.santaProgress += delta / 20.0;
        }

        if (this.santaProgress >= 1) {
          this.santaActive = false;
          this.santaGroup.visible = false;
          this.santaTimer = 4.5;
        } else {
          const pts = this.santaRouteWaypoints;
          const segLens = [7.0, 6.5, 4.0, 21.0, 8.0, 21.0, 4.0, 6.5, 10.0];
          const totalLen = 88.0;
          let dist = this.santaProgress * totalLen;
          let segIdx = 0;
          for (let i = 0; i < segLens.length; i++) {
            if (dist <= segLens[i] || i === segLens.length - 1) {
              segIdx = i;
              break;
            }
            dist -= segLens[i];
          }
          const p0 = pts[segIdx];
          const p1 = pts[segIdx + 1];
          const t = THREE.MathUtils.clamp(dist / segLens[segIdx], 0, 1);
          const x = THREE.MathUtils.lerp(p0.x, p1.x, t);
          const z = THREE.MathUtils.lerp(p0.y, p1.y, t);
          const rumbleBob = Math.sin(elapsed * 28) * 0.012;
          this.santaGroup.position.set(x, 0.25 + rumbleBob, z);
          this.santaGroup.rotation.y = Math.atan2(p1.x - p0.x, p1.y - p0.y);
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
