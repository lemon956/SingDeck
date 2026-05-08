import { describe, expect, it } from 'vitest';
import {
  classifyApiFailure,
  getDelayTestUrl,
  inferControllerFromLocation,
  normalizeControllerUrl,
  parseControllerFromHash,
  validateNecessaryConfig
} from './controller';

describe('controller startup', () => {
  it('parses zashboard-style hash parameters into a single controller config', () => {
    const config = parseControllerFromHash(
      '#/setup?url=http%3A%2F%2F127.0.0.1%3A9090&secret=deck&testUrl=https%3A%2F%2Fcp.cloudflare.com%2Fgenerate_204'
    );

    expect(config).toEqual({
      controllerUrl: 'http://127.0.0.1:9090',
      secret: 'deck',
      defaultTestUrl: 'https://cp.cloudflare.com/generate_204'
    });
  });

  it('normalizes controller urls without trailing slashes', () => {
    expect(normalizeControllerUrl(' http://127.0.0.1:9090/// ')).toBe('http://127.0.0.1:9090');
  });

  it('infers the controller from sing-box hosted /ui/ pages', () => {
    expect(inferControllerFromLocation('http://127.0.0.1:9090', '/ui/')).toBe('http://127.0.0.1:9090');
    expect(inferControllerFromLocation('https://panel.example.com', '/')).toBeNull();
  });
});

describe('necessary config validation', () => {
  it('accepts a config that enables clash_api with an external controller', () => {
    const issues = validateNecessaryConfig(`{
      "experimental": {
        "clash_api": {
          "external_controller": "127.0.0.1:9090",
          "secret": "deck"
        }
      }
    }`);

    expect(issues).toHaveLength(0);
  });

  it('reports only necessary problems and a local safety hint', () => {
    const issues = validateNecessaryConfig(`{
      "experimental": {
        "clash_api": {
          "external_controller": "0.0.0.0:9090"
        }
      }
    }`);

    expect(issues).toEqual([
      expect.objectContaining({
        severity: 'info',
        path: '$.experimental.clash_api.secret'
      })
    ]);
  });

  it('blocks invalid json and missing clash_api', () => {
    expect(validateNecessaryConfig('{')).toEqual([
      expect.objectContaining({ severity: 'error', path: '$' })
    ]);

    expect(validateNecessaryConfig('{"log":{"level":"info"}}')).toEqual([
      expect.objectContaining({ severity: 'error', path: '$.experimental.clash_api' })
    ]);
  });
});

describe('runtime helpers', () => {
  it('classifies common API failures into actionable buckets', () => {
    expect(classifyApiFailure(new Response(null, { status: 401 }))).toMatchObject({
      kind: 'auth',
      title: 'Authentication failed'
    });

    expect(classifyApiFailure(new TypeError('Failed to fetch'))).toMatchObject({
      kind: 'network',
      title: 'Controller unreachable'
    });
  });

  it('uses node test url before group, controller, and panel defaults', () => {
    expect(
      getDelayTestUrl({
        nodeUrl: 'https://node.test/204',
        groupUrl: 'https://group.test/204',
        controllerUrl: 'https://controller.test/204',
        panelDefaultUrl: 'https://panel.test/204'
      })
    ).toBe('https://node.test/204');

    expect(
      getDelayTestUrl({
        groupUrl: 'https://group.test/204',
        controllerUrl: 'https://controller.test/204',
        panelDefaultUrl: 'https://panel.test/204'
      })
    ).toBe('https://group.test/204');

    expect(getDelayTestUrl({})).toBe('https://cp.cloudflare.com/generate_204');
  });
});
