package io.singdeck.app.manager;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.security.SecureRandom;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;

import io.nekohasekai.libbox.Libbox;

/** Builds an in-memory-only authenticated SOCKS inspection path through sing-box. */
public final class RuntimeConfigOverlay {
    public static final String HIDDEN_PREFIX = "__singdeck_";
    public static final String INSPECTOR_INBOUND = HIDDEN_PREFIX + "inspector_in";
    public static final String INSPECTOR_OUTBOUND = HIDDEN_PREFIX + "inspector_out";
    private static final int PORT_SEARCH_START = 37_000;
    private static final Set<String> NON_PROXY_TYPES = Set.of(
            "direct", "block", "dns", "selector", "urltest"
    );
    private static final SecureRandom RANDOM = new SecureRandom();
    private static final Gson GSON = new Gson();

    private RuntimeConfigOverlay() {
    }

    public static final class ProxyEndpoint {
        public final int port;
        public final String username;
        public final String password;
        public final String selectorTag;

        ProxyEndpoint(int port, String username, String password, String selectorTag) {
            this.port = port;
            this.username = username;
            this.password = password;
            this.selectorTag = selectorTag;
        }
    }

    public static final class Result {
        public final String runtimeConfig;
        public final ProxyEndpoint endpoint;

        Result(String runtimeConfig, ProxyEndpoint endpoint) {
            this.runtimeConfig = runtimeConfig;
            this.endpoint = endpoint;
        }
    }

    public static Result create(String originalConfig) throws Exception {
        int port = Libbox.availablePort(PORT_SEARCH_START);
        return create(originalConfig, port, randomSecret(), randomSecret());
    }

    static Result create(
            String originalConfig,
            int port,
            String username,
            String password
    ) {
        if (originalConfig == null || originalConfig.trim().isEmpty()) {
            throw new IllegalArgumentException("配置内容为空");
        }
        if (port < 1 || port > 65_535) {
            throw new IllegalArgumentException("Inspector 端口无效");
        }
        if (username == null || username.isEmpty() || password == null || password.isEmpty()) {
            throw new IllegalArgumentException("Inspector 凭据为空");
        }

        JsonObject root = JsonParser.parseString(originalConfig).getAsJsonObject();
        JsonArray inbounds = array(root, "inbounds");
        JsonArray outbounds = array(root, "outbounds");
        rejectReservedTags(inbounds);
        rejectReservedTags(outbounds);

        LinkedHashSet<String> proxyTags = new LinkedHashSet<>();
        for (JsonElement element : outbounds) {
            if (!element.isJsonObject()) {
                continue;
            }
            JsonObject outbound = element.getAsJsonObject();
            String tag = string(outbound, "tag");
            String type = string(outbound, "type").toLowerCase(Locale.ROOT);
            if (!tag.isEmpty() && !NON_PROXY_TYPES.contains(type)) {
                proxyTags.add(tag);
            }
        }
        if (proxyTags.isEmpty()) {
            throw new IllegalArgumentException("配置中没有可供 Inspector 使用的代理节点");
        }

        JsonObject inspectorInbound = new JsonObject();
        inspectorInbound.addProperty("type", "mixed");
        inspectorInbound.addProperty("tag", INSPECTOR_INBOUND);
        inspectorInbound.addProperty("listen", "127.0.0.1");
        inspectorInbound.addProperty("listen_port", port);
        JsonArray users = new JsonArray();
        JsonObject user = new JsonObject();
        user.addProperty("username", username);
        user.addProperty("password", password);
        users.add(user);
        inspectorInbound.add("users", users);
        inbounds.add(inspectorInbound);

        JsonObject inspectorSelector = new JsonObject();
        inspectorSelector.addProperty("type", "selector");
        inspectorSelector.addProperty("tag", INSPECTOR_OUTBOUND);
        JsonArray selectorMembers = new JsonArray();
        for (String tag : proxyTags) {
            selectorMembers.add(tag);
        }
        inspectorSelector.add("outbounds", selectorMembers);
        outbounds.add(inspectorSelector);

        JsonObject route = root.has("route") && root.get("route").isJsonObject()
                ? root.getAsJsonObject("route")
                : new JsonObject();
        JsonArray existingRules = route.has("rules") && route.get("rules").isJsonArray()
                ? route.getAsJsonArray("rules")
                : new JsonArray();
        JsonArray rules = new JsonArray();
        JsonObject inspectorRule = new JsonObject();
        inspectorRule.addProperty("inbound", INSPECTOR_INBOUND);
        inspectorRule.addProperty("action", "route");
        inspectorRule.addProperty("outbound", INSPECTOR_OUTBOUND);
        rules.add(inspectorRule);
        for (JsonElement rule : existingRules) {
            rules.add(rule);
        }
        route.add("rules", rules);
        root.add("route", route);

        return new Result(
                GSON.toJson(root),
                new ProxyEndpoint(port, username, password, INSPECTOR_OUTBOUND)
        );
    }

    public static boolean isHiddenTag(String tag) {
        return tag != null && tag.startsWith(HIDDEN_PREFIX);
    }

    private static JsonArray array(JsonObject root, String name) {
        if (root.has(name) && root.get(name).isJsonArray()) {
            return root.getAsJsonArray(name);
        }
        JsonArray value = new JsonArray();
        root.add(name, value);
        return value;
    }

    private static void rejectReservedTags(JsonArray entries) {
        for (JsonElement element : entries) {
            if (element.isJsonObject() && isHiddenTag(string(element.getAsJsonObject(), "tag"))) {
                throw new IllegalArgumentException("配置占用了 SingDeck 保留标签前缀 " + HIDDEN_PREFIX);
            }
        }
    }

    private static String string(JsonObject object, String name) {
        JsonElement value = object.get(name);
        return value == null || value.isJsonNull() || !value.isJsonPrimitive()
                ? ""
                : value.getAsString();
    }

    private static String randomSecret() {
        byte[] bytes = new byte[18];
        RANDOM.nextBytes(bytes);
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            result.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        }
        return result.toString();
    }
}
