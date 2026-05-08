export type StrategyWallLayoutItem = {
  name: string;
  memberCount: number;
  expanded: boolean;
  collapsed: boolean;
};

export type StrategyWallGroupLike = {
  name: string;
  type: string;
  now: string;
  all: string[];
};

export type StrategyWallProxyLike = {
  type?: string;
  now?: string;
};

export function buildStrategyWallGroups<T extends StrategyWallGroupLike>(input: {
  groups: T[];
  activeName: string | null;
  proxyByName: Map<string, StrategyWallProxyLike>;
  query: string;
}): T[] {
  const normalizedQuery = input.query.trim().toLowerCase();
  if (!normalizedQuery) {
    return input.groups;
  }

  return input.groups.filter((group) => {
    const groupText = `${group.name} ${group.type} ${group.now}`.toLowerCase();
    if (groupText.includes(normalizedQuery)) {
      return true;
    }

    return group.all.some((member) => {
      const memberProxy = input.proxyByName.get(member);
      return `${member} ${memberProxy?.type ?? ''} ${memberProxy?.now ?? ''}`.toLowerCase().includes(normalizedQuery);
    });
  });
}

export function distributeStrategyWallColumns(
  items: StrategyWallLayoutItem[],
  columnCount: number
): string[][] {
  const count = Math.max(1, Math.floor(columnCount));
  const columns = Array.from({ length: count }, () => [] as string[]);

  items.forEach((item, index) => {
    columns[index % count].push(item.name);
  });

  return columns;
}

export function applyStrategyWallOrder<T extends { name: string }>(groups: T[], order: string[]): T[] {
  if (order.length === 0) {
    return groups;
  }

  const groupByName = new Map(groups.map((group) => [group.name, group]));
  const seen = new Set<string>();
  const orderedGroups: T[] = [];

  order.forEach((name) => {
    const group = groupByName.get(name);
    if (!group || seen.has(name)) {
      return;
    }

    orderedGroups.push(group);
    seen.add(name);
  });

  groups.forEach((group) => {
    if (!seen.has(group.name)) {
      orderedGroups.push(group);
    }
  });

  return orderedGroups;
}

export function moveStrategyWallGroupOrder(
  currentOrder: string[],
  sourceName: string,
  targetName: string,
  allNames: string[]
): string[] {
  if (sourceName === targetName) {
    return normalizeStrategyWallOrder(currentOrder, allNames);
  }

  const knownNames = new Set(allNames);
  if (!knownNames.has(sourceName) || !knownNames.has(targetName)) {
    return normalizeStrategyWallOrder(currentOrder, allNames);
  }

  const nextOrder = normalizeStrategyWallOrder(currentOrder, allNames).filter((name) => name !== sourceName);
  const targetIndex = nextOrder.indexOf(targetName);
  if (targetIndex < 0) {
    nextOrder.push(sourceName);
    return nextOrder;
  }

  nextOrder.splice(targetIndex, 0, sourceName);
  return nextOrder;
}

function normalizeStrategyWallOrder(currentOrder: string[], allNames: string[]): string[] {
  const knownNames = new Set(allNames);
  const seen = new Set<string>();
  const normalized: string[] = [];

  currentOrder.forEach((name) => {
    if (!knownNames.has(name) || seen.has(name)) {
      return;
    }

    normalized.push(name);
    seen.add(name);
  });

  allNames.forEach((name) => {
    if (!seen.has(name)) {
      normalized.push(name);
      seen.add(name);
    }
  });

  return normalized;
}

export function selectVisibleStrategyWallMembers<T>(members: T[], options: { collapsed: boolean }): T[] {
  return options.collapsed ? [] : members;
}
