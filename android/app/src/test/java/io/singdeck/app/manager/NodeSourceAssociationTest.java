package io.singdeck.app.manager;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.Map;

public class NodeSourceAssociationTest {
    @Test
    public void manualNodesWinBeforeRemoteNodesAndSourceOrderBreaksTies() {
        NodeSourceAssociation.SourceCandidates ssid = new NodeSourceAssociation.SourceCandidates(
                "ssid",
                Collections.emptyList(),
                Arrays.asList("Shared", "SSID-1")
        );
        NodeSourceAssociation.SourceCandidates self = new NodeSourceAssociation.SourceCandidates(
                "Self",
                Arrays.asList("Shared", "Reality-1"),
                Collections.emptyList()
        );

        Map<String, String> owners = NodeSourceAssociation.associate(
                Arrays.asList(ssid, self),
                Arrays.asList("Shared", "SSID-1", "Reality-1", "Removed")
        );

        assertEquals("Self", owners.get("Shared"));
        assertEquals("Self", owners.get("Reality-1"));
        assertEquals("ssid", owners.get("SSID-1"));
        assertFalse(owners.containsKey("Removed"));
    }

    @Test
    public void matchingIsExactAndCaseSensitive() {
        NodeSourceAssociation.SourceCandidates source = new NodeSourceAssociation.SourceCandidates(
                "Self",
                Arrays.asList("Reality-1", "reality-2"),
                Collections.emptyList()
        );

        Map<String, String> owners = NodeSourceAssociation.associate(
                Collections.singletonList(source),
                Arrays.asList("reality-1", "reality-2")
        );

        assertFalse(owners.containsKey("reality-1"));
        assertEquals("Self", owners.get("reality-2"));
    }
}
