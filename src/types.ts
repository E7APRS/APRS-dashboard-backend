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
  source: 'aprsfi' | 'aprsis' | 'simulator' | 'fixed' | 'dmr' | 'relay';
}

export interface Device {
  radioId: string;
  callsign: string;
  lastSeen: string;
  lastPosition: Position;
}

export type DataSource = 'aprsfi' | 'aprsis' | 'simulator' | 'fixed' | 'dmr' | 'relay';

export interface UserProfile {
  id: string;
  authId: string;
  email: string;
  firstName: string;
  lastName: string;
  address: string;
  city: string;
  country: string;
  qthLocator: string;
  callsign: string;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
}
