package io.singdeck.app.manager;

import java.util.Collections;
import java.util.Map;

import io.singdeck.app.model.MobileBootstrap;

/** Enforces a strategy group's persisted node-source restriction. */
public final class NodeEligibilityPolicy {
    private NodeEligibilityPolicy() {
    }

    public static boolean isAllowed(
            MobileBootstrap.GroupSettings settings,
            String node,
            Map<String, String> sourceOwners
    ) {
        return isAllowed(settings, node, sourceOwners, false);
    }

    public static boolean isAllowed(
            MobileBootstrap.GroupSettings settings,
            String node,
            Map<String, String> sourceOwners,
            boolean nestedGroup
    ) {
        if (settings == null || !settings.sourceRestrictionEnabled) {
            return true;
        }
        if (nestedGroup) {
            return false;
        }
        Map<String, String> owners = sourceOwners == null
                ? Collections.emptyMap()
                : sourceOwners;
        String source = owners.get(node);
        if (source == null || source.isEmpty()) {
            return settings.allowUnlabeledNodes;
        }
        return settings.allowedNodeSources != null
                && settings.allowedNodeSources.contains(source);
    }
}
