package io.singdeck.app.ui;

import android.content.res.Configuration;

/**
 * Encapsulates layout and breakpoint policies for phone and tablet adaptations.
 *
 * Breakpoints:
 * - < 600dp: Mobile phone (bottom nav, full-width single column or 2-col nodes, modal sheets).
 * - 600–839dp: Tablet portrait (bottom nav, no cramped 360dp side inspector, 3-col nodes).
 * - 840–1199dp: Tablet landscape (left navigation rail, embedded 360dp side inspector, 2–3 col nodes).
 * - >= 1200dp: Large tablet console (left navigation rail, embedded inspector, 3–4 col nodes).
 */
public final class TabletLayoutPolicy {
    public static final int BREAKPOINT_TABLET_MIN_DP = 600;
    public static final int BREAKPOINT_SIDE_INSPECTOR_DP = 840;
    public static final int BREAKPOINT_LARGE_CONSOLE_DP = 1200;

    public static final int NAVIGATION_RAIL_WIDTH_DP = 88;
    public static final int SIDE_INSPECTOR_WIDTH_DP = 360;

    private TabletLayoutPolicy() {
        // Utility class
    }

    /**
     * Whether a screen is wide enough to embed a permanent 360dp side inspector panel
     * alongside the main content without cramping proxy cards.
     */
    public static boolean isSideInspectorSupported(int screenWidthDp) {
        return screenWidthDp >= BREAKPOINT_SIDE_INSPECTOR_DP;
    }

    /**
     * Whether the left NavigationRailView should be displayed instead of BottomNavigationView.
     */
    public static boolean isNavigationRailSupported(int screenWidthDp, int orientation) {
        return screenWidthDp >= BREAKPOINT_SIDE_INSPECTOR_DP
                || (screenWidthDp >= BREAKPOINT_TABLET_MIN_DP
                && orientation == Configuration.ORIENTATION_LANDSCAPE);
    }

    /**
     * Calculates available width in DP for the proxies node list/grid, deducting
     * the navigation rail and embedded side inspector if present.
     */
    public static int calculateAvailableNodeWidthDp(
            int screenWidthDp,
            int orientation,
            boolean hasSideInspector
    ) {
        int available = screenWidthDp;
        if (isNavigationRailSupported(screenWidthDp, orientation)) {
            available -= NAVIGATION_RAIL_WIDTH_DP;
        }
        if (hasSideInspector) {
            available -= SIDE_INSPECTOR_WIDTH_DP;
        }
        return Math.max(0, available);
    }

    /**
     * Calculates grid span count (1 to 4 columns) based on available content width in DP.
     */
    public static int calculateSpanCount(int availableWidthDp, boolean isGridLayout) {
        if (!isGridLayout) {
            return 1;
        }
        if (availableWidthDp >= 1000) {
            return 4;
        } else if (availableWidthDp >= 680) {
            return 3;
        } else if (availableWidthDp >= 320) {
            return 2;
        } else {
            return 1;
        }
    }

    /**
     * Convenience method to calculate grid span count from screen configuration.
     */
    public static int calculateSpanCount(int screenWidthDp, int orientation, boolean isGridLayout) {
        boolean hasSideInspector = isSideInspectorSupported(screenWidthDp);
        int availableWidthDp = calculateAvailableNodeWidthDp(screenWidthDp, orientation, hasSideInspector);
        return calculateSpanCount(availableWidthDp, isGridLayout);
    }
}
