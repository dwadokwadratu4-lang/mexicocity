import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Compass, QrCode, RotateCcw } from 'lucide-react';
import { AREngine, type ARTrackingStatus } from './ar/AREngine';
import { ControlDock } from './components/ControlDock';
import { HiroMarkerModal } from './components/HiroMarkerModal';
import { ObjectInspectorCard } from './components/ObjectInspectorCard';
import { TopBar } from './components/TopBar';
import type { ScreenLabelCoord } from './three/SiteBuilder';
import type {
  HandoverOverride,
  HarmonogramData,
  LayerVisibility,
  ViewMode,
} from './types/bim';
import {
  DAY_MS,
  evaluateObjectState,
  formatDateIso,
  parseDateMs,
} from './utils/schedule';

export default function App() {
  const [data, setData] = useState<HarmonogramData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [currentMs, setCurrentMs] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [transparencyPct, setTransparencyPct] = useState<number>(30);
  const [layers, setLayers] = useState<LayerVisibility>({
    labels: true,
    budowlane: true,
    technologia: true,
    elektryka: true,
  });
  const [isLockedOnTable, setIsLockedOnTable] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('ar');
  const [arStatus, setArStatus] = useState<ARTrackingStatus>(
    'initializing_camera',
  );
  const [arErrorMsg, setArErrorMsg] = useState<string | null>(null);
  const [selectedObjectId, setSelectedObjectId] = useState<string | null>(null);
  const [handoverOverrides, setHandoverOverrides] = useState<
    Record<string, HandoverOverride>
  >({});
  const [showHiroModal, setShowHiroModal] = useState(false);

  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const engineRef = useRef<AREngine | null>(null);
  const lastVibrateRef = useRef<number>(0);

  // Direct DOM refs for 60fps floating 3D object labels (zero React re-renders per frame)
  const labelContainerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const labelTextRefs = useRef<Record<string, HTMLSpanElement | null>>({});

  // 1. Load external /harmonogram.json
  useEffect(() => {
    let active = true;
    fetch('/harmonogram.json')
      .then((res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return res.json() as Promise<HarmonogramData>;
      })
      .then((json) => {
        if (!active) return;
        setData(json);
        setCurrentMs(parseDateMs(json.projekt.dataStart));
      })
      .catch((err) => {
        if (!active) return;
        setLoadError(
          err instanceof Error
            ? `Nie udało się wczytać harmonogram.json: ${err.message}`
            : 'Nie udało się wczytać harmonogram.json',
        );
      });
    return () => {
      active = false;
    };
  }, []);

  const handleObjectDrop = useCallback(() => {
    const now = performance.now();
    if (now - lastVibrateRef.current < 140) return;
    lastVibrateRef.current = now;
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(100);
    }
  }, []);

  const handleLabelsUpdate = useCallback((coords: ScreenLabelCoord[]) => {
    for (let i = 0; i < coords.length; i++) {
      const c = coords[i];
      const el = labelContainerRefs.current[c.id];
      const txt = labelTextRefs.current[c.id];
      if (!el) continue;
      if (!c.visible) {
        el.style.opacity = '0';
        el.style.pointerEvents = 'none';
        continue;
      }
      el.style.opacity = '1';
      el.style.pointerEvents = 'auto';
      el.style.transform = `translate3d(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px, 0) translate(-50%, -110%)`;
      if (txt) {
        txt.textContent = `${c.id} · ${c.overallPct}%`;
      }
    }
  }, []);

  // 2. Mount WebAR + Three.js engine once data is loaded
  useEffect(() => {
    if (!data || !canvasHostRef.current || !videoRef.current) return;

    const engine = new AREngine(
      canvasHostRef.current,
      videoRef.current,
      data,
      parseDateMs(data.projekt.dataStart),
      {
        labels: true,
        budowlane: true,
        technologia: true,
        elektryka: true,
      },
      30,
      {
        onStatusChange: (status, message) => {
          setArStatus(status);
          setArErrorMsg(message ?? null);
        },
        onSelectObject: (id) => {
          setSelectedObjectId(id);
        },
        onLabelsUpdate: handleLabelsUpdate,
        onObjectDrop: handleObjectDrop,
      },
    );

    engineRef.current = engine;
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, [data, handleLabelsUpdate, handleObjectDrop]);

  // 3. Sync schedule date to 3D scene
  useEffect(() => {
    if (!engineRef.current || !data) return;
    engineRef.current.setScheduleDate(currentMs, true);
  }, [currentMs, data]);

  // 4. Sync layers & wall transparency
  useEffect(() => {
    if (!engineRef.current) return;
    engineRef.current.setLayers(layers);
  }, [layers]);

  useEffect(() => {
    if (!engineRef.current) return;
    engineRef.current.setBuildingTransparency(transparencyPct);
  }, [transparencyPct]);

  // 5. Auto-play timeline animation
  useEffect(() => {
    if (!isPlaying || !data) return;
    const endMs = parseDateMs(data.projekt.dataKoniec);
    let lastTime = performance.now();
    let raf = 0;

    const step = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;
      setCurrentMs((prev) => {
        const next = prev + dt * 55 * DAY_MS; // ~55 days per second
        if (next >= endMs) {
          setIsPlaying(false);
          return endMs;
        }
        return next;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, data]);

  const handleChangeViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    engineRef.current?.setViewMode(mode);
  };

  const handleToggleLock = () => {
    const next = !isLockedOnTable;
    setIsLockedOnTable(next);
    engineRef.current?.setLockedOnTable(next);
  };

  const handleToggleLayer = (key: keyof LayerVisibility) => {
    setLayers((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleSelectFromLabel = (id: string) => {
    setSelectedObjectId(id);
    engineRef.current?.selectObject(id);
  };

  const handleCloseInspector = () => {
    setSelectedObjectId(null);
    engineRef.current?.selectObject(null);
  };

  const handleToggleTechAcceptance = (id: string, nextValue: boolean) => {
    setHandoverOverrides((prev) => ({
      ...prev,
      [id]: { ...prev[id], techAccepted: nextValue },
    }));
  };

  const handleToggleElecAcceptance = (id: string, nextValue: boolean) => {
    setHandoverOverrides((prev) => ({
      ...prev,
      [id]: { ...prev[id], elecAccepted: nextValue },
    }));
  };

  const selectedObject = useMemo(() => {
    if (!data || !selectedObjectId) return null;
    return data.obiekty.find((o) => o.id === selectedObjectId) ?? null;
  }, [data, selectedObjectId]);

  const selectedState = useMemo(() => {
    if (!data || !selectedObject) return null;
    return evaluateObjectState(selectedObject, currentMs, data);
  }, [data, selectedObject, currentMs]);

  const showFloatingLabels =
    layers.labels &&
    (viewMode === 'preview3d' ||
      arStatus === 'tracking_hiro' ||
      arStatus === 'locked_on_table');

  if (loadError) {
    return (
      <main className="w-full h-full bg-slate-950 text-slate-100 flex items-center justify-center p-6">
        <div className="max-w-md rounded-2xl bg-slate-900 border border-red-500/40 p-5 text-center space-y-3">
          <h1 className="text-base font-semibold text-white">
            Błąd ładowania harmonogramu
          </h1>
          <p className="text-xs text-slate-300">{loadError}</p>
        </div>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="w-full h-full bg-slate-950 text-slate-100 flex items-center justify-center p-6">
        <div className="text-sm font-medium text-slate-300">
          Ładowanie harmonogramu 4D BIM…
        </div>
      </main>
    );
  }

  const currentDateStr = formatDateIso(currentMs);

  return (
    <div className="relative w-full h-full bg-slate-950 overflow-hidden select-none">
      {/* Live Camera Feed Layer (AR Mode) */}
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none ${
          viewMode === 'ar' ? 'opacity-100' : 'opacity-0'
        }`}
      />

      {/* Dedicated WebGL Mount Container (never unmounted by React HUD changes) */}
      <div
        ref={canvasHostRef}
        className="absolute inset-0 overflow-hidden"
      />

      {/* Top Bar */}
      <TopBar
        currentDateStr={currentDateStr}
        viewMode={viewMode}
        onChangeViewMode={handleChangeViewMode}
        onOpenHiroModal={() => setShowHiroModal(true)}
      />

      {/* 3D Floating Code + % Labels Overlay */}
      {showFloatingLabels && (
        <div className="fixed inset-0 z-10 pointer-events-none overflow-hidden">
          {data.obiekty.map((obj) => (
            <button
              key={obj.id}
              type="button"
              ref={(el) => {
                labelContainerRefs.current[obj.id] = el;
              }}
              onClick={() => handleSelectFromLabel(obj.id)}
              style={{ opacity: 0, transform: 'translate3d(-999px,-999px,0)' }}
              className={`absolute top-0 left-0 px-2 py-1 rounded-lg border text-[11px] font-mono tabular-nums font-semibold shadow-md transition-opacity duration-75 whitespace-nowrap ${
                selectedObjectId === obj.id
                  ? 'bg-amber-500 border-white text-slate-950'
                  : 'bg-slate-950/90 border-white/25 text-white hover:border-amber-400'
              }`}
            >
              <span
                ref={(el) => {
                  labelTextRefs.current[obj.id] = el;
                }}
              >
                {obj.id} · 0%
              </span>
            </button>
          ))}
        </div>
      )}

      {/* AR HIRO Search Reticle (shown only while waiting for marker) */}
      {viewMode === 'ar' &&
        (arStatus === 'searching_hiro' || arStatus === 'initializing_camera') && (
          <div className="fixed inset-0 z-20 pointer-events-none flex flex-col items-center justify-center px-6 pb-28">
            <div className="relative w-48 h-48 sm:w-56 sm:h-56">
              <span className="absolute top-0 left-0 w-7 h-7 border-t-3 border-l-3 border-amber-400 rounded-tl-lg" />
              <span className="absolute top-0 right-0 w-7 h-7 border-t-3 border-r-3 border-amber-400 rounded-tr-lg" />
              <span className="absolute bottom-0 left-0 w-7 h-7 border-b-3 border-l-3 border-amber-400 rounded-bl-lg" />
              <span className="absolute bottom-0 right-0 w-7 h-7 border-b-3 border-r-3 border-amber-400 rounded-br-lg" />
            </div>

            <div className="mt-4 px-3.5 py-2 rounded-xl bg-slate-950/90 border border-white/15 text-center max-w-xs pointer-events-auto">
              <p className="text-xs font-medium text-slate-100">
                {arStatus === 'initializing_camera'
                  ? 'Uruchamianie kamery AR…'
                  : 'Skieruj kamerę na czarny znacznik HIRO'}
              </p>
              <div className="mt-2 flex items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowHiroModal(true)}
                  className="min-h-[36px] px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 flex items-center gap-1.5"
                >
                  <QrCode className="w-3.5 h-3.5 text-amber-400" />
                  <span>Znacznik HIRO</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleChangeViewMode('preview3d')}
                  className="min-h-[36px] px-3 rounded-lg bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/40 text-xs text-sky-200 flex items-center gap-1.5"
                >
                  <Compass className="w-3.5 h-3.5" />
                  <span>Podgląd 3D</span>
                </button>
              </div>
            </div>
          </div>
        )}

      {/* Camera Permission / Fallback Prompt */}
      {viewMode === 'ar' && arStatus === 'camera_error' && (
        <div className="fixed inset-0 z-20 flex items-center justify-center px-5 pb-28 pointer-events-none">
          <div className="pointer-events-auto max-w-sm w-full rounded-2xl bg-slate-950/95 border border-white/15 p-4 text-center shadow-2xl space-y-3">
            <div className="w-11 h-11 rounded-xl bg-amber-500/15 border border-amber-400/30 text-amber-400 flex items-center justify-center mx-auto">
              <Camera className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white">
                Kamera niedostępna w tym oknie
              </h2>
              <p className="text-xs text-slate-300 mt-1 leading-relaxed">
                {arErrorMsg ||
                  'Zezwól przeglądarce na dostęp do kamery dla trybu WebAR HIRO lub przełącz się na interaktywny podgląd 3D.'}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => engineRef.current?.retryCamera()}
                className="flex-1 min-h-[44px] px-3 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-medium text-white flex items-center justify-center gap-1.5"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Ponów kamerę</span>
              </button>
              <button
                type="button"
                onClick={() => handleChangeViewMode('preview3d')}
                className="flex-1 min-h-[44px] px-3 rounded-xl bg-sky-500 hover:bg-sky-400 text-xs font-semibold text-slate-950 flex items-center justify-center gap-1.5"
              >
                <Compass className="w-3.5 h-3.5" />
                <span>Podgląd 3D</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tapped Building Inspector & Handover Card */}
      {selectedObject && selectedState && (
        <ObjectInspectorCard
          object={selectedObject}
          state={selectedState}
          override={handoverOverrides[selectedObject.id]}
          onToggleTechAcceptance={handleToggleTechAcceptance}
          onToggleElecAcceptance={handleToggleElecAcceptance}
          onClose={handleCloseInspector}
        />
      )}

      {/* Thumb-Zone Bottom Control Dock */}
      <ControlDock
        data={data}
        currentMs={currentMs}
        isPlaying={isPlaying}
        transparencyPct={transparencyPct}
        layers={layers}
        isLockedOnTable={isLockedOnTable}
        viewMode={viewMode}
        onChangeDateMs={(ms) => {
          setIsPlaying(false);
          setCurrentMs(ms);
        }}
        onTogglePlay={() => {
          const endMs = parseDateMs(data.projekt.dataKoniec);
          if (currentMs >= endMs) {
            setCurrentMs(parseDateMs(data.projekt.dataStart));
          }
          setIsPlaying((p) => !p);
        }}
        onChangeTransparency={setTransparencyPct}
        onToggleLayer={handleToggleLayer}
        onToggleLockOnTable={handleToggleLock}
      />

      {/* HIRO Marker Reference Modal */}
      {showHiroModal && (
        <HiroMarkerModal onClose={() => setShowHiroModal(false)} />
      )}
    </div>
  );
}
