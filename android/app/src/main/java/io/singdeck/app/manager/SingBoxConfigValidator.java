package io.singdeck.app.manager;

import android.content.Context;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import io.nekohasekai.libbox.Libbox;
import io.singdeck.app.LibboxRuntime;

/**
 * The single native validation boundary for persisted and running profiles.
 */
public final class SingBoxConfigValidator {
    private SingBoxConfigValidator() {
    }

    public static final class ValidationException extends Exception {
        public ValidationException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    public static void validate(Context context, String config) throws ValidationException {
        if (config == null || config.trim().isEmpty()) {
            throw new ValidationException("配置内容为空", null);
        }
        validateAndroidVpnShape(config);
        try {
            LibboxRuntime.initialize(context.getApplicationContext());
            Libbox.checkConfig(config);
        } catch (Throwable error) {
            throw new ValidationException("sing-box 配置校验失败：" + safeMessage(error), error);
        }
    }

    static void validateAndroidVpnShape(String config) throws ValidationException {
        try {
            JsonObject root = JsonParser.parseString(config).getAsJsonObject();
            JsonArray inbounds = root.has("inbounds") && root.get("inbounds").isJsonArray()
                    ? root.getAsJsonArray("inbounds")
                    : new JsonArray();
            JsonObject tun = null;
            int tunCount = 0;
            for (JsonElement element : inbounds) {
                if (!element.isJsonObject()) {
                    continue;
                }
                JsonObject inbound = element.getAsJsonObject();
                if (inbound.has("type")
                        && !inbound.get("type").isJsonNull()
                        && "tun".equalsIgnoreCase(inbound.get("type").getAsString())) {
                    tun = inbound;
                    tunCount++;
                }
            }
            if (tunCount != 1) {
                throw new ValidationException(
                        "Android VPN 配置必须且只能包含一个 tun 入站（当前 " + tunCount + " 个）",
                        null
                );
            }
            JsonElement address = tun.get("address");
            boolean hasAddress = address != null
                    && !address.isJsonNull()
                    && ((address.isJsonArray() && !address.getAsJsonArray().isEmpty())
                    || (address.isJsonPrimitive() && !address.getAsString().trim().isEmpty()));
            if (!hasAddress) {
                throw new ValidationException("Android tun 入站必须包含 address", null);
            }
            JsonElement autoRoute = tun.get("auto_route");
            if (autoRoute == null
                    || !autoRoute.isJsonPrimitive()
                    || !autoRoute.getAsJsonPrimitive().isBoolean()
                    || !autoRoute.getAsBoolean()) {
                throw new ValidationException("Android tun 入站必须启用 auto_route", null);
            }
        } catch (ValidationException error) {
            throw error;
        } catch (Throwable error) {
            throw new ValidationException("Android VPN 配置结构无效：" + safeMessage(error), error);
        }
    }

    private static String safeMessage(Throwable error) {
        String message = error.getMessage();
        return message == null || message.trim().isEmpty()
                ? error.getClass().getSimpleName()
                : message;
    }
}
