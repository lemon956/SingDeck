package io.singdeck.app.manager;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import org.junit.Test;

public class RuntimeConfigOverlayTest {
    private static final String CONFIG = "{\n"
            + "  \"inbounds\": [{\"type\":\"tun\",\"tag\":\"tun-in\","
            + "\"address\":[\"172.19.0.1/30\"],\"auto_route\":true}],\n"
            + "  \"outbounds\": ["
            + "{\"type\":\"anytls\",\"tag\":\"HK 01\",\"server\":\"example.com\","
            + "\"server_port\":443,\"password\":\"secret\"},"
            + "{\"type\":\"direct\",\"tag\":\"DIRECT\"},"
            + "{\"type\":\"selector\",\"tag\":\"Proxy\",\"outbounds\":[\"HK 01\"]}],\n"
            + "  \"route\": {\"rules\":[{\"action\":\"route\",\"outbound\":\"Proxy\"}]}\n"
            + "}";

    @Test
    public void injectsAuthenticatedLocalInspectorWithoutChangingOriginalText() {
        String original = CONFIG;
        RuntimeConfigOverlay.Result result = RuntimeConfigOverlay.create(
                CONFIG,
                37_123,
                "inspector-user",
                "inspector-pass"
        );

        assertEquals(original, CONFIG);
        assertEquals(37_123, result.endpoint.port);
        JsonObject root = JsonParser.parseString(result.runtimeConfig).getAsJsonObject();
        JsonArray inbounds = root.getAsJsonArray("inbounds");
        JsonObject inbound = inbounds.get(inbounds.size() - 1).getAsJsonObject();
        assertEquals(RuntimeConfigOverlay.INSPECTOR_INBOUND, inbound.get("tag").getAsString());
        assertEquals("127.0.0.1", inbound.get("listen").getAsString());
        assertEquals("inspector-user", inbound.getAsJsonArray("users")
                .get(0).getAsJsonObject().get("username").getAsString());

        JsonArray outbounds = root.getAsJsonArray("outbounds");
        JsonObject selector = outbounds.get(outbounds.size() - 1).getAsJsonObject();
        assertEquals(RuntimeConfigOverlay.INSPECTOR_OUTBOUND, selector.get("tag").getAsString());
        assertEquals(1, selector.getAsJsonArray("outbounds").size());
        assertEquals("HK 01", selector.getAsJsonArray("outbounds").get(0).getAsString());

        JsonObject firstRule = root.getAsJsonObject("route")
                .getAsJsonArray("rules").get(0).getAsJsonObject();
        assertEquals(RuntimeConfigOverlay.INSPECTOR_INBOUND,
                firstRule.get("inbound").getAsString());
        assertEquals(RuntimeConfigOverlay.INSPECTOR_OUTBOUND,
                firstRule.get("outbound").getAsString());
    }

    @Test
    public void rejectsUserConfigUsingReservedTags() {
        String collision = CONFIG.replace("tun-in", "__singdeck_custom");
        IllegalArgumentException error = assertThrows(
                IllegalArgumentException.class,
                () -> RuntimeConfigOverlay.create(collision, 37_123, "user", "pass")
        );
        assertTrue(error.getMessage().contains(RuntimeConfigOverlay.HIDDEN_PREFIX));
    }

    @Test
    public void hiddenTagCheckIsExactAndCaseSensitive() {
        assertTrue(RuntimeConfigOverlay.isHiddenTag("__singdeck_inspector_out"));
        assertFalse(RuntimeConfigOverlay.isHiddenTag("__SingDeck_inspector_out"));
        assertFalse(RuntimeConfigOverlay.isHiddenTag("Proxy"));
    }
}
