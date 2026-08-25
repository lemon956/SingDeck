import type { ConnectionRecord } from './connections';

export type GeoPoint = {
  lng: number;
  lat: number;
};

export type GeoLocation = {
  id: string;
  name: string;
  country: string;
  flag: string;
  coordinates: GeoPoint;
};

export type GeoConnection = {
  id: string;
  connection: ConnectionRecord;
  targetHost: string;
  destinationPort: string;
  destinationIP: string;
  sourceOrigin: GeoLocation;
  proxyLocation?: GeoLocation;
  destinationLocation: GeoLocation;
  isDirect: boolean;
  outboundName: string;
  ruleName: string;
  network: string;
  processPath: string;
  uploadBytes: number;
  downloadBytes: number;
  totalBytes: number;
  curveOffset: number;
  color: string;
};

export type GeoCityHub = {
  id: string;
  location: GeoLocation;
  connectionCount: number;
  asProxyCount: number;
  asDestinationCount: number;
  connections: GeoConnection[];
  downloadBytes: number;
  uploadBytes: number;
  totalBytes: number;
  targetHosts: string[];
};

export const PRESET_CLIENT_ORIGINS: Record<string, GeoLocation> = {
  'cn-east': { id: 'cn-east', name: '上海 / 华东', country: '中国', flag: '🇨🇳', coordinates: { lng: 121.4737, lat: 31.2304 } },
  'cn-north': { id: 'cn-north', name: '北京 / 华北', country: '中国', flag: '🇨🇳', coordinates: { lng: 116.4074, lat: 39.9042 } },
  'cn-south': { id: 'cn-south', name: '广州·深圳 / 华南', country: '中国', flag: '🇨🇳', coordinates: { lng: 113.2644, lat: 23.1291 } },
  'cn-west': { id: 'cn-west', name: '成都·重庆 / 西南', country: '中国', flag: '🇨🇳', coordinates: { lng: 104.0668, lat: 30.5728 } },
  'hk': { id: 'hk', name: '香港特别行政区', country: '中国香港', flag: '🇭🇰', coordinates: { lng: 114.1694, lat: 22.3193 } },
  'tw': { id: 'tw', name: '台北 / 台湾', country: '中国台湾', flag: '🇹🇼', coordinates: { lng: 121.5654, lat: 25.0330 } },
  'sg': { id: 'sg', name: '新加坡', country: '新加坡', flag: '🇸🇬', coordinates: { lng: 103.8198, lat: 1.3521 } },
  'jp': { id: 'jp', name: '东京 / 日本', country: '日本', flag: '🇯🇵', coordinates: { lng: 139.6917, lat: 35.6895 } },
  'us-west': { id: 'us-west', name: '圣何塞 / 美西', country: '美国', flag: '🇺🇸', coordinates: { lng: -121.8863, lat: 37.3382 } },
  'us-east': { id: 'us-east', name: '纽约·弗吉尼亚 / 美东', country: '美国', flag: '🇺🇸', coordinates: { lng: -74.0060, lat: 40.7128 } },
  'eu-west': { id: 'eu-west', name: '法兰克福 / 欧洲', country: '德国', flag: '🇩🇪', coordinates: { lng: 8.6821, lat: 50.1109 } }
};

export const GLOBAL_HUBS: Record<string, GeoLocation> = {
  HK: { id: 'HK', name: '香港', country: '中国香港', flag: '🇭🇰', coordinates: { lng: 114.1772, lat: 22.3027 } },
  'JP-TYO': { id: 'JP-TYO', name: '东京', country: '日本', flag: '🇯🇵', coordinates: { lng: 139.6917, lat: 35.6895 } },
  'JP-OSA': { id: 'JP-OSA', name: '大阪', country: '日本', flag: '🇯🇵', coordinates: { lng: 135.5023, lat: 34.6937 } },
  SG: { id: 'SG', name: '新加坡', country: '新加坡', flag: '🇸🇬', coordinates: { lng: 103.8198, lat: 1.3521 } },
  'US-SJC': { id: 'US-SJC', name: '硅谷/圣何塞', country: '美国', flag: '🇺🇸', coordinates: { lng: -121.8863, lat: 37.3382 } },
  'US-LAX': { id: 'US-LAX', name: '洛杉矶', country: '美国', flag: '🇺🇸', coordinates: { lng: -118.2437, lat: 34.0522 } },
  'US-SEA': { id: 'US-SEA', name: '西雅图', country: '美国', flag: '🇺🇸', coordinates: { lng: -122.3321, lat: 47.6062 } },
  'US-NYC': { id: 'US-NYC', name: '纽约', country: '美国', flag: '🇺🇸', coordinates: { lng: -74.0060, lat: 40.7128 } },
  'US-IAD': { id: 'US-IAD', name: '弗吉尼亚/华盛顿', country: '美国', flag: '🇺🇸', coordinates: { lng: -77.4875, lat: 39.0438 } },
  'US-ORD': { id: 'US-ORD', name: '芝加哥', country: '美国', flag: '🇺🇸', coordinates: { lng: -87.6298, lat: 41.8781 } },
  TW: { id: 'TW', name: '台北', country: '中国台湾', flag: '🇹🇼', coordinates: { lng: 121.5654, lat: 25.0330 } },
  KR: { id: 'KR', name: '首尔', country: '韩国', flag: '🇰🇷', coordinates: { lng: 126.9780, lat: 37.5665 } },
  GB: { id: 'GB', name: '伦敦', country: '英国', flag: '🇬🇧', coordinates: { lng: -0.1278, lat: 51.5074 } },
  DE: { id: 'DE', name: '法兰克福', country: '德国', flag: '🇩🇪', coordinates: { lng: 8.6821, lat: 50.1109 } },
  FR: { id: 'FR', name: '巴黎', country: '法国', flag: '🇫🇷', coordinates: { lng: 2.3522, lat: 48.8566 } },
  NL: { id: 'NL', name: '阿姆斯特丹', country: '荷兰', flag: '🇳🇱', coordinates: { lng: 4.9041, lat: 52.3676 } },
  AU: { id: 'AU', name: '悉尼', country: '澳大利亚', flag: '🇦🇺', coordinates: { lng: 151.2093, lat: -33.8688 } },
  CA: { id: 'CA', name: '多伦多', country: '加拿大', flag: '🇨🇦', coordinates: { lng: -79.3832, lat: 43.6532 } },
  RU: { id: 'RU', name: '莫斯科', country: '俄罗斯', flag: '🇷🇺', coordinates: { lng: 37.6173, lat: 55.7558 } },
  IN: { id: 'IN', name: '孟买', country: '印度', flag: '🇮🇳', coordinates: { lng: 72.8777, lat: 19.0760 } },
  BR: { id: 'BR', name: '圣保罗', country: '巴西', flag: '🇧🇷', coordinates: { lng: -46.6333, lat: -23.5505 } },
  'CN-SHA': { id: 'CN-SHA', name: '上海', country: '中国', flag: '🇨🇳', coordinates: { lng: 121.4737, lat: 31.2304 } },
  'CN-BJS': { id: 'CN-BJS', name: '北京', country: '中国', flag: '🇨🇳', coordinates: { lng: 116.4074, lat: 39.9042 } },
  'CN-CAN': { id: 'CN-CAN', name: '广州/深圳', country: '中国', flag: '🇨🇳', coordinates: { lng: 113.2644, lat: 23.1291 } },
  'CN-DIRECT': { id: 'CN-DIRECT', name: '国内直连', country: '中国', flag: '🇨🇳', coordinates: { lng: 116.4074, lat: 39.9042 } },
  GLOBAL: { id: 'GLOBAL', name: '全球云节点', country: 'Global', flag: '🌐', coordinates: { lng: -98.5795, lat: 39.8283 } }
};

const PROXY_KEYWORD_MAP: Array<{ regex: RegExp; key: keyof typeof GLOBAL_HUBS }> = [
  { regex: /(?:hong\s*kong|hkg|hk|港|香港)/i, key: 'HK' },
  { regex: /(?:osaka|大阪)/i, key: 'JP-OSA' },
  { regex: /(?:japan|jpn|jp|tokyo|日本|东京)/i, key: 'JP-TYO' },
  { regex: /(?:singapore|sgp|sg|sin|新加坡|狮城)/i, key: 'SG' },
  { regex: /(?:taiwan|twn|tw|taipei|台湾|台北)/i, key: 'TW' },
  { regex: /(?:korea|kor|kr|seoul|韩国|首尔)/i, key: 'KR' },
  { regex: /(?:los\s*angeles|lax|洛杉矶)/i, key: 'US-LAX' },
  { regex: /(?:seattle|sea|西雅图)/i, key: 'US-SEA' },
  { regex: /(?:new\s*york|nyc|纽约)/i, key: 'US-NYC' },
  { regex: /(?:virginia|ashburn|iad|弗吉尼亚)/i, key: 'US-IAD' },
  { regex: /(?:chicago|ord|芝加哥)/i, key: 'US-ORD' },
  { regex: /(?:united\s*states|usa|us|america|san\s*jose|silicon|california|oregon|美西|美东|美国|圣何塞|硅谷|加州)/i, key: 'US-SJC' },
  { regex: /(?:united\s*kingdom|britain|uk|gbr|gb|london|英国|伦敦)/i, key: 'GB' },
  { regex: /(?:germany|deu|de|ger|frankfurt|德国|法兰克福)/i, key: 'DE' },
  { regex: /(?:france|fra|fr|paris|法国|巴黎)/i, key: 'FR' },
  { regex: /(?:netherlands|nld|nl|amsterdam|荷兰|阿姆斯特丹)/i, key: 'NL' },
  { regex: /(?:australia|aus|au|sydney|澳大利亚|悉尼)/i, key: 'AU' },
  { regex: /(?:canada|can|ca|toronto|vancouver|加拿大|多伦多)/i, key: 'CA' },
  { regex: /(?:russia|rus|ru|moscow|俄罗斯|莫斯科)/i, key: 'RU' },
  { regex: /(?:india|ind|in|mumbai|印度|孟买)/i, key: 'IN' },
  { regex: /(?:brazil|bra|br|巴西)/i, key: 'BR' },
  { regex: /(?:shanghai|上海)/i, key: 'CN-SHA' },
  { regex: /(?:beijing|北京)/i, key: 'CN-BJS' },
  { regex: /(?:guangzhou|shenzhen|广州|深圳)/i, key: 'CN-CAN' },
  { regex: /(?:direct|local|china|chn|cn|国内|直连|局域网|内网)/i, key: 'CN-DIRECT' }
];

const DOMAIN_KEYWORD_MAP: Array<{ regex: RegExp; key: keyof typeof GLOBAL_HUBS }> = [
  { regex: /\.(?:hk|com\.hk)$/i, key: 'HK' },
  { regex: /\.(?:jp|co\.jp)$/i, key: 'JP-TYO' },
  { regex: /\.(?:sg|com\.sg)$/i, key: 'SG' },
  { regex: /\.(?:tw|com\.tw)$/i, key: 'TW' },
  { regex: /\.(?:kr|co\.kr)$/i, key: 'KR' },
  { regex: /\.(?:uk|co\.uk)$/i, key: 'GB' },
  { regex: /\.(?:de)$/i, key: 'DE' },
  { regex: /\.(?:fr)$/i, key: 'FR' },
  { regex: /\.(?:nl)$/i, key: 'NL' },
  { regex: /\.(?:au|com\.au)$/i, key: 'AU' },
  { regex: /\.(?:ca)$/i, key: 'CA' },
  { regex: /\.(?:ru)$/i, key: 'RU' },
  { regex: /\.(?:in)$/i, key: 'IN' },
  { regex: /\.(?:cn|com\.cn)$/i, key: 'CN-DIRECT' },
  { regex: /(?:bilibili|qq\.com|baidu|taobao|alipay|jd\.com|zhihu|weibo|douyin|tencent|aliyun|163\.com|bytedance|127\.0\.0\.1|localhost)/i, key: 'CN-SHA' },
  { regex: /(?:openai|anthropic|chatgpt|claude|github|microsoft|apple|icloud|google|youtube|twitter|x\.com|facebook|instagram|amazon|netflix|fastly|meta|reddit|discord|spotify)/i, key: 'US-SJC' },
  { regex: /(?:telegram|t\.me)/i, key: 'NL' },
  { regex: /(?:cloudflare|1\.1\.1\.1)/i, key: 'HK' }
];

export function resolveOutboundLocation(outbound: string, chains?: string[]): GeoLocation | null {
  const combined = [outbound, ...(chains ?? [])].join(' ');
  for (const item of PROXY_KEYWORD_MAP) {
    if (item.regex.test(combined)) {
      return GLOBAL_HUBS[item.key];
    }
  }
  return null;
}

export function resolveDestinationLocation(host: string, ip: string, proxyLocation?: GeoLocation | null): GeoLocation {
  const target = `${host} ${ip}`.toLowerCase();

  for (const item of DOMAIN_KEYWORD_MAP) {
    if (item.regex.test(target)) {
      return GLOBAL_HUBS[item.key];
    }
  }

  for (const item of PROXY_KEYWORD_MAP) {
    if (item.regex.test(target)) {
      return GLOBAL_HUBS[item.key];
    }
  }

  if (proxyLocation && proxyLocation.country !== '中国') {
    return proxyLocation;
  }

  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('172.16.') || ip.startsWith('127.')) {
    return GLOBAL_HUBS['CN-DIRECT'];
  }

  return GLOBAL_HUBS.GLOBAL;
}

function computeStringHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

export function buildLiveGeoConnections(
  connections: ConnectionRecord[],
  clientOrigin: GeoLocation = PRESET_CLIENT_ORIGINS['cn-east']
): {
  geoConnections: GeoConnection[];
  cityHubs: GeoCityHub[];
  totalConnections: number;
  totalUploadBytes: number;
  totalDownloadBytes: number;
} {
  const geoConnections: GeoConnection[] = [];
  const cityHubMap = new Map<string, GeoCityHub>();

  let totalUploadBytes = 0;
  let totalDownloadBytes = 0;

  const ensureHub = (location: GeoLocation): GeoCityHub => {
    let hub = cityHubMap.get(location.id);
    if (!hub) {
      hub = {
        id: location.id,
        location,
        connectionCount: 0,
        asProxyCount: 0,
        asDestinationCount: 0,
        connections: [],
        downloadBytes: 0,
        uploadBytes: 0,
        totalBytes: 0,
        targetHosts: []
      };
      cityHubMap.set(location.id, hub);
    }
    return hub;
  };

  ensureHub(clientOrigin);

  connections.forEach((conn, index) => {
    totalUploadBytes += conn.uploadBytes;
    totalDownloadBytes += conn.downloadBytes;

    const proxyLoc = resolveOutboundLocation(conn.outbound, conn.chains);
    const destLoc = resolveDestinationLocation(conn.destinationHost || conn.target, conn.destinationIP, proxyLoc);
    const isDirect = !proxyLoc || proxyLoc.id === 'CN-DIRECT' || conn.outbound.toLowerCase().includes('direct');

    const hash = computeStringHash(conn.id || `${conn.target}-${index}`);
    const curveOffset = ((hash % 9) - 4) * 6; // Fan out curves from -24px to +24px

    let color = '#38bdf8'; // Cyan
    if (isDirect) {
      color = '#34d399'; // Green
    } else if (destLoc.id.startsWith('US')) {
      color = '#a78bfa'; // Purple
    } else if (destLoc.id === 'HK' || destLoc.id.startsWith('JP') || destLoc.id === 'SG') {
      color = '#38bdf8'; // Cyan
    } else {
      color = '#fbbf24'; // Amber
    }

    const hostLabel = conn.destinationHost || conn.target.split(':')[0] || conn.destinationIP;

    const geoConn: GeoConnection = {
      id: conn.id || `conn-${index}`,
      connection: conn,
      targetHost: hostLabel,
      destinationPort: conn.destinationPort || '443',
      destinationIP: conn.destinationIP,
      sourceOrigin: clientOrigin,
      proxyLocation: isDirect ? undefined : proxyLoc ?? undefined,
      destinationLocation: destLoc,
      isDirect,
      outboundName: conn.outbound,
      ruleName: conn.rule || 'Default',
      network: conn.network || 'tcp',
      processPath: conn.processPath || '',
      uploadBytes: conn.uploadBytes,
      downloadBytes: conn.downloadBytes,
      totalBytes: conn.totalBytes,
      curveOffset,
      color
    };

    geoConnections.push(geoConn);

    // Update Hubs
    const destHub = ensureHub(destLoc);
    destHub.connectionCount += 1;
    destHub.asDestinationCount += 1;
    destHub.downloadBytes += conn.downloadBytes;
    destHub.uploadBytes += conn.uploadBytes;
    destHub.totalBytes += conn.totalBytes;
    destHub.connections.push(geoConn);
    if (!destHub.targetHosts.includes(hostLabel) && destHub.targetHosts.length < 10) {
      destHub.targetHosts.push(hostLabel);
    }

    if (proxyLoc && !isDirect) {
      const proxyHub = ensureHub(proxyLoc);
      proxyHub.connectionCount += 1;
      proxyHub.asProxyCount += 1;
      proxyHub.downloadBytes += conn.downloadBytes;
      proxyHub.uploadBytes += conn.uploadBytes;
      proxyHub.totalBytes += conn.totalBytes;
      if (!proxyHub.connections.some((c) => c.id === geoConn.id)) {
        proxyHub.connections.push(geoConn);
      }
    }
  });

  const cityHubs = Array.from(cityHubMap.values()).sort((a, b) => b.connectionCount - a.connectionCount);

  return {
    geoConnections,
    cityHubs,
    totalConnections: connections.length,
    totalUploadBytes,
    totalDownloadBytes
  };
}

/**
 * Convert [lng, lat] to SVG coordinates for Equirectangular projection (1000x500 viewport)
 */
export function projectGeoPoint(point: GeoPoint, width = 1000, height = 500): { x: number; y: number } {
  const x = ((point.lng + 180) / 360) * width;
  const y = ((90 - point.lat) / 180) * height;
  return {
    x: Math.max(0, Math.min(width, x)),
    y: Math.max(0, Math.min(height, y))
  };
}

/**
 * Generate a curved Quadratic Bézier arc path with offset
 */
export function generateCurvedArcPath(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  offset = 0
): string {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist < 4) {
    return `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} L ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }

  // Base curvature based on distance
  const baseCurvature = Math.min(75, Math.max(20, dist * 0.22));
  const midX = (p1.x + p2.x) / 2;
  const midY = (p1.y + p2.y) / 2;

  // Add individual connection offset perpendicular to trajectory
  const ctrlX = midX;
  const ctrlY = midY - baseCurvature + offset;

  return `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} Q ${ctrlX.toFixed(1)} ${ctrlY.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
}
