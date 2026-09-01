package io.singdeck.app.manager;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Pure source ownership policy shared by startup restore and manual refresh. */
public final class NodeSourceAssociation {
    public static final class SourceCandidates {
        public final String name;
        public final List<String> configuredNodes;
        public final List<String> remoteNodes;

        public SourceCandidates(
                String name,
                Collection<String> configuredNodes,
                Collection<String> remoteNodes
        ) {
            this.name = name == null ? "" : name.trim();
            this.configuredNodes = unique(configuredNodes);
            this.remoteNodes = unique(remoteNodes);
        }
    }

    private NodeSourceAssociation() {
    }

    public static Map<String, String> associate(
            List<SourceCandidates> orderedSources,
            Collection<String> currentNodes
    ) {
        Set<String> available = new LinkedHashSet<>(unique(currentNodes));
        Map<String, String> owners = new LinkedHashMap<>();
        if (orderedSources == null) {
            return owners;
        }

        for (SourceCandidates source : orderedSources) {
            claim(source, source.configuredNodes, available, owners);
        }
        for (SourceCandidates source : orderedSources) {
            claim(source, source.remoteNodes, available, owners);
        }
        return owners;
    }

    private static void claim(
            SourceCandidates source,
            List<String> candidates,
            Set<String> available,
            Map<String, String> owners
    ) {
        if (source == null || source.name.isEmpty()) {
            return;
        }
        for (String node : candidates) {
            if (available.contains(node) && !owners.containsKey(node)) {
                owners.put(node, source.name);
            }
        }
    }

    private static List<String> unique(Collection<String> values) {
        LinkedHashSet<String> unique = new LinkedHashSet<>();
        if (values != null) {
            for (String value : values) {
                if (value != null && !value.trim().isEmpty()) {
                    unique.add(value.trim());
                }
            }
        }
        return new ArrayList<>(unique);
    }
}
