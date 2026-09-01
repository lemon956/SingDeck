package io.singdeck.app.manager;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

/**
 * Applies narrow sing-box 1.14 remote rule-set HTTP client compatibility at runtime.
 *
 * <p>An HTTP client detour that points to a direct outbound without dialer options is
 * redundant and rejected by sing-box 1.14. Replace that detour with an explicit direct
 * HTTP/2 client. The persisted profile is intentionally left untouched.</p>
 */
public final class RuleSetHttpClientCompat {
    private static final Gson GSON = new Gson();

    private RuleSetHttpClientCompat() {
    }

    public static String normalizeForRuntime(String originalConfig) {
        JsonObject root = JsonParser.parseString(originalConfig).getAsJsonObject();
        Set<String> emptyDirectTags = emptyDirectOutboundTags(root);
        if (emptyDirectTags.isEmpty()) {
            return originalConfig;
        }

        boolean changed = normalizeNamedHttpClients(root, emptyDirectTags);
        JsonObject route = object(root, "route");
        if (route != null) {
            JsonArray ruleSets = array(route, "rule_set");
            if (ruleSets != null) {
                for (JsonElement element : ruleSets) {
                    if (!element.isJsonObject()) {
                        continue;
                    }
                    JsonObject ruleSet = element.getAsJsonObject();
                    if (!"remote".equalsIgnoreCase(string(ruleSet, "type"))) {
                        continue;
                    }
                    changed |= normalizeRemoteRuleSet(ruleSet, emptyDirectTags);
                }
            }
        }
        return changed ? GSON.toJson(root) : originalConfig;
    }

    private static boolean normalizeNamedHttpClients(
            JsonObject root,
            Set<String> emptyDirectTags
    ) {
        JsonArray clients = array(root, "http_clients");
        if (clients == null) {
            return false;
        }
        boolean changed = false;
        for (JsonElement element : clients) {
            if (element.isJsonObject()) {
                changed |= normalizeHttpClient(
                        element.getAsJsonObject(),
                        emptyDirectTags,
                        true
                );
            }
        }
        return changed;
    }

    private static boolean normalizeRemoteRuleSet(
            JsonObject ruleSet,
            Set<String> emptyDirectTags
    ) {
        boolean changed = false;
        String legacyDetour = string(ruleSet, "download_detour");
        JsonElement clientElement = ruleSet.get("http_client");
        if (emptyDirectTags.contains(legacyDetour) && isAbsentOrEmptyObject(clientElement)) {
            ruleSet.remove("download_detour");
            JsonObject client = clientElement != null && clientElement.isJsonObject()
                    ? clientElement.getAsJsonObject()
                    : new JsonObject();
            ensureExplicitDirectClient(client, false);
            ruleSet.add("http_client", client);
            changed = true;
        }

        clientElement = ruleSet.get("http_client");
        if (clientElement != null && clientElement.isJsonObject()) {
            changed |= normalizeHttpClient(
                    clientElement.getAsJsonObject(),
                    emptyDirectTags,
                    false
            );
        }
        return changed;
    }

    private static boolean normalizeHttpClient(
            JsonObject client,
            Set<String> emptyDirectTags,
            boolean namedClient
    ) {
        String detour = string(client, "detour");
        if (!emptyDirectTags.contains(detour)) {
            return false;
        }
        client.remove("detour");
        ensureExplicitDirectClient(client, namedClient);
        return true;
    }

    private static void ensureExplicitDirectClient(JsonObject client, boolean namedClient) {
        int nonIdentityFields = 0;
        for (Map.Entry<String, JsonElement> entry : client.entrySet()) {
            if (!namedClient || !"tag".equals(entry.getKey())) {
                nonIdentityFields++;
            }
        }
        if (nonIdentityFields == 0) {
            client.addProperty("version", 2);
        }
    }

    private static Set<String> emptyDirectOutboundTags(JsonObject root) {
        Set<String> tags = new LinkedHashSet<>();
        JsonArray outbounds = array(root, "outbounds");
        if (outbounds == null) {
            return tags;
        }
        for (JsonElement element : outbounds) {
            if (!element.isJsonObject()) {
                continue;
            }
            JsonObject outbound = element.getAsJsonObject();
            if (!"direct".equalsIgnoreCase(string(outbound, "type"))
                    || hasDirectDialerOptions(outbound)) {
                continue;
            }
            String tag = string(outbound, "tag");
            if (!tag.isEmpty()) {
                tags.add(tag);
            }
        }
        return tags;
    }

    private static boolean hasDirectDialerOptions(JsonObject outbound) {
        for (Map.Entry<String, JsonElement> entry : outbound.entrySet()) {
            if (!"type".equals(entry.getKey()) && !"tag".equals(entry.getKey())) {
                return true;
            }
        }
        return false;
    }

    private static boolean isAbsentOrEmptyObject(JsonElement element) {
        return element == null
                || element.isJsonNull()
                || (element.isJsonObject() && element.getAsJsonObject().entrySet().isEmpty());
    }

    private static JsonObject object(JsonObject root, String name) {
        JsonElement value = root.get(name);
        return value != null && value.isJsonObject() ? value.getAsJsonObject() : null;
    }

    private static JsonArray array(JsonObject root, String name) {
        JsonElement value = root.get(name);
        return value != null && value.isJsonArray() ? value.getAsJsonArray() : null;
    }

    private static String string(JsonObject object, String name) {
        JsonElement value = object.get(name);
        return value == null || value.isJsonNull() || !value.isJsonPrimitive()
                ? ""
                : value.getAsString().trim();
    }
}
