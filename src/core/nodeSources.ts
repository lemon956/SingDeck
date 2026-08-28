import type { CSSProperties } from 'react';

/**
 * Deterministic string hash for consistent color generation
 */
export function sourceNameHash(name: string): number {
  let hash = 2166136261;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Builds deterministic, high-contrast, beautiful tag styles using Golden Ratio HSL distribution
 */
export function buildNodeSourceTagStyles(sourceNames: string[]): Map<string, CSSProperties> {
  const styles = new Map<string, CSSProperties>();
  const uniqueNames = Array.from(new Set(sourceNames)).sort((left, right) => left.localeCompare(right));

  uniqueNames.forEach((sourceName, index) => {
    // Golden ratio conjugate ensures maximum perceptual color separation
    const hash = sourceNameHash(sourceName);
    const hue = Math.round((hash * 137.508 + index * 45) % 360);
    const color = `hsl(${hue}, 88%, 72%)`;
    const background = `hsla(${hue}, 80%, 50%, 0.14)`;
    const border = `hsla(${hue}, 80%, 65%, 0.32)`;

    styles.set(sourceName, {
      '--source-color': color,
      '--source-background': background,
      '--source-border': border
    } as CSSProperties);
  });

  return styles;
}

/**
 * Checks if a given node is permitted by strategy group source restrictions
 */
export function sourceRestrictionAllowsNode(
  nodeName: string,
  nodeIsGroup: boolean,
  allowedSources: Set<string> | string[] | undefined,
  allowUnlabeled: boolean | undefined,
  sourceByNodeName: Map<string, string>,
  restrictionEnabled = true
): boolean {
  if (!restrictionEnabled) {
    return true;
  }
  if (nodeIsGroup) {
    return false;
  }

  const allowedSet =
    allowedSources instanceof Set
      ? allowedSources
      : new Set(Array.isArray(allowedSources) ? allowedSources : []);

  const sourceName = sourceByNodeName.get(nodeName);
  if (sourceName) {
    return allowedSet.has(sourceName);
  }

  return Boolean(allowUnlabeled);
}

/**
 * Formats an ISO datetime string into a human-friendly relative time (e.g. 刚刚, 3分钟前)
 */
export function formatRelativeTime(isoString: string | null | undefined, now = new Date()): string {
  if (!isoString) {
    return '--';
  }

  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return '--';
  }

  const diffMs = now.getTime() - date.getTime();
  if (diffMs < 0) {
    return '刚刚';
  }

  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 45) {
    return '刚刚';
  }

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return `${diffMin} 分钟前`;
  }

  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) {
    return `${diffHours} 小时前`;
  }

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) {
    return `${diffDays} 天前`;
  }

  return date.toLocaleDateString();
}
