import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ConnectionRecord } from '../core/connections';
import {
  buildLiveGeoConnections,
  generateCurvedArcPath,
  type GeoCityHub,
  type GeoConnection,
  type GeoLocation,
  PRESET_CLIENT_ORIGINS,
  projectGeoPoint
} from '../core/geoMap';
import { formatBytes } from '../core/runtime';
import { REAL_WORLD_COUNTRY_PATHS } from './worldMapData';
import {
  Activity,
  ArrowRight,
  Crosshair,
  ExternalLink,
  Filter,
  GripVertical,
  Maximize2,
  Minimize2,
  Move,
  Navigation,
  Radio,
  RotateCcw,
  Search,
  Shield,
  Zap,
  ZoomIn,
  ZoomOut
} from 'lucide-react';

export type WorldRequestMapProps = {
  connections: ConnectionRecord[];
  onSelectHost?: (host: string) => void;
  className?: string;
  embedded?: boolean;
};

// Major landmark reference cities
const MAJOR_TECH_CITIES = [
  { name: 'Silicon Valley', pos: { lng: -121.88, lat: 37.33 } },
  { name: 'New York', pos: { lng: -74.00, lat: 40.71 } },
  { name: 'London', pos: { lng: -0.12, lat: 51.50 } },
  { name: 'Frankfurt', pos: { lng: 8.68, lat: 50.11 } },
  { name: 'Tokyo', pos: { lng: 139.69, lat: 35.68 } },
  { name: 'Hong Kong', pos: { lng: 114.17, lat: 22.30 } },
  { name: 'Singapore', pos: { lng: 103.82, lat: 1.35 } },
  { name: 'Shanghai', pos: { lng: 121.47, lat: 31.23 } },
  { name: 'Sydney', pos: { lng: 151.20, lat: -33.86 } }
];

export function WorldRequestMap({ connections, onSelectHost, className, embedded }: WorldRequestMapProps) {
  const mapSvgId = useId();
  const [selectedOriginKey, setSelectedOriginKey] = useState<string>('cn-east');
  const [filterMode, setFilterMode] = useState<'all' | 'proxy' | 'direct'>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [hoveredConnectionId, setHoveredConnectionId] = useState<string | null>(null);
  const [hoveredHubId, setHoveredHubId] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState<boolean>(false);
  const [stageHeightMode, setStageHeightMode] = useState<'immersive' | 'compact'>('immersive');

  // Interactive Zoom & Pan State
  const [zoomLevel, setZoomLevel] = useState<number>(1);
  const [panOffset, setPanOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState<boolean>(false);
  const panStartRef = useRef<{ mouseX: number; mouseY: number; startPanX: number; startPanY: number; moved: boolean } | null>(null);

  // Resizable live request stream width
  const [streamWidth, setStreamWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('singdeck_map_stream_w');
      return saved ? Math.max(300, Math.min(680, Number(saved))) : 420;
    } catch {
      return 420;
    }
  });
  const [isDraggingStream, setIsDraggingStream] = useState<boolean>(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgStageRef = useRef<HTMLDivElement | null>(null);

  const clientOrigin = PRESET_CLIENT_ORIGINS[selectedOriginKey] ?? PRESET_CLIENT_ORIGINS['cn-east'];

  const { geoConnections, cityHubs, totalConnections, totalUploadBytes, totalDownloadBytes } = useMemo(() => {
    return buildLiveGeoConnections(connections, clientOrigin);
  }, [connections, clientOrigin]);

  const filteredGeoConnections = useMemo(() => {
    return geoConnections.filter((item) => {
      if (filterMode === 'direct' && !item.isDirect) return false;
      if (filterMode === 'proxy' && item.isDirect) return false;
      if (searchQuery.trim()) {
        const query = searchQuery.trim().toLowerCase();
        const matchesTarget = item.targetHost.toLowerCase().includes(query);
        const matchesOutbound = item.outboundName.toLowerCase().includes(query);
        const matchesCountry = item.destinationLocation.country.toLowerCase().includes(query);
        const matchesCity = item.destinationLocation.name.toLowerCase().includes(query);
        if (!matchesTarget && !matchesOutbound && !matchesCountry && !matchesCity) {
          return false;
        }
      }
      return true;
    });
  }, [geoConnections, filterMode, searchQuery]);

  const activeSelectedOrHoveredConn = useMemo(() => {
    const targetId = hoveredConnectionId || selectedConnectionId;
    if (!targetId) return null;
    return geoConnections.find((c) => c.id === targetId) ?? null;
  }, [geoConnections, hoveredConnectionId, selectedConnectionId]);

  // When a connection is selected, find its involved hubs
  const selectedInvolvedHubIds = useMemo(() => {
    if (!selectedConnectionId) return null;
    const conn = geoConnections.find((c) => c.id === selectedConnectionId);
    if (!conn) return null;
    const set = new Set<string>();
    set.add(conn.sourceOrigin.id);
    set.add(conn.destinationLocation.id);
    if (conn.proxyLocation) {
      set.add(conn.proxyLocation.id);
    }
    return set;
  }, [geoConnections, selectedConnectionId]);

  // Stream pane width resize handlers
  const handleStreamDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDraggingStream(true);
  }, []);

  useEffect(() => {
    if (!isDraggingStream) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const newWidth = Math.max(280, Math.min(720, rect.right - e.clientX));
      setStreamWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsDraggingStream(false);
      try {
        localStorage.setItem('singdeck_map_stream_w', String(streamWidth));
      } catch {}
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDraggingStream, streamWidth]);

  // Map canvas mouse pan & wheel zoom handlers
  const handleMapMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return; // Left click only
    setIsPanning(true);
    panStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      startPanX: panOffset.x,
      startPanY: panOffset.y,
      moved: false
    };
  };

  const handleMapMouseMove = (e: React.MouseEvent) => {
    if (!isPanning || !panStartRef.current) return;
    const dx = e.clientX - panStartRef.current.mouseX;
    const dy = e.clientY - panStartRef.current.mouseY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      panStartRef.current.moved = true;
    }
    setPanOffset({
      x: panStartRef.current.startPanX + dx,
      y: panStartRef.current.startPanY + dy
    });
  };

  const handleMapMouseUp = (e: React.MouseEvent) => {
    if (panStartRef.current && !panStartRef.current.moved) {
      // Clicked without dragging: if clicked on blank canvas, deselect
      const target = e.target as HTMLElement | SVGElement;
      if (target.tagName === 'rect' || target.classList.contains('world-map-stage')) {
        setSelectedConnectionId(null);
      }
    }
    setIsPanning(false);
    panStartRef.current = null;
  };

  const handleMapWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const zoomDelta = e.deltaY < 0 ? 0.15 : -0.15;
    setZoomLevel((prev) => Math.max(0.8, Math.min(4.0, Number((prev + zoomDelta).toFixed(2)))));
  };

  const resetView = () => {
    setZoomLevel(1);
    setPanOffset({ x: 0, y: 0 });
  };

  return (
    <div
      className={`world-map-root ${isExpanded ? 'map-expanded' : ''} ${stageHeightMode === 'immersive' ? 'stage-immersive' : 'stage-compact'} ${embedded ? 'map-embedded' : ''} ${className ?? ''}`}
      ref={containerRef}
    >
      {/* Tactical Header Bar */}
      <div className="world-map-toolbar">
        <div className="world-map-title">
          <div className="title-beacon" />
          <div className="title-texts">
            <span className="title-heading">实时全球请求网络大地图</span>
            <span className="title-sub">
              <strong>{totalConnections}</strong> 个实时连接 · 捕获流量{' '}
              <strong style={{ color: '#34d399' }}>{formatBytes(totalDownloadBytes)}</strong>
            </span>
          </div>
        </div>

        <div className="world-map-controls">
          {/* Client Origin Selection */}
          <div className="map-control-group" title="设置本机客户端所在的物理地理位置，用于作为世界地图请求光束的出发点">
            <span className="map-control-label">
              <Navigation size={11} />
              客户端位置:
            </span>
            <select
              aria-label="Select Client Origin Region"
              className="map-select"
              value={selectedOriginKey}
              onChange={(e) => setSelectedOriginKey(e.target.value)}
            >
              {Object.entries(PRESET_CLIENT_ORIGINS).map(([key, item]) => (
                <option key={key} value={key}>
                  {item.flag} {item.name}
                </option>
              ))}
            </select>
          </div>

          {/* Filter Mode - Slim, Lightweight Styling */}
          <div className="policy-segment map-filter-segment">
            <button
              className={filterMode === 'all' ? 'active' : ''}
              onClick={() => setFilterMode('all')}
              type="button"
            >
              全部 ({geoConnections.length})
            </button>
            <button
              className={filterMode === 'proxy' ? 'active' : ''}
              onClick={() => setFilterMode('proxy')}
              type="button"
            >
              代理 ({geoConnections.filter((c) => !c.isDirect).length})
            </button>
            <button
              className={filterMode === 'direct' ? 'active' : ''}
              onClick={() => setFilterMode('direct')}
              type="button"
            >
              直连 ({geoConnections.filter((c) => c.isDirect).length})
            </button>
          </div>

          {/* Search Box */}
          <div className="map-search-box">
            <Search size={12} />
            <input
              placeholder="搜索域名/IP/节点..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          {/* Zoom & Expansion Actions */}
          <div className="map-zoom-actions">
            <button
              aria-label="Zoom In"
              className="ghost-action compact-icon-action"
              disabled={zoomLevel >= 4.0}
              onClick={() => setZoomLevel((z) => Math.min(4.0, Number((z + 0.3).toFixed(2))))}
              title="放大 (支持滚轮)"
              type="button"
            >
              <ZoomIn size={13} />
            </button>
            <button
              aria-label="Zoom Out"
              className="ghost-action compact-icon-action"
              disabled={zoomLevel <= 0.7}
              onClick={() => setZoomLevel((z) => Math.max(0.7, Number((z - 0.3).toFixed(2))))}
              title="缩小 (支持滚轮)"
              type="button"
            >
              <ZoomOut size={13} />
            </button>
            <button
              aria-label="Reset View"
              className="ghost-action compact-icon-action"
              onClick={resetView}
              title="重置缩放与位置"
              type="button"
            >
              <RotateCcw size={13} />
            </button>
            <button
              aria-label={stageHeightMode === 'immersive' ? 'Compact Size' : 'Large Size'}
              className="ghost-action compact-icon-action"
              onClick={() => setStageHeightMode((m) => (m === 'immersive' ? 'compact' : 'immersive'))}
              title={stageHeightMode === 'immersive' ? '切换为紧凑高度' : '切换为沉浸大图'}
              type="button"
            >
              <Move size={13} />
            </button>
            <button
              aria-label={isExpanded ? 'Collapse Map' : 'Expand Map'}
              className="ghost-action compact-icon-action"
              onClick={() => setIsExpanded((exp) => !exp)}
              title={isExpanded ? '退出全屏' : '全屏巨幕查看'}
              type="button"
            >
              {isExpanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
          </div>
        </div>
      </div>

      {/* Main Workspace (Map Canvas + Resizer + Live Requests Stream) */}
      <div className="world-map-layout">
        {/* Left: Interactive SVG World Map Canvas */}
        <div
          className={`world-map-stage ${isPanning ? 'panning' : ''}`}
          onMouseDown={handleMapMouseDown}
          onMouseLeave={handleMapMouseUp}
          onMouseMove={handleMapMouseMove}
          onMouseUp={handleMapMouseUp}
          onWheel={handleMapWheel}
          ref={svgStageRef}
        >
          {/* Zoom & Focus Indicator Tag */}
          <div className="map-zoom-badge">
            <Crosshair size={11} />
            <span>
              缩放: {(zoomLevel * 100).toFixed(0)}%
              {selectedConnectionId ? ' · 🎯 已聚焦单条请求 (点击右侧记录或空白取消)' : ' (滚轮缩放 / 按住拖拽平移)'}
            </span>
          </div>

          <svg
            aria-label="High Resolution Natural Earth World Connection Map"
            className="world-map-svg"
            style={{
              transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomLevel})`,
              transformOrigin: '500px 250px'
            }}
            viewBox="0 0 1000 500"
          >
            <defs>
              {/* Tactical Graticule Grid */}
              <pattern height="25" id={`tactical-grid-${mapSvgId}`} patternUnits="userSpaceOnUse" width="25">
                <path d="M 25 0 L 0 0 0 25" fill="none" stroke="rgba(56, 189, 248, 0.05)" strokeWidth="0.5" />
              </pattern>

              {/* Glowing Laser Filters */}
              <filter id={`laser-glow-${mapSvgId}`} x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {/* Deep Ocean Canvas */}
            <rect width="1000" height="500" fill="#070a0e" />
            <rect width="1000" height="500" fill={`url(#tactical-grid-${mapSvgId})`} />

            {/* Major Lat/Long Reference Lines */}
            <line x1="0" y1="250" x2="1000" y2="250" stroke="rgba(56, 189, 248, 0.22)" strokeDasharray="5,5" strokeWidth="1.2" />
            <line x1="500" y1="0" x2="500" y2="500" stroke="rgba(56, 189, 248, 0.15)" strokeDasharray="5,5" strokeWidth="1.2" />
            <line x1="0" y1="125" x2="1000" y2="125" stroke="rgba(255, 255, 255, 0.06)" strokeDasharray="3,5" strokeWidth="0.6" />
            <line x1="0" y1="375" x2="1000" y2="375" stroke="rgba(255, 255, 255, 0.06)" strokeDasharray="3,5" strokeWidth="0.6" />

            {/* Real Natural Earth 110m Geographic Country Polygons */}
            <g className="world-real-countries">
              {REAL_WORLD_COUNTRY_PATHS.map((pathD, idx) => (
                <path
                  className="real-country-poly"
                  d={pathD}
                  fill="#15212f"
                  key={idx}
                  stroke="#283a4e"
                  strokeLinejoin="round"
                  strokeWidth="0.85"
                />
              ))}
            </g>

            {/* Major Landmark City Reference Points */}
            <g className="world-landmark-dots">
              {MAJOR_TECH_CITIES.map((city, idx) => {
                const pt = projectGeoPoint(city.pos);
                return (
                  <circle
                    cx={pt.x.toFixed(1)}
                    cy={pt.y.toFixed(1)}
                    fill="rgba(255, 255, 255, 0.3)"
                    key={idx}
                    r="1.5"
                  />
                );
              })}
            </g>

            {/* Individual Live Request Laser Beams */}
            <g className="world-request-beams">
              {filteredGeoConnections.map((item) => {
                const srcPos = projectGeoPoint(item.sourceOrigin.coordinates);
                const destPos = projectGeoPoint(item.destinationLocation.coordinates);
                const isSelected = selectedConnectionId === item.id;
                const isHovered = hoveredConnectionId === item.id;
                const isFocusActive = selectedConnectionId !== null;

                // When a specific connection is selected, dim all other beams to subtle background
                if (isFocusActive && !isSelected) {
                  const pathDirect = item.proxyLocation && !item.isDirect
                    ? generateCurvedArcPath(srcPos, projectGeoPoint(item.proxyLocation.coordinates), item.curveOffset * 0.4)
                    : generateCurvedArcPath(srcPos, destPos, item.curveOffset);

                  return (
                    <path
                      className="request-beam-dimmed"
                      d={pathDirect}
                      fill="none"
                      key={item.id}
                      stroke={item.color}
                      strokeOpacity={0.05}
                      strokeWidth={1}
                    />
                  );
                }

                if (item.proxyLocation && !item.isDirect) {
                  const proxyPos = projectGeoPoint(item.proxyLocation.coordinates);
                  const path1 = generateCurvedArcPath(srcPos, proxyPos, item.curveOffset * 0.4);
                  const path2 = generateCurvedArcPath(proxyPos, destPos, item.curveOffset);

                  return (
                    <g
                      className={`request-beam-group ${isSelected || isHovered ? 'highlighted' : ''}`}
                      key={item.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedConnectionId((prev) => (prev === item.id ? null : item.id));
                      }}
                      onMouseEnter={() => setHoveredConnectionId(item.id)}
                      onMouseLeave={() => setHoveredConnectionId(null)}
                    >
                      {/* Leg 1: Origin -> Proxy */}
                      <path
                        className="request-beam-bg"
                        d={path1}
                        fill="none"
                        stroke={item.color}
                        strokeOpacity={isSelected ? 0.9 : isHovered ? 0.75 : 0.25}
                        strokeWidth={isSelected ? 6 : isHovered ? 5 : 2.2}
                      />
                      <path
                        className="request-beam-pulse"
                        d={path1}
                        fill="none"
                        filter={`url(#laser-glow-${mapSvgId})`}
                        stroke={item.color}
                        strokeDasharray="8,10"
                        strokeWidth={isSelected ? 4 : isHovered ? 3.5 : 2}
                      />
                      <circle
                        r={isSelected ? 3.5 : isHovered ? 3 : 2}
                        fill="#ffffff"
                        opacity={isSelected ? 1 : isHovered ? 0.95 : 0.8}
                        filter={`url(#laser-glow-${mapSvgId})`}
                      >
                        <animateMotion
                          path={path1}
                          dur="2.2s"
                          repeatCount="indefinite"
                        />
                      </circle>

                      {/* Leg 2: Proxy -> Destination */}
                      <path
                        className="request-beam-bg"
                        d={path2}
                        fill="none"
                        stroke="#c084fc"
                        strokeOpacity={isSelected ? 0.9 : isHovered ? 0.75 : 0.25}
                        strokeWidth={isSelected ? 6 : isHovered ? 5 : 2.2}
                      />
                      <path
                        className="request-beam-pulse secondary"
                        d={path2}
                        fill="none"
                        filter={`url(#laser-glow-${mapSvgId})`}
                        stroke="#c084fc"
                        strokeDasharray="8,10"
                        strokeWidth={isSelected ? 4 : isHovered ? 3.5 : 2}
                      />
                      <circle
                        r={isSelected ? 3.5 : isHovered ? 3 : 2}
                        fill="#ffffff"
                        opacity={isSelected ? 1 : isHovered ? 0.95 : 0.8}
                        filter={`url(#laser-glow-${mapSvgId})`}
                      >
                        <animateMotion
                          path={path2}
                          dur="2.2s"
                          begin="0.35s"
                          repeatCount="indefinite"
                        />
                      </circle>
                    </g>
                  );
                }

                // Direct Connection Leg
                const pathDirect = generateCurvedArcPath(srcPos, destPos, item.curveOffset);
                return (
                  <g
                    className={`request-beam-group ${isSelected || isHovered ? 'highlighted' : ''}`}
                    key={item.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedConnectionId((prev) => (prev === item.id ? null : item.id));
                    }}
                    onMouseEnter={() => setHoveredConnectionId(item.id)}
                    onMouseLeave={() => setHoveredConnectionId(null)}
                  >
                    <path
                      className="request-beam-bg"
                      d={pathDirect}
                      fill="none"
                      stroke={item.color}
                      strokeOpacity={isSelected ? 0.9 : isHovered ? 0.75 : 0.25}
                      strokeWidth={isSelected ? 6 : isHovered ? 5 : 2.2}
                    />
                    <path
                      className="request-beam-pulse"
                      d={pathDirect}
                      fill="none"
                      filter={`url(#laser-glow-${mapSvgId})`}
                      stroke={item.color}
                      strokeDasharray="8,10"
                      strokeWidth={isSelected ? 4 : isHovered ? 3.5 : 2}
                    />
                    <circle
                      r={isSelected ? 3.5 : isHovered ? 3 : 2}
                      fill="#ffffff"
                      opacity={isSelected ? 1 : isHovered ? 0.95 : 0.8}
                      filter={`url(#laser-glow-${mapSvgId})`}
                    >
                      <animateMotion
                        path={pathDirect}
                        dur="2.2s"
                        repeatCount="indefinite"
                      />
                    </circle>
                  </g>
                );
              })}
            </g>

            {/* High-Contrast Non-Colliding Radar Hub Pins */}
            <g className="world-city-pins">
              {cityHubs.map((hub) => {
                const pos = projectGeoPoint(hub.location.coordinates);
                const isOrigin = hub.location.id === clientOrigin.id;
                const isHovered = hoveredHubId === hub.id;
                const hasConnections = hub.connectionCount > 0;
                const isDimmed = selectedInvolvedHubIds !== null && !selectedInvolvedHubIds.has(hub.location.id);

                if (!hasConnections && !isOrigin) return null;

                return (
                  <g
                    className={`hub-pin ${isOrigin ? 'origin-hub' : ''} ${isHovered ? 'hovered' : ''} ${isDimmed ? 'dimmed' : ''}`}
                    key={hub.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (hub.connections.length > 0) {
                        setSelectedConnectionId((prev) => (prev === hub.connections[0].id ? null : hub.connections[0].id));
                      }
                    }}
                    onMouseEnter={() => setHoveredHubId(hub.id)}
                    onMouseLeave={() => setHoveredHubId(null)}
                    style={{ opacity: isDimmed ? 0.2 : 1, transition: 'opacity 200ms ease' }}
                    transform={`translate(${pos.x.toFixed(1)}, ${pos.y.toFixed(1)})`}
                  >
                    {/* Radar Pulse Wave */}
                    <circle
                      className="pin-pulse-wave"
                      r={isOrigin ? 14 : 10}
                      fill="none"
                      stroke={isOrigin ? '#34d399' : '#38bdf8'}
                      strokeWidth="1.5"
                    />
                    {/* Center Beacon Dot */}
                    <circle
                      className="pin-center-dot"
                      r={isOrigin ? 5.5 : 4}
                      fill={isOrigin ? '#34d399' : '#38bdf8'}
                      stroke="#07090e"
                      strokeWidth="2"
                    />

                    {/* Non-overlapping Compact Pill Badge */}
                    <g className="pin-tag-badge" transform="translate(7, -8)">
                      <rect
                        className="pin-tag-bg"
                        height="17"
                        rx="8.5"
                        width={isOrigin ? 82 : (hub.location.flag.length > 0 ? 44 : 34)}
                        x="0"
                        y="-11"
                      />
                      <text className="pin-tag-text" x="6" y="2">
                        {isOrigin
                          ? `${hub.location.flag} 客户端`
                          : `${hub.location.flag} ${hub.connectionCount}`}
                      </text>
                    </g>
                  </g>
                );
              })}
            </g>
          </svg>

          {/* Empty Overlay */}
          {connections.length === 0 ? (
            <div className="world-map-empty-overlay">
              <Radio className="empty-pulse" size={28} />
              <strong>暂无实时请求连接</strong>
              <span>当前没有活跃的网络外联会话，发起网络请求后将在此呈现实时激光光束</span>
            </div>
          ) : null}

          {/* Tactical HUD Popover for Hovered / Selected Connection */}
          {activeSelectedOrHoveredConn ? (
            <div className="connection-hud-popover">
              <div className="conn-hud-head">
                <div className="conn-hud-title">
                  <Zap size={14} style={{ color: activeSelectedOrHoveredConn.color }} />
                  <strong>{activeSelectedOrHoveredConn.targetHost}</strong>
                  <span>:{activeSelectedOrHoveredConn.destinationPort}</span>
                </div>
                <span className={`status-chip ${activeSelectedOrHoveredConn.isDirect ? 'ok' : 'blue'}`}>
                  {activeSelectedOrHoveredConn.isDirect ? '直连' : '代理'}
                </span>
              </div>

              <div className="conn-hud-route">
                <span>{activeSelectedOrHoveredConn.sourceOrigin.flag} {activeSelectedOrHoveredConn.sourceOrigin.name}</span>
                <ArrowRight size={11} className="route-arrow" />
                {activeSelectedOrHoveredConn.proxyLocation ? (
                  <>
                    <span className="proxy-chip">
                      <Shield size={10} />
                      {activeSelectedOrHoveredConn.proxyLocation.flag} {activeSelectedOrHoveredConn.proxyLocation.name} ({activeSelectedOrHoveredConn.outboundName})
                    </span>
                    <ArrowRight size={11} className="route-arrow" />
                  </>
                ) : null}
                <span>{activeSelectedOrHoveredConn.destinationLocation.flag} {activeSelectedOrHoveredConn.destinationLocation.name}</span>
              </div>

              <div className="conn-hud-stats">
                <div>
                  <small>下行传输</small>
                  <strong style={{ color: '#34d399' }}>{formatBytes(activeSelectedOrHoveredConn.downloadBytes)}</strong>
                </div>
                <div>
                  <small>上行传输</small>
                  <strong style={{ color: '#38bdf8' }}>{formatBytes(activeSelectedOrHoveredConn.uploadBytes)}</strong>
                </div>
                <div>
                  <small>命中规则</small>
                  <strong>{activeSelectedOrHoveredConn.ruleName}</strong>
                </div>
              </div>

              <div className="conn-hud-actions">
                <button
                  className="ghost-action"
                  onClick={() => onSelectHost?.(activeSelectedOrHoveredConn.targetHost)}
                  type="button"
                >
                  <ExternalLink size={12} />
                  在会话列表中筛选
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {/* Middle: Drag Resizer Handle */}
        <div
          className={`map-split-resizer ${isDraggingStream ? 'dragging' : ''}`}
          onMouseDown={handleStreamDragStart}
          title="拖拽调节实时请求流列表宽度"
        >
          <GripVertical size={12} className="resizer-icon" />
        </div>

        {/* Right: Resizable Live Requests Stream Panel */}
        <aside className="world-requests-stream" style={{ width: `${streamWidth}px` }}>
          <div className="stream-head">
            <Activity size={14} style={{ color: '#38bdf8' }} />
            <strong>实时请求流 ({filteredGeoConnections.length})</strong>
            {selectedConnectionId ? (
              <button
                className="stream-clear-focus-btn"
                onClick={() => setSelectedConnectionId(null)}
                title="取消单条聚焦，显示全部请求"
                type="button"
              >
                取消聚焦
              </button>
            ) : null}
          </div>

          <div className="stream-list">
            {filteredGeoConnections.length === 0 ? (
              <div className="stream-empty">无匹配的活跃请求连接</div>
            ) : (
              filteredGeoConnections.map((item) => {
                const isSelected = selectedConnectionId === item.id;
                const isHovered = hoveredConnectionId === item.id;

                return (
                  <article
                    className={`stream-row ${isSelected ? 'selected' : ''} ${isHovered ? 'hovered' : ''}`}
                    key={item.id}
                    onClick={() => setSelectedConnectionId((prev) => (prev === item.id ? null : item.id))}
                    onMouseEnter={() => setHoveredConnectionId(item.id)}
                    onMouseLeave={() => setHoveredConnectionId(null)}
                    title={isSelected ? '点击取消聚焦' : '点击在地图中单独聚焦此请求'}
                  >
                    <div className="stream-row-main">
                      <div className="stream-host">
                        <span className="dest-flag" title={item.destinationLocation.country}>
                          {item.destinationLocation.flag}
                        </span>
                        <strong title={item.targetHost}>{item.targetHost}</strong>
                        <span className="port-tag">:{item.destinationPort}</span>
                      </div>
                      <div className="stream-meta">
                        <span className="outbound-pill" style={{ color: item.color }}>
                          {item.outboundName}
                        </span>
                        <span className="city-name">{item.destinationLocation.name}</span>
                        {item.network ? <span className="net-tag">{item.network.toUpperCase()}</span> : null}
                      </div>
                    </div>

                    <div className="stream-traffic">
                      <strong style={{ color: '#34d399' }}>↓ {formatBytes(item.downloadBytes)}</strong>
                      <span style={{ color: '#38bdf8' }}>↑ {formatBytes(item.uploadBytes)}</span>
                    </div>
                  </article>
                );
              })
            )}
          </div>
        </aside>
      </div>

      {/* Map Bottom Status Bar */}
      <div className="world-map-footer">
        <div className="map-stat-item">
          <Zap size={13} style={{ color: '#38bdf8' }} />
          <span>活跃连接: <strong>{filteredGeoConnections.length} 个请求</strong></span>
        </div>
        <div className="map-stat-item">
          <span>覆盖目的地: <strong>{cityHubs.filter((h) => h.connectionCount > 0).length} 个地区</strong></span>
        </div>
        <div className="map-stat-item">
          <span>总下行: <strong style={{ color: '#34d399' }}>{formatBytes(totalDownloadBytes)}</strong></span>
        </div>
        <div className="map-stat-item">
          <span>总上行: <strong style={{ color: '#38bdf8' }}>{formatBytes(totalUploadBytes)}</strong></span>
        </div>
      </div>
    </div>
  );
}
