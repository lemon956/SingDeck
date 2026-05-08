import { describe, expect, it } from 'vitest';
import {
  applyStrategyWallOrder,
  buildStrategyWallGroups,
  distributeStrategyWallColumns,
  moveStrategyWallGroupOrder,
  selectVisibleStrategyWallMembers
} from './strategyWallLayout';

describe('strategy wall layout', () => {
  it('keeps cards in independent stable columns instead of weight-balanced rows', () => {
    const columns = distributeStrategyWallColumns(
      [
        { name: 'small-a', memberCount: 5, expanded: false, collapsed: false },
        { name: 'large', memberCount: 70, expanded: true, collapsed: false },
        { name: 'small-b', memberCount: 5, expanded: false, collapsed: false },
        { name: 'medium', memberCount: 26, expanded: false, collapsed: false }
      ],
      2
    );

    expect(columns).toEqual([
      ['small-a', 'small-b'],
      ['large', 'medium']
    ]);
  });

  it('does not move groups between columns when expansion state changes', () => {
    const collapsedColumns = distributeStrategyWallColumns(
      [
        { name: 'claude-us', memberCount: 5, expanded: false, collapsed: true },
        { name: 'download-node', memberCount: 26, expanded: false, collapsed: false },
        { name: 'gemini-us', memberCount: 5, expanded: false, collapsed: false },
        { name: 'openai-us', memberCount: 5, expanded: false, collapsed: false }
      ],
      2
    );
    const expandedColumns = distributeStrategyWallColumns(
      [
        { name: 'claude-us', memberCount: 5, expanded: true, collapsed: false },
        { name: 'download-node', memberCount: 26, expanded: false, collapsed: false },
        { name: 'gemini-us', memberCount: 5, expanded: false, collapsed: true },
        { name: 'openai-us', memberCount: 5, expanded: true, collapsed: false }
      ],
      2
    );

    expect(expandedColumns).toEqual(collapsedColumns);
  });

  it('keeps the original group order when a group is selected', () => {
    const groups = [
      { name: 'claude-us', type: 'Selector', now: 'Reality-1', all: [] },
      { name: 'download-node', type: 'Selector', now: '香港 01', all: [] },
      { name: 'openai-us', type: 'Selector', now: '美国 01', all: [] }
    ];

    const result = buildStrategyWallGroups({
      groups,
      activeName: 'openai-us',
      proxyByName: new Map(),
      query: ''
    });

    expect(result.map((group) => group.name)).toEqual(['claude-us', 'download-node', 'openai-us']);
  });

  it('applies manual group order and appends new groups in source order', () => {
    const groups = [
      { name: 'claude-us', type: 'Selector', now: 'Reality-1', all: [] },
      { name: 'download-node', type: 'Selector', now: '香港 01', all: [] },
      { name: 'openai-us', type: 'Selector', now: '美国 01', all: [] },
      { name: 'urltest', type: 'URLTest', now: '香港 08', all: [] }
    ];

    expect(applyStrategyWallOrder(groups, ['openai-us', 'claude-us']).map((group) => group.name)).toEqual([
      'openai-us',
      'claude-us',
      'download-node',
      'urltest'
    ]);
  });

  it('moves a dragged group before the drop target without dropping unseen groups', () => {
    const nextOrder = moveStrategyWallGroupOrder(
      ['claude-us', 'download-node', 'openai-us'],
      'openai-us',
      'download-node',
      ['claude-us', 'download-node', 'gemini-us', 'openai-us']
    );

    expect(nextOrder).toEqual(['claude-us', 'openai-us', 'download-node', 'gemini-us']);
  });

  it('shows members only according to the group collapsed state', () => {
    const members = Array.from({ length: 20 }, (_, index) => `node-${index + 1}`);

    expect(selectVisibleStrategyWallMembers(members, { collapsed: false })).toHaveLength(20);
    expect(selectVisibleStrategyWallMembers(members, { collapsed: true })).toEqual([]);
  });
});
