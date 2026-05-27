import { describe, expect, it } from 'vitest';
import { routeFromHash } from './navigation';

describe('navigation routing', () => {
  it('uses overview as the default route', () => {
    expect(routeFromHash('')).toBe('overview');
    expect(routeFromHash('#/')).toBe('overview');
  });

  it('parses hash routes and legacy anchor routes', () => {
    expect(routeFromHash('#/proxies')).toBe('proxies');
    expect(routeFromHash('#config')).toBe('config');
  });

  it('routes setup url parameters to the controller page', () => {
    expect(routeFromHash('#/setup?url=http%3A%2F%2F127.0.0.1%3A9090')).toBe('controller');
  });

  it('folds removed pages into active pages', () => {
    expect(routeFromHash('#/rules')).toBe('controller');
  });

  it('routes tools to the tools workspace', () => {
    expect(routeFromHash('#/tools')).toBe('tools');
  });
});
