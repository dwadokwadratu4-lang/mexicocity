import { X } from 'lucide-react';

interface HiroMarkerModalProps {
  onClose: () => void;
}

export function HiroMarkerModal({ onClose }: HiroMarkerModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Znacznik HIRO do śledzenia WebAR"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-slate-900 border border-white/15 p-4 text-slate-100 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 pb-3 border-b border-white/10">
          <h2 className="text-base font-semibold text-white">
            Znacznik HIRO (WebAR)
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Zamknij okno znacznika"
            className="min-w-[40px] min-h-[40px] flex items-center justify-center rounded-xl text-slate-400 hover:text-white hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="text-xs text-slate-300 mt-3 mb-3 leading-relaxed">
          Skieruj kamerę telefonu na poniższy czarny kwadratowy znacznik HIRO
          (wydrukowany na białej kartce lub wyświetlony na ekranie monitora).
        </p>

        {/* Authentic ARToolKit patt.hiro marker geometry (25% black border + HIRO in lower inner half) */}
        <div className="bg-white p-5 rounded-xl flex items-center justify-center">
          <svg
            viewBox="0 0 200 200"
            className="w-52 h-52"
            aria-label="Znacznik HIRO"
          >
            <rect x="0" y="0" width="200" height="200" fill="#000000" />
            <rect x="50" y="50" width="100" height="100" fill="#ffffff" />
            <text
              x="100"
              y="138"
              textAnchor="middle"
              fontFamily="Arial, Helvetica, sans-serif"
              fontWeight="900"
              fontSize="35"
              fill="#000000"
              letterSpacing="-1"
            >
              HIRO
            </text>
          </svg>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="mt-3 w-full min-h-[44px] rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 text-sm font-semibold transition-colors"
        >
          Zamknij
        </button>
      </div>
    </div>
  );
}
