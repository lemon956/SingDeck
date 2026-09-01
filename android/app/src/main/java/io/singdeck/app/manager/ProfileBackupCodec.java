package io.singdeck.app.manager;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonParser;
import com.google.gson.reflect.TypeToken;

import java.lang.reflect.Type;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import io.singdeck.app.model.MobileBootstrap;
import io.singdeck.app.model.Profile;

/**
 * Pure-Java versioned backup codec shared by Android persistence and JVM tests.
 */
public final class ProfileBackupCodec {
    public static final int CURRENT_VERSION = 2;
    private static final Gson GSON = new Gson();

    private ProfileBackupCodec() {
    }

    public static final class DecodedBackup {
        public int version;
        public String activeProfileId;
        public List<Profile> profiles = new ArrayList<>();
        public Map<String, MobileBootstrap> inspectorProfiles = new LinkedHashMap<>();
    }

    public static String encode(String activeProfileId, List<Profile> profiles) {
        return encode(activeProfileId, profiles, null);
    }

    public static String encode(
            String activeProfileId,
            List<Profile> profiles,
            Map<String, MobileBootstrap> inspectorProfiles
    ) {
        DecodedBackup backup = new DecodedBackup();
        backup.version = CURRENT_VERSION;
        backup.activeProfileId = activeProfileId;
        backup.profiles = profiles == null ? new ArrayList<>() : new ArrayList<>(profiles);
        backup.inspectorProfiles = inspectorProfiles == null
                ? new LinkedHashMap<>()
                : new LinkedHashMap<>(inspectorProfiles);
        return GSON.toJson(backup);
    }

    public static DecodedBackup decode(String json) {
        if (json == null || json.trim().isEmpty()) {
            throw new IllegalArgumentException("备份内容为空");
        }
        try {
            JsonElement root = JsonParser.parseString(json);
            if (root.isJsonArray()) {
                Type listType = new TypeToken<List<Profile>>() {
                }.getType();
                DecodedBackup legacy = new DecodedBackup();
                legacy.version = 0;
                legacy.profiles = GSON.fromJson(root, listType);
                if (legacy.profiles == null) {
                    legacy.profiles = new ArrayList<>();
                }
                for (Profile profile : legacy.profiles) {
                    if (profile != null && profile.active) {
                        legacy.activeProfileId = profile.id;
                        break;
                    }
                }
                return legacy;
            }
            if (!root.isJsonObject()) {
                throw new IllegalArgumentException("备份根节点必须是 JSON 对象");
            }
            DecodedBackup backup = GSON.fromJson(root, DecodedBackup.class);
            if (backup == null || (backup.version != 1 && backup.version != CURRENT_VERSION)) {
                throw new IllegalArgumentException("不支持的备份版本");
            }
            if (backup.profiles == null) {
                backup.profiles = new ArrayList<>();
            }
            if (backup.inspectorProfiles == null) {
                backup.inspectorProfiles = new LinkedHashMap<>();
            }
            return backup;
        } catch (IllegalArgumentException error) {
            throw error;
        } catch (Exception error) {
            String message = error.getMessage();
            throw new IllegalArgumentException(
                    "备份 JSON 格式错误："
                            + (message == null || message.trim().isEmpty()
                            ? error.getClass().getSimpleName()
                            : message),
                    error
            );
        }
    }
}
