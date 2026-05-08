export const ROUTES = [
  'overview',
  'controller',
  'proxies',
  'connections',
  'logs',
  'config'
] as const;

export type AppRoute = (typeof ROUTES)[number];

export function routeFromHash(hash: string): AppRoute {
  const normalized = hash.replace(/^#\/?/, '').split('?')[0] || 'overview';
  if (normalized === 'settings' || normalized === 'setup') {
    return 'controller';
  }
  if (normalized === 'rules') {
    return 'controller';
  }
  if (normalized === 'tools') {
    return 'overview';
  }

  return isRoute(normalized) ? normalized : 'overview';
}

function isRoute(value: string): value is AppRoute {
  return ROUTES.includes(value as AppRoute);
}
