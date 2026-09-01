package io.singdeck.app.manager;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/** Parsed SingDeck/sing-box remote profile import contract. */
public final class MobileImportLink {
    private static final String REMOTE_PROFILE_SCHEME = "sing-box";
    private static final String REMOTE_PROFILE_HOST = "import-remote-profile";
    private static final String CONFIG_PATH_SUFFIX = "/api/v1/config/raw";
    private static final String BOOTSTRAP_PATH_SUFFIX = "/api/v1/mobile/bootstrap";
    private static final String SETTINGS_QUERY = "singdeck_settings";

    public final String name;
    public final String configUrl;
    public final String bootstrapUrl;
    public final boolean includeSettings;

    private MobileImportLink(
            String name,
            String configUrl,
            String bootstrapUrl,
            boolean includeSettings
    ) {
        this.name = name;
        this.configUrl = configUrl;
        this.bootstrapUrl = bootstrapUrl;
        this.includeSettings = includeSettings;
    }

    public static boolean isRemoteProfileLink(String value) {
        return value != null
                && value.trim().toLowerCase().startsWith(REMOTE_PROFILE_SCHEME + "://");
    }

    public static MobileImportLink parse(String value) {
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalArgumentException("远程配置链接为空");
        }
        final URI outer;
        try {
            outer = URI.create(value.trim());
        } catch (RuntimeException error) {
            throw new IllegalArgumentException("远程配置链接格式错误", error);
        }
        if (!REMOTE_PROFILE_SCHEME.equalsIgnoreCase(outer.getScheme())
                || !REMOTE_PROFILE_HOST.equalsIgnoreCase(outer.getHost())) {
            throw new IllegalArgumentException("不是受支持的 sing-box 远程配置链接");
        }
        String configUrl = queryValue(outer.getRawQuery(), "url");
        if (configUrl == null || configUrl.trim().isEmpty()) {
            throw new IllegalArgumentException("远程配置链接缺少 url 参数");
        }
        String name = decode(outer.getRawFragment());
        return fromConfigUrl(configUrl, name);
    }

    public static MobileImportLink fromConfigUrl(String configUrl, String name) {
        final URI config;
        try {
            config = URI.create(configUrl.trim());
        } catch (RuntimeException error) {
            throw new IllegalArgumentException("配置下载地址格式错误", error);
        }
        if (!("http".equalsIgnoreCase(config.getScheme())
                || "https".equalsIgnoreCase(config.getScheme()))) {
            throw new IllegalArgumentException("配置下载地址只支持 HTTP 或 HTTPS");
        }
        if (config.getRawAuthority() == null || config.getRawAuthority().trim().isEmpty()) {
            throw new IllegalArgumentException("配置下载地址缺少主机");
        }
        String path = config.getRawPath() == null ? "" : config.getRawPath();
        if (!path.endsWith(CONFIG_PATH_SUFFIX)) {
            throw new IllegalArgumentException("远程配置地址不是 SingDeck Config API");
        }
        boolean includeSettings = "1".equals(queryValue(config.getRawQuery(), SETTINGS_QUERY));
        String bootstrapPath = path.substring(0, path.length() - CONFIG_PATH_SUFFIX.length())
                + BOOTSTRAP_PATH_SUFFIX;
        String bootstrapQuery = removeQuery(config.getRawQuery(), SETTINGS_QUERY);
        StringBuilder bootstrap = new StringBuilder()
                .append(config.getScheme())
                .append("://")
                .append(config.getRawAuthority())
                .append(bootstrapPath);
        if (!bootstrapQuery.isEmpty()) {
            bootstrap.append('?').append(bootstrapQuery);
        }
        return new MobileImportLink(
                name == null || name.trim().isEmpty() ? "SingDeck" : name.trim(),
                config.toASCIIString(),
                bootstrap.toString(),
                includeSettings
        );
    }

    private static String queryValue(String rawQuery, String target) {
        if (rawQuery == null || rawQuery.isEmpty()) {
            return null;
        }
        for (String pair : rawQuery.split("&")) {
            int separator = pair.indexOf('=');
            String rawName = separator >= 0 ? pair.substring(0, separator) : pair;
            if (target.equals(decode(rawName))) {
                return decode(separator >= 0 ? pair.substring(separator + 1) : "");
            }
        }
        return null;
    }

    private static String removeQuery(String rawQuery, String target) {
        if (rawQuery == null || rawQuery.isEmpty()) {
            return "";
        }
        List<String> kept = new ArrayList<>();
        for (String pair : rawQuery.split("&")) {
            int separator = pair.indexOf('=');
            String rawName = separator >= 0 ? pair.substring(0, separator) : pair;
            if (!target.equals(decode(rawName))) {
                kept.add(pair);
            }
        }
        return String.join("&", kept);
    }

    private static String decode(String value) {
        if (value == null) {
            return null;
        }
        try {
            return URLDecoder.decode(value, StandardCharsets.UTF_8.name());
        } catch (Exception error) {
            throw new IllegalArgumentException("远程配置链接包含无效编码", error);
        }
    }
}
