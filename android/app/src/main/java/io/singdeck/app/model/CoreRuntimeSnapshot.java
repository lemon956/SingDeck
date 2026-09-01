package io.singdeck.app.model;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Immutable Java-side view of the running libbox command stream.
 */
public final class CoreRuntimeSnapshot {
    public final String state;
    public final String runningProfileId;
    public final String activeOutbound;
    public final String error;
    public final long startedAt;
    public final long uploadSpeed;
    public final long downloadSpeed;
    public final long totalUpload;
    public final long totalDownload;
    public final long updatedAt;
    public final List<OutboundGroup> groups;
    public final Map<String, NodeItem> nodes;
    public final List<ConnectionItem> connections;

    public CoreRuntimeSnapshot(
            String state,
            String runningProfileId,
            String activeOutbound,
            String error,
            long startedAt,
            long uploadSpeed,
            long downloadSpeed,
            long totalUpload,
            long totalDownload,
            long updatedAt,
            List<OutboundGroup> groups,
            Map<String, NodeItem> nodes,
            List<ConnectionItem> connections
    ) {
        this.state = state;
        this.runningProfileId = runningProfileId;
        this.activeOutbound = activeOutbound;
        this.error = error;
        this.startedAt = startedAt;
        this.uploadSpeed = uploadSpeed;
        this.downloadSpeed = downloadSpeed;
        this.totalUpload = totalUpload;
        this.totalDownload = totalDownload;
        this.updatedAt = updatedAt;

        List<OutboundGroup> groupCopies = new ArrayList<>();
        for (OutboundGroup group : groups) {
            groupCopies.add(new OutboundGroup(group));
        }
        this.groups = Collections.unmodifiableList(groupCopies);

        Map<String, NodeItem> nodeCopies = new LinkedHashMap<>();
        for (Map.Entry<String, NodeItem> entry : nodes.entrySet()) {
            nodeCopies.put(entry.getKey(), new NodeItem(entry.getValue()));
        }
        this.nodes = Collections.unmodifiableMap(nodeCopies);

        List<ConnectionItem> connectionCopies = new ArrayList<>();
        for (ConnectionItem connection : connections) {
            connectionCopies.add(new ConnectionItem(connection));
        }
        this.connections = Collections.unmodifiableList(connectionCopies);
    }
}
