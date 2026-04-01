import { Position } from '../types';
import { config } from '../config';

// Sarajevo area as starting point
const BASE_LAT = 43.8563;
const BASE_LON = 18.4131;

interface SimRadio {
  radioId: string;
  callsign: string;
  lat: number;
  lon: number;
  bearing: number;
  speed: number; // degrees per tick
}

const radios: SimRadio[] = [
  { radioId: 'SIM001', callsign: 'E73SIM1', lat: BASE_LAT,          lon: BASE_LON,          bearing: 45,  speed: 0.0003 },
  { radioId: 'SIM002', callsign: 'E73SIM2', lat: BASE_LAT + 0.01,   lon: BASE_LON - 0.01,   bearing: 135, speed: 0.0002 },
  { radioId: 'SIM003', callsign: 'E73SIM3', lat: BASE_LAT - 0.005,  lon: BASE_LON + 0.008,  bearing: 270, speed: 0.0004 },
];

function moveRadio(radio: SimRadio): void {
  const rad = (radio.bearing * Math.PI) / 180;
  radio.lat += Math.cos(rad) * radio.speed;
  radio.lon += Math.sin(rad) * radio.speed;

  // Gradually change bearing to simulate natural movement
  radio.bearing = (radio.bearing + (Math.random() * 20 - 10)) % 360;
  if (radio.bearing < 0) radio.bearing += 360;
}

export function startSimulator(onPosition: (pos: Position) => void): () => void {
  console.log('[simulator] Started — interval:', config.simulator.interval, 'ms');

  const interval = setInterval(() => {
    for (const radio of radios) {
      moveRadio(radio);

      onPosition({
        radioId: radio.radioId,
        callsign: radio.callsign,
        lat: parseFloat(radio.lat.toFixed(6)),
        lon: parseFloat(radio.lon.toFixed(6)),
        altitude: Math.round(500 + Math.random() * 200),
        speed: Math.round(radio.speed * 100000),
        course: Math.round(radio.bearing),
        comment: 'Simulated radio',
        timestamp: new Date().toISOString(),
        source: 'simulator',
      });
    }
  }, config.simulator.interval);

  return () => clearInterval(interval);
}
