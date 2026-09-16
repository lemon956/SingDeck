package io.singdeck.app.manager;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;

public class HarmonyAppInventoryCodecTest {
    private static final String VALID = "{\"format\":\"singdeck.harmony-apps\",\"version\":1,"
            + "\"collectedAt\":1789516800000,\"deviceModel\":\"Test phone\","
            + "\"osVersion\":\"OpenHarmony-6.1.1.120\",\"userId\":100,\"apps\":["
            + "{\"bundleName\":\"com.tencent.wechat\",\"label\":\"微信\","
            + "\"versionName\":\"8.0.21\",\"systemApp\":false}]}";

    @Test
    public void readsChineseNamesAndPreservesMetadataAcrossCacheRoundTrip() throws Exception {
        HarmonyAppInventoryCodec.Inventory decoded = HarmonyAppInventoryCodec.read(
                new ByteArrayInputStream(VALID.getBytes(StandardCharsets.UTF_8)));
        HarmonyAppInventoryCodec.Inventory cached = HarmonyAppInventoryCodec.decode(
                HarmonyAppInventoryCodec.encode(decoded));
        assertEquals(100, cached.userId);
        assertEquals(1789516800000L, cached.collectedAt);
        assertEquals("微信", cached.apps.get(0).label);
        assertEquals("com.tencent.wechat", cached.apps.get(0).bundleName);
        assertFalse(cached.apps.get(0).systemApp);
        assertThrows(UnsupportedOperationException.class, () -> cached.apps.clear());
    }

    @Test
    public void rejectsConfigBackupsAndFutureProtocolVersions() {
        rejects(VALID.replace("singdeck.harmony-apps", "singdeck.backup"));
        rejects(VALID.replace("\"version\":1", "\"version\":2"));
        rejects(VALID.replace("\"version\":1", "\"version\":1.5"));
        rejects(VALID.replace("\"version\":1", "\"version\":\"1\""));
        rejects("{}");
        rejects("[]");
        rejects("null");
        rejects("{broken json");
    }

    @Test
    public void rejectsPartialEmptyAndDuplicateSnapshots() {
        JsonObject root = JsonParser.parseString(VALID).getAsJsonObject();
        root.getAsJsonArray("apps").add(root.getAsJsonArray("apps").get(0).deepCopy());
        rejects(root.toString());
        root.getAsJsonArray("apps").remove(1);
        root.getAsJsonArray("apps").get(0).getAsJsonObject().remove("systemApp");
        rejects(root.toString());
        root.getAsJsonArray("apps").remove(0);
        rejects(root.toString());
    }

    @Test
    public void rejectsInvalidFieldTypesAndUnboundedDisplayText() {
        rejects(VALID.replace("\"systemApp\":false", "\"systemApp\":\"false\""));
        rejects(VALID.replace("com.tencent.wechat", "com.tencent;echo"));
        rejects(VALID.replace("微信", "微信\\nextra"));
        rejects(VALID.replace("微信", "a".repeat(257)));
        rejects(VALID.replace("1789516800000", "0"));
        rejects(VALID.replace("\"userId\":100", "\"userId\":-1"));
    }

    @Test
    public void rejectsTooManyAppsAndOversizedStreams() {
        JsonObject root = JsonParser.parseString(VALID).getAsJsonObject();
        for (int i = 1; i <= HarmonyAppInventoryCodec.MAX_APPS; i++) {
            JsonObject app = root.getAsJsonArray("apps").get(0).deepCopy().getAsJsonObject();
            app.addProperty("bundleName", "com.example.app" + i);
            root.getAsJsonArray("apps").add(app);
        }
        rejects(root.toString());
        assertThrows(IllegalArgumentException.class, () -> HarmonyAppInventoryCodec.read(
                new ByteArrayInputStream(new byte[HarmonyAppInventoryCodec.MAX_BYTES + 1])));
    }

    private static void rejects(String json) {
        assertThrows(IllegalArgumentException.class, () -> HarmonyAppInventoryCodec.decode(json));
    }
}
