---
name: singdeck-dashboard-design
description: Use when designing or reviewing SingDeck, a local sing-box web dashboard. Provides product-specific UI constraints for compact network-control pages, proxy selection, topology, logs, config, and settings flows.
---

# SingDeck Dashboard Design

Use this skill together with a general frontend design skill when working on SingDeck UI.

## Product Direction

SingDeck is a local-first sing-box control console, not a marketing site. Optimize for repeated daily use, fast diagnosis, and compact scanning.

Default aesthetic: quiet network operations console.
- System font stack only.
- Dark neutral base with restrained green, yellow, red latency/status colors.
- Dense but calm layouts; no hero copy, no oversized introduction text, no decorative gradients or cards inside cards.
- Page navigation must be explicit. Do not put all major functions on one scrolling page.

## Layout Rules

- Use a persistent left navigation for pages: Overview, Proxies, Connections, Logs, Config, Rules/Controller, Settings.
- Use a compact top status bar for controller URL, API status, active mode, traffic, and refresh/test actions.
- Pages should use the full viewport height. Logs and Connections must fill available vertical space and avoid dead blank regions.
- Overview should combine live health, traffic, active selector, DNS/rule summaries, and a small request topology widget.
- Proxies should prioritize strategy groups first, then node cards. Node cards should be grid-based, compact, searchable, and latency-colored.
- Selector node choice should use a lightweight anchored popover, not a blocking modal. The popover should show all group nodes in a grid, support search, show latency, and allow per-node testing.
- Settings should contain operational knobs such as controller, default test URL, per-strategy-group test URL, and parallel test count.

## Interaction Rules

- Latency status colors: green for fast/healthy, yellow for slow/degraded, red for failed/bad.
- Batch testing must respect a configurable concurrency limit.
- Clicking a latency badge should test that node or group.
- Group-level test URLs are preferred over per-node test URL controls.
- Config page displays the currently running config content only when the controller exposes it; otherwise show the exact missing capability and recommended exposure path.

## Topology Widget

The request topology should be a compact Sankey-like diagram:
- Left: source/inbound.
- Middle: matched rule or rule set.
- Right: outbound or final node.
- Smooth continuous curves with low opacity bands.
- Hover/focus highlights a path and reveals route details.
- Keep it short enough not to dominate the Overview page.

## Review Checklist

Before considering a SingDeck UI change complete:
- Each page has one clear purpose and no filler copy.
- Dense data still has readable spacing and stable dimensions.
- No page leaves large unused blank space in normal desktop viewport.
- Mobile/tablet layout stacks predictably.
- System fonts are used everywhere.
- Interactive controls have hover/focus states.
