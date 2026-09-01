package io.singdeck.app.manager;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

public class NodeLinkParserTest {
    private static final String ANYTLS_LINK =
            "anytls://094a21e8-6633-4e81-9803-8c87dbde505b@9e1d7a04.hotssid.com:42101/"
                    + "?insecure=0&sni=d5.dirvt.com#%F0%9F%87%AD%F0%9F%87%B0%20%E9%A6%99%E6%B8%AF%2001";

    @Test
    public void parsesAnyTlsShareLinkForSingBox114() {
        JsonObject root = JsonParser.parseString(
                NodeLinkParser.parseToSingBoxConfig(ANYTLS_LINK, "SSID")
        ).getAsJsonObject();

        JsonObject anyTls = findOutbound(root.getAsJsonArray("outbounds"), "anytls");
        assertEquals("🇭🇰 香港 01", anyTls.get("tag").getAsString());
        assertEquals("9e1d7a04.hotssid.com", anyTls.get("server").getAsString());
        assertEquals(42101, anyTls.get("server_port").getAsInt());
        assertEquals(
                "094a21e8-6633-4e81-9803-8c87dbde505b",
                anyTls.get("password").getAsString()
        );
        assertEquals(
                "d5.dirvt.com",
                anyTls.getAsJsonObject("tls").get("server_name").getAsString()
        );
        assertFalse(anyTls.getAsJsonObject("tls").get("insecure").getAsBoolean());

        JsonObject tun = root.getAsJsonArray("inbounds").get(0).getAsJsonObject();
        assertTrue(tun.has("address"));
        assertEquals(2, tun.getAsJsonArray("address").size());
        assertFalse(tun.has("inet4_address"));
        assertFalse(tun.has("sniff"));
        assertEquals("local-dns",
                root.getAsJsonObject("route").get("default_domain_resolver").getAsString());
        JsonArray routeRules = root.getAsJsonObject("route").getAsJsonArray("rules");
        assertEquals("sniff", routeRules.get(0).getAsJsonObject().get("action").getAsString());
        JsonArray dnsServers = root.getAsJsonObject("dns").getAsJsonArray("servers");
        assertEquals("DIRECT", dnsServers.get(1).getAsJsonObject().get("detour").getAsString());
        for (int index = 0; index < root.getAsJsonArray("outbounds").size(); index++) {
            assertFalse("dns".equals(root.getAsJsonArray("outbounds")
                    .get(index).getAsJsonObject().get("type").getAsString()));
        }
    }

    @Test
    public void preservesFullSingBoxJsonExactly() {
        String json = "{\n  \"outbounds\": [{\"type\": \"direct\", \"tag\": \"DIRECT\"}]\n}\n";
        assertEquals(json, NodeLinkParser.parseToSingBoxConfig(json, "raw"));
    }

    @Test
    public void decodesBase64SubscriptionAndMakesDuplicateTagsUnique() {
        String links = ANYTLS_LINK + "\n" + ANYTLS_LINK;
        String encoded = Base64.getEncoder()
                .withoutPadding()
                .encodeToString(links.getBytes(StandardCharsets.UTF_8));

        JsonArray outbounds = JsonParser.parseString(
                NodeLinkParser.parseToSingBoxConfig(encoded, "encoded")
        ).getAsJsonObject().getAsJsonArray("outbounds");

        assertEquals("🇭🇰 香港 01", findOutbound(outbounds, "anytls").get("tag").getAsString());
        assertTrue(hasTag(outbounds, "🇭🇰 香港 01 (2)"));
    }

    @Test
    public void convertsHysteria2BandwidthAndObfuscationToTypedOptions() {
        JsonObject root = JsonParser.parseString(NodeLinkParser.parseToSingBoxConfig(
                "hy2://secret@example.com:443?sni=example.com&obfs=salamander"
                        + "&obfs-password=mask&upmbps=20&downmbps=100#HY2",
                "HY2"
        )).getAsJsonObject();

        JsonObject hysteria = findOutbound(root.getAsJsonArray("outbounds"), "hysteria2");
        assertEquals(20, hysteria.get("up_mbps").getAsInt());
        assertEquals(100, hysteria.get("down_mbps").getAsInt());
        assertEquals("salamander", hysteria.getAsJsonObject("obfs").get("type").getAsString());
        assertEquals("mask", hysteria.getAsJsonObject("obfs").get("password").getAsString());
    }

    @Test
    public void rejectsUnsupportedOrPartiallyConvertibleInput() {
        NodeLinkParser.ParseException unsupported = assertThrows(
                NodeLinkParser.ParseException.class,
                () -> NodeLinkParser.parseToSingBoxConfig(
                        ANYTLS_LINK + "\nvmess://unsupported",
                        "mixed"
                )
        );
        assertTrue(unsupported.getMessage().contains("不支持 vmess 协议"));

        NodeLinkParser.ParseException clash = assertThrows(
                NodeLinkParser.ParseException.class,
                () -> NodeLinkParser.parseToSingBoxConfig("proxies:\n  - name: HK", "clash")
        );
        assertTrue(clash.getMessage().contains("暂不支持 Clash YAML"));
    }

    private static JsonObject findOutbound(JsonArray outbounds, String type) {
        for (int index = 0; index < outbounds.size(); index++) {
            JsonObject outbound = outbounds.get(index).getAsJsonObject();
            if (type.equals(outbound.get("type").getAsString())) {
                return outbound;
            }
        }
        throw new AssertionError("Missing outbound type " + type);
    }

    private static boolean hasTag(JsonArray outbounds, String tag) {
        for (int index = 0; index < outbounds.size(); index++) {
            JsonObject outbound = outbounds.get(index).getAsJsonObject();
            if (outbound.has("tag") && tag.equals(outbound.get("tag").getAsString())) {
                return true;
            }
        }
        return false;
    }
}
