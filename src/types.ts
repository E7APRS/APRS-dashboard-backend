export interface Position {
  radioId: string;
  callsign: string;
  lat: number;
  lon: number;
  altitude?: number;
  speed?: number;
  course?: number;
  comment?: string;
  symbol?: string;       // APRS symbol code e.g. '-', '#', '['
  symbolTable?: string;  // '/' = primary table, '\' = alternate table
  timestamp: string;
  source: 'aprsfi' | 'aprsis' | 'simulator' | 'fixed' | 'dmr';
}

export interface Device {
  radioId: string;
  callsign: string;
  lastSeen: string;
  lastPosition: Position;
}

export type DataSource = 'aprsfi' | 'aprsis' | 'simulator' | 'fixed' | 'dmr';
