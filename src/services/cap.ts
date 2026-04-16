/**
 * CAP (Common Alerting Protocol) feed ingestion.
 *
 * Polls CAP XML feeds at configured intervals, parses alert polygons and
 * metadata, and broadcasts them to connected clients.
 */
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

function parseCapXml(xml: string): CapAlert[] {
  const alerts: CapAlert[] = [];

  // Simple regex-based XML parsing (no external XML dep needed for CAP's flat structure)
  const alertRegex = /<alert>([\s\S]*?)<\/alert>/gi;
  let alertMatch;

  while ((alertMatch = alertRegex.exec(xml)) !== null) {
    const block = alertMatch[1];

    const getText = (tag: string, source: string = block): string => {
      const m = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(source);
      return m ? m[1].trim() : '';
    };

    const id = getText('identifier');
    if (!id) continue;

    // Parse info blocks
    const infoRegex = /<info>([\s\S]*?)<\/info>/gi;
    let infoMatch;
    const areas: CapAlert['areas'] = [];
    let headline = '';
    let description = '';
    let severity = '';
    let urgency = '';
    let certainty = '';
    let expires = '';

    while ((infoMatch = infoRegex.exec(block)) !== null) {
      const info = infoMatch[1];
      headline = headline || getText('headline', info);
      description = description || getText('description', info);
      severity = severity || getText('severity', info);
      urgency = urgency || getText('urgency', info);
      certainty = certainty || getText('certainty', info);
      expires = expires || getText('expires', info);

      // Parse area blocks
      const areaRegex = /<area>([\s\S]*?)<\/area>/gi;
      let areaMatch;
      while ((areaMatch = areaRegex.exec(info)) !== null) {
        const area = areaMatch[1];
        const areaDesc = getText('areaDesc', area);
        const polygonStr = getText('polygon', area);
        const circleStr = getText('circle', area);

        let polygon: [number, number][] | null = null;
        if (polygonStr) {
          polygon = polygonStr.split(/\s+/).map(pair => {
            const [lat, lon] = pair.split(',').map(Number);
            return [lat, lon] as [number, number];
          }).filter(([lat, lon]) => !isNaN(lat) && !isNaN(lon));
        }

        areas.push({ areaDesc, polygon, circle: circleStr || null });
      }
    }

    alerts.push({
      id,
      sender: getText('sender'),
      sent: getText('sent'),
      status: getText('status'),
      msgType: getText('msgType'),
      headline,
      description,
      severity,
      urgency,
      certainty,
      expires,
      areas,
    });
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
