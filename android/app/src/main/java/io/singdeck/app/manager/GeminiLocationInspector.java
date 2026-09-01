package io.singdeck.app.manager;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.UnsupportedEncodingException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;

/** Authenticated Gemini location check using app-private WebView cookies. */
public final class GeminiLocationInspector {
    public static final String APP_URL = "https://gemini.google.com/app";
    static final String BATCH_URL = "https://gemini.google.com/_/BardChatUi/data/batchexecute";
    static final String LOCATION_SOURCE = "SWML_DESCRIPTION_FROM_YOUR_INTERNET_ADDRESS";
    private static final String RPC_ID = "K4WWud";
    private static final String FORM = "[[[\"K4WWud\",\"[[1],[\\\"zh-CN\\\"]]\",null,\"generic\"]]]";

    private GeminiLocationInspector() {
    }

    public static final class Result {
        public final String status;
        public final String label;
        public final String source;
        public final String authMode = "webview";
        public final String testedAt = isoNow();
        public final String error;

        private Result(String status, String label, String source, String error) {
            this.status = status;
            this.label = label;
            this.source = source;
            this.error = error;
        }

        static Result success(String label, String source) {
            return new Result("success", label, source, null);
        }

        static Result failure(String status, String error) {
            return new Result(status, null, null, error);
        }
    }

    static final class Session {
        final String at;
        final String sid;
        final String bl;

        Session(String at, String sid, String bl) {
            this.at = at;
            this.sid = sid;
            this.bl = bl;
        }
    }

    public static Result inspect(
            StrictOutboundHttpClient client,
            String cookieHeader,
            String userAgent,
            long timeoutMs
    ) {
        try {
            if (!hasGoogleSessionCookie(cookieHeader)) {
                return Result.failure("auth_error", "请先在 SingDeck 的 Gemini 登录页登录 Google");
            }
            if (userAgent == null || userAgent.trim().isEmpty()) {
                return Result.failure("auth_error", "WebView User-Agent 不可用");
            }
            Map<String, String> headers = browserHeaders(cookieHeader, userAgent);
            StrictOutboundHttpClient.Response bootstrap = client.execute(
                    "GET",
                    APP_URL,
                    null,
                    headers,
                    timeoutMs,
                    false
            );
            Result redirect = redirectFailure(bootstrap, "Gemini 会话初始化");
            if (redirect != null) {
                return redirect;
            }
            if (!bootstrap.isSuccess()) {
                return Result.failure("http_error", "Gemini 会话初始化返回 HTTP "
                        + bootstrap.statusCode);
            }
            Session session = parseSession(bootstrap.body);
            String requestId = String.valueOf(1_000_000L
                    + Math.floorMod(System.currentTimeMillis(), 9_000_000L));
            String url = BATCH_URL
                    + "?rpcids=" + RPC_ID
                    + "&source-path=%2Fapp"
                    + "&bl=" + encode(session.bl)
                    + "&f.sid=" + encode(session.sid)
                    + "&hl=zh-CN"
                    + "&_reqid=" + requestId
                    + "&rt=c";
            Map<String, String> postHeaders = new LinkedHashMap<>(headers);
            postHeaders.put("Accept", "*/*");
            postHeaders.put("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
            postHeaders.put("Origin", "https://gemini.google.com");
            postHeaders.put("Referer", "https://gemini.google.com/");
            postHeaders.put("x-same-domain", "1");
            StrictOutboundHttpClient.Response response = client.execute(
                    "POST",
                    url,
                    "f.req=" + encode(FORM) + "&at=" + encode(session.at),
                    postHeaders,
                    timeoutMs,
                    false
            );
            redirect = redirectFailure(response, "Gemini 位置检测");
            if (redirect != null) {
                return redirect;
            }
            if (!response.isSuccess()) {
                return Result.failure("http_error", "Gemini 位置检测返回 HTTP "
                        + response.statusCode);
            }
            return parseBatch(response.body);
        } catch (IllegalArgumentException error) {
            return Result.failure("parse_error", safeMessage(error));
        } catch (Exception error) {
            return Result.failure("transport_error", safeMessage(error));
        }
    }

    static Session parseSession(String html) {
        int marker = html == null ? -1 : html.indexOf("window.WIZ_global_data");
        if (marker < 0) {
            throw new IllegalArgumentException("WIZ_global_data 标记不存在");
        }
        int start = html.indexOf('{', marker);
        int end = findJsonObjectEnd(html, start);
        if (start < 0 || end < 0) {
            throw new IllegalArgumentException("WIZ_global_data JSON 不完整");
        }
        JsonObject data = JsonParser.parseString(html.substring(start, end)).getAsJsonObject();
        return new Session(
                requiredString(data, "SNlM0e"),
                requiredString(data, "FdrFJe"),
                requiredString(data, "cfb2h")
        );
    }

    static Result parseBatch(String body) {
        String normalized = body == null ? "" : body;
        if (normalized.startsWith(")]}'")) {
            normalized = normalized.substring(4);
        }
        for (String rawLine : normalized.split("\\r?\\n")) {
            String line = rawLine.trim();
            if (!line.startsWith("[")) {
                continue;
            }
            try {
                Result found = findPayload(JsonParser.parseString(line));
                if (found != null) {
                    return found;
                }
            } catch (RuntimeException ignored) {
                // Batchexecute includes length frames and unrelated RPC payloads.
            }
        }
        throw new IllegalArgumentException(RPC_ID + " 位置数据不存在");
    }

    private static Result findPayload(JsonElement value) {
        if (value == null || !value.isJsonArray()) {
            return null;
        }
        JsonArray array = value.getAsJsonArray();
        if (array.size() >= 3
                && "wrb.fr".equals(asString(array.get(0)))
                && RPC_ID.equals(asString(array.get(1)))) {
            JsonElement encoded = array.get(2);
            if (!encoded.isJsonPrimitive() || !encoded.getAsJsonPrimitive().isString()) {
                throw new IllegalArgumentException(RPC_ID + " 返回值不是字符串");
            }
            JsonArray payload = JsonParser.parseString(encoded.getAsString()).getAsJsonArray();
            JsonArray row = payload.get(0).getAsJsonArray();
            String label = asString(row.get(0)).trim();
            String source = asString(row.get(1)).trim();
            if (label.isEmpty() || !LOCATION_SOURCE.equals(source)) {
                throw new IllegalArgumentException("Gemini 位置数据格式不符合预期");
            }
            return Result.success(label, source);
        }
        for (JsonElement item : array) {
            Result found = findPayload(item);
            if (found != null) {
                return found;
            }
        }
        return null;
    }

    private static int findJsonObjectEnd(String input, int start) {
        if (input == null || start < 0) {
            return -1;
        }
        int depth = 0;
        boolean inString = false;
        boolean escaped = false;
        for (int index = start; index < input.length(); index++) {
            char value = input.charAt(index);
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (value == '\\') {
                    escaped = true;
                } else if (value == '"') {
                    inString = false;
                }
                continue;
            }
            if (value == '"') {
                inString = true;
            } else if (value == '{') {
                depth++;
            } else if (value == '}' && --depth == 0) {
                return index + 1;
            }
        }
        return -1;
    }

    private static Map<String, String> browserHeaders(String cookieHeader, String userAgent) {
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
        headers.put("Accept-Language", "en,zh-CN;q=0.9,zh;q=0.8");
        headers.put("Cookie", cookieHeader);
        headers.put("User-Agent", userAgent);
        return headers;
    }

    private static Result redirectFailure(StrictOutboundHttpClient.Response response, String stage) {
        if (response.statusCode < 300 || response.statusCode >= 400) {
            return null;
        }
        String location = response.location == null ? "" : response.location;
        if (location.contains("/sorry/") || location.contains("google.com/sorry")) {
            return Result.failure("anti_abuse_challenge", stage + "触发了 Google 反滥用验证");
        }
        if (location.contains("accounts.google.com")
                || location.contains("ServiceLogin")
                || location.contains("/signin/")) {
            return Result.failure("auth_error", stage + "的 Google 登录已失效");
        }
        return Result.failure("routing_error", stage + "被重定向到 " + location);
    }

    private static boolean hasGoogleSessionCookie(String cookieHeader) {
        if (cookieHeader == null) {
            return false;
        }
        for (String cookie : cookieHeader.split(";")) {
            String name = cookie.trim().split("=", 2)[0];
            if ("SID".equals(name)
                    || "__Secure-1PSID".equals(name)
                    || "__Secure-3PSID".equals(name)) {
                return true;
            }
        }
        return false;
    }

    private static String requiredString(JsonObject object, String name) {
        String value = asString(object.get(name)).trim();
        if (value.isEmpty()) {
            throw new IllegalArgumentException("WIZ_global_data 缺少字段 " + name);
        }
        return value;
    }

    private static String asString(JsonElement value) {
        return value == null || value.isJsonNull() || !value.isJsonPrimitive()
                ? ""
                : value.getAsString();
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
