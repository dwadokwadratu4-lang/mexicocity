import type {
  BimObject,
  CommissioningPhase,
  DateRange,
  HarmonogramData,
  ObjectProgressState,
} from '../types/bim';

export const DAY_MS = 86_400_000;

export function parseDateMs(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1, 12, 0, 0, 0);
}

export function formatDateIso(ms: number): string {
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function calcRangeProgress(currentMs: number, range: DateRange): number {
  const startMs = parseDateMs(range.start);
  const endMs = parseDateMs(range.koniec);
  if (currentMs < startMs) return 0;
  if (currentMs >= endMs) return 1;
  if (endMs <= startMs) return 1;
  return (currentMs - startMs) / (endMs - startMs);
}

/**
 * Identifies key technological units that receive the global Hot Commissioning (Rozruch Goracy) indicator.
 */
export function isMajorTechObject(obj: BimObject): boolean {
  if (obj.typ === 'chimney') return true;
  if (obj.h >= 2.0) return true;
  if (obj.w * obj.d >= 2.0) return true;
  return false;
}

export function evaluateObjectState(
  obj: BimObject,
  currentMs: number,
  data: HarmonogramData,
): ObjectProgressState {
  const budPct = calcRangeProgress(currentMs, obj.budowlane);
  const techPct = calcRangeProgress(currentMs, obj.technologiczne);
  const elecPct = calcRangeProgress(currentMs, obj.elektryczne);
  const overallPct = (budPct + techPct + elecPct) / 3;
  const hasStarted = budPct > 0 || techPct > 0 || elecPct > 0;

  const coldDays = data.projekt.rozruchZimnyDni ?? 14;
  const allDoneMs = Math.max(
    parseDateMs(obj.budowlane.koniec),
    parseDateMs(obj.technologiczne.koniec),
    parseDateMs(obj.elektryczne.koniec),
  );
  const coldEndMs = allDoneMs + coldDays * DAY_MS;

  const hotStartMs = parseDateMs(data.projekt.etapyGlobalne.rozruchGoracy.start);
  const hotEndMs = parseDateMs(data.projekt.etapyGlobalne.rozruchGoracy.koniec);
  const handoverStartMs = parseDateMs(data.projekt.etapyGlobalne.przekazanie.start);

  let commissioning: CommissioningPhase = 'none';

  if (currentMs >= handoverStartMs) {
    commissioning = 'zakonczenie';
  } else if (
    budPct >= 1 &&
    techPct >= 1 &&
    elecPct >= 1 &&
    currentMs >= allDoneMs &&
    currentMs <= coldEndMs
  ) {
    commissioning = 'rozruch_zimny';
  } else if (
    currentMs >= hotStartMs &&
    currentMs < hotEndMs &&
    isMajorTechObject(obj)
  ) {
    commissioning = 'rozruch_goracy';
  }

  return {
    budPct,
    techPct,
    elecPct,
    overallPct,
    hasStarted,
    commissioning,
  };
}

export function getMilestoneDates(data: HarmonogramData) {
  return [
    { id: 'start', label: 'Start', date: data.projekt.dataStart },
    { id: 'peak', label: 'Szczyt montażu', date: '2027-08-15' },
    {
      id: 'hot',
      label: 'Rozruch Gorący',
      date: data.projekt.etapyGlobalne.rozruchGoracy.start,
    },
    { id: 'end', label: 'Koniec', date: data.projekt.dataKoniec },
  ] as const;
}

export function getGlobalPhaseLabel(currentMs: number, data: HarmonogramData): string {
  const hotStart = parseDateMs(data.projekt.etapyGlobalne.rozruchGoracy.start);
  const handoverStart = parseDateMs(data.projekt.etapyGlobalne.przekazanie.start);
  const endMs = parseDateMs(data.projekt.etapyGlobalne.zakonczenie.start);

  if (currentMs >= endMs) return 'Zakończenie inwestycji';
  if (currentMs >= handoverStart) return 'Przekazanie do eksploatacji';
  if (currentMs >= hotStart) return 'Rozruch Gorący';
  return 'Realizacja robót';
}
