package io.singdeck.app.manager;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;

import io.singdeck.app.model.Profile;

public class ProfileBackupCodecTest {
    @Test
    public void roundTripsVersionedBackupAndExactContent() {
        String content = "{\n  \"outbounds\": []\n}\n";
        Profile valid = new Profile("one", "Primary", "raw", null, content, true);
        Profile invalid = new Profile("two", "Legacy", "migrated", null, "old config", false);
        invalid.valid = false;
        invalid.validationError = "removed option";

        String encoded = ProfileBackupCodec.encode("one", Arrays.asList(valid, invalid));
        ProfileBackupCodec.DecodedBackup decoded = ProfileBackupCodec.decode(encoded);

        assertEquals(ProfileBackupCodec.CURRENT_VERSION, decoded.version);
        assertEquals("one", decoded.activeProfileId);
        assertEquals(2, decoded.profiles.size());
        assertEquals(content, decoded.profiles.get(0).content);
        assertFalse(decoded.profiles.get(1).valid);
        assertEquals("removed option", decoded.profiles.get(1).validationError);
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
