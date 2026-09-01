package io.singdeck.app.model;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class CoreRuntimeSnapshotTest {
    @Test
    public void deepCopiesCollectionsAndExposesUnmodifiableViews() {
        NodeItem node = new NodeItem("HK", "anytls");
        node.delay = 82;
        Map<String, NodeItem> nodes = new LinkedHashMap<>();
        nodes.put(node.name, node);
        List<OutboundGroup> groups = new ArrayList<>();
        groups.add(new OutboundGroup("PROXY", "selector", "HK", new ArrayList<>(nodes.keySet())));
        List<ConnectionItem> connections = new ArrayList<>();
        connections.add(new ConnectionItem("id", "example.com:443", "HK", "PROXY ➔ HK"));

        CoreRuntimeSnapshot snapshot = new CoreRuntimeSnapshot(
                "running", "profile", "HK", "", 1, 2, 3, 4, 5, 6,
                groups, nodes, connections
        );
        node.delay = 999;
        groups.get(0).now = "changed";
        connections.get(0).host = "changed";

        assertEquals(Integer.valueOf(82), snapshot.nodes.get("HK").delay);
        assertEquals("HK", snapshot.groups.get(0).now);
        assertEquals("example.com:443", snapshot.connections.get(0).host);
        assertThrows(UnsupportedOperationException.class, () -> snapshot.groups.clear());
        assertThrows(UnsupportedOperationException.class, () -> snapshot.nodes.clear());
    }
}
