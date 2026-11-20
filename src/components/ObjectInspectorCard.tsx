import { Check, X } from 'lucide-react';
import type {
  BimObject,
  HandoverOverride,
  ObjectProgressState,
} from '../types/bim';

interface ObjectInspectorCardProps {
  object: BimObject;
  state: ObjectProgressState;
  override?: HandoverOverride;
  onToggleTechAcceptance: (id: string, nextValue: boolean) => void;
  onToggleElecAcceptance: (id: string, nextValue: boolean) => void;
  onClose: () => void;
}

function getTypeLabel(typ: BimObject['typ']): string {
  if (typ === 'container') return 'Moduł kontenerowy';
  if (typ === 'chimney') return 'Obiekt pionowy';
  return 'Obiekt kubaturowy';
}

function getCommissioningLabel(
  state: ObjectProgressState,
): { text: string; toneClass: string } {
  switch (state.commissioning) {
    case 'rozruch_zimny':
      return {
        text: 'Rozruch Zimny (14 dni)',
        toneClass: 'text-orange-400',
      };
    case 'rozruch_goracy':
      return {
        text: 'Rozruch Gorący',
        toneClass: 'text-red-400',
      };
    case 'zakonczenie':
      return {
        text: 'Przekazanie / Zakończono',
        toneClass: 'text-emerald-400',
      };
    default:
      if (!state.hasStarted) {
        return { text: 'Przed rozpoczęciem', toneClass: 'text-slate-400' };
      }
      if (state.budPct >= 1 && state.techPct >= 1 && state.elecPct >= 1) {
        return { text: 'Roboty zakończone (100%)', toneClass: 'text-emerald-300' };
      }
      return { text: 'W trakcie realizacji', toneClass: 'text-sky-300' };
  }
}

export function ObjectInspectorCard({
  object,
  state,
  override,
  onToggleTechAcceptance,
  onToggleElecAcceptance,
  onClose,
}: ObjectInspectorCardProps) {
  const budPercent = Math.round(state.budPct * 100);
  const techPercent = Math.round(state.techPct * 100);
  const elecPercent = Math.round(state.elecPct * 100);

  const techAccepted =
    override?.techAccepted !== undefined
      ? override.techAccepted
      : techPercent >= 100;
  const elecAccepted =
    override?.elecAccepted !== undefined
      ? override.elecAccepted
      : elecPercent >= 100;

  const status = getCommissioningLabel(state);

  return (
    <aside
      aria-label={`Karta obiektu ${object.id}`}
      className="fixed top-16 left-3 right-3 sm:left-auto sm:right-4 sm:w-88 z-30 rounded-2xl bg-slate-950/95 border border-white/15 shadow-2xl p-3.5 text-slate-100"
    >
      {/* Header: strict code-only confidentiality */}
      <div className="flex items-start justify-between gap-2 pb-2.5 border-b border-white/10">
        <div className="min-w-0">
          <h2 className="text-lg font-bold tracking-tight text-white">
            {object.id}
          </h2>
          <div className="flex items-center gap-1.5 text-xs text-slate-400">
            <span>{getTypeLabel(object.typ)}</span>
            <span aria-hidden="true">·</span>
            <span className={status.toneClass}>{status.text}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Zamknij kartę obiektu"
          className="min-w-[40px] min-h-[40px] -mr-1 -mt-1 flex items-center justify-center rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Progress Bars per Branch */}
      <div className="py-2.5 space-y-2 border-b border-white/10">
        <div>
          <div className="flex justify-between text-xs mb-1">
            <span className="text-slate-300">Budowlane</span>
            <span className="font-mono tabular-nums text-[#f3e8d6]">
              {budPercent}%
            </span>
          </div>
          <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
            <div
              className="h-full bg-[#dfd0b8] transition-all duration-150"
              style={{ width: `${budPercent}%` }}
            />
          </div>
        </div>

        <div>
          <div className="flex justify-between text-xs mb-1">
            <span className="text-slate-300">Technologia</span>
            <span className="font-mono tabular-nums text-blue-300">
              {techPercent}%
            </span>
          </div>
          <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
            <div
              className="h-full bg-blue-500 transition-all duration-150"
              style={{ width: `${techPercent}%` }}
            />
          </div>
        </div>

        <div>
          <div className="flex justify-between text-xs mb-1">
            <span className="text-slate-300">Elektryka</span>
            <span className="font-mono tabular-nums text-emerald-300">
              {elecPercent}%
            </span>
          </div>
          <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
            <div
              className="h-full bg-emerald-500 transition-all duration-150"
              style={{ width: `${elecPercent}%` }}
            />
          </div>
        </div>
      </div>

      {/* Interactive Handover Checkboxes */}
      <div className="pt-2 space-y-1.5">
        <button
          type="button"
          onClick={() => onToggleTechAcceptance(object.id, !techAccepted)}
          className="w-full min-h-[44px] px-2.5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 border border-white/10 flex items-center gap-2.5 text-left transition-colors"
        >
          <span
            className={`w-5 h-5 rounded-md flex items-center justify-center border shrink-0 transition-colors ${
              techAccepted
                ? 'bg-blue-500 border-blue-400 text-white'
                : 'bg-slate-950 border-slate-600 text-transparent'
            }`}
          >
            <Check className="w-3.5 h-3.5 stroke-[3]" />
          </span>
          <span className="text-xs font-medium text-slate-100 leading-snug">
            Odbiór Technologiczny (
            <span className="font-mono tabular-nums">{techPercent}%</span> -{' '}
            {techAccepted ? 'Wykonano' : 'W toku'})
          </span>
        </button>

        <button
          type="button"
          onClick={() => onToggleElecAcceptance(object.id, !elecAccepted)}
          className="w-full min-h-[44px] px-2.5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 border border-white/10 flex items-center gap-2.5 text-left transition-colors"
        >
          <span
            className={`w-5 h-5 rounded-md flex items-center justify-center border shrink-0 transition-colors ${
              elecAccepted
                ? 'bg-emerald-500 border-emerald-400 text-white'
                : 'bg-slate-950 border-slate-600 text-transparent'
            }`}
          >
            <Check className="w-3.5 h-3.5 stroke-[3]" />
          </span>
          <span className="text-xs font-medium text-slate-100 leading-snug">
            Odbiór Elektryczny (
            <span className="font-mono tabular-nums">{elecPercent}%</span> -{' '}
            {elecAccepted ? 'Wykonano' : 'W toku'})
          </span>
        </button>
      </div>
    </aside>
  );
}
