package io.singdeck.app.manager;

import com.google.gson.Gson;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Locale;

import io.singdeck.app.model.MobileBootstrap;

/** Strict parser and config-pair verifier for mobile bootstrap snapshots. */
public final class MobileBootstrapVerifier {
    public static final String SCHEMA = "singdeck.mobile-bootstrap.v1";
    private static final Gson GSON = new Gson();

    private MobileBootstrapVerifier() {
    }

    public static MobileBootstrap parseAndVerify(String rawConfig, String bootstrapJson) {
        if (rawConfig == null || rawConfig.isEmpty()) {
            throw new IllegalArgumentException("远程 Config 为空");
        }
        if (bootstrapJson == null || bootstrapJson.trim().isEmpty()) {
            throw new IllegalArgumentException("伴随设置为空");
        }
        final MobileBootstrap bootstrap;
        try {
            bootstrap = GSON.fromJson(bootstrapJson, MobileBootstrap.class);
        } catch (RuntimeException error) {
            throw new IllegalArgumentException("伴随设置 JSON 格式错误", error);
        }
        if (bootstrap == null || !SCHEMA.equals(bootstrap.schema)) {
            throw new IllegalArgumentException("不支持的伴随设置版本");
        }
        String expectedHash = bootstrap.configSha256 == null
                ? ""
                : bootstrap.configSha256.trim().toLowerCase(Locale.ROOT);
        if (!sha256(rawConfig).equals(expectedHash)) {
            throw new IllegalArgumentException("Config 与伴随设置版本不一致");
        }
        if (bootstrap.testingSettings == null) {
            bootstrap.testingSettings = new MobileBootstrap.TestingSettings();
        }
        if (bootstrap.groups == null) {
            bootstrap.groups = new ArrayList<>();
        }
        if (bootstrap.nodeSources == null) {
            bootstrap.nodeSources = new ArrayList<>();
        }
        return bootstrap;
    }

    public static String sha256(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(bytes.length * 2);
            for (byte item : bytes) {
                hex.append(String.format(Locale.ROOT, "%02x", item & 0xff));
            }
            return hex.toString();
        } catch (Exception error) {
            throw new IllegalStateException("当前设备不支持 SHA-256", error);
        }
    }
}
