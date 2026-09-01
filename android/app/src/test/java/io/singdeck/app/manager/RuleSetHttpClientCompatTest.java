package io.singdeck.app.manager;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import org.junit.Test;

public class RuleSetHttpClientCompatTest {
    @Test
    public void replacesRedundantDirectDetourWithExplicitHttp2Client() {
        String original = config(
                "{\"type\":\"direct\",\"tag\":\"direct-out\"}",
                "{\"type\":\"remote\",\"tag\":\"geoip-cn\","
                        + "\"url\":\"https://example.com/geoip.srs\","
                        + "\"http_client\":{\"detour\":\"direct-out\"}}"
        );

        String normalized = RuleSetHttpClientCompat.normalizeForRuntime(original);

        JsonObject ruleSet = firstRuleSet(normalized);
        JsonObject client = ruleSet.getAsJsonObject("http_client");
        assertFalse(client.has("detour"));
        assertEquals(2, client.get("version").getAsInt());
        assertTrue(original.contains("\"detour\":\"direct-out\""));
        assertEquals(normalized, RuleSetHttpClientCompat.normalizeForRuntime(normalized));
    }

    @Test
    public void preservesDetoursThroughProxyOutbounds() {
        String original = config(
                "{\"type\":\"direct\",\"tag\":\"direct-out\"},"
                        + "{\"type\":\"anytls\",\"tag\":\"proxy\","
                        + "\"server\":\"example.com\",\"server_port\":443,"
                        + "\"password\":\"secret\"}",
                "{\"type\":\"remote\",\"tag\":\"geoip-cn\","
                        + "\"url\":\"https://example.com/geoip.srs\","
                        + "\"http_client\":{\"detour\":\"proxy\"}}"
        );

        String normalized = RuleSetHttpClientCompat.normalizeForRuntime(original);

        assertSame(original, normalized);
        assertEquals(
                "proxy",
                firstRuleSet(normalized).getAsJsonObject("http_client")
                        .get("detour").getAsString()
        );
    }

    @Test
    public void migratesLegacyDownloadDetourForEmptyDirectOutbound() {
        String original = config(
                "{\"type\":\"direct\",\"tag\":\"direct-out\"}",
                "{\"type\":\"remote\",\"tag\":\"geosite-cn\","
                        + "\"url\":\"https://example.com/geosite.srs\","
                        + "\"download_detour\":\"direct-out\"}"
        );

        JsonObject ruleSet = firstRuleSet(
                RuleSetHttpClientCompat.normalizeForRuntime(original)
        );

        assertFalse(ruleSet.has("download_detour"));
        assertEquals(2, ruleSet.getAsJsonObject("http_client").get("version").getAsInt());
    }

    @Test
    public void preservesDirectDetourWhenDirectOutboundHasDialerOptions() {
        String original = config(
                "{\"type\":\"direct\",\"tag\":\"direct-out\","
                        + "\"bind_interface\":\"wlan0\"}",
                "{\"type\":\"remote\",\"tag\":\"geoip-cn\","
                        + "\"url\":\"https://example.com/geoip.srs\","
                        + "\"http_client\":{\"detour\":\"direct-out\"}}"
        );

        assertSame(original, RuleSetHttpClientCompat.normalizeForRuntime(original));
    }

    @Test
    public void normalizesNamedHttpClientDefinitions() {
        String original = "{"
                + "\"outbounds\":[{\"type\":\"direct\",\"tag\":\"direct-out\"}],"
                + "\"http_clients\":[{\"tag\":\"rules-direct\","
                + "\"detour\":\"direct-out\"}],"
                + "\"route\":{\"rule_set\":[{\"type\":\"remote\","
                + "\"tag\":\"geoip-cn\",\"url\":\"https://example.com/geoip.srs\","
                + "\"http_client\":\"rules-direct\"}]}}";

        JsonObject normalized = JsonParser.parseString(
                RuleSetHttpClientCompat.normalizeForRuntime(original)
        ).getAsJsonObject();
        JsonObject client = normalized.getAsJsonArray("http_clients")
                .get(0).getAsJsonObject();

        assertEquals("rules-direct", client.get("tag").getAsString());
        assertFalse(client.has("detour"));
        assertEquals(2, client.get("version").getAsInt());
    }

    private static String config(String outbounds, String ruleSet) {
        return "{\"outbounds\":[" + outbounds + "],"
                + "\"route\":{\"rule_set\":[" + ruleSet + "]}}";
    }

    private static JsonObject firstRuleSet(String config) {
        JsonObject root = JsonParser.parseString(config).getAsJsonObject();
        JsonArray ruleSets = root.getAsJsonObject("route").getAsJsonArray("rule_set");
        return ruleSets.get(0).getAsJsonObject();
    }
}
