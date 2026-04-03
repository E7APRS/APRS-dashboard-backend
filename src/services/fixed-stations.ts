import { Position } from '../types';

interface FixedStation {
  radioId:  string;
  callsign: string;
  lat:      number;
  lon:      number;
  symbol:   string;
  comment:  string;
}

const STATIONS: FixedStation[] = [
  {
    radioId:  'E70AB',
    callsign: 'E70AB',
    lat:      44.534722,  // 44°32'05.0"N
    lon:      18.662583,  // 18°39'45.3"E
    symbol:   '-',
    comment:  'E70AB shack',
  },
  {
    radioId:  'E74BMN',
    callsign: 'E74BMN',
    lat:      44.533694,  // 44°32'01.3"N
    lon:      18.655361,  // 18°39'19.3"E
    symbol:   'y',
    comment:  'Radio klub ``Kreka``',
  },
];

const BROADCAST_INTERVAL_MS = 30_000; // re-broadcast every 30s so map stays fresh

export function startFixedStations(onPosition: (pos: Position) => void): () => void {
  function broadcast(): void {
    const now = new Date().toISOString();
    for (const s of STATIONS) {
      onPosition({
        radioId:   s.radioId,
        callsign:  s.callsign,
        lat:       s.lat,
        lon:       s.lon,
        speed:     0,
        course:    0,
        symbol:    s.symbol,
        comment:   s.comment,
        timestamp: now,
        source:    'fixed',
      });
    }
  }

  broadcast(); // immediate on start
  const timer = setInterval(broadcast, BROADCAST_INTERVAL_MS);

  console.log(`[fixed-stations] ${STATIONS.length} station(s) loaded`);
  return () => clearInterval(timer);
}
