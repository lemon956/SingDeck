export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.startsWith('127.');
}

export function isLoopbackUrl(value: string): boolean {
  try {
    return isLoopbackHost(new URL(value).hostname);
  } catch {
    return false;
  }
}

export function buildConfigDownloadUrl(helperUrl: string, pageHostname: string): string {
  try {
    const url = new URL(helperUrl);
    if (isLoopbackHost(url.hostname) && pageHostname && !isLoopbackHost(pageHostname)) {
      url.hostname = pageHostname;
    }
    url.pathname = '/api/v1/config/raw';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

export function resolveConfigDownloadUrl(input: {
  helperUrl: string;
  mobileConfigUrl?: string | null;
  pageHostname: string;
}): string {
  if (input.mobileConfigUrl && !isLoopbackUrl(input.mobileConfigUrl)) {
    return input.mobileConfigUrl;
  }
  if (isLoopbackUrl(input.helperUrl)) {
    return '';
  }
  return buildConfigDownloadUrl(input.helperUrl, input.pageHostname);
}
