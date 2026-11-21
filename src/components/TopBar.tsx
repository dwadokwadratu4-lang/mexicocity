import { QrCode, Volume2, VolumeX } from 'lucide-react';
import type { ViewMode } from '../types/bim';

interface TopBarProps {
  currentDateStr: string;
  viewMode: ViewMode;
  isMuted: boolean;
  onChangeViewMode: (mode: ViewMode) => void;
  onOpenHiroModal: () => void;
  onToggleMute: () => void;
}

export function TopBar({
  currentDateStr,
  viewMode,
  isMuted,
  onChangeViewMode,
  onOpenHiroModal,
  onToggleMute,
}: TopBarProps) {
  return (
    <header className="fixed top-0 left-0 right-0 z-30 h-13 px-3 sm:px-5 bg-slate-950/92 border-b border-white/10 flex items-center justify-between gap-2">
      <div className="min-w-0 flex items-center gap-2 sm:gap-3">
        <span className="text-xs sm:text-sm font-semibold tracking-tight text-amber-100 truncate">
          MexicoCity | Artur Wierzbicki
        </span>
        <span className="text-slate-600 hidden xs:inline" aria-hidden="true">
          ·
        </span>
        <time
          dateTime={currentDateStr}
          className="text-xs sm:text-sm font-mono tabular-nums font-semibold text-amber-400 whitespace-nowrap shrink-0"
        >
          {currentDateStr}
        </time>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <div
          className="flex items-center p-0.5 rounded-lg bg-slate-900 border border-white/10"
          role="group"
          aria-label="Tryb widoku"
        >
          <button
            type="button"
            onClick={() => onChangeViewMode('ar')}
            className={`px-2.5 min-h-[36px] text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              viewMode === 'ar'
                ? 'bg-amber-500 text-slate-950'
                : 'text-slate-300 hover:text-white'
            }`}
          >
            AR HIRO
          </button>
          <button
            type="button"
            onClick={() => onChangeViewMode('preview3d')}
            className={`px-2.5 min-h-[36px] text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              viewMode === 'preview3d'
                ? 'bg-sky-500 text-slate-950'
                : 'text-slate-300 hover:text-white'
            }`}
          >
            3D
          </button>
        </div>

        <button
          type="button"
          onClick={onToggleMute}
          aria-label={isMuted ? 'Włącz dźwięki' : 'Wycisz dźwięki'}
          title={isMuted ? 'Włącz dźwięki' : 'Wycisz dźwięki'}
          className={`min-w-[40px] min-h-[40px] flex items-center justify-center rounded-lg border transition-colors shrink-0 ${
            isMuted
              ? 'bg-slate-900 border-white/10 text-slate-500 hover:text-slate-300'
              : 'bg-slate-900 border-white/10 text-amber-400 hover:bg-slate-800'
          }`}
        >
          {isMuted ? (
            <VolumeX className="w-4 h-4" />
          ) : (
            <Volume2 className="w-4 h-4" />
          )}
        </button>

        <button
          type="button"
          onClick={onOpenHiroModal}
          aria-label="Pokaż znacznik HIRO"
          title="Pokaż znacznik HIRO"
          className="min-w-[40px] min-h-[40px] flex items-center justify-center rounded-lg bg-slate-900 border border-white/10 text-slate-200 hover:bg-slate-800 hover:text-white transition-colors shrink-0"
        >
          <QrCode className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}
