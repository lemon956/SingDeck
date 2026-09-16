package io.singdeck.app.manager;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** 主机采集清单的版本化协议；完整校验后才能替换手机缓存。 */
public final class HarmonyAppInventoryCodec {
    public static final String FORMAT = "singdeck.harmony-apps";
    public static final int VERSION = 1;
    public static final int MAX_BYTES = 2 * 1024 * 1024;
    public static final int MAX_APPS = 5000;

    public static final class App {
        public final String bundleName;
        public final String label;
        public final String versionName;
        public final boolean systemApp;

        private App(String bundleName, String label, String versionName, boolean systemApp) {
            this.bundleName = bundleName;
            this.label = label;
            this.versionName = versionName;
            this.systemApp = systemApp;
        }
    }

    public static final class Inventory {
        public final String format = FORMAT;
        public final int version = VERSION;
        public final long collectedAt;
        public final String deviceModel;
        public final String osVersion;
        public final int userId;
        public final List<App> apps;

        private Inventory(long collectedAt, String deviceModel, String osVersion,
                          int userId, List<App> apps) {
            this.collectedAt = collectedAt;
            this.deviceModel = deviceModel;
            this.osVersion = osVersion;
            this.userId = userId;
            this.apps = Collections.unmodifiableList(apps);
        }
    }

    private HarmonyAppInventoryCodec() {
    }

    /** 读取有大小限制的 UTF-8 清单，不关闭调用方持有的流。 */
    public static Inventory read(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int size;
        while ((size = input.read(buffer)) != -1) {
            if (output.size() + size > MAX_BYTES) {
                throw invalid("文件超过 2 MiB 限制");
            }
            output.write(buffer, 0, size);
        }
        return decode(new String(output.toByteArray(), StandardCharsets.UTF_8));
    }

    /** 校验类型、版本和全部条目；无效或不完整的清单抛出 IllegalArgumentException。 */
    public static Inventory decode(String json) {
        if (json == null || json.getBytes(StandardCharsets.UTF_8).length > MAX_BYTES) {
            throw invalid("文件为空或超过 2 MiB 限制");
        }
        JsonObject root;
        try {
            root = JsonParser.parseString(json).getAsJsonObject();
        } catch (RuntimeException | StackOverflowError error) {
            throw invalid("无法解析 JSON");
        }
        if (!FORMAT.equals(string(root, "format", 64, false))) {
            throw invalid("请选择电脑采集的鸿蒙应用清单");
        }
        if (number(root, "version", Integer.MAX_VALUE) != VERSION) {
            throw invalid("不支持此清单版本，请更新 SingDeck 或重新采集");
        }
        long collectedAt = number(root, "collectedAt", 253402300799999L);
        if (collectedAt == 0) {
            throw invalid("缺少有效采集时间");
        }
        String deviceModel = string(root, "deviceModel", 256, false);
        String osVersion = string(root, "osVersion", 256, false);
        int userId = (int) number(root, "userId", Integer.MAX_VALUE);
        JsonElement items = root.get("apps");
        if (items == null || !items.isJsonArray()) {
            throw invalid("缺少应用列表");
        }
        JsonArray array = items.getAsJsonArray();
        if (array.size() == 0 || array.size() > MAX_APPS) {
            throw invalid("应用数量必须为 1–5000");
        }
        List<App> apps = new ArrayList<>();
        Set<String> bundles = new HashSet<>();
        for (JsonElement element : array) {
            if (!element.isJsonObject()) {
                throw invalid("应用条目不是对象");
            }
            JsonObject item = element.getAsJsonObject();
            String bundle = string(item, "bundleName", 255, false);
            if (!bundle.matches("[A-Za-z0-9_][A-Za-z0-9_.]*") || !bundles.add(bundle)) {
                throw invalid("存在无效或重复的应用包名");
            }
            String label = string(item, "label", 256, false);
            String version = string(item, "versionName", 128, true);
            JsonElement system = item.get("systemApp");
            if (system == null || !system.isJsonPrimitive()
                    || !system.getAsJsonPrimitive().isBoolean()) {
                throw invalid("systemApp 必须为布尔值");
            }
            apps.add(new App(bundle, label, version, system.getAsBoolean()));
        }
        return new Inventory(collectedAt, deviceModel, osVersion, userId, apps);
    }

    public static String encode(Inventory inventory) {
        return new Gson().toJson(inventory);
    }

    private static String string(JsonObject object, String name, int max, boolean allowEmpty) {
        JsonElement value = object.get(name);
        if (value == null || !value.isJsonPrimitive()
                || !value.getAsJsonPrimitive().isString()) {
            throw invalid(name + " 必须为字符串");
        }
        String text = value.getAsString().trim();
        if ((!allowEmpty && text.isEmpty()) || text.length() > max
                || text.matches("(?s).*\\p{Cntrl}.*")) {
            throw invalid(name + " 内容无效或过长");
        }
        return text;
    }

    private static long number(JsonObject object, String name, long max) {
        JsonElement value = object.get(name);
        if (value == null || !value.isJsonPrimitive()
                || !value.getAsJsonPrimitive().isNumber()
                || !value.getAsString().matches("[0-9]{1,15}")) {
            throw invalid(name + " 必须为非负整数");
        }
        long result = Long.parseLong(value.getAsString());
        if (result > max) {
            throw invalid(name + " 超出范围");
        }
        return result;
    }

    private static IllegalArgumentException invalid(String reason) {
        return new IllegalArgumentException("应用清单无效：" + reason);
    }
}
