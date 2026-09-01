package io.singdeck.app.manager;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.util.AtomicFile;
import android.util.Log;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.reflect.TypeToken;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.lang.reflect.Type;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import io.nekohasekai.libbox.Libbox;
import io.nekohasekai.libbox.StringBox;
import io.singdeck.app.LibboxRuntime;
import io.singdeck.app.model.MobileBootstrap;
import io.singdeck.app.model.NodeItem;
import io.singdeck.app.model.OutboundGroup;
import io.singdeck.app.model.Profile;

/**
 * Native profile repository.
 *
 * <p>Profile metadata lives in SharedPreferences while complete sing-box configurations are
 * written through {@link AtomicFile} under app-private storage. The service and every native
 * screen resolve configuration content through this class.</p>
 */
public final class ProfileManager {
    private static final String TAG = "ProfileManager";
    private static final String PREF_NAME = "singdeck_native_profiles";
    private static final String KEY_LEGACY_PROFILES = "profiles_json";
    private static final String KEY_METADATA = "profile_metadata_json";
    private static final String KEY_ACTIVE_ID = "active_profile_id";
    private static final String KEY_SCHEMA_VERSION = "schema_version";
    private static final int SCHEMA_VERSION = 2;

    private static final String LEGACY_VPN_PREF_NAME = "singdeck_vpn";
    private static final String LEGACY_VPN_CONFIG = "last_config";
    private static final String KEY_LEGACY_VPN_MIGRATED = "legacy_vpn_migrated";
    private static final int MAX_PROFILE_BYTES = 20 * 1024 * 1024;

    private static ProfileManager instance;

    private final Context context;
    private final SharedPreferences prefs;
    private final File profilesDirectory;
    private final Gson gson = new Gson();
    private final ExecutorService executor = Executors.newFixedThreadPool(3);
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final InspectorRepository inspectorRepository;

    private final List<Profile> profiles = new ArrayList<>();
    private final List<OnProfileChangeListener> listeners = new ArrayList<>();
    private final List<OutboundGroup> cachedGroups = new ArrayList<>();
    private final Map<String, NodeItem> cachedNodes = new LinkedHashMap<>();
    private String activeProfileId;

    public interface OnProfileChangeListener {
        void onProfilesChanged();
    }

    public interface OnAsyncResultCallback {
        void onSuccess(Profile profile);

        void onError(String message);
    }

    public interface OnRemoteImportCallback {
        void onSuccess(RemoteImportResult result);

        void onError(String message);
    }

    public static final class RemoteImportResult {
        public final Profile profile;
        public final MobileBootstrap bootstrap;
        public final String warning;

        RemoteImportResult(Profile profile, MobileBootstrap bootstrap, String warning) {
            this.profile = profile;
            this.bootstrap = bootstrap;
            this.warning = warning;
        }
    }

    private static final class RemotePayload {
        final String config;
        final MobileBootstrap bootstrap;
        final String warning;

        RemotePayload(String config, MobileBootstrap bootstrap, String warning) {
            this.config = config;
            this.bootstrap = bootstrap;
            this.warning = warning;
        }
    }

    public static final class RestoreResult {
        public final int importedCount;
        public final int skippedCount;

        RestoreResult(int importedCount, int skippedCount) {
            this.importedCount = importedCount;
            this.skippedCount = skippedCount;
        }
    }

    private ProfileManager(Context context) {
        this.context = context.getApplicationContext();
        prefs = this.context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
        profilesDirectory = new File(this.context.getFilesDir(), "profiles");
        inspectorRepository = InspectorRepository.getInstance(this.context);
        if (!profilesDirectory.exists() && !profilesDirectory.mkdirs()) {
            throw new IllegalStateException("无法创建配置存储目录");
        }
        loadAndMigrate();
    }

    public static synchronized ProfileManager getInstance(Context context) {
        if (instance == null) {
            instance = new ProfileManager(context);
        }
        return instance;
    }

    public synchronized void addListener(OnProfileChangeListener listener) {
        if (listener != null && !listeners.contains(listener)) {
            listeners.add(listener);
        }
    }

    public synchronized void removeListener(OnProfileChangeListener listener) {
        listeners.remove(listener);
    }

    public synchronized List<Profile> getProfiles() {
        return new ArrayList<>(profiles);
    }

    public synchronized Profile getProfile(String id) {
        return findProfileLocked(id);
    }

    public synchronized Profile getActiveProfile() {
        Profile active = findProfileLocked(activeProfileId);
        if (active != null && active.valid) {
            return active;
        }
        return firstValidProfileLocked();
    }

    public synchronized String getActiveProfileId() {
        Profile active = getActiveProfile();
        return active == null ? null : active.id;
    }

    public synchronized String getProfileContent(String id) {
        Profile profile = findProfileLocked(id);
        if (profile == null) {
            throw new IllegalArgumentException("配置不存在");
        }
        if (!profile.valid) {
            throw new IllegalStateException(
                    profile.validationError == null ? "配置无效" : profile.validationError
            );
        }
        if (profile.content == null || profile.content.trim().isEmpty()) {
            throw new IllegalStateException("配置内容为空");
        }
        return profile.content;
    }

    public synchronized String createBackupJson() {
        List<Profile> backupProfiles = new ArrayList<>();
        Map<String, MobileBootstrap> inspectorProfiles = new LinkedHashMap<>();
        for (Profile profile : profiles) {
            Profile copy = copyProfile(profile, true);
            backupProfiles.add(copy);
            inspectorProfiles.put(profile.id, inspectorRepository.exportBootstrap(profile.id));
        }
        return ProfileBackupCodec.encode(getActiveProfileId(), backupProfiles, inspectorProfiles);
    }

    public RestoreResult restoreBackupJson(String backupJson, boolean replaceExisting) {
        ProfileBackupCodec.DecodedBackup backup = ProfileBackupCodec.decode(backupJson);
        if (backup.profiles == null || backup.profiles.isEmpty()) {
            throw new IllegalArgumentException("备份中没有配置");
        }
        if (backup.profiles.size() > 200) {
            throw new IllegalArgumentException("单次最多恢复 200 个配置");
        }

        List<Profile> prepared = new ArrayList<>();
        Map<String, MobileBootstrap> inspectorByRestoredId = new LinkedHashMap<>();
        String restoredActiveId = null;
        for (Profile source : backup.profiles) {
            if (source == null || source.content == null || source.content.trim().isEmpty()) {
                throw new IllegalArgumentException("备份包含空配置");
            }
            String content = source.content;
            if (source.valid) {
                content = NodeLinkParser.parseToSingBoxConfig(source.content, source.name);
                try {
                    SingBoxConfigValidator.validate(context, content);
                } catch (SingBoxConfigValidator.ValidationException error) {
                    throw new IllegalArgumentException(
                            "配置「" + normalizedName(source.name) + "」无效：" + error.getMessage(),
                            error
                    );
                }
            }
            Profile restored = new Profile(
                    UUID.randomUUID().toString(),
                    normalizedName(source.name),
                    normalizedType(source.type),
                    normalizedUrl(source.url),
                    content,
                    false
            );
            restored.valid = source.valid;
            restored.validationError = source.valid
                    ? null
                    : (source.validationError == null ? "备份中的无效配置" : source.validationError);
            restored.nodeCount = countNodesInContent(content);
            restored.lastUpdatedAt = source.lastUpdatedAt > 0
                    ? source.lastUpdatedAt
                    : System.currentTimeMillis();
            prepared.add(restored);
            if (source.id != null && backup.inspectorProfiles.containsKey(source.id)) {
                MobileBootstrap bootstrap = backup.inspectorProfiles.get(source.id);
                if (bootstrap != null) {
                    inspectorByRestoredId.put(restored.id, bootstrap);
                }
            }
            if (restored.valid
                    && ((backup.activeProfileId != null && backup.activeProfileId.equals(source.id))
                    || (backup.activeProfileId == null && source.active))) {
                restoredActiveId = restored.id;
            }
        }

        int skipped = 0;
        List<Profile> written = new ArrayList<>();
        List<Profile> previousProfiles;
        String previousActiveId;
        synchronized (this) {
            previousProfiles = new ArrayList<>(profiles);
            previousActiveId = activeProfileId;
            if (!replaceExisting) {
                List<Profile> unique = new ArrayList<>();
                Set<String> contents = new HashSet<>();
                for (Profile existing : profiles) {
                    contents.add(existing.content);
                }
                for (Profile candidate : prepared) {
                    if (!contents.add(candidate.content)) {
                        skipped++;
                    } else {
                        unique.add(candidate);
                    }
                }
                prepared = unique;
            }
            try {
                for (Profile profile : prepared) {
                    writeConfigLocked(profile.id, profile.content);
                    written.add(profile);
                }
                for (Profile profile : prepared) {
                    MobileBootstrap bootstrap = inspectorByRestoredId.get(profile.id);
                    if (bootstrap != null) {
                        inspectorRepository.importBootstrap(
                                profile.id,
                                bootstrap,
                                nodeNamesInContent(profile.content)
                        );
                    }
                }
                if (replaceExisting) {
                    profiles.clear();
                }
                profiles.addAll(prepared);
                if (replaceExisting) {
                    activeProfileId = restoredActiveId;
                } else if (getActiveProfile() == null && restoredActiveId != null) {
                    activeProfileId = restoredActiveId;
                }
                normalizeActiveProfileLocked();
                saveMetadataLocked();
                parseActiveProfileContentLocked();
            } catch (RuntimeException error) {
                for (Profile profile : written) {
                    inspectorRepository.deleteProfile(profile.id);
                }
                profiles.clear();
                profiles.addAll(previousProfiles);
                setActiveProfileLocked(previousActiveId);
                try {
                    saveMetadataLocked();
                } catch (RuntimeException rollbackError) {
                    error.addSuppressed(rollbackError);
                }
                parseActiveProfileContentLocked();
                for (Profile profile : written) {
                    File file = profileFile(profile.id);
                    if (file.exists()) {
                        file.delete();
                    }
                }
                throw error;
            }
        }

        if (replaceExisting) {
            for (Profile previous : previousProfiles) {
                inspectorRepository.deleteProfile(previous.id);
                File oldFile = profileFile(previous.id);
                if (oldFile.exists()) {
                    oldFile.delete();
                }
            }
        }
        notifyListeners();
        return new RestoreResult(prepared.size(), skipped);
    }

    public Profile addProfile(String name, String type, String url, String content) {
        String prepared = prepareAndValidate(content, name);
        Profile profile = new Profile(
                UUID.randomUUID().toString(),
                normalizedName(name),
                normalizedType(type),
                normalizedUrl(url),
                prepared,
                true
        );
        profile.nodeCount = countNodesInContent(prepared);

        synchronized (this) {
            persistNewProfileLocked(profile, true);
        }
        notifyListeners();
        return profile;
    }

    public void fetchAndAddSubscriptionUrl(
            String url,
            String name,
            OnAsyncResultCallback callback
    ) {
        executor.submit(() -> {
            try {
                String raw = download(url);
                String prepared = prepareAndValidate(raw, name);
                Profile profile = new Profile(
                        UUID.randomUUID().toString(),
                        normalizedName(name),
                        "url",
                        normalizedUrl(url),
                        prepared,
                        true
                );
                profile.nodeCount = countNodesInContent(prepared);
                synchronized (ProfileManager.this) {
                    persistNewProfileLocked(profile, true);
                }
                notifyListeners();
                if (callback != null) {
                    mainHandler.post(() -> callback.onSuccess(profile));
                }
            } catch (Exception error) {
                postError(callback, safeMessage(error));
            }
        });
    }

    public void importRemoteProfile(MobileImportLink link, OnRemoteImportCallback callback) {
        executor.submit(() -> {
            try {
                RemotePayload payload = downloadRemotePayload(link);
                String normalized = formatRemoteConfig(payload.config);
                String prepared = prepareAndValidate(normalized, link.name);
                Profile profile = new Profile(
                        UUID.randomUUID().toString(),
                        normalizedName(link.name),
                        "url",
                        normalizedUrl(link.configUrl),
                        prepared,
                        true
                );
                profile.nodeCount = countNodesInContent(prepared);
                if (payload.bootstrap != null) {
                    inspectorRepository.importBootstrap(
                            profile.id,
                            payload.bootstrap,
                            nodeNamesInContent(prepared)
                    );
                }
                synchronized (ProfileManager.this) {
                    try {
                        persistNewProfileLocked(profile, true);
                    } catch (RuntimeException error) {
                        inspectorRepository.deleteProfile(profile.id);
                        throw error;
                    }
                }
                notifyListeners();
                if (callback != null) {
                    RemoteImportResult result = new RemoteImportResult(
                            profile,
                            payload.bootstrap,
                            payload.warning
                    );
                    mainHandler.post(() -> callback.onSuccess(result));
                }
            } catch (Exception error) {
                if (callback != null) {
                    mainHandler.post(() -> callback.onError(safeMessage(error)));
                }
            }
        });
    }

    public void refreshProfile(String id, OnAsyncResultCallback callback) {
        final String targetUrl;
        final String targetName;
        synchronized (this) {
            Profile target = findProfileLocked(id);
            if (target == null || target.url == null || target.url.trim().isEmpty()) {
                postError(callback, "此配置不是 URL 订阅");
                return;
            }
            targetUrl = target.url;
            targetName = target.name;
        }

        executor.submit(() -> {
            try {
                String raw = download(targetUrl);
                String prepared = prepareAndValidate(raw, targetName);
                final Profile refreshed;
                synchronized (ProfileManager.this) {
                    Profile current = findProfileLocked(id);
                    if (current == null) {
                        throw new IllegalStateException("配置已被删除");
                    }
                    replaceProfileContentLocked(current, current.name, prepared);
                    refreshed = copyProfile(current, false);
                }
                notifyListeners();
                if (callback != null) {
                    mainHandler.post(() -> callback.onSuccess(refreshed));
                }
            } catch (Exception error) {
                postError(callback, safeMessage(error));
            }
        });
    }

    public void updateProfile(String id, String name, String content) {
        String prepared = prepareAndValidate(content, name);
        synchronized (this) {
            Profile profile = findProfileLocked(id);
            if (profile == null) {
                throw new IllegalArgumentException("配置不存在");
            }
            replaceProfileContentLocked(profile, name, prepared);
        }
        notifyListeners();
    }

    public void activateProfile(String id) {
        synchronized (this) {
            Profile selected = findProfileLocked(id);
            if (selected == null) {
                throw new IllegalArgumentException("配置不存在");
            }
            if (!selected.valid) {
                throw new IllegalStateException(
                        selected.validationError == null ? "配置无效" : selected.validationError
                );
            }
            String previousActiveId = activeProfileId;
            setActiveProfileLocked(id);
            try {
                saveMetadataLocked();
            } catch (RuntimeException error) {
                setActiveProfileLocked(previousActiveId);
                throw error;
            }
            parseActiveProfileContentLocked();
        }
        notifyListeners();
    }

    public void deleteProfile(String id) {
        File orphanedFile = null;
        synchronized (this) {
            Profile profile = findProfileLocked(id);
            if (profile == null) {
                return;
            }
            List<Profile> previousProfiles = new ArrayList<>(profiles);
            String previousActiveId = activeProfileId;
            profiles.remove(profile);
            if (profile.id.equals(activeProfileId)) {
                Profile replacement = firstValidProfileLocked();
                setActiveProfileLocked(replacement == null ? null : replacement.id);
            }
            try {
                saveMetadataLocked();
            } catch (RuntimeException error) {
                profiles.clear();
                profiles.addAll(previousProfiles);
                setActiveProfileLocked(previousActiveId);
                throw error;
            }
            parseActiveProfileContentLocked();
            orphanedFile = profileFile(profile.id);
        }
        if (orphanedFile.exists() && !orphanedFile.delete()) {
            orphanedFile.deleteOnExit();
        }
        inspectorRepository.deleteProfile(id);
        notifyListeners();
    }

    public synchronized List<OutboundGroup> getCachedGroups() {
        return new ArrayList<>(cachedGroups);
    }

    public synchronized Map<String, NodeItem> getCachedNodes() {
        return new LinkedHashMap<>(cachedNodes);
    }

    public synchronized String getRouteRulesSummary() {
        Profile active = getActiveProfile();
        if (active == null || active.content == null) {
            return "未加载配置";
        }
        try {
            JsonObject root = gson.fromJson(active.content, JsonObject.class);
            if (root != null && root.has("route")) {
                JsonObject route = root.getAsJsonObject("route");
                if (route.has("rules")) {
                    return route.getAsJsonArray("rules").size() + " 条 sing-box 原生分流规则";
                }
            }
        } catch (Exception ignored) {
        }
        return "遵循 sing-box 配置文件内置分流规则";
    }

    private synchronized void loadAndMigrate() {
        if (prefs.getInt(KEY_SCHEMA_VERSION, 0) < SCHEMA_VERSION) {
            migrateLegacyNativeProfilesLocked();
        } else {
            loadMetadataLocked();
        }
        migrateLegacyVpnConfigLocked();
        normalizeActiveProfileLocked();
        saveMetadataLocked();
        parseActiveProfileContentLocked();
    }

    private void migrateLegacyNativeProfilesLocked() {
        profiles.clear();
        activeProfileId = prefs.getString(KEY_ACTIVE_ID, null);
        String legacyJson = prefs.getString(KEY_LEGACY_PROFILES, null);
        if (legacyJson != null && !legacyJson.trim().isEmpty()) {
            Type listType = new TypeToken<List<Profile>>() {
            }.getType();
            try {
                List<Profile> legacyProfiles = gson.fromJson(legacyJson, listType);
                if (legacyProfiles != null) {
                    for (Profile legacy : legacyProfiles) {
                        migrateProfileContentLocked(legacy);
                    }
                }
            } catch (Exception error) {
                throw new IllegalStateException("旧配置索引迁移失败：" + safeMessage(error), error);
            }
        }
        saveMetadataLocked();
    }

    private void migrateProfileContentLocked(Profile profile) {
        if (profile == null) {
            return;
        }
        if (!isSafeProfileId(profile.id)) {
            profile.id = UUID.randomUUID().toString();
        }
        profile.name = normalizedName(profile.name);
        profile.type = normalizedType(profile.type);
        profile.url = normalizedUrl(profile.url);
        profile.active = false;
        profile.valid = true;
        profile.validationError = null;
        if (profile.content == null || profile.content.trim().isEmpty()) {
            profile.valid = false;
            profile.validationError = "配置内容为空";
            profile.content = "";
        } else {
            try {
                SingBoxConfigValidator.validate(context, profile.content);
            } catch (SingBoxConfigValidator.ValidationException error) {
                profile.valid = false;
                profile.validationError = error.getMessage();
            }
        }
        writeConfigLocked(profile.id, profile.content);
        profile.nodeCount = countNodesInContent(profile.content);
        profiles.add(profile);
    }

    private void loadMetadataLocked() {
        profiles.clear();
        activeProfileId = prefs.getString(KEY_ACTIVE_ID, null);
        String metadataJson = prefs.getString(KEY_METADATA, null);
        if (metadataJson == null || metadataJson.trim().isEmpty()) {
            return;
        }
        Type listType = new TypeToken<List<Profile>>() {
        }.getType();
        try {
            List<Profile> metadata = gson.fromJson(metadataJson, listType);
            if (metadata == null) {
                return;
            }
            for (Profile profile : metadata) {
                if (profile == null || !isSafeProfileId(profile.id)) {
                    continue;
                }
                try {
                    profile.content = readConfigLocked(profile.id);
                } catch (RuntimeException error) {
                    profile.content = "";
                    profile.valid = false;
                    profile.validationError = "配置文件读取失败：" + safeMessage(error);
                }
                profiles.add(profile);
            }
        } catch (Exception error) {
            throw new IllegalStateException("配置索引读取失败：" + safeMessage(error), error);
        }
    }

    private void migrateLegacyVpnConfigLocked() {
        if (prefs.getBoolean(KEY_LEGACY_VPN_MIGRATED, false)) {
            return;
        }
        SharedPreferences legacyPrefs = context.getSharedPreferences(
                LEGACY_VPN_PREF_NAME,
                Context.MODE_PRIVATE
        );
        String legacyConfig = legacyPrefs.getString(LEGACY_VPN_CONFIG, null);
        if (legacyConfig != null && !legacyConfig.trim().isEmpty() && !containsContentLocked(legacyConfig)) {
            Profile migrated = new Profile(
                    UUID.randomUUID().toString(),
                    "旧版 VPN 配置",
                    "migrated",
                    null,
                    legacyConfig,
                    false
            );
            try {
                SingBoxConfigValidator.validate(context, legacyConfig);
            } catch (SingBoxConfigValidator.ValidationException error) {
                migrated.valid = false;
                migrated.validationError = error.getMessage();
            }
            migrated.nodeCount = countNodesInContent(legacyConfig);
            writeConfigLocked(migrated.id, legacyConfig);
            profiles.add(migrated);
            if (migrated.valid && firstValidProfileLocked() == migrated) {
                activeProfileId = migrated.id;
            }
        }
        saveMetadataLocked();
        if (!legacyPrefs.edit().remove(LEGACY_VPN_CONFIG).commit()) {
            throw new IllegalStateException("旧 VPN 配置清理失败");
        }
        if (!prefs.edit().putBoolean(KEY_LEGACY_VPN_MIGRATED, true).commit()) {
            throw new IllegalStateException("旧 VPN 配置迁移状态保存失败");
        }
    }

    private boolean containsContentLocked(String content) {
        for (Profile profile : profiles) {
            if (content.equals(profile.content)) {
                return true;
            }
        }
        return false;
    }

    private void normalizeActiveProfileLocked() {
        Profile active = findProfileLocked(activeProfileId);
        if (active == null || !active.valid) {
            Profile replacement = firstValidProfileLocked();
            activeProfileId = replacement == null ? null : replacement.id;
        }
        setActiveProfileLocked(activeProfileId);
    }

    private void persistNewProfileLocked(Profile profile, boolean activate) {
        String previousActiveId = activeProfileId;
        writeConfigLocked(profile.id, profile.content);
        profiles.add(profile);
        if (activate) {
            setActiveProfileLocked(profile.id);
        }
        try {
            saveMetadataLocked();
            parseActiveProfileContentLocked();
        } catch (RuntimeException error) {
            profiles.remove(profile);
            setActiveProfileLocked(previousActiveId);
            File file = profileFile(profile.id);
            if (file.exists()) {
                file.delete();
            }
            throw error;
        }
    }

    private void replaceProfileContentLocked(Profile profile, String name, String content) {
        Profile previous = copyProfile(profile, true);
        writeConfigLocked(profile.id, content);
        profile.name = normalizedName(name);
        profile.content = content;
        profile.nodeCount = countNodesInContent(content);
        profile.lastUpdatedAt = System.currentTimeMillis();
        profile.valid = true;
        profile.validationError = null;
        try {
            saveMetadataLocked();
        } catch (RuntimeException error) {
            restoreProfileFields(profile, previous);
            try {
                writeConfigLocked(profile.id, previous.content);
            } catch (RuntimeException rollbackError) {
                error.addSuppressed(rollbackError);
            }
            throw error;
        }
        parseActiveProfileContentLocked();
    }

    private void restoreProfileFields(Profile target, Profile source) {
        target.name = source.name;
        target.type = source.type;
        target.url = source.url;
        target.content = source.content;
        target.active = source.active;
        target.valid = source.valid;
        target.validationError = source.validationError;
        target.nodeCount = source.nodeCount;
        target.lastUpdatedAt = source.lastUpdatedAt;
    }

    private void saveMetadataLocked() {
        List<Profile> metadata = new ArrayList<>();
        for (Profile profile : profiles) {
            Profile copy = new Profile();
            copy.id = profile.id;
            copy.name = profile.name;
            copy.type = profile.type;
            copy.url = profile.url;
            copy.active = profile.active;
            copy.valid = profile.valid;
            copy.validationError = profile.validationError;
            copy.nodeCount = profile.nodeCount;
            copy.lastUpdatedAt = profile.lastUpdatedAt;
            metadata.add(copy);
        }

        SharedPreferences.Editor editor = prefs.edit()
                .putString(KEY_METADATA, gson.toJson(metadata))
                .putInt(KEY_SCHEMA_VERSION, SCHEMA_VERSION)
                .remove(KEY_LEGACY_PROFILES);
        if (activeProfileId == null) {
            editor.remove(KEY_ACTIVE_ID);
        } else {
            editor.putString(KEY_ACTIVE_ID, activeProfileId);
        }
        if (!editor.commit()) {
            throw new IllegalStateException("配置索引保存失败");
        }
    }

    private void writeConfigLocked(String id, String content) {
        byte[] bytes = content == null
                ? new byte[0]
                : content.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_PROFILE_BYTES) {
            throw new IllegalArgumentException("配置超过 20 MiB 限制");
        }

        AtomicFile atomicFile = new AtomicFile(profileFile(id));
        FileOutputStream stream = null;
        try {
            stream = atomicFile.startWrite();
            stream.write(bytes);
            stream.flush();
            stream.getFD().sync();
            atomicFile.finishWrite(stream);
        } catch (Exception error) {
            if (stream != null) {
                atomicFile.failWrite(stream);
            }
            throw new IllegalStateException("配置文件保存失败：" + safeMessage(error), error);
        }
    }

    private String readConfigLocked(String id) {
        AtomicFile atomicFile = new AtomicFile(profileFile(id));
        try (FileInputStream stream = atomicFile.openRead()) {
            return new String(readLimited(stream), StandardCharsets.UTF_8);
        } catch (Exception error) {
            throw new IllegalStateException(safeMessage(error), error);
        }
    }

    private File profileFile(String id) {
        if (!isSafeProfileId(id)) {
            throw new IllegalArgumentException("配置 ID 无效");
        }
        return new File(profilesDirectory, id + ".json");
    }

    private boolean isSafeProfileId(String id) {
        return id != null && id.matches("[A-Za-z0-9._-]{1,128}");
    }

    private byte[] readLimited(InputStream input) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int total = 0;
        int read;
        while ((read = input.read(buffer)) != -1) {
            total += read;
            if (total > MAX_PROFILE_BYTES) {
                throw new IllegalArgumentException("配置超过 20 MiB 限制");
            }
            output.write(buffer, 0, read);
        }
        return output.toByteArray();
    }

    private String download(String urlText) throws Exception {
        URL url = new URL(urlText);
        String protocol = url.getProtocol();
        if (!"http".equalsIgnoreCase(protocol) && !"https".equalsIgnoreCase(protocol)) {
            throw new IllegalArgumentException("订阅地址只支持 HTTP 或 HTTPS");
        }

        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        try {
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(20_000);
            connection.setInstanceFollowRedirects(true);
            connection.setRequestProperty("User-Agent", "sing-box/1.14.0 SingDeck/Android");
            int code = connection.getResponseCode();
            if (code < 200 || code >= 400) {
                throw new IllegalStateException("HTTP 响应错误：" + code);
            }
            try (InputStream input = connection.getInputStream()) {
                return new String(readLimited(input), StandardCharsets.UTF_8);
            }
        } finally {
            connection.disconnect();
        }
    }

    private RemotePayload downloadRemotePayload(MobileImportLink link) throws Exception {
        String config = download(link.configUrl);
        if (!link.includeSettings) {
            return new RemotePayload(config, null, null);
        }

        Exception lastError = null;
        for (int attempt = 0; attempt < 2; attempt++) {
            if (attempt > 0) {
                config = download(link.configUrl);
            }
            try {
                String bootstrapJson = download(link.bootstrapUrl);
                MobileBootstrap bootstrap = MobileBootstrapVerifier.parseAndVerify(
                        config,
                        bootstrapJson
                );
                return new RemotePayload(config, bootstrap, null);
            } catch (Exception error) {
                lastError = error;
            }
        }
        return new RemotePayload(
                config,
                null,
                "伴随设置同步失败：" + safeMessage(lastError)
        );
    }

    private String formatRemoteConfig(String rawConfig) {
        try {
            LibboxRuntime.initialize(context);
            StringBox formatted = Libbox.formatConfig(rawConfig);
            String value = formatted == null ? null : formatted.getValue();
            if (value == null || value.trim().isEmpty()) {
                throw new IllegalArgumentException("sing-box 未返回格式化配置");
            }
            return value;
        } catch (Exception error) {
            throw new IllegalArgumentException("远程 Config 规范化失败：" + safeMessage(error), error);
        }
    }

    private String prepareAndValidate(String content, String profileName) {
        String prepared = NodeLinkParser.parseToSingBoxConfig(content, normalizedName(profileName));
        try {
            SingBoxConfigValidator.validate(context, prepared);
        } catch (SingBoxConfigValidator.ValidationException error) {
            throw new NodeLinkParser.ParseException(error.getMessage(), error);
        }
        return prepared;
    }

    private Profile copyProfile(Profile profile, boolean includeContent) {
        Profile copy = new Profile();
        copy.id = profile.id;
        copy.name = profile.name;
        copy.type = profile.type;
        copy.url = profile.url;
        copy.content = includeContent ? profile.content : null;
        copy.active = profile.active;
        copy.valid = profile.valid;
        copy.validationError = profile.validationError;
        copy.nodeCount = profile.nodeCount;
        copy.lastUpdatedAt = profile.lastUpdatedAt;
        return copy;
    }

    private int countNodesInContent(String content) {
        if (content == null || content.trim().isEmpty()) {
            return 0;
        }
        try {
            JsonObject root = gson.fromJson(content, JsonObject.class);
            if (root == null || !root.has("outbounds")) {
                return 0;
            }
            int count = 0;
            for (JsonElement element : root.getAsJsonArray("outbounds")) {
                if (!element.isJsonObject()) {
                    continue;
                }
                String type = stringValue(element.getAsJsonObject(), "type");
                if (!"selector".equalsIgnoreCase(type)
                        && !"urltest".equalsIgnoreCase(type)
                        && !"direct".equalsIgnoreCase(type)
                        && !"block".equalsIgnoreCase(type)
                        && !"dns".equalsIgnoreCase(type)) {
                    count++;
                }
            }
            return count;
        } catch (Exception ignored) {
            return 0;
        }
    }

    private List<String> nodeNamesInContent(String content) {
        List<String> names = new ArrayList<>();
        if (content == null || content.trim().isEmpty()) {
            return names;
        }
        try {
            JsonObject root = gson.fromJson(content, JsonObject.class);
            if (root == null || !root.has("outbounds") || !root.get("outbounds").isJsonArray()) {
                return names;
            }
            for (JsonElement element : root.getAsJsonArray("outbounds")) {
                if (!element.isJsonObject()) {
                    continue;
                }
                JsonObject outbound = element.getAsJsonObject();
                String type = stringValue(outbound, "type");
                String tag = stringValue(outbound, "tag");
                if (!tag.isEmpty()
                        && !"selector".equalsIgnoreCase(type)
                        && !"urltest".equalsIgnoreCase(type)
                        && !"direct".equalsIgnoreCase(type)
                        && !"block".equalsIgnoreCase(type)
                        && !"dns".equalsIgnoreCase(type)) {
                    names.add(tag);
                }
            }
        } catch (RuntimeException ignored) {
        }
        return names;
    }

    private void parseActiveProfileContentLocked() {
        cachedGroups.clear();
        cachedNodes.clear();
        Profile active = getActiveProfile();
        if (active == null || active.content == null) {
            return;
        }

        try {
            JsonObject root = gson.fromJson(active.content, JsonObject.class);
            if (root == null || !root.has("outbounds")) {
                return;
            }
            JsonArray outbounds = root.getAsJsonArray("outbounds");
            for (JsonElement element : outbounds) {
                if (!element.isJsonObject()) {
                    continue;
                }
                JsonObject outbound = element.getAsJsonObject();
                String tag = stringValue(outbound, "tag");
                String type = stringValue(outbound, "type");
                if (tag.isEmpty()) {
                    continue;
                }

                if ("selector".equalsIgnoreCase(type) || "urltest".equalsIgnoreCase(type)) {
                    List<String> members = new ArrayList<>();
                    if (outbound.has("outbounds") && outbound.get("outbounds").isJsonArray()) {
                        for (JsonElement member : outbound.getAsJsonArray("outbounds")) {
                            members.add(member.getAsString());
                        }
                    }
                    String selected = outbound.has("default")
                            ? outbound.get("default").getAsString()
                            : (members.isEmpty() ? "" : members.get(0));
                    cachedGroups.add(new OutboundGroup(tag, type, selected, members));
                } else if (!"direct".equalsIgnoreCase(type) && !"block".equalsIgnoreCase(type)) {
                    NodeItem node = new NodeItem(tag, type.toUpperCase());
                    if (outbound.has("server")) {
                        node.server = outbound.get("server").getAsString();
                    }
                    if (outbound.has("server_port")) {
                        node.port = outbound.get("server_port").getAsInt();
                    }
                    cachedNodes.put(tag, node);
                }
            }
        } catch (Exception ignored) {
        } finally {
            try {
                inspectorRepository.reconcileSourceLinks(
                        active.id,
                        nodeNamesInContent(active.content)
                );
            } catch (RuntimeException error) {
                Log.w(TAG, "Unable to reconcile Inspector node sources", error);
            }
        }
    }

    private Profile findProfileLocked(String id) {
        if (id == null) {
            return null;
        }
        for (Profile profile : profiles) {
            if (id.equals(profile.id)) {
                return profile;
            }
        }
        return null;
    }

    private Profile firstValidProfileLocked() {
        for (Profile profile : profiles) {
            if (profile.valid) {
                return profile;
            }
        }
        return null;
    }

    private void setActiveProfileLocked(String id) {
        activeProfileId = id;
        for (Profile profile : profiles) {
            profile.active = id != null && id.equals(profile.id) && profile.valid;
        }
    }

    private String normalizedName(String name) {
        return name == null || name.trim().isEmpty() ? "未命名配置" : name.trim();
    }

    private String normalizedType(String type) {
        return type == null || type.trim().isEmpty() ? "raw" : type.trim();
    }

    private String normalizedUrl(String url) {
        return url == null || url.trim().isEmpty() ? null : url.trim();
    }

    private String stringValue(JsonObject object, String key) {
        return object.has(key) && !object.get(key).isJsonNull()
                ? object.get(key).getAsString()
                : "";
    }

    private void notifyListeners() {
        final List<OnProfileChangeListener> snapshot;
        synchronized (this) {
            snapshot = new ArrayList<>(listeners);
        }
        mainHandler.post(() -> {
            for (OnProfileChangeListener listener : snapshot) {
                try {
                    listener.onProfilesChanged();
                } catch (Exception ignored) {
                }
            }
        });
    }

    private void postError(OnAsyncResultCallback callback, String message) {
        if (callback != null) {
            mainHandler.post(() -> callback.onError(message));
        }
    }

    private String safeMessage(Throwable error) {
        String message = error.getMessage();
        return message == null || message.trim().isEmpty()
                ? error.getClass().getSimpleName()
                : message;
    }
}
