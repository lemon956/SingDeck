package io.singdeck.app.manager;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class MobileImportLinkTest {
    @Test
    public void parsesConfigOnlyRemoteProfileWithoutChangingCompatibilityUrl() {
        MobileImportLink link = MobileImportLink.parse(
                "sing-box://import-remote-profile?url="
                        + "http%3A%2F%2F192.168.1.20%3A9531%2Fapi%2Fv1%2Fconfig%2Fraw"
                        + "%3Ftoken%3Dabc%2520def#SingDeck"
        );

        assertEquals("SingDeck", link.name);
        assertEquals(
                "http://192.168.1.20:9531/api/v1/config/raw?token=abc%20def",
                link.configUrl
        );
        assertFalse(link.includeSettings);
    }

    @Test
    public void derivesAuthenticatedBootstrapUrlForSettingsImport() {
        MobileImportLink link = MobileImportLink.fromConfigUrl(
                "http://192.168.1.20:9531/api/v1/config/raw"
                        + "?token=abc%20def&singdeck_settings=1",
                "Phone"
        );

        assertTrue(link.includeSettings);
        assertEquals("Phone", link.name);
        assertEquals(
                "http://192.168.1.20:9531/api/v1/mobile/bootstrap?token=abc%20def",
                link.bootstrapUrl
        );
    }

    @Test
    public void rejectsNonSingDeckRemoteConfigEndpoint() {
        assertThrows(
                IllegalArgumentException.class,
                () -> MobileImportLink.fromConfigUrl("https://example.com/sub", "Profile")
        );
    }
}
