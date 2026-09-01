package io.singdeck.app.manager;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

import io.singdeck.app.model.MobileBootstrap;
import io.singdeck.app.model.Profile;

public class ProfileBackupCodecTest {
    @Test
    public void roundTripsVersionedBackupAndExactContent() {
        String content = "{\n  \"outbounds\": []\n}\n";
        Profile valid = new Profile("one", "Primary", "raw", null, content, true);
        Profile invalid = new Profile("two", "Legacy", "migrated", null, "old config", false);
        invalid.valid = false;
        invalid.validationError = "removed option";

        MobileBootstrap bootstrap = new MobileBootstrap();
        MobileBootstrap.NodeSource source = new MobileBootstrap.NodeSource();
        source.name = "Self";
        source.configuredNodes = Collections.singletonList("Reality-1");
        bootstrap.nodeSources = Collections.singletonList(source);
        Map<String, MobileBootstrap> inspectorProfiles = new LinkedHashMap<>();
        inspectorProfiles.put("one", bootstrap);

        String encoded = ProfileBackupCodec.encode(
                "one",
                Arrays.asList(valid, invalid),
                inspectorProfiles
        );
        ProfileBackupCodec.DecodedBackup decoded = ProfileBackupCodec.decode(encoded);

        assertEquals(ProfileBackupCodec.CURRENT_VERSION, decoded.version);
        assertEquals("one", decoded.activeProfileId);
        assertEquals(2, decoded.profiles.size());
        assertEquals(content, decoded.profiles.get(0).content);
        assertFalse(decoded.profiles.get(1).valid);
        assertEquals("removed option", decoded.profiles.get(1).validationError);
        assertEquals(
                "Reality-1",
                decoded.inspectorProfiles.get("one").nodeSources.get(0).configuredNodes.get(0)
        );
    }

    @Test
    public void readsVersionOneObjectWithoutInspectorState() {
        ProfileBackupCodec.DecodedBackup decoded = ProfileBackupCodec.decode(
                "{\"version\":1,\"activeProfileId\":\"one\",\"profiles\":[]}"
        );

        assertEquals(1, decoded.version);
        assertEquals("one", decoded.activeProfileId);
        assertTrue(decoded.inspectorProfiles.isEmpty());
    }

    @Test
    public void readsLegacyArrayBackupAndFindsActiveProfile() {
        String legacyJson = "[{\"id\":\"legacy\",\"name\":\"Legacy\","
                + "\"type\":\"raw\",\"content\":\"{}\",\"active\":true}]";

        ProfileBackupCodec.DecodedBackup decoded = ProfileBackupCodec.decode(legacyJson);

        assertEquals(0, decoded.version);
        assertEquals("legacy", decoded.activeProfileId);
        assertTrue(decoded.profiles.get(0).valid);
    }

    @Test
    public void rejectsUnknownOrEmptyBackup() {
        assertThrows(
                IllegalArgumentException.class,
                () -> ProfileBackupCodec.decode("{\"version\":99,\"profiles\":[]}")
        );
        assertThrows(IllegalArgumentException.class, () -> ProfileBackupCodec.decode(" "));
    }
}
