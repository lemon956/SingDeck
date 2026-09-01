package io.singdeck.app.manager;

import android.content.Context;
import android.os.SystemClock;
import android.webkit.CookieManager;
import android.webkit.WebSettings;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.UnsupportedEncodingException;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;

import io.nekohasekai.libbox.Libbox;
import io.singdeck.app.SingDeckVpnService;
import io.singdeck.app.model.MobileBootstrap;
import io.singdeck.app.model.OutboundGroup;

/** Runs connectivity, egress-risk and Gemini checks through the hidden native selector. */
public final class NativeInspectionEngine {
    private static final Object PROBE_LOCK = new Object();
    private static final String EXIT_IP_URL = "https://api64.ipify.org?format=json";
    private static final String RIPE_NETWORK_URL =
            "https://stat.ripe.net/data/network-info/data.json?resource=";
    private static final String RIPE_RPKI_URL =
            "https://stat.ripe.net/data/rpki-validation/data.json";
    private static final String ONIONOO_URL =
            "https://onionoo.torproject.org/details?type=relay&running=true&fields="
                    + "fingerprint%2Cnickname%2Cor_addresses%2Cexit_addresses%2Cflags&search=";
    private static final Gson GSON = new Gson();

    private NativeInspectionEngine() {
    }

    public static final class Result {
        public final ProbeScoringEngine.NodeScore score;
        public final String riskJson;
        public final String geminiJson;

        Result(ProbeScoringEngine.NodeScore score, String riskJson, String geminiJson) {
            this.score = score;
            this.riskJson = riskJson;
            this.geminiJson = geminiJson;
        }
    }

    public static Result inspectNode(
            Context context,
            String profileId,
            String groupName,
            String nodeName,
            boolean includeRisk,
            boolean includeGemini
    ) throws Exception {
        synchronized (PROBE_LOCK) {
            if (!SingDeckVpnService.isVpnRunning()) {
                throw new IllegalStateException("请先启动 VPN，再执行节点检测");
            }
            RuntimeConfigOverlay.ProxyEndpoint endpoint = SingDeckVpnService.getInspectionProxy();
            if (endpoint == null) {
                String reason = SingDeckVpnService.getInspectionDegradedReason();
                throw new IllegalStateException(reason == null || reason.isEmpty()
                        ? "当前配置没有可用的本地 Inspector 通道"
                        : "Inspector 通道不可用：" + reason);
            }

            InspectorRepository repository = InspectorRepository.getInstance(context);
            MobileBootstrap.GroupSettings settings = repository.getGroupSettings(profileId, groupName);
            Map<String, String> owners = repository.getSourceOwners(profileId);
            List<OutboundGroup> runtimeGroups = SingDeckVpnService.getRuntimeSnapshot().groups;
            OutboundGroup targetGroup = null;
            boolean nestedGroup = false;
            for (OutboundGroup group : runtimeGroups) {
                if (group.name.equals(groupName)) {
                    targetGroup = group;
                }
                if (group.name.equals(nodeName)) {
                    nestedGroup = true;
                }
            }
            if (targetGroup == null || !targetGroup.all.contains(nodeName)) {
                throw new IllegalArgumentException("节点不属于当前运行策略组");
            }
            if (!NodeEligibilityPolicy.isAllowed(settings, nodeName, owners, nestedGroup)) {
                throw new IllegalArgumentException("该节点不在当前策略组允许的来源范围内");
            }

            Libbox.newStandaloneCommandClient().selectOutbound(endpoint.selectorTag, nodeName);
            StrictOutboundHttpClient client = new StrictOutboundHttpClient(endpoint);
            long timeoutMs = repository.getTestingSettings(profileId).delayTestTimeoutMs;
            long testedAt = System.currentTimeMillis();
            Integer delayMs = null;
            boolean success = false;
            String probeError = null;
            long started = SystemClock.elapsedRealtime();
            try {
                StrictOutboundHttpClient.Response response = client.get(settings.testUrl, timeoutMs);
                delayMs = (int) Math.min(Integer.MAX_VALUE,
                        Math.max(0, SystemClock.elapsedRealtime() - started));
                success = response.statusCode >= 200 && response.statusCode < 400;
                if (!success) {
                    probeError = "HTTP " + response.statusCode;
                    delayMs = null;
                }
            } catch (Exception error) {
                probeError = safeMessage(error);
            }
            repository.saveProbeSample(
                    profileId,
                    groupName,
                    nodeName,
                    settings.testUrl,
                    delayMs,
                    success,
                    probeError,
                    testedAt
            );
            ProbeScoringEngine.NodeScore score = ProbeScoringEngine.score(
                    nodeName,
                    repository.getRecentProbeSamples(
                            profileId,
                            groupName,
                            nodeName,
                            settings.testUrl,
                            settings,
                            testedAt
                    ),
                    settings,
                    testedAt
            );

            String riskJson = null;
            if (includeRisk && hasRiskCheck(settings.nodeRisk)) {
                JsonObject risk = inspectRisk(client, settings.nodeRisk, timeoutMs);
                riskJson = GSON.toJson(risk);
                repository.saveInspectionResult(
                        profileId,
                        groupName,
                        nodeName,
                        "node_risk",
                        riskJson,
                        System.currentTimeMillis()
                );
            }

            String geminiJson = null;
            if (includeGemini && settings.geminiLocationProbeEnabled) {
                MobileBootstrap.TestingSettings testing = repository.getTestingSettings(profileId);
                if (!groupName.equals(testing.geminiLocationGroup)) {
                    throw new IllegalArgumentException("Gemini 位置检测只允许在已配置的策略组中运行");
                }
                String cookies = CookieManager.getInstance().getCookie(GeminiLocationInspector.APP_URL);
                String userAgent = WebSettings.getDefaultUserAgent(context.getApplicationContext());
                GeminiLocationInspector.Result gemini = GeminiLocationInspector.inspect(
                        client,
                        cookies,
                        userAgent,
                        Math.max(timeoutMs, 10_000)
                );
                geminiJson = GSON.toJson(gemini);
                repository.saveInspectionResult(
                        profileId,
                        groupName,
                        nodeName,
                        "gemini_location",
                        geminiJson,
                        System.currentTimeMillis()
                );
            }
            return new Result(score, riskJson, geminiJson);
        }
    }

    static JsonObject inspectRisk(
            StrictOutboundHttpClient client,
            MobileBootstrap.NodeRiskChecks checks,
            long timeoutMs
    ) {
        JsonObject report = new JsonObject();
        report.add("checks", GSON.toJsonTree(checks));
        report.addProperty("assessedAt", isoNow());

        String ip;
        try {
            JsonObject response = requireJson(client.get(EXIT_IP_URL, timeoutMs), "ipify");
            ip = response.has("ip") ? response.get("ip").getAsString().trim() : "";
            parseLiteralIp(ip);
        } catch (Exception error) {
            String reason = "出口 IP 检测失败：" + safeMessage(error);
            addUnavailableChecks(report, checks, reason);
            return report;
        }

        if (checks.exitIp) {
            JsonObject result = success("ipify HTTPS via sing-box outbound");
            result.addProperty("ip", ip);
            result.addProperty("family", ip.contains(":") ? "ipv6" : "ipv4");
            report.add("exitIp", result);
        }
        if (checks.addressScope) {
            report.add("addressScope", classifyAddress(ip));
        }

        JsonObject networkInfo = null;
        if (checks.networkIdentity || checks.routeSecurity) {
            try {
                networkInfo = requireJson(
                        client.get(RIPE_NETWORK_URL + encode(ip), timeoutMs),
                        "RIPEstat network-info"
                );
                if (checks.networkIdentity) {
                    report.add("networkIdentity", parseNetworkIdentity(networkInfo));
                }
            } catch (Exception error) {
                if (checks.networkIdentity) {
                    report.add("networkIdentity", unavailable(
                            "RIPEstat Network Info (RIPE RIS)", safeMessage(error)));
                }
            }
        }
        if (checks.networkClass) {
            report.add("networkClass", inspectNetworkClass(client, ip, timeoutMs));
        }
        if (checks.routeSecurity) {
            report.add("routeSecurity", inspectRpki(client, networkInfo, timeoutMs));
        }
        if (checks.tor) {
            report.add("tor", inspectTor(client, ip, timeoutMs));
        }
        if (checks.privacy) {
            report.add("privacy", notConfigured(
                    "IPinfo Privacy Detection API",
                    "Android 端未配置 IPinfo API token"
            ));
        }
        if (checks.abuse) {
            report.add("abuse", notConfigured(
                    "AbuseIPDB API v2 CHECK (90 day window)",
                    "Android 端未配置 AbuseIPDB API key"
            ));
        }
        return report;
    }

    private static JsonObject inspectNetworkClass(
            StrictOutboundHttpClient client,
            String ip,
            long timeoutMs
    ) {
        JsonArray evidence = new JsonArray();
        Set<String> signals = new LinkedHashSet<>();
        try {
            JsonObject body = requireJson(
                    client.get("https://proxycheck.io/v3/" + encode(ip), timeoutMs),
                    "proxycheck.io"
            );
            JsonObject item = body.has(ip) && body.get(ip).isJsonObject()
                    ? body.getAsJsonObject(ip)
                    : new JsonObject();
            JsonObject network = item.has("network") && item.get("network").isJsonObject()
                    ? item.getAsJsonObject("network")
                    : new JsonObject();
            String type = jsonString(network, "type");
            addNetworkSignal(signals, type);
            JsonObject provider = success("proxycheck.io v3 API");
            provider.addProperty("connectionType", type);
            provider.addProperty("isp", jsonString(network, "provider"));
            provider.addProperty("organization", jsonString(network, "organisation"));
            provider.addProperty("network", jsonString(network, "range"));
            evidence.add(provider);
        } catch (Exception error) {
            evidence.add(unavailable("proxycheck.io v3 API", safeMessage(error)));
        }
        try {
            JsonObject body = requireJson(
                    client.get("https://api.ipquery.io/" + encode(ip), timeoutMs),
                    "ipquery.io"
            );
            JsonObject risk = body.has("risk") && body.get("risk").isJsonObject()
                    ? body.getAsJsonObject("risk") : new JsonObject();
            if (jsonBoolean(risk, "is_mobile")) {
                signals.add("mobile");
            }
            if (jsonBoolean(risk, "is_datacenter")) {
                signals.add("data_center");
            }
            JsonObject isp = body.has("isp") && body.get("isp").isJsonObject()
                    ? body.getAsJsonObject("isp") : new JsonObject();
            JsonObject provider = success("ipquery.io API");
            provider.addProperty("isp", jsonString(isp, "isp"));
            provider.addProperty("organization", jsonString(isp, "org"));
            provider.addProperty("asn", jsonString(isp, "asn"));
            evidence.add(provider);
        } catch (Exception error) {
            evidence.add(unavailable("ipquery.io API", safeMessage(error)));
        }
        JsonObject result = success("independent proxycheck.io and ipquery.io evidence");
        result.addProperty("verdict", networkVerdict(signals));
        result.add("signals", GSON.toJsonTree(signals));
        result.add("evidence", evidence);
        if (evidence.size() == 0) {
            result.addProperty("status", "unavailable");
        }
        return result;
    }

    private static JsonObject inspectRpki(
            StrictOutboundHttpClient client,
            JsonObject networkInfo,
            long timeoutMs
    ) {
        if (networkInfo == null) {
            return unavailable("RIPEstat RPKI Validation (Routinator)",
                    "缺少 RIPEstat network-info 结果");
        }
        try {
            JsonObject data = networkInfo.getAsJsonObject("data");
            String prefix = jsonString(data, "prefix");
            JsonArray asns = data.has("asns") && data.get("asns").isJsonArray()
                    ? data.getAsJsonArray("asns") : new JsonArray();
            JsonObject result = success("RIPEstat RPKI Validation (Routinator)");
            result.addProperty("prefix", prefix);
            JsonArray origins = new JsonArray();
            Set<String> validities = new LinkedHashSet<>();
            if (prefix.isEmpty() || asns.isEmpty()) {
                result.addProperty("validity", "unrouted");
                result.add("origins", origins);
                return result;
            }
            for (JsonElement asnValue : asns) {
                String asn = asnValue.getAsString();
                try {
                    String url = RIPE_RPKI_URL + "?resource=" + encode(asn)
                            + "&prefix=" + encode(prefix);
                    JsonObject response = requireJson(client.get(url, timeoutMs), "RIPEstat RPKI");
                    JsonObject rpkiData = response.getAsJsonObject("data");
                    String validity = jsonString(rpkiData, "status");
                    validities.add(validity);
                    JsonObject origin = success("RIPEstat RPKI");
                    origin.addProperty("asn", asn);
                    origin.addProperty("validity", validity);
                    origin.addProperty("description", jsonString(rpkiData, "description"));
                    origins.add(origin);
                } catch (Exception error) {
                    JsonObject origin = unavailable("RIPEstat RPKI", safeMessage(error));
                    origin.addProperty("asn", asn);
                    origins.add(origin);
                }
            }
            result.add("origins", origins);
            result.addProperty("validity", validities.size() == 1
                    ? validities.iterator().next() : "mixed");
            return result;
        } catch (Exception error) {
            return unavailable("RIPEstat RPKI Validation (Routinator)", safeMessage(error));
        }
    }

    private static JsonObject inspectTor(
            StrictOutboundHttpClient client,
            String ip,
            long timeoutMs
    ) {
        try {
            JsonObject body = requireJson(client.get(ONIONOO_URL + encode(ip), timeoutMs),
                    "Tor Onionoo");
            JsonArray input = body.has("relays") && body.get("relays").isJsonArray()
                    ? body.getAsJsonArray("relays") : new JsonArray();
            JsonArray matches = new JsonArray();
            boolean exit = false;
            for (JsonElement element : input) {
                if (!element.isJsonObject()) {
                    continue;
                }
                JsonObject relay = element.getAsJsonObject();
                boolean addressMatch = stringArrayContains(relay, "exit_addresses", ip)
                        || socketArrayContains(relay, "or_addresses", ip);
                if (!addressMatch) {
                    continue;
                }
                boolean exitFlag = stringArrayContainsIgnoreCase(relay, "flags", "Exit");
                exit |= exitFlag || stringArrayContains(relay, "exit_addresses", ip);
                matches.add(relay);
            }
            JsonObject result = success("Tor Project Onionoo relay details");
            result.addProperty("verdict", exit ? "exit" : matches.isEmpty()
                    ? "not_detected" : "relay");
            result.add("relays", matches);
            return result;
        } catch (Exception error) {
            return unavailable("Tor Project Onionoo relay details", safeMessage(error));
        }
    }

    private static JsonObject parseNetworkIdentity(JsonObject response) {
        JsonObject result = success("RIPEstat Network Info (RIPE RIS)");
        JsonObject data = response.has("data") && response.get("data").isJsonObject()
                ? response.getAsJsonObject("data") : new JsonObject();
        result.addProperty("prefix", jsonString(data, "prefix"));
        result.add("originAsns", data.has("asns") ? data.get("asns") : new JsonArray());
        return result;
    }

    private static JsonObject classifyAddress(String ip) {
        try {
            InetAddress address = parseLiteralIp(ip);
            String classification = "global_unicast";
            boolean global = true;
            if (address.isAnyLocalAddress()) {
                classification = "unspecified";
                global = false;
            } else if (address.isLoopbackAddress()) {
                classification = "loopback";
                global = false;
            } else if (address.isLinkLocalAddress()) {
                classification = "link_local";
                global = false;
            } else if (address.isSiteLocalAddress()) {
                classification = "private";
                global = false;
            } else if (address.isMulticastAddress()) {
                classification = "multicast";
                global = false;
            } else if (address instanceof Inet4Address && isSharedIpv4(address.getAddress())) {
                classification = "shared";
                global = false;
            } else if (address instanceof Inet4Address && isDocumentationIpv4(address.getAddress())) {
                classification = "documentation";
                global = false;
            }
            JsonObject result = success("IANA IPv4/IPv6 Special-Purpose Address Registries");
            result.addProperty("classification", classification);
            result.addProperty("globallyReachable", global);
            return result;
        } catch (Exception error) {
            return unavailable("IANA IPv4/IPv6 Special-Purpose Address Registries",
                    safeMessage(error));
        }
    }

    private static void addUnavailableChecks(
            JsonObject report,
            MobileBootstrap.NodeRiskChecks checks,
            String reason
    ) {
        if (checks.exitIp) report.add("exitIp", unavailable("ipify HTTPS", reason));
        if (checks.addressScope) report.add("addressScope", unavailable("IANA registries", reason));
        if (checks.networkIdentity) report.add("networkIdentity", unavailable("RIPEstat", reason));
        if (checks.networkClass) report.add("networkClass", unavailable("network class providers", reason));
        if (checks.routeSecurity) report.add("routeSecurity", unavailable("RIPEstat RPKI", reason));
        if (checks.tor) report.add("tor", unavailable("Tor Onionoo", reason));
        if (checks.privacy) report.add("privacy", notConfigured("IPinfo", "Android 端未配置 token"));
        if (checks.abuse) report.add("abuse", notConfigured("AbuseIPDB", "Android 端未配置 key"));
    }

    private static JsonObject requireJson(StrictOutboundHttpClient.Response response, String provider) {
        if (!response.isSuccess()) {
            throw new IllegalArgumentException(provider + " 返回 HTTP " + response.statusCode);
        }
        JsonElement value = JsonParser.parseString(response.body);
        if (!value.isJsonObject()) {
            throw new IllegalArgumentException(provider + " 返回内容不是 JSON 对象");
        }
        return value.getAsJsonObject();
    }

    private static JsonObject success(String source) {
        JsonObject result = new JsonObject();
        result.addProperty("status", "success");
        result.addProperty("source", source);
        result.addProperty("checkedAt", isoNow());
        return result;
    }

    private static JsonObject unavailable(String source, String error) {
        JsonObject result = new JsonObject();
        result.addProperty("status", "unavailable");
        result.addProperty("source", source);
        result.addProperty("checkedAt", isoNow());
        result.addProperty("error", error);
        return result;
    }

    private static JsonObject notConfigured(String source, String error) {
        JsonObject result = unavailable(source, error);
        result.addProperty("status", "not_configured");
        return result;
    }

    private static InetAddress parseLiteralIp(String value) throws Exception {
        String ip = value == null ? "" : value.trim();
        boolean ipv4 = ip.matches("[0-9]{1,3}(\\.[0-9]{1,3}){3}");
        boolean ipv6 = ip.contains(":") && ip.matches("[0-9a-fA-F:.]+");
        if (!ipv4 && !ipv6) {
            throw new IllegalArgumentException("无效的公网 IP 地址");
        }
        if (ipv4) {
            for (String part : ip.split("\\.")) {
                if (Integer.parseInt(part) > 255) {
                    throw new IllegalArgumentException("无效的 IPv4 地址");
                }
            }
        }
        return InetAddress.getByName(ip);
    }

    private static boolean hasRiskCheck(MobileBootstrap.NodeRiskChecks checks) {
        return checks != null && (checks.exitIp || checks.addressScope || checks.networkIdentity
                || checks.networkClass || checks.routeSecurity || checks.tor
                || checks.privacy || checks.abuse);
    }

    private static void addNetworkSignal(Set<String> signals, String type) {
        String value = type == null ? "" : type.toLowerCase(Locale.ROOT);
        if ("residential".equals(value)) signals.add("residential");
        else if ("hosting".equals(value)) signals.add("data_center");
        else if ("wireless".equals(value)) signals.add("mobile");
        else if ("business".equals(value)) signals.add("business");
        else if (!value.isEmpty()) signals.add("other");
    }

    private static String networkVerdict(Set<String> signals) {
        return signals.size() > 1 ? "mixed" : signals.isEmpty()
                ? "unknown" : signals.iterator().next();
    }

    private static boolean jsonBoolean(JsonObject object, String name) {
        return object.has(name) && !object.get(name).isJsonNull()
                && object.get(name).isJsonPrimitive()
                && object.get(name).getAsBoolean();
    }

    private static String jsonString(JsonObject object, String name) {
        return object != null && object.has(name) && !object.get(name).isJsonNull()
                && object.get(name).isJsonPrimitive() ? object.get(name).getAsString() : "";
    }

    private static boolean stringArrayContains(JsonObject object, String name, String expected) {
        if (!object.has(name) || !object.get(name).isJsonArray()) return false;
        for (JsonElement value : object.getAsJsonArray(name)) {
            if (expected.equals(value.getAsString())) return true;
        }
        return false;
    }

    private static boolean stringArrayContainsIgnoreCase(
            JsonObject object,
            String name,
            String expected
    ) {
        if (!object.has(name) || !object.get(name).isJsonArray()) return false;
        for (JsonElement value : object.getAsJsonArray(name)) {
            if (expected.equalsIgnoreCase(value.getAsString())) return true;
        }
        return false;
    }

    private static boolean socketArrayContains(JsonObject object, String name, String ip) {
        if (!object.has(name) || !object.get(name).isJsonArray()) return false;
        for (JsonElement value : object.getAsJsonArray(name)) {
            String address = value.getAsString();
            if (address.equals(ip)
                    || address.startsWith(ip + ":")
                    || address.startsWith("[" + ip + "]:")) return true;
        }
        return false;
    }

    private static boolean isSharedIpv4(byte[] bytes) {
        int first = bytes[0] & 0xff;
        int second = bytes[1] & 0xff;
        return first == 100 && second >= 64 && second <= 127;
    }

    private static boolean isDocumentationIpv4(byte[] bytes) {
        int first = bytes[0] & 0xff;
        int second = bytes[1] & 0xff;
        int third = bytes[2] & 0xff;
        return (first == 192 && second == 0 && third == 2)
                || (first == 198 && second == 51 && third == 100)
                || (first == 203 && second == 0 && third == 113);
    }

    private static String encode(String value) {
        try {
            return URLEncoder.encode(value, StandardCharsets.UTF_8.name());
        } catch (UnsupportedEncodingException impossible) {
            throw new IllegalStateException("UTF-8 encoding is unavailable", impossible);
        }
    }

    private static String isoNow() {
        SimpleDateFormat formatter = new SimpleDateFormat(
                "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
                Locale.US
        );
        formatter.setTimeZone(TimeZone.getTimeZone("UTC"));
        return formatter.format(new Date());
    }

    private static String safeMessage(Throwable error) {
        String message = error.getMessage();
        return message == null || message.trim().isEmpty()
                ? error.getClass().getSimpleName()
                : message;
    }
}
