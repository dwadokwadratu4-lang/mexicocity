import { useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Eye,
  Lock,
  Pause,
  Play,
  Tag,
  Unlock,
} from 'lucide-react';
import type { HarmonogramData, LayerVisibility, ViewMode } from '../types/bim';
import {
  formatDateIso,
  getGlobalPhaseLabel,
  getMilestoneDates,
  parseDateMs,
} from '../utils/schedule';

interface ControlDockProps {
  data: HarmonogramData;
  currentMs: number;
  isPlaying: boolean;
  transparencyPct: number;
  layers: LayerVisibility;
  isLockedOnTable: boolean;
  viewMode: ViewMode;
  onChangeDateMs: (ms: number) => void;
  onTogglePlay: () => void;
  onChangeTransparency: (pct: number) => void;
  onToggleLayer: (key: keyof LayerVisibility) => void;
  onToggleLockOnTable: () => void;
}

export function ControlDock({
  data,
  currentMs,
  isPlaying,
  transparencyPct,
  layers,
  isLockedOnTable,
  viewMode,
  onChangeDateMs,
  onTogglePlay,
  onChangeTransparency,
  onToggleLayer,
  onToggleLockOnTable,
}: ControlDockProps) {
  const [collapsed, setCollapsed] = useState(false);

  const minMs = parseDateMs(data.projekt.dataStart);
  const maxMs = parseDateMs(data.projekt.dataKoniec);
  const currentDateStr = formatDateIso(currentMs);
  const phaseLabel = getGlobalPhaseLabel(currentMs, data);
  const milestones = getMilestoneDates(data);

  return (
    <section
      aria-label="Panel sterowania 4D BIM"
      className="fixed bottom-0 left-0 right-0 z-30 flex flex-col items-center pointer-events-none px-2 pb-2 sm:pb-4"
    >
      <div className="w-full max-w-2xl pointer-events-auto">
        {/* Collapse/Expand trigger */}
        <div className="flex justify-center mb-1">
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="min-h-[36px] px-4 rounded-t-xl bg-slate-950/92 border border-b-0 border-white/15 text-xs font-medium text-slate-200 flex items-center gap-1.5 hover:text-white transition-colors"
          >
            {collapsed ? (
              <>
                <ChevronUp className="w-4 h-4 text-amber-400" />
                <span>Sterowanie</span>
              </>
            ) : (
              <>
                <ChevronDown className="w-4 h-4 text-slate-400" />
                <span>Ukryj panel</span>
              </>
            )}
          </button>
        </div>

        {/* Main Dock Container */}
        <div className="rounded-2xl bg-slate-950/94 border border-white/15 shadow-2xl px-3.5 py-3 sm:px-4 sm:py-3.5">
          {/* Always-visible Timeline Row */}
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onTogglePlay}
              aria-label={isPlaying ? 'Pauza animacji' : 'Odtwórz harmonogram'}
              className="min-w-[44px] min-h-[44px] rounded-xl bg-amber-500 hover:bg-amber-400 active:scale-95 text-slate-950 flex items-center justify-center transition-all shrink-0"
            >
              {isPlaying ? (
                <Pause className="w-5 h-5 fill-current" />
              ) : (
                <Play className="w-5 h-5 fill-current ml-0.5" />
              )}
            </button>

            <div className="flex-1 min-w-0">
              <div className="flex items-baseline justify-between gap-2 mb-0.5">
                <span className="text-xs sm:text-sm font-mono tabular-nums font-semibold text-white">
                  {currentDateStr}
                </span>
                <span className="text-[11px] sm:text-xs text-slate-400 truncate">
                  {phaseLabel}
                </span>
              </div>
              <input
                type="range"
                min={minMs}
                max={maxMs}
                step={86_400_000}
                value={currentMs}
                onChange={(e) => onChangeDateMs(Number(e.target.value))}
                aria-label="Suwak kalendarzowy harmonogramu"
                className="bim-slider"
              />
            </div>
          </div>

          {/* Expanded Controls */}
          {!collapsed && (
            <div className="mt-2.5 pt-2.5 border-t border-white/10 space-y-2.5">
              {/* 4 Quick-Jump Milestone Buttons */}
              <div className="grid grid-cols-4 gap-1.5">
                {milestones.map((m) => {
                  const mMs = parseDateMs(m.date);
                  const isNear = Math.abs(currentMs - mMs) <= 86_400_000 * 2;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => onChangeDateMs(mMs)}
                      className={`min-h-[40px] px-1.5 py-1 rounded-lg text-[11px] sm:text-xs font-medium border transition-colors truncate ${
                        isNear
                          ? 'bg-amber-500/20 border-amber-400/70 text-amber-200'
                          : 'bg-slate-900 border-white/10 text-slate-300 hover:text-white hover:bg-slate-800'
                      }`}
                    >
                      {m.label}
                    </button>
                  );
                })}
              </div>

              {/* Building Shell Transparency Slider */}
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5 text-xs text-slate-300 whitespace-nowrap shrink-0">
                  <Eye className="w-3.5 h-3.5 text-slate-400" />
                  <span>Przezroczystość ścian</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={transparencyPct}
                  onChange={(e) => onChangeTransparency(Number(e.target.value))}
                  aria-label="Przezroczystość ścian budowlanych"
                  className="bim-slider bim-slider-neutral flex-1"
                />
                <span className="w-10 text-right text-xs font-mono tabular-nums text-sky-300 shrink-0">
                  {transparencyPct}%
                </span>
              </div>

              {/* Layer Toggles & Lock on Table */}
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => onToggleLayer('labels')}
                  className={`flex-1 min-w-[96px] min-h-[44px] px-2.5 rounded-xl text-xs font-medium border flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap ${
                    layers.labels
                      ? 'bg-slate-800 border-sky-400/70 text-sky-200'
                      : 'bg-slate-900 border-white/10 text-slate-400'
                  }`}
                >
                  <Tag className="w-3.5 h-3.5 shrink-0" />
                  <span>Etykiety %: {layers.labels ? 'ON' : 'OFF'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => onToggleLayer('budowlane')}
                  className={`flex-1 min-w-[92px] min-h-[44px] px-2.5 rounded-xl text-xs font-medium border transition-colors whitespace-nowrap ${
                    layers.budowlane
                      ? 'bg-[#e4d5bc]/20 border-[#e4d5bc]/70 text-[#f3e8d6]'
                      : 'bg-slate-900 border-white/10 text-slate-400'
                  }`}
                >
                  Budowlane {layers.budowlane ? 'ON' : 'OFF'}
                </button>

                <button
                  type="button"
                  onClick={() => onToggleLayer('technologia')}
                  className={`flex-1 min-w-[96px] min-h-[44px] px-2.5 rounded-xl text-xs font-medium border transition-colors whitespace-nowrap ${
                    layers.technologia
                      ? 'bg-blue-600/25 border-blue-400/70 text-blue-200'
                      : 'bg-slate-900 border-white/10 text-slate-400'
                  }`}
                >
                  Technologia {layers.technologia ? 'ON' : 'OFF'}
                </button>

                <button
                  type="button"
                  onClick={() => onToggleLayer('elektryka')}
                  className={`flex-1 min-w-[88px] min-h-[44px] px-2.5 rounded-xl text-xs font-medium border transition-colors whitespace-nowrap ${
                    layers.elektryka
                      ? 'bg-emerald-600/25 border-emerald-400/70 text-emerald-200'
                      : 'bg-slate-900 border-white/10 text-slate-400'
                  }`}
                >
                  Elektryka {layers.elektryka ? 'ON' : 'OFF'}
                </button>

                {viewMode === 'ar' && (
                  <button
                    type="button"
                    onClick={onToggleLockOnTable}
                    className={`w-full sm:w-auto sm:flex-1 min-w-[140px] min-h-[44px] px-3 rounded-xl text-xs font-semibold border flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap ${
                      isLockedOnTable
                        ? 'bg-emerald-500 border-emerald-400 text-slate-950'
                        : 'bg-slate-900 border-amber-400/50 text-amber-300 hover:bg-slate-800'
                    }`}
                  >
                    {isLockedOnTable ? (
                      <>
                        <Lock className="w-3.5 h-3.5 shrink-0" />
                        <span>Zablokowano na stole</span>
                      </>
                    ) : (
                      <>
                        <Unlock className="w-3.5 h-3.5 shrink-0" />
                        <span>Zablokuj na stole</span>
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
