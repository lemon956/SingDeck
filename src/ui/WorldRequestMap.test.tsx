import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectionRecord } from '../core/connections';
import { WorldRequestMap } from './WorldRequestMap';

const mockConnections: ConnectionRecord[] = [
  {
    id: 'c1',
    source: '127.0.0.1:1234',
    sourceIP: '127.0.0.1',
    sourcePort: '1234',
    sourceEndpoint: '127.0.0.1:1234',
    target: 'api.openai.com:443',
    destinationHost: 'api.openai.com',
    destinationIP: '104.18.2.1',
    destinationPort: '443',
    destinationEndpoint: '104.18.2.1:443',
    network: 'tcp',
    inboundType: 'mixed',
    dnsMode: 'fakeip',
    processPath: '/usr/bin/node',
    upload: '10 KB',
    uploadBytes: 10240,
    download: '120 KB',
    downloadBytes: 122880,
    totalBytes: 133120,
    rule: 'AI-Services',
    ruleType: 'domain-suffix',
    rulePayload: 'openai.com',
    outbound: 'US-Node-1',
    chains: ['Proxy', 'US-Node-1'],
    startedAt: new Date().toISOString()
  }
];

describe('WorldRequestMap component', () => {
  it('renders world map with connection counts, live stream, and titles', () => {
    render(<WorldRequestMap connections={mockConnections} />);
    expect(screen.getByText(/实时全球请求网络/)).toBeInTheDocument();
    expect(screen.getByText(/个实时连接/)).toBeInTheDocument();
    expect(screen.getByLabelText('Select Client Origin Region')).toBeInTheDocument();
    expect(screen.getByText('api.openai.com')).toBeInTheDocument();
    expect(screen.getByText('实时请求流 (1)')).toBeInTheDocument();
  });

  it('allows changing filter mode and origin region', () => {
    render(<WorldRequestMap connections={mockConnections} />);
    const directBtn = screen.getByRole('button', { name: /直连/ });
    fireEvent.click(directBtn);
    expect(directBtn).toHaveClass('active');

    const select = screen.getByLabelText('Select Client Origin Region');
    fireEvent.change(select, { target: { value: 'jp' } });
    expect(select).toHaveValue('jp');
  });

  it('renders empty overlay when connections list is empty', () => {
    render(<WorldRequestMap connections={[]} />);
    expect(screen.getByText('暂无实时请求连接')).toBeInTheDocument();
  });
});
