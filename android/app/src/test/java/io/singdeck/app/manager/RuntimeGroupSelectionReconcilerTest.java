package io.singdeck.app.manager;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import io.singdeck.app.model.OutboundGroup;

public class RuntimeGroupSelectionReconcilerTest {
    private static final long NOW = 10_000L;

    @Test
    public void publishesSuccessfulSelectionWithoutMutatingPreviousSnapshot() {
        RuntimeGroupSelectionReconciler reconciler = new RuntimeGroupSelectionReconciler();
        List<OutboundGroup> original = groups("HK");

        List<OutboundGroup> updated = reconciler.recordSuccessfulSelection(
                original,
                "select",
                "SG",
                NOW
        );

        assertEquals("HK", original.get(0).now);
        assertEquals("SG", updated.get(0).now);
        assertEquals(1, reconciler.pendingCount());
    }

    @Test
    public void ignoresStaleGroupStreamDuringConfirmationWindow() {
        RuntimeGroupSelectionReconciler reconciler = new RuntimeGroupSelectionReconciler();
        reconciler.recordSuccessfulSelection(groups("HK"), "select", "SG", NOW);

        List<OutboundGroup> reconciled = reconciler.reconcileStream(groups("HK"), NOW + 100L);

        assertEquals("SG", reconciled.get(0).now);
        assertEquals(1, reconciler.pendingCount());
    }

    @Test
    public void acceptsMatchingCoreStreamAndClearsPendingSelection() {
        RuntimeGroupSelectionReconciler reconciler = new RuntimeGroupSelectionReconciler();
        reconciler.recordSuccessfulSelection(groups("HK"), "select", "SG", NOW);

        List<OutboundGroup> reconciled = reconciler.reconcileStream(groups("SG"), NOW + 100L);

        assertEquals("SG", reconciled.get(0).now);
        assertEquals(0, reconciler.pendingCount());
    }

    @Test
    public void acceptsCoreStreamAfterConfirmationWindowExpires() {
        RuntimeGroupSelectionReconciler reconciler = new RuntimeGroupSelectionReconciler();
        reconciler.recordSuccessfulSelection(groups("HK"), "select", "SG", NOW);

        List<OutboundGroup> reconciled = reconciler.reconcileStream(
                groups("HK"),
                NOW + RuntimeGroupSelectionReconciler.CONFIRMATION_WINDOW_MS
        );

        assertEquals("HK", reconciled.get(0).now);
        assertEquals(0, reconciler.pendingCount());
    }

    private static List<OutboundGroup> groups(String selected) {
        return new ArrayList<>(List.of(new OutboundGroup(
                "select",
                "selector",
                selected,
                new ArrayList<>(Arrays.asList("HK", "SG"))
        )));
    }
}
