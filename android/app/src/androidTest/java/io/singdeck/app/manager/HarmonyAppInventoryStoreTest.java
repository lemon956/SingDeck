package io.singdeck.app.manager;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;

import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import android.content.Context;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.nio.charset.StandardCharsets;

@RunWith(AndroidJUnit4.class)
public class HarmonyAppInventoryStoreTest {
    private File directory;
    private HarmonyAppInventoryStore store;

    @Before
    public void setUp() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        directory = new File(context.getCacheDir(), "inventory-test-" + System.nanoTime());
        if (!directory.mkdirs()) {
            throw new IllegalStateException("无法创建测试目录");
        }
        store = new HarmonyAppInventoryStore(directory);
    }

    @After
    public void tearDown() throws Exception {
        store.clear();
        directory.delete();
    }

    @Test
    public void survivesRecreationAndRejectsInvalidReplacement() throws Exception {
        assertNull(store.read());
        String json = "{\"format\":\"singdeck.harmony-apps\",\"version\":1,"
                + "\"collectedAt\":1789516800000,\"deviceModel\":\"Test\","
                + "\"osVersion\":\"6.1\",\"userId\":100,\"apps\":["
                + "{\"bundleName\":\"com.tencent.wechat\",\"label\":\"微信\","
                + "\"versionName\":\"8\",\"systemApp\":false}]}";
        store.importFrom(new ByteArrayInputStream(json.getBytes(StandardCharsets.UTF_8)));
        assertThrows(IllegalArgumentException.class, () -> store.importFrom(
                new ByteArrayInputStream("{}".getBytes(StandardCharsets.UTF_8))));
        HarmonyAppInventoryStore reopened = new HarmonyAppInventoryStore(directory);
        assertEquals("微信", reopened.read().apps.get(0).label);
        reopened.clear();
        assertNull(store.read());
    }
}
