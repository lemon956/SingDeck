package io.singdeck.app.manager;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.Map;

import io.singdeck.app.model.MobileBootstrap;

public class NodeEligibilityPolicyTest {
    @Test
    public void enforcesAllowedSourcesAndExplicitUnlabeledFallback() {
        MobileBootstrap.GroupSettings settings = new MobileBootstrap.GroupSettings();
        settings.sourceRestrictionEnabled = true;
        settings.allowedNodeSources = Arrays.asList("SSID", "Self");
        Map<String, String> owners = Map.of("hk-1", "SSID", "jp-1", "Other");

        assertTrue(NodeEligibilityPolicy.isAllowed(settings, "hk-1", owners));
        assertFalse(NodeEligibilityPolicy.isAllowed(settings, "jp-1", owners));
        assertFalse(NodeEligibilityPolicy.isAllowed(settings, "manual", owners));
        settings.allowUnlabeledNodes = true;
        assertTrue(NodeEligibilityPolicy.isAllowed(settings, "manual", owners));
        assertFalse(NodeEligibilityPolicy.isAllowed(settings, "nested", owners, true));
    }

    @Test
    public void disabledRestrictionAllowsEveryNode() {
        assertTrue(NodeEligibilityPolicy.isAllowed(
                new MobileBootstrap.GroupSettings(),
                "any-node",
                Map.of()
        ));
    }
}
