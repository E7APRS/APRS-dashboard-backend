/**
 * CAP (Common Alerting Protocol) feed ingestion.
 *
 * Polls CAP XML feeds at configured intervals, parses alert polygons and
 * metadata, and broadcasts them to connected clients.
 */
import { XMLParser } from 'fast-xml-parser';
import { config } from '../config';
import { broadcast } from '../socket/index';

export interface CapAlert {
  id: string;
  sender: string;
  sent: string;
  status: string;
  msgType: string;
  headline: string;
  description: string;
  severity: string;
  urgency: string;
  certainty: string;
  expires: string;
  areas: Array<{
    areaDesc: string;
    polygon: [number, number][] | null;
    circle: string | null;
  }>;
}

let activeAlerts: CapAlert[] = [];
let timer: ReturnType<typeof setInterval> | null = null;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  isArray: (name) => ['alert', 'info', 'area'].includes(name),
  removeNSPrefix: true,
});

function parseCapXml(xml: string): CapAlert[] {
  const alerts: CapAlert[] = [];

  try {
    const parsed = xmlParser.parse(xml);

    // Handle both <feed><alert>... and top-level <alert>...
    const root = parsed.feed ?? parsed.alert ?? parsed;
    const alertNodes: unknown[] = Array.isArray(root.alert) ? root.alert
      : Array.isArray(root) ? root
      : root.alert ? [root.alert]
      : [];

    for (const node of alertNodes as Record<string, unknown>[]) {
      const id = String(node.identifier ?? '');
      if (!id) continue;

      const infoNodes: Record<string, unknown>[] = Array.isArray(node.info) ? node.info
        : node.info ? [node.info as Record<string, unknown>] : [];

      const areas: CapAlert['areas'] = [];
      let headline = '';
      let description = '';
      let severity = '';
      let urgency = '';
      let certainty = '';
      let expires = '';

      for (const info of infoNodes) {
        headline = headline || String(info.headline ?? '');
        description = description || String(info.description ?? '');
        severity = severity || String(info.severity ?? '');
        urgency = urgency || String(info.urgency ?? '');
        certainty = certainty || String(info.certainty ?? '');
        expires = expires || String(info.expires ?? '');

        const areaNodes: Record<string, unknown>[] = Array.isArray(info.area) ? info.area
          : info.area ? [info.area as Record<string, unknown>] : [];

        for (const area of areaNodes) {
          const areaDesc = String(area.areaDesc ?? '');
          const polygonStr = String(area.polygon ?? '');
          const circleStr = String(area.circle ?? '');

          let polygon: [number, number][] | null = null;
          if (polygonStr) {
            polygon = polygonStr.split(/\s+/).map(pair => {
              const [lat, lon] = pair.split(',').map(Number);
              return [lat, lon] as [number, number];
            }).filter(([lat, lon]) => !isNaN(lat) && !isNaN(lon));
            if (polygon.length === 0) polygon = null;
          }

          areas.push({ areaDesc, polygon, circle: circleStr || null });
        }
      }

      alerts.push({
        id,
        sender: String(node.sender ?? ''),
        sent: String(node.sent ?? ''),
        status: String(node.status ?? ''),
        msgType: String(node.msgType ?? ''),
        headline,
        description,
        severity,
        urgency,
        certainty,
        expires,
        areas,
      });
    }
  } catch (err) {
    console.warn('[cap] XML parse error:', (err as Error).message);
  }

  return alerts;
}

async function fetchCapFeed(): Promise<void> {
  const { feedUrl } = config.cap;
  if (!feedUrl) return;

  try {
    const res = await fetch(feedUrl, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      console.warn(`[cap] Feed returned ${res.status}`);
      return;
    }

    const xml = await res.text();
    const alerts = parseCapXml(xml);

    // Filter expired alerts
    const now = Date.now();
    activeAlerts = alerts.filter(a => {
      if (!a.expires) return true;
      return new Date(a.expires).getTime() > now;
    });

    broadcast('cap:alerts', activeAlerts);
    console.log(`[cap] Fetched ${alerts.length} alerts, ${activeAlerts.length} active`);
  } catch (err) {
    console.warn('[cap] Fetch error:', (err as Error).message);
  }
}

export function getActiveCapAlerts(): CapAlert[] {
  return activeAlerts;
}

export function startCapPoller(): () => void {
  if (!config.cap.feedUrl) {
    console.log('[cap] No CAP_FEED_URL configured, skipping');
    return () => {};
  }

  console.log(`[cap] Polling ${config.cap.feedUrl} every ${config.cap.pollInterval / 1000}s`);
  fetchCapFeed();
  timer = setInterval(fetchCapFeed, config.cap.pollInterval);

  return () => {
    if (timer) { clearInterval(timer); timer = null; }
    console.log('[cap] Stopped');
  };
}
