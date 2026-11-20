import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import ARToolkitLib from '@ar-js-org/artoolkit5-js';
import type {
  HarmonogramData,
  LayerVisibility,
  ViewMode,
} from '../types/bim';
import {
  BimSiteScene,
  GRID_TO_MARKER_SCALE,
  type ScreenLabelCoord,
} from '../three/SiteBuilder';

export type ARTrackingStatus =
  | 'initializing_camera'
  | 'searching_hiro'
  | 'tracking_hiro'
  | 'locked_on_table'
  | 'camera_error'
  | 'preview_3d';

export interface AREngineCallbacks {
  onStatusChange: (status: ARTrackingStatus, message?: string) => void;
  onSelectObject: (id: string | null) => void;
  onLabelsUpdate: (labels: ScreenLabelCoord[]) => void;
  onObjectDrop: () => void;
}

const _mat4 = new THREE.Matrix4();
const _targetPos = new THREE.Vector3();
const _targetQuat = new THREE.Quaternion();
const _targetScale = new THREE.Vector3();
const _pointerNdc = new THREE.Vector2();
const _raycaster = new THREE.Raycaster();

function detectSoftwareWebGL(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return false;
  }
}

export class AREngine {
  private readonly container: HTMLElement;
  private readonly videoEl: HTMLVideoElement;
  private readonly callbacks: AREngineCallbacks;
  private readonly data: HarmonogramData;

  private readonly isSoftwareGl: boolean;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly arCamera: THREE.PerspectiveCamera;
  private readonly previewCamera: THREE.PerspectiveCamera;
  private readonly orbitControls: OrbitControls;

  private readonly markerRoot: THREE.Group;
  private readonly siteScaleGroup: THREE.Group;
  private readonly previewRoot: THREE.Group;
  public readonly site: BimSiteScene;

  private arController: any = null;
  private hiroMarkerId = -1;
  private detectedInCurrentFrame = false;
  private lastDetectedAt = 0;
  private mediaStream: MediaStream | null = null;
  private arInitStarted = false;

  private viewMode: ViewMode = 'ar';
  private isLockedOnTable = false;
  private currentMs: number;
  private layers: LayerVisibility;
  private labelsBuffer: ScreenLabelCoord[] = [];

  private frameId = 0;
  private disposed = false;
  private readonly clock = new THREE.Clock();
  private pointerDownPos: { x: number; y: number } | null = null;

  constructor(
    container: HTMLElement,
    videoEl: HTMLVideoElement,
    data: HarmonogramData,
    initialDateMs: number,
    initialLayers: LayerVisibility,
    initialTransparency: number,
    callbacks: AREngineCallbacks,
  ) {
    this.container = container;
    this.videoEl = videoEl;
    this.data = data;
    this.currentMs = initialDateMs;
    this.layers = { ...initialLayers };
    this.callbacks = callbacks;

    this.isSoftwareGl = detectSoftwareWebGL();

    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.setPixelRatio(
      this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2),
    );
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x000000, 0);

    const canvas = this.renderer.domElement;
    canvas.style.position = 'absolute';
    canvas.style.top = '50%';
    canvas.style.left = '50%';
    canvas.style.transform = 'translate(-50%, -50%)';
    canvas.style.touchAction = 'none';
    this.container.appendChild(canvas);

    this.scene = new THREE.Scene();

    // Studio environment map for crisp PBR reflections
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    // 3-point outdoor/studio lighting rig
    const hemiLight = new THREE.HemisphereLight(0xdbeafe, 0x57534e, 0.95);
    this.scene.add(hemiLight);

    const keyLight = new THREE.DirectionalLight(0xfff5e4, 1.55);
    keyLight.position.set(16, 28, 18);
    keyLight.castShadow = !this.isSoftwareGl;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.near = 2;
    keyLight.shadow.camera.far = 80;
    const d = 24;
    keyLight.shadow.camera.left = -d;
    keyLight.shadow.camera.right = d;
    keyLight.shadow.camera.top = d;
    keyLight.shadow.camera.bottom = -d;
    keyLight.shadow.bias = -0.0005;
    keyLight.shadow.normalBias = 0.02;
    this.scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0xbae6fd, 0.45);
    rimLight.position.set(-18, 12, -16);
    this.scene.add(rimLight);

    // Cameras
    this.arCamera = new THREE.PerspectiveCamera(45, 16 / 9, 0.05, 100);
    this.arCamera.matrixAutoUpdate = false;

    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.previewCamera = new THREE.PerspectiveCamera(44, w / h, 0.2, 200);
    this.previewCamera.position.set(16, 18, 22);

    this.orbitControls = new OrbitControls(this.previewCamera, canvas);
    this.orbitControls.enableDamping = !this.isSoftwareGl;
    this.orbitControls.dampingFactor = 0.06;
    this.orbitControls.maxPolarAngle = Math.PI / 2 - 0.06;
    this.orbitControls.minDistance = 8;
    this.orbitControls.maxDistance = 58;
    this.orbitControls.target.set(0, 0.8, 0);
    this.orbitControls.enabled = false;

    // Scene roots
    this.markerRoot = new THREE.Group();
    this.markerRoot.visible = false; // MUST stay hidden until HIRO marker is detected
    this.scene.add(this.markerRoot);

    this.siteScaleGroup = new THREE.Group();
    // Rotate +Y (up) onto ARToolKit marker +Z normal (out of paper)
    this.siteScaleGroup.rotation.x = Math.PI / 2;
    this.siteScaleGroup.scale.setScalar(GRID_TO_MARKER_SCALE);
    this.markerRoot.add(this.siteScaleGroup);

    this.previewRoot = new THREE.Group();
    this.previewRoot.visible = false;
    this.scene.add(this.previewRoot);

    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    this.site = new BimSiteScene(this.data, maxAniso, () => {
      this.callbacks.onObjectDrop();
    });
    this.site.setBuildingTransparency(initialTransparency);
    this.site.updateSchedule(this.currentMs, this.layers, false);

    // Attach site to AR marker root by default
    this.siteScaleGroup.add(this.site.root);

    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.previewCamera);
    }

    this.bindEvents();
    this.handleResize();
    this.startLoop();
    void this.startCameraAndAR();
  }

  private bindEvents() {
    window.addEventListener('resize', this.handleResize);
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', this.handlePointerDown);
    canvas.addEventListener('pointerup', this.handlePointerUp);
    canvas.addEventListener('webglcontextlost', this.handleContextLost);
  }

  private handleContextLost = (e: Event) => {
    e.preventDefault();
  };

  private handlePointerDown = (e: PointerEvent) => {
    this.pointerDownPos = { x: e.clientX, y: e.clientY };
  };

  private handlePointerUp = (e: PointerEvent) => {
    if (!this.pointerDownPos) return;
    const dx = e.clientX - this.pointerDownPos.x;
    const dy = e.clientY - this.pointerDownPos.y;
    this.pointerDownPos = null;
    if (Math.hypot(dx, dy) > 12) return; // Dragged, not tapped

    const activeCamera =
      this.viewMode === 'ar' ? this.arCamera : this.previewCamera;
    const rect = this.renderer.domElement.getBoundingClientRect();
    _pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    _pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

    _raycaster.setFromCamera(_pointerNdc, activeCamera);
    const hits = _raycaster.intersectObjects(this.site.clickableMeshes, false);

    if (hits.length > 0) {
      const objectId = hits[0].object.userData.objectId as string | undefined;
      if (objectId) {
        this.site.setSelectedObject(objectId);
        this.callbacks.onSelectObject(objectId);
        return;
      }
    }
    this.site.setSelectedObject(null);
    this.callbacks.onSelectObject(null);
  };

  private handleResize = () => {
    const vw = this.container.clientWidth || window.innerWidth;
    const vh = this.container.clientHeight || window.innerHeight;
    const canvas = this.renderer.domElement;

    if (this.viewMode === 'preview3d') {
      canvas.style.width = `${vw}px`;
      canvas.style.height = `${vh}px`;
      this.previewCamera.aspect = vw / vh;
      this.previewCamera.updateProjectionMatrix();
      this.renderer.setSize(vw, vh, false);
      return;
    }

    // AR mode: keep video & WebGL canvas synced to cover viewport with exact camera aspect
    const vidW = this.videoEl.videoWidth || 640;
    const vidH = this.videoEl.videoHeight || 480;
    const scale = Math.max(vw / vidW, vh / vidH);
    const targetW = Math.round(vidW * scale);
    const targetH = Math.round(vidH * scale);

    this.videoEl.style.width = `${targetW}px`;
    this.videoEl.style.height = `${targetH}px`;
    canvas.style.width = `${targetW}px`;
    canvas.style.height = `${targetH}px`;

    this.renderer.setSize(targetW, targetH, false);
  };

  public async startCameraAndAR() {
    if (this.disposed || this.arInitStarted) return;
    this.arInitStarted = true;
    this.callbacks.onStatusChange('initializing_camera');

    if (!navigator.mediaDevices?.getUserMedia) {
      this.arInitStarted = false;
      this.callbacks.onStatusChange(
        'camera_error',
        'Brak dostępu do interfejsu kamery w tej przeglądarce.',
      );
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });

      if (this.disposed) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      this.mediaStream = stream;
      this.videoEl.srcObject = stream;
      await this.videoEl.play();

      const vw = this.videoEl.videoWidth || 640;
      const vh = this.videoEl.videoHeight || 480;
      this.handleResize();

      const ARControllerCtor =
        (ARToolkitLib as any).ARController ||
        (ARToolkitLib as any).default?.ARController;

      if (!ARControllerCtor) {
        throw new Error('Nie znaleziono kontrolera ARToolKit.');
      }

      const controller = await ARControllerCtor.initWithDimensions(
        vw,
        vh,
        '/ar/camera_para.dat',
      );
      if (this.disposed) {
        controller.dispose();
        return;
      }

      // Adaptive threshold mode handles changing office/outdoor illumination well
      if (
        controller.artoolkit?.AR_LABELING_THRESH_MODE_AUTO_MEDIAN !== undefined
      ) {
        controller.setThresholdMode(
          controller.artoolkit.AR_LABELING_THRESH_MODE_AUTO_MEDIAN,
        );
      }

      const markerId = await controller.loadMarker('/ar/hiro.patt');
      controller.trackPatternMarkerId(markerId, 1);

      this.arCamera.projectionMatrix.fromArray(controller.getCameraMatrix());
      this.arCamera.projectionMatrixInverse
        .copy(this.arCamera.projectionMatrix)
        .invert();

      controller.addEventListener('getMarker', (ev: any) => {
        const marker = ev?.data?.marker;
        if (!marker) return;
        if (marker.idPatt === this.hiroMarkerId && (marker.cfPatt ?? 1) >= 0.35) {
          this.detectedInCurrentFrame = true;
          _mat4.fromArray(ev.data.matrixGL_RH);
        }
      });

      this.hiroMarkerId = markerId;
      this.arController = controller;

      if (this.viewMode === 'ar') {
        this.callbacks.onStatusChange(
          this.isLockedOnTable ? 'locked_on_table' : 'searching_hiro',
        );
      }
    } catch (err) {
      this.arInitStarted = false;
      const msg =
        err instanceof Error
          ? err.message
          : 'Nie udało się uruchomić kamery.';
      this.callbacks.onStatusChange('camera_error', msg);
    }
  }

  public retryCamera() {
    this.stopCameraOnly();
    this.arInitStarted = false;
    void this.startCameraAndAR();
  }

  private stopCameraOnly() {
    if (this.arController) {
      try {
        this.arController.dispose();
      } catch {
        // ignore
      }
      this.arController = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
    this.videoEl.srcObject = null;
  }

  public setViewMode(mode: ViewMode) {
    if (this.viewMode === mode) return;
    this.viewMode = mode;

    if (mode === 'preview3d') {
      this.orbitControls.enabled = true;
      this.previewRoot.add(this.site.root);
      this.previewRoot.visible = true;
      this.markerRoot.visible = false;
      this.scene.background = new THREE.Color(0x0f172a);
      this.scene.fog = new THREE.FogExp2(0x0f172a, 0.011);
      this.callbacks.onStatusChange('preview_3d');
    } else {
      this.orbitControls.enabled = false;
      this.siteScaleGroup.add(this.site.root);
      this.previewRoot.visible = false;
      this.scene.background = null;
      this.scene.fog = null;
      this.markerRoot.visible = this.isLockedOnTable;

      if (!this.arController && !this.arInitStarted) {
        void this.startCameraAndAR();
      } else if (this.arController) {
        this.callbacks.onStatusChange(
          this.isLockedOnTable ? 'locked_on_table' : 'searching_hiro',
        );
      }
    }
    this.handleResize();
  }

  public setLockedOnTable(locked: boolean) {
    this.isLockedOnTable = locked;
    if (this.viewMode === 'ar') {
      if (locked) {
        // If user locks before marker was ever seen, place a centered fallback pose in front of camera
        if (!this.markerRoot.visible) {
          this.markerRoot.position.set(0, -0.25, -2.1);
          this.markerRoot.quaternion.setFromEuler(
            new THREE.Euler(-0.95, 0, 0),
          );
          this.markerRoot.visible = true;
        }
        this.callbacks.onStatusChange('locked_on_table');
      } else {
        this.callbacks.onStatusChange(
          this.arController ? 'searching_hiro' : 'camera_error',
        );
      }
    }
  }

  public setScheduleDate(dateMs: number, allowDropVibration: boolean) {
    this.currentMs = dateMs;
    this.site.updateSchedule(dateMs, this.layers, allowDropVibration);
  }

  public setLayers(layers: LayerVisibility) {
    this.layers = { ...layers };
    this.site.updateSchedule(this.currentMs, this.layers, false);
  }

  public setBuildingTransparency(pct: number) {
    this.site.setBuildingTransparency(pct);
    this.site.updateSchedule(this.currentMs, this.layers, false);
  }

  public selectObject(id: string | null) {
    this.site.setSelectedObject(id);
  }

  private afterDraw(cb: () => void) {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (!gl || typeof gl.fenceSync !== 'function') {
      this.frameId = window.setTimeout(cb, 80);
      return;
    }
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const poll = () => {
      if (this.disposed) return;
      const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
      if (state === gl.UNSIGNALED) {
        this.frameId = window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        this.frameId = window.setTimeout(cb, 80);
      }
    };
    this.frameId = window.setTimeout(poll, 5);
  }

  private startLoop() {
    const tick = () => {
      if (this.disposed) return;

      const delta = Math.min(this.clock.getDelta(), 0.1);
      const elapsed = this.clock.elapsedTime;
      const now = performance.now();

      if (this.viewMode === 'ar') {
        if (
          this.arController &&
          !this.isLockedOnTable &&
          this.videoEl.readyState >= this.videoEl.HAVE_CURRENT_DATA
        ) {
          this.detectedInCurrentFrame = false;
          this.arController.process(this.videoEl);

          if (this.detectedInCurrentFrame) {
            this.lastDetectedAt = now;
            _mat4.decompose(_targetPos, _targetQuat, _targetScale);

            if (!this.markerRoot.visible) {
              this.markerRoot.position.copy(_targetPos);
              this.markerRoot.quaternion.copy(_targetQuat);
              this.markerRoot.visible = true;
              this.callbacks.onStatusChange('tracking_hiro');
            } else {
              const lerpAlpha = 1 - Math.exp(-12 * delta);
              this.markerRoot.position.lerp(_targetPos, lerpAlpha);
              this.markerRoot.quaternion.slerp(_targetQuat, lerpAlpha);
            }
          } else if (this.markerRoot.visible && now - this.lastDetectedAt > 520) {
            this.markerRoot.visible = false;
            this.callbacks.onStatusChange('searching_hiro');
          }
        }
      } else {
        this.orbitControls.update();
      }

      this.site.tickAnimations(delta, elapsed);

      const activeCam =
        this.viewMode === 'ar' ? this.arCamera : this.previewCamera;
      this.renderer.render(this.scene, activeCam);

      if (
        this.layers.labels &&
        ((this.viewMode === 'ar' && this.markerRoot.visible) ||
          this.viewMode === 'preview3d')
      ) {
        const vw = this.container.clientWidth || window.innerWidth;
        const vh = this.container.clientHeight || window.innerHeight;
        const cw = this.renderer.domElement.clientWidth || vw;
        const ch = this.renderer.domElement.clientHeight || vh;
        this.site.projectLabels(activeCam, cw, ch, vw, vh, this.labelsBuffer);
        this.callbacks.onLabelsUpdate(this.labelsBuffer);
      }

      if (this.isSoftwareGl) {
        this.afterDraw(tick);
      } else {
        this.frameId = requestAnimationFrame(tick);
      }
    };

    if (this.isSoftwareGl) {
      this.afterDraw(tick);
    } else {
      this.frameId = requestAnimationFrame(tick);
    }
  }

  public dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    clearTimeout(this.frameId);

    window.removeEventListener('resize', this.handleResize);
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.handlePointerDown);
    canvas.removeEventListener('pointerup', this.handlePointerUp);
    canvas.removeEventListener('webglcontextlost', this.handleContextLost);

    this.stopCameraOnly();
    this.orbitControls.dispose();
    this.site.dispose();
    this.renderer.dispose();
    if (canvas.parentElement) {
      canvas.parentElement.removeChild(canvas);
    }
  }
}
