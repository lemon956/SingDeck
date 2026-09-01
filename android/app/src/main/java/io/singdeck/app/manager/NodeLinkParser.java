package io.singdeck.app.manager;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Converts supported share links into a sing-box 1.14 configuration.
 *
 * <p>Full sing-box JSON is intentionally preserved byte-for-byte. Conversion is strict: an
 * unsupported or malformed line rejects the complete import so users never start an incomplete
 * subscription by accident.</p>
 */
public final class NodeLinkParser {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final Set<String> SUPPORTED_SCHEMES = new LinkedHashSet<>(Arrays.asList(
            "anytls", "ss", "trojan", "vless", "hysteria2", "hy2"
    ));

    private NodeLinkParser() {
    }

    public static final class ParseException extends IllegalArgumentException {
        public ParseException(String message) {
            super(message);
        }

        public ParseException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    public static String parseToSingBoxConfig(String rawText, String profileName) {
        if (rawText == null || rawText.trim().isEmpty()) {
            throw new ParseException("配置内容为空");
        }

        String trimmed = rawText.trim();
        if (trimmed.startsWith("{")) {
            validateJsonShape(trimmed);
            return rawText;
        }

        if (looksLikeClashYaml(trimmed)) {
            throw new ParseException("暂不支持 Clash YAML，请先转换为 sing-box JSON");
        }

        String decodedText = decodeSubscriptionBlob(trimmed);
        String[] lines = decodedText.split("\\r?\\n");
        JsonArray nodes = new JsonArray();
        List<String> nodeTags = new ArrayList<>();
        Map<String, Integer> tagCounts = new LinkedHashMap<>();
        List<String> errors = new ArrayList<>();

        for (int index = 0; index < lines.length; index++) {
            String line = lines[index].trim();
            if (line.isEmpty() || line.startsWith("#")) {
                continue;
            }

            try {
                JsonObject node = parseNodeUri(line);
                String tag = makeUniqueTag(node.get("tag").getAsString(), tagCounts);
                node.addProperty("tag", tag);
                nodes.add(node);
                nodeTags.add(tag);
            } catch (ParseException error) {
                errors.add("第 " + (index + 1) + " 行：" + error.getMessage());
            }
        }

        if (!errors.isEmpty()) {
            throw new ParseException(joinValues(errors, "；"));
        }
        if (nodeTags.isEmpty()) {
            throw new ParseException("未找到支持的节点链接");
        }

        return GSON.toJson(buildConfig(nodes, nodeTags));
    }

    private static void validateJsonShape(String content) {
        try {
            JsonElement parsed = JsonParser.parseString(content);
            if (!parsed.isJsonObject()) {
                throw new ParseException("sing-box 配置必须是 JSON 对象");
            }
            JsonObject root = parsed.getAsJsonObject();
            if (!root.has("outbounds") || !root.get("outbounds").isJsonArray()) {
                throw new ParseException("sing-box 配置缺少 outbounds 数组");
            }
        } catch (ParseException error) {
            throw error;
        } catch (Exception error) {
            throw new ParseException("JSON 配置格式错误：" + safeMessage(error), error);
        }
    }

    private static boolean looksLikeClashYaml(String content) {
        return content.contains("proxies:")
                || content.contains("proxy-groups:")
                || content.contains("rules:");
    }

    private static String decodeSubscriptionBlob(String content) {
        if (content.contains("://")) {
            return content;
        }

        String compact = content.replaceAll("\\s+", "");
        String padded = padBase64(compact);
        try {
            String candidate = new String(decodeBase64Bytes(padded), StandardCharsets.UTF_8).trim();
            if (candidate.contains("://")) {
                return candidate;
            }
        } catch (IllegalArgumentException ignored) {
        }
        return content;
    }

    private static String padBase64(String value) {
        int remainder = value.length() % 4;
        if (remainder == 0) {
            return value;
        }
        StringBuilder padded = new StringBuilder(value);
        for (int index = remainder; index < 4; index++) {
            padded.append('=');
        }
        return padded.toString();
    }

    private static JsonObject buildConfig(JsonArray nodes, List<String> nodeTags) {
        JsonObject root = new JsonObject();

        JsonObject tun = new JsonObject();
        tun.addProperty("type", "tun");
        tun.addProperty("tag", "tun-in");
        JsonArray addresses = new JsonArray();
        addresses.add("172.19.0.1/30");
        addresses.add("fdfe:dcba:9876::1/126");
        tun.add("address", addresses);
        tun.addProperty("auto_route", true);
        tun.addProperty("strict_route", true);
        tun.addProperty("stack", "system");
        JsonArray inbounds = new JsonArray();
        inbounds.add(tun);
        root.add("inbounds", inbounds);

        JsonArray outbounds = new JsonArray();
        JsonObject selector = new JsonObject();
        selector.addProperty("type", "selector");
        selector.addProperty("tag", "PROXY");
        JsonArray selectorMembers = new JsonArray();
        for (String tag : nodeTags) {
            selectorMembers.add(tag);
        }
        selector.add("outbounds", selectorMembers);
        selector.addProperty("default", nodeTags.get(0));
        outbounds.add(selector);

        JsonObject direct = new JsonObject();
        direct.addProperty("type", "direct");
        direct.addProperty("tag", "DIRECT");
        outbounds.add(direct);
        for (JsonElement node : nodes) {
            outbounds.add(node);
        }
        root.add("outbounds", outbounds);

        JsonObject dns = new JsonObject();
        JsonArray dnsServers = new JsonArray();
        JsonObject remoteDns = new JsonObject();
        remoteDns.addProperty("type", "https");
        remoteDns.addProperty("tag", "remote-dns");
        remoteDns.addProperty("server", "1.1.1.1");
        remoteDns.addProperty("server_port", 443);
        remoteDns.addProperty("path", "/dns-query");
        JsonObject dnsTls = new JsonObject();
        dnsTls.addProperty("enabled", true);
        dnsTls.addProperty("server_name", "cloudflare-dns.com");
        remoteDns.add("tls", dnsTls);
        remoteDns.addProperty("detour", "PROXY");
        dnsServers.add(remoteDns);

        JsonObject localDns = new JsonObject();
        localDns.addProperty("type", "udp");
        localDns.addProperty("tag", "local-dns");
        localDns.addProperty("server", "223.5.5.5");
        localDns.addProperty("detour", "DIRECT");
        dnsServers.add(localDns);
        dns.add("servers", dnsServers);

        JsonArray dnsRules = new JsonArray();
        JsonObject localDnsRule = new JsonObject();
        localDnsRule.add("domain_suffix", stringArray(
                "cn", "qq.com", "baidu.com", "taobao.com", "alipay.com", "jd.com",
                "bilibili.com", "163.com", "zhihu.com", "weibo.com", "douyin.com",
                "xiaohongshu.com"
        ));
        localDnsRule.addProperty("action", "route");
        localDnsRule.addProperty("server", "local-dns");
        dnsRules.add(localDnsRule);
        dns.add("rules", dnsRules);
        dns.addProperty("final", "remote-dns");
        root.add("dns", dns);

        JsonObject route = new JsonObject();
        JsonArray rules = new JsonArray();

        JsonObject sniff = new JsonObject();
        sniff.addProperty("action", "sniff");
        rules.add(sniff);

        JsonObject dnsHijack = new JsonObject();
        dnsHijack.addProperty("protocol", "dns");
        dnsHijack.addProperty("action", "hijack-dns");
        rules.add(dnsHijack);

        JsonObject privateRule = new JsonObject();
        privateRule.addProperty("ip_is_private", true);
        privateRule.addProperty("action", "route");
        privateRule.addProperty("outbound", "DIRECT");
        rules.add(privateRule);

        JsonObject domesticRule = new JsonObject();
        domesticRule.add("domain_suffix", stringArray(
                "cn", "qq.com", "baidu.com", "taobao.com", "alipay.com", "jd.com",
                "bilibili.com", "163.com", "zhihu.com", "weibo.com", "douyin.com",
                "xiaohongshu.com"
        ));
        domesticRule.addProperty("action", "route");
        domesticRule.addProperty("outbound", "DIRECT");
        rules.add(domesticRule);

        route.add("rules", rules);
        route.addProperty("default_domain_resolver", "local-dns");
        route.addProperty("auto_detect_interface", true);
        route.addProperty("final", "PROXY");
        root.add("route", route);
        return root;
    }

    private static JsonArray stringArray(String... values) {
        JsonArray array = new JsonArray();
        for (String value : values) {
            array.add(value);
        }
        return array;
    }

    private static JsonObject parseNodeUri(String uriText) {
        final URI uri;
        try {
            uri = URI.create(uriText.replace(" ", "%20"));
        } catch (Exception error) {
            throw new ParseException("节点链接格式错误", error);
        }

        String scheme = uri.getScheme();
        if (scheme == null) {
            throw new ParseException("节点链接缺少协议");
        }
        scheme = scheme.toLowerCase(Locale.ROOT);
        if (!SUPPORTED_SCHEMES.contains(scheme)) {
            throw new ParseException("不支持 " + scheme + " 协议");
        }
        if ("ss".equals(scheme)) {
            return parseShadowsocks(uriText, uri);
        }

        String server = uri.getHost();
        int port = uri.getPort();
        String credential = decodePercent(uri.getRawUserInfo());
        if (isBlank(server)) {
            throw new ParseException(scheme + " 节点缺少服务器地址");
        }
        if (isBlank(credential)) {
            throw new ParseException(scheme + " 节点缺少认证信息");
        }
        if (port < 1 || port > 65535) {
            port = 443;
        }

        Map<String, String> query = parseQuery(uri.getRawQuery());
        JsonObject node = new JsonObject();
        node.addProperty("tag", buildTag(uri, scheme, server, port));
        node.addProperty("server", server);
        node.addProperty("server_port", port);

        switch (scheme) {
            case "anytls":
                node.addProperty("type", "anytls");
                node.addProperty("password", credential);
                node.add("tls", createTls(query, true));
                addInteger(query, node, "min-idle-session", "min_idle_session");
                addInteger(query, node, "min_idle_session", "min_idle_session");
                addString(query, node, "idle-session-check-interval", "idle_session_check_interval");
                addString(query, node, "idle_session_check_interval", "idle_session_check_interval");
                addString(query, node, "idle-session-timeout", "idle_session_timeout");
                addString(query, node, "idle_session_timeout", "idle_session_timeout");
                return node;
            case "trojan":
                node.addProperty("type", "trojan");
                node.addProperty("password", credential);
                node.add("tls", createTls(query, true));
                addTransport(node, query);
                return node;
            case "hysteria2":
            case "hy2":
                node.addProperty("type", "hysteria2");
                node.addProperty("password", credential);
                node.add("tls", createTls(query, true));
                String obfsType = value(query, "obfs");
                String obfsPassword = firstValue(query, "obfs-password", "obfs_password");
                if (!isBlank(obfsType)) {
                    JsonObject obfs = new JsonObject();
                    obfs.addProperty("type", obfsType);
                    if (!isBlank(obfsPassword)) {
                        obfs.addProperty("password", obfsPassword);
                    }
                    node.add("obfs", obfs);
                } else if (!isBlank(obfsPassword)) {
                    throw new ParseException("Hysteria2 obfs-password 缺少 obfs 类型");
                }
                addInteger(query, node, "upmbps", "up_mbps");
                addInteger(query, node, "downmbps", "down_mbps");
                return node;
            case "vless":
                node.addProperty("type", "vless");
                node.addProperty("uuid", credential);
                addString(query, node, "flow", "flow");
                addString(query, node, "packetEncoding", "packet_encoding");
                String security = value(query, "security");
                boolean tlsEnabled = "tls".equalsIgnoreCase(security)
                        || "reality".equalsIgnoreCase(security)
                        || hasAny(query, "sni", "serverName", "pbk", "publicKey");
                if (tlsEnabled) {
                    JsonObject tls = createTls(query, true);
                    if ("reality".equalsIgnoreCase(security)
                            || hasAny(query, "pbk", "publicKey", "sid", "shortId")) {
                        JsonObject reality = new JsonObject();
                        reality.addProperty("enabled", true);
                        String publicKey = firstValue(query, "pbk", "publicKey");
                        String shortId = firstValue(query, "sid", "shortId");
                        if (isBlank(publicKey)) {
                            throw new ParseException("VLESS Reality 节点缺少 public key");
                        }
                        reality.addProperty("public_key", publicKey);
                        if (!isBlank(shortId)) {
                            reality.addProperty("short_id", shortId);
                        }
                        tls.add("reality", reality);
                    }
                    node.add("tls", tls);
                }
                addTransport(node, query);
                return node;
            default:
                throw new ParseException("不支持 " + scheme + " 协议");
        }
    }

    private static JsonObject parseShadowsocks(String original, URI parsedUri) {
        URI uri = parsedUri;
        String userInfo = decodePercent(uri.getRawUserInfo());
        String server = uri.getHost();
        int port = uri.getPort();

        if (server == null || userInfo == null) {
            String withoutScheme = original.substring(original.indexOf("://") + 3);
            int fragmentIndex = withoutScheme.indexOf('#');
            String fragment = fragmentIndex >= 0 ? withoutScheme.substring(fragmentIndex) : "";
            String payload = fragmentIndex >= 0 ? withoutScheme.substring(0, fragmentIndex) : withoutScheme;
            int queryIndex = payload.indexOf('?');
            String query = queryIndex >= 0 ? payload.substring(queryIndex) : "";
            payload = queryIndex >= 0 ? payload.substring(0, queryIndex) : payload;
            String decoded = decodeBase64Value(payload);
            try {
                uri = URI.create("ss://" + decoded + query + fragment);
            } catch (Exception error) {
                throw new ParseException("Shadowsocks 节点链接格式错误", error);
            }
            userInfo = decodePercent(uri.getRawUserInfo());
            server = uri.getHost();
            port = uri.getPort();
        }

        if (userInfo != null && !userInfo.contains(":")) {
            userInfo = decodeBase64Value(userInfo);
        }
        if (isBlank(server) || port < 1 || port > 65535) {
            throw new ParseException("Shadowsocks 节点缺少有效服务器或端口");
        }
        if (userInfo == null || !userInfo.contains(":")) {
            throw new ParseException("Shadowsocks 节点缺少 method:password");
        }

        String[] credential = userInfo.split(":", 2);
        if (isBlank(credential[0]) || credential[1].isEmpty()) {
            throw new ParseException("Shadowsocks method 或 password 为空");
        }

        JsonObject node = new JsonObject();
        node.addProperty("type", "shadowsocks");
        node.addProperty("tag", buildTag(uri, "ss", server, port));
        node.addProperty("server", server);
        node.addProperty("server_port", port);
        node.addProperty("method", credential[0]);
        node.addProperty("password", credential[1]);
        return node;
    }

    private static String decodeBase64Value(String value) {
        String padded = padBase64(value);
        try {
            return new String(decodeBase64Bytes(padded), StandardCharsets.UTF_8);
        } catch (IllegalArgumentException error) {
            throw new ParseException("Base64 节点内容无效", error);
        }
    }

    /**
     * Small RFC 4648 decoder kept here so parsing remains JVM-testable and works below Android 26.
     */
    private static byte[] decodeBase64Bytes(String value) {
        String compact = value.replaceAll("\\s+", "").replace('-', '+').replace('_', '/');
        if (compact.length() % 4 != 0) {
            throw new IllegalArgumentException("Invalid Base64 length");
        }
        java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream(compact.length() * 3 / 4);
        for (int offset = 0; offset < compact.length(); offset += 4) {
            int a = base64Value(compact.charAt(offset));
            int b = base64Value(compact.charAt(offset + 1));
            char third = compact.charAt(offset + 2);
            char fourth = compact.charAt(offset + 3);
            int c = third == '=' ? 0 : base64Value(third);
            int d = fourth == '=' ? 0 : base64Value(fourth);

            output.write((a << 2) | (b >> 4));
            if (third != '=') {
                output.write(((b & 0x0f) << 4) | (c >> 2));
            }
            if (fourth != '=') {
                output.write(((c & 0x03) << 6) | d);
            }
        }
        return output.toByteArray();
    }

    private static int base64Value(char value) {
        if (value >= 'A' && value <= 'Z') {
            return value - 'A';
        }
        if (value >= 'a' && value <= 'z') {
            return value - 'a' + 26;
        }
        if (value >= '0' && value <= '9') {
            return value - '0' + 52;
        }
        if (value == '+') {
            return 62;
        }
        if (value == '/') {
            return 63;
        }
        throw new IllegalArgumentException("Invalid Base64 character");
    }

    private static JsonObject createTls(Map<String, String> query, boolean enabled) {
        JsonObject tls = new JsonObject();
        tls.addProperty("enabled", enabled);
        String serverName = firstValue(query, "sni", "serverName", "peer");
        if (!isBlank(serverName)) {
            tls.addProperty("server_name", serverName);
        }

        String insecure = firstValue(query, "insecure", "allowInsecure", "skip-cert-verify");
        if (insecure != null) {
            tls.addProperty("insecure", parseBoolean(insecure));
        }

        String alpn = value(query, "alpn");
        if (!isBlank(alpn)) {
            JsonArray values = new JsonArray();
            for (String item : alpn.split(",")) {
                if (!isBlank(item)) {
                    values.add(item.trim());
                }
            }
            if (!values.isEmpty()) {
                tls.add("alpn", values);
            }
        }

        String fingerprint = firstValue(query, "fp", "fingerprint");
        if (!isBlank(fingerprint) && !"none".equalsIgnoreCase(fingerprint)) {
            JsonObject utls = new JsonObject();
            utls.addProperty("enabled", true);
            utls.addProperty("fingerprint", fingerprint);
            tls.add("utls", utls);
        }
        return tls;
    }

    private static void addTransport(JsonObject node, Map<String, String> query) {
        String network = firstValue(query, "type", "network");
        if (isBlank(network) || "tcp".equalsIgnoreCase(network)) {
            return;
        }

        JsonObject transport = new JsonObject();
        switch (network.toLowerCase(Locale.ROOT)) {
            case "ws":
                transport.addProperty("type", "ws");
                addString(query, transport, "path", "path");
                String host = firstValue(query, "host", "Host");
                if (!isBlank(host)) {
                    JsonObject headers = new JsonObject();
                    headers.addProperty("Host", host);
                    transport.add("headers", headers);
                }
                addInteger(query, transport, "ed", "max_early_data");
                addString(query, transport, "eh", "early_data_header_name");
                break;
            case "grpc":
                transport.addProperty("type", "grpc");
                String serviceName = firstValue(query, "serviceName", "service_name");
                if (!isBlank(serviceName)) {
                    transport.addProperty("service_name", serviceName);
                }
                break;
            case "http":
                transport.addProperty("type", "http");
                addString(query, transport, "path", "path");
                break;
            case "httpupgrade":
                transport.addProperty("type", "httpupgrade");
                addString(query, transport, "path", "path");
                addString(query, transport, "host", "host");
                break;
            default:
                throw new ParseException("暂不支持 " + network + " 传输层");
        }
        node.add("transport", transport);
    }

    private static String buildTag(URI uri, String scheme, String server, int port) {
        String fragment = decodePercent(uri.getRawFragment());
        if (!isBlank(fragment)) {
            return fragment.trim();
        }
        return scheme.toUpperCase(Locale.ROOT) + " " + server + ":" + port;
    }

    private static String makeUniqueTag(String tag, Map<String, Integer> counts) {
        String normalized = isBlank(tag) ? "未命名节点" : tag.trim();
        int next = counts.getOrDefault(normalized, 0) + 1;
        counts.put(normalized, next);
        return next == 1 ? normalized : normalized + " (" + next + ")";
    }

    private static Map<String, String> parseQuery(String rawQuery) {
        Map<String, String> result = new LinkedHashMap<>();
        if (isBlank(rawQuery)) {
            return result;
        }
        for (String pair : rawQuery.split("&")) {
            int separator = pair.indexOf('=');
            String key = decodePercent(separator >= 0 ? pair.substring(0, separator) : pair);
            String value = decodePercent(separator >= 0 ? pair.substring(separator + 1) : "");
            if (!isBlank(key)) {
                result.put(key, value == null ? "" : value);
            }
        }
        return result;
    }

    private static String decodePercent(String value) {
        if (value == null) {
            return null;
        }
        try {
            return URLDecoder.decode(value.replace("+", "%2B"), "UTF-8");
        } catch (Exception error) {
            throw new ParseException("URL 编码无效", error);
        }
    }

    private static boolean parseBoolean(String value) {
        return "1".equals(value)
                || "true".equalsIgnoreCase(value)
                || "yes".equalsIgnoreCase(value);
    }

    private static void addString(Map<String, String> query, JsonObject target, String source, String destination) {
        String value = value(query, source);
        if (!isBlank(value)) {
            target.addProperty(destination, value);
        }
    }

    private static void addInteger(Map<String, String> query, JsonObject target, String source, String destination) {
        String value = value(query, source);
        if (isBlank(value)) {
            return;
        }
        try {
            target.addProperty(destination, Integer.parseInt(value));
        } catch (NumberFormatException error) {
            throw new ParseException(source + " 必须是整数", error);
        }
    }

    private static boolean hasAny(Map<String, String> query, String... keys) {
        return firstValue(query, keys) != null;
    }

    private static String firstValue(Map<String, String> query, String... keys) {
        for (String key : keys) {
            String result = value(query, key);
            if (result != null) {
                return result;
            }
        }
        return null;
    }

    private static String value(Map<String, String> query, String key) {
        for (Map.Entry<String, String> entry : query.entrySet()) {
            if (entry.getKey().equalsIgnoreCase(key)) {
                return entry.getValue();
            }
        }
        return null;
    }

    private static String safeMessage(Throwable error) {
        String message = error.getMessage();
        return isBlank(message) ? error.getClass().getSimpleName() : message;
    }

    private static boolean isBlank(String value) {
        return value == null || value.trim().isEmpty();
    }

    private static String joinValues(List<String> values, String separator) {
        StringBuilder result = new StringBuilder();
        for (String value : values) {
            if (result.length() > 0) {
                result.append(separator);
            }
            result.append(value);
        }
        return result.toString();
    }
}
