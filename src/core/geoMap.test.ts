import { describe, expect, it } from 'vitest';
import type { ConnectionRecord } from './connections';
import {
  buildLiveGeoConnections,
  generateCurvedArcPath,
  GLOBAL_HUBS,
  PRESET_CLIENT_ORIGINS,
  projectGeoPoint,
  resolveDestinationLocation,
  resolveOutboundLocation
} from './geoMap';

const mockConnection: ConnectionRecord = {
  id: 'conn-1',
  source: '127.0.0.1:54321',
  sourceIP: '127.0.0.1',
  sourcePort: '54321',
  sourceEndpoint: '127.0.0.1:54321',
  target: 'api.github.com:443',
  destinationHost: 'api.github.com',
  destinationIP: '140.82.112.4',
  destinationPort: '443',
  destinationEndpoint: '140.82.112.4:443',
  network: 'tcp',
  inboundType: 'mixed',
  dnsMode: 'fakeip',
  processPath: '/usr/bin/curl',
  upload: '1.2 KB',
  uploadBytes: 1200,
  download: '45.6 KB',
  downloadBytes: 45600,
  totalBytes: 46800,
  rule: 'Match',
  ruleType: 'default',
  rulePayload: '',
  outbound: 'HK-Node-01',
  chains: ['Proxy', 'HK-Node-01'],
  startedAt: new Date().toISOString()
};

describe('geoMap module', () => {
  it('resolves outbound locations correctly', () => {
    expect(resolveOutboundLocation('HK-01')?.id).toBe('HK');
    expect(resolveOutboundLocation('Tokyo-Server-JP')?.id).toBe('JP-TYO');
    expect(resolveOutboundLocation('Singapore-Node')?.id).toBe('SG');
    expect(resolveOutboundLocation('US-Silicon-Valley')?.id).toBe('US-SJC');
    expect(resolveOutboundLocation('direct')?.id).toBe('CN-DIRECT');
    expect(resolveOutboundLocation('unknown-outbound')).toBeNull();
  });

  it('resolves destination locations correctly', () => {
    expect(resolveDestinationLocation('api.github.com', '140.82.112.4').country).toBe('美国');
    expect(resolveDestinationLocation('bilibili.com', '120.92.12.3').country).toBe('中国');
    expect(resolveDestinationLocation('yahoo.co.jp', '183.79.198.252').country).toBe('日本');
    expect(resolveDestinationLocation('t.me', '149.154.167.99').country).toBe('荷兰');
  });

  it('builds live individual geo connections and city hubs', () => {
    const connections: ConnectionRecord[] = [
      mockConnection,
      {
        ...mockConnection,
        id: 'conn-2',
        target: 'bilibili.com:443',
        destinationHost: 'bilibili.com',
        outbound: 'direct',
        chains: ['direct']
      }
    ];

    const result = buildLiveGeoConnections(connections, PRESET_CLIENT_ORIGINS['cn-east']);
    expect(result.totalConnections).toBe(2);
    expect(result.geoConnections.length).toBe(2);
    expect(result.geoConnections[0].targetHost).toBe('api.github.com');
    expect(result.geoConnections[1].targetHost).toBe('bilibili.com');
    expect(result.cityHubs.length).toBeGreaterThanOrEqual(1);
  });

  it('projects geo points to canvas coordinates', () => {
    const origin = projectGeoPoint({ lng: 0, lat: 0 }, 1000, 500);
    expect(origin.x).toBeCloseTo(500, 0);
    expect(origin.y).toBeCloseTo(250, 0);

    const topLeft = projectGeoPoint({ lng: -180, lat: 90 }, 1000, 500);
    expect(topLeft.x).toBeCloseTo(0, 0);
    expect(topLeft.y).toBeCloseTo(0, 0);
  });

  it('generates curved SVG arc paths with offset', () => {
    const p1 = { x: 100, y: 100 };
    const p2 = { x: 300, y: 100 };
    const path = generateCurvedArcPath(p1, p2, 5);
    expect(path).toContain('M 100');
    expect(path).toContain('Q 200');
  });
});
