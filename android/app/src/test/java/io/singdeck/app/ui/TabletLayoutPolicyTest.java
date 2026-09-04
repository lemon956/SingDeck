package io.singdeck.app.ui;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.res.Configuration;

import org.junit.Test;

public class TabletLayoutPolicyTest {

    @Test
    public void sideInspectorSupportedOnlyOnWideScreens() {
        assertFalse(TabletLayoutPolicy.isSideInspectorSupported(360));
        assertFalse(TabletLayoutPolicy.isSideInspectorSupported(599));
        assertFalse(TabletLayoutPolicy.isSideInspectorSupported(600));
        assertFalse(TabletLayoutPolicy.isSideInspectorSupported(839));
        assertTrue(TabletLayoutPolicy.isSideInspectorSupported(840));
        assertTrue(TabletLayoutPolicy.isSideInspectorSupported(1024));
        assertTrue(TabletLayoutPolicy.isSideInspectorSupported(1200));
    }

    @Test
    public void navigationRailSupportedOnLandscapeOrW840dp() {
        assertFalse(TabletLayoutPolicy.isNavigationRailSupported(360, Configuration.ORIENTATION_PORTRAIT));
        assertFalse(TabletLayoutPolicy.isNavigationRailSupported(360, Configuration.ORIENTATION_LANDSCAPE));
        assertFalse(TabletLayoutPolicy.isNavigationRailSupported(599, Configuration.ORIENTATION_LANDSCAPE));

        // Tablet portrait below 840dp keeps bottom nav
        assertFalse(TabletLayoutPolicy.isNavigationRailSupported(600, Configuration.ORIENTATION_PORTRAIT));
        assertFalse(TabletLayoutPolicy.isNavigationRailSupported(800, Configuration.ORIENTATION_PORTRAIT));

        // Tablet landscape at/above 600dp uses navigation rail
        assertTrue(TabletLayoutPolicy.isNavigationRailSupported(600, Configuration.ORIENTATION_LANDSCAPE));
        assertTrue(TabletLayoutPolicy.isNavigationRailSupported(800, Configuration.ORIENTATION_LANDSCAPE));

        // Screen width >= 840dp uses navigation rail regardless of orientation
        assertTrue(TabletLayoutPolicy.isNavigationRailSupported(840, Configuration.ORIENTATION_PORTRAIT));
        assertTrue(TabletLayoutPolicy.isNavigationRailSupported(840, Configuration.ORIENTATION_LANDSCAPE));
        assertTrue(TabletLayoutPolicy.isNavigationRailSupported(1200, Configuration.ORIENTATION_LANDSCAPE));
    }

    @Test
    public void availableNodeWidthDeductsRailAndInspector() {
        // Phone portrait (390dp): no rail, no inspector
        int phoneWidth = TabletLayoutPolicy.calculateAvailableNodeWidthDp(
                390, Configuration.ORIENTATION_PORTRAIT, false
        );
        assertEquals(390, phoneWidth);

        // Tablet portrait (800dp): no rail, no embedded side inspector
        int tabletPortraitWidth = TabletLayoutPolicy.calculateAvailableNodeWidthDp(
                800, Configuration.ORIENTATION_PORTRAIT, false
        );
        assertEquals(800, tabletPortraitWidth);

        // MatePad standard landscape (1024dp): 88dp rail + 360dp side inspector
        int tabletLandscapeWidth = TabletLayoutPolicy.calculateAvailableNodeWidthDp(
                1024, Configuration.ORIENTATION_LANDSCAPE, true
        );
        assertEquals(1024 - 88 - 360, tabletLandscapeWidth); // 576dp

        // Extremely small or constrained width never becomes negative
        int constrained = TabletLayoutPolicy.calculateAvailableNodeWidthDp(
                300, Configuration.ORIENTATION_LANDSCAPE, true
        );
        assertEquals(0, constrained);
    }

    @Test
    public void calculateSpanCountRespectsWidthThresholds() {
        // Linear list mode always returns 1 span
        assertEquals(1, TabletLayoutPolicy.calculateSpanCount(1200, false));
        assertEquals(1, TabletLayoutPolicy.calculateSpanCount(360, false));

        // Grid mode: <320dp -> 1 column
        assertEquals(1, TabletLayoutPolicy.calculateSpanCount(280, true));
        assertEquals(1, TabletLayoutPolicy.calculateSpanCount(319, true));

        // Grid mode: 320..679dp -> 2 columns
        assertEquals(2, TabletLayoutPolicy.calculateSpanCount(320, true));
        assertEquals(2, TabletLayoutPolicy.calculateSpanCount(500, true));
        assertEquals(2, TabletLayoutPolicy.calculateSpanCount(679, true));

        // Grid mode: 680..999dp -> 3 columns
        assertEquals(3, TabletLayoutPolicy.calculateSpanCount(680, true));
        assertEquals(3, TabletLayoutPolicy.calculateSpanCount(800, true));
        assertEquals(3, TabletLayoutPolicy.calculateSpanCount(999, true));

        // Grid mode: >=1000dp -> 4 columns
        assertEquals(4, TabletLayoutPolicy.calculateSpanCount(1000, true));
        assertEquals(4, TabletLayoutPolicy.calculateSpanCount(1440, true));
    }

    @Test
    public void calculateSpanCountFromConfigurationWorksAcrossScenarios() {
        // Phone portrait (360dp) -> 2 columns
        assertEquals(2, TabletLayoutPolicy.calculateSpanCount(360, Configuration.ORIENTATION_PORTRAIT, true));

        // Small compact phone portrait (300dp) -> 1 column
        assertEquals(1, TabletLayoutPolicy.calculateSpanCount(300, Configuration.ORIENTATION_PORTRAIT, true));

        // MatePad portrait (800dp) -> available 800dp -> 3 columns
        assertEquals(3, TabletLayoutPolicy.calculateSpanCount(800, Configuration.ORIENTATION_PORTRAIT, true));

        // MatePad landscape (1024dp) -> available 576dp -> 2 columns
        assertEquals(2, TabletLayoutPolicy.calculateSpanCount(1024, Configuration.ORIENTATION_LANDSCAPE, true));

        // Large tablet landscape (1440dp) -> available 1440 - 88 - 360 = 992dp -> 3 columns
        assertEquals(3, TabletLayoutPolicy.calculateSpanCount(1440, Configuration.ORIENTATION_LANDSCAPE, true));

        // Ultra-wide console landscape (1600dp) -> available 1600 - 88 - 360 = 1152dp -> 4 columns
        assertEquals(4, TabletLayoutPolicy.calculateSpanCount(1600, Configuration.ORIENTATION_LANDSCAPE, true));
    }
}
