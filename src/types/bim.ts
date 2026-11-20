export interface DateRange {
  start: string;
  koniec: string;
}

export interface ProjektConfig {
  nazwa: string;
  autor: string;
  dataStart: string;
  dataKoniec: string;
  rozruchZimnyDni: number;
  etapyGlobalne: {
    rozruchGoracy: DateRange;
    przekazanie: DateRange;
    zakonczenie: DateRange;
  };
}

export interface RoadSegment {
  x: number;
  z: number;
  w: number;
  d: number;
}

export interface RoadConfig {
  id: string;
  typ: 'road';
  wysokosc: number;
  budowlane: DateRange;
  segmenty: RoadSegment[];
}

export interface TerenConfig {
  siatkaSzerokosc: number;
  siatkaGlebokosc: number;
  ogrodzenie: {
    id: string;
    typ: 'fence';
    wysokosc: number;
    budowlane: DateRange;
  };
  drogi: RoadConfig[];
}

export type BimObjectType = 'building' | 'container' | 'chimney';

export interface BimObject {
  id: string;
  typ: BimObjectType;
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  budowlane: DateRange;
  technologiczne: DateRange;
  elektryczne: DateRange;
  demontaz?: string;
}

export interface HarmonogramData {
  projekt: ProjektConfig;
  teren: TerenConfig;
  obiekty: BimObject[];
}

export type CommissioningPhase =
  | 'none'
  | 'rozruch_zimny'
  | 'rozruch_goracy'
  | 'zakonczenie';

export interface ObjectProgressState {
  budPct: number;
  techPct: number;
  elecPct: number;
  overallPct: number;
  hasStarted: boolean;
  commissioning: CommissioningPhase;
}

export interface LayerVisibility {
  labels: boolean;
  budowlane: boolean;
  technologia: boolean;
  elektryka: boolean;
}

export interface HandoverOverride {
  techAccepted?: boolean;
  elecAccepted?: boolean;
}

export type ViewMode = 'ar' | 'preview3d';
