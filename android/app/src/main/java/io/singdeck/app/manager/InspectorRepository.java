package io.singdeck.app.manager;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;

import java.lang.reflect.Type;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import io.singdeck.app.model.MobileBootstrap;

/** App-private persistence for native Proxies Inspector state. */
public final class InspectorRepository extends SQLiteOpenHelper {
    private static final String DB_NAME = "singdeck_inspector.db";
    private static final int DB_VERSION = 1;
    private static final Type STRING_LIST_TYPE = new TypeToken<List<String>>() {
    }.getType();
    private static InspectorRepository instance;

    private final Gson gson = new Gson();

    public static final class SourceState {
        public final String name;
        public final String url;
        public final boolean associate;
        public final List<String> configuredNodes;
        public final List<String> remoteNodes;
        public final List<String> linkedNodes;
        public final String lastSyncedAt;
        public final String lastError;
        public final int colorIndex;

        SourceState(
                String name,
                String url,
                boolean associate,
                List<String> configuredNodes,
                List<String> remoteNodes,
                List<String> linkedNodes,
                String lastSyncedAt,
                String lastError,
                int colorIndex
        ) {
            this.name = name;
            this.url = url;
            this.associate = associate;
            this.configuredNodes = configuredNodes;
            this.remoteNodes = remoteNodes;
            this.linkedNodes = linkedNodes;
            this.lastSyncedAt = lastSyncedAt;
            this.lastError = lastError;
            this.colorIndex = colorIndex;
        }
    }

    private InspectorRepository(Context context) {
        super(context.getApplicationContext(), DB_NAME, null, DB_VERSION);
    }

    public static synchronized InspectorRepository getInstance(Context context) {
        if (instance == null) {
            instance = new InspectorRepository(context);
        }
        return instance;
    }

    @Override
    public void onConfigure(SQLiteDatabase db) {
        super.onConfigure(db);
        db.setForeignKeyConstraintsEnabled(true);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE profiles (profile_id TEXT PRIMARY KEY)");
        db.execSQL("CREATE TABLE testing_settings ("
                + "profile_id TEXT PRIMARY KEY REFERENCES profiles(profile_id) ON DELETE CASCADE,"
                + "settings_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE group_settings ("
                + "profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,"
                + "group_name TEXT NOT NULL, group_kind TEXT NOT NULL, config_json TEXT NOT NULL,"
                + "updated_at INTEGER NOT NULL, PRIMARY KEY(profile_id, group_name))");
        db.execSQL("CREATE TABLE node_sources ("
                + "profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,"
                + "source_name TEXT NOT NULL, source_url TEXT, associate INTEGER NOT NULL,"
                + "configured_nodes_json TEXT NOT NULL, remote_nodes_json TEXT NOT NULL,"
                + "last_synced_at TEXT, last_error TEXT, source_order INTEGER NOT NULL,"
                + "color_index INTEGER NOT NULL, PRIMARY KEY(profile_id, source_name))");
        db.execSQL("CREATE TABLE source_links ("
                + "profile_id TEXT NOT NULL REFERENCES profiles(profile_id) ON DELETE CASCADE,"
                + "node_name TEXT NOT NULL, source_name TEXT NOT NULL,"
                + "PRIMARY KEY(profile_id, node_name),"
                + "FOREIGN KEY(profile_id, source_name) REFERENCES node_sources(profile_id, source_name)"
                + " ON DELETE CASCADE)");
        db.execSQL("CREATE TABLE probe_samples ("
                + "id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT NOT NULL,"
                + "group_name TEXT NOT NULL, node_name TEXT NOT NULL, test_url TEXT NOT NULL,"
                + "delay_ms INTEGER, success INTEGER NOT NULL, error TEXT, tested_at INTEGER NOT NULL)");
        db.execSQL("CREATE INDEX probe_samples_lookup ON probe_samples"
                + "(profile_id, group_name, node_name, tested_at)");
        db.execSQL("CREATE TABLE inspection_results ("
                + "profile_id TEXT NOT NULL, group_name TEXT NOT NULL, node_name TEXT NOT NULL,"
                + "result_kind TEXT NOT NULL, result_json TEXT NOT NULL, tested_at INTEGER NOT NULL,"
                + "PRIMARY KEY(profile_id, group_name, node_name, result_kind))");
        db.execSQL("CREATE TABLE scheduler_state ("
                + "profile_id TEXT NOT NULL, group_name TEXT NOT NULL, last_probe_at INTEGER NOT NULL,"
                + "PRIMARY KEY(profile_id, group_name))");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        throw new IllegalStateException(
                "不支持的 Inspector 数据库升级：" + oldVersion + " -> " + newVersion
        );
    }

    public synchronized void importBootstrap(
            String profileId,
            MobileBootstrap bootstrap,
            Collection<String> currentNodes
    ) {
        requireProfileId(profileId);
        if (bootstrap == null) {
            return;
        }
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            ensureProfile(db, profileId);
            replaceTestingSettings(db, profileId, bootstrap.testingSettings);
            replaceGroupSettings(db, profileId, bootstrap.groups);
            replaceNodeSources(db, profileId, bootstrap.nodeSources);
            reconcileSourceLinks(db, profileId, currentNodes);
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    public synchronized MobileBootstrap.TestingSettings getTestingSettings(String profileId) {
        requireProfileId(profileId);
        try (Cursor cursor = getReadableDatabase().query(
                "testing_settings",
                new String[]{"settings_json"},
                "profile_id = ?",
                new String[]{profileId},
                null,
                null,
                null
        )) {
            if (cursor.moveToFirst()) {
                MobileBootstrap.TestingSettings settings = gson.fromJson(
                        cursor.getString(0),
                        MobileBootstrap.TestingSettings.class
                );
                return normalizeTestingSettings(settings);
            }
        }
        return normalizeTestingSettings(null);
    }

    public synchronized void saveTestingSettings(
            String profileId,
            MobileBootstrap.TestingSettings settings
    ) {
        requireProfileId(profileId);
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            ensureProfile(db, profileId);
            replaceTestingSettings(db, profileId, settings);
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    public synchronized MobileBootstrap.GroupSettings getGroupSettings(
            String profileId,
            String groupName
    ) {
        requireProfileId(profileId);
        try (Cursor cursor = getReadableDatabase().query(
                "group_settings",
                new String[]{"config_json"},
                "profile_id = ? AND group_name = ?",
                new String[]{profileId, groupName},
                null,
                null,
                null
        )) {
            if (cursor.moveToFirst()) {
                MobileBootstrap.GroupSettings settings = gson.fromJson(
                        cursor.getString(0),
                        MobileBootstrap.GroupSettings.class
                );
                return normalizeGroupSettings(settings, getTestingSettings(profileId));
            }
        }
        return normalizeGroupSettings(null, getTestingSettings(profileId));
    }

    public synchronized void saveGroupSettings(
            String profileId,
            String groupName,
            String groupKind,
            MobileBootstrap.GroupSettings settings
    ) {
        requireProfileId(profileId);
        if (groupName == null || groupName.trim().isEmpty()) {
            throw new IllegalArgumentException("策略组名称为空");
        }
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            ensureProfile(db, profileId);
            putGroupSettings(
                    db,
                    profileId,
                    groupName.trim(),
                    groupKind,
                    normalizeGroupSettings(settings, getTestingSettings(profileId))
            );
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    public synchronized List<SourceState> getNodeSources(String profileId) {
        requireProfileId(profileId);
        Map<String, List<String>> linked = new HashMap<>();
        try (Cursor cursor = getReadableDatabase().query(
                "source_links",
                new String[]{"source_name", "node_name"},
                "profile_id = ?",
                new String[]{profileId},
                null,
                null,
                "source_name, node_name"
        )) {
            while (cursor.moveToNext()) {
                linked.computeIfAbsent(cursor.getString(0), ignored -> new ArrayList<>())
                        .add(cursor.getString(1));
            }
        }

        List<SourceState> sources = new ArrayList<>();
        try (Cursor cursor = getReadableDatabase().query(
                "node_sources",
                new String[]{
                        "source_name", "source_url", "associate", "configured_nodes_json",
                        "remote_nodes_json", "last_synced_at", "last_error", "color_index"
                },
                "profile_id = ?",
                new String[]{profileId},
                null,
                null,
                "source_order, source_name"
        )) {
            while (cursor.moveToNext()) {
                String name = cursor.getString(0);
                sources.add(new SourceState(
                        name,
                        cursor.isNull(1) ? null : cursor.getString(1),
                        cursor.getInt(2) != 0,
                        decodeStringList(cursor.getString(3)),
                        decodeStringList(cursor.getString(4)),
                        linked.getOrDefault(name, Collections.emptyList()),
                        cursor.isNull(5) ? null : cursor.getString(5),
                        cursor.isNull(6) ? null : cursor.getString(6),
                        cursor.getInt(7)
                ));
            }
        }
        return sources;
    }

    /** Creates a portable settings/source snapshot without transient probe history. */
    public synchronized MobileBootstrap exportBootstrap(String profileId) {
        requireProfileId(profileId);
        MobileBootstrap bootstrap = new MobileBootstrap();
        bootstrap.schema = "singdeck-mobile-v1";
        bootstrap.testingSettings = getTestingSettings(profileId);

        try (Cursor cursor = getReadableDatabase().query(
                "group_settings",
                new String[]{"group_name", "group_kind", "config_json"},
                "profile_id = ?",
                new String[]{profileId},
                null,
                null,
                "group_name"
        )) {
            while (cursor.moveToNext()) {
                MobileBootstrap.Group group = new MobileBootstrap.Group();
                group.name = cursor.getString(0);
                group.kind = cursor.getString(1);
                MobileBootstrap.GroupSettings settings = gson.fromJson(
                        cursor.getString(2),
                        MobileBootstrap.GroupSettings.class
                );
                group.config = normalizeGroupSettings(settings, bootstrap.testingSettings);
                bootstrap.groups.add(group);
            }
        }

        for (SourceState state : getNodeSources(profileId)) {
            MobileBootstrap.NodeSource source = new MobileBootstrap.NodeSource();
            source.name = state.name;
            source.url = state.url;
            source.associate = state.associate;
            source.configuredNodes = unique(state.configuredNodes);
            LinkedHashSet<String> candidates = new LinkedHashSet<>(source.configuredNodes);
            candidates.addAll(state.remoteNodes);
            source.linkedNodes = new ArrayList<>(candidates);
            source.lastSyncedAt = state.lastSyncedAt;
            source.lastError = state.lastError;
            bootstrap.nodeSources.add(source);
        }
        return bootstrap;
    }

    public synchronized Map<String, String> getSourceOwners(String profileId) {
        requireProfileId(profileId);
        Map<String, String> owners = new LinkedHashMap<>();
        try (Cursor cursor = getReadableDatabase().query(
                "source_links",
                new String[]{"node_name", "source_name"},
                "profile_id = ?",
                new String[]{profileId},
                null,
                null,
                "node_name"
        )) {
            while (cursor.moveToNext()) {
                owners.put(cursor.getString(0), cursor.getString(1));
            }
        }
        return owners;
    }

    public synchronized List<String> eligibleNodes(
            String profileId,
            String groupName,
            Collection<String> nodes
    ) {
        MobileBootstrap.GroupSettings settings = getGroupSettings(profileId, groupName);
        Map<String, String> owners = getSourceOwners(profileId);
        List<String> eligible = new ArrayList<>();
        if (nodes != null) {
            for (String node : nodes) {
                if (node != null
                        && !node.trim().isEmpty()
                        && NodeEligibilityPolicy.isAllowed(settings, node, owners)) {
                    eligible.add(node);
                }
            }
        }
        return eligible;
    }

    public synchronized void saveProbeSample(
            String profileId,
            String groupName,
            String nodeName,
            String testUrl,
            Integer delayMs,
            boolean success,
            String error,
            long testedAt
    ) {
        requireProfileId(profileId);
        ContentValues values = new ContentValues();
        values.put("profile_id", profileId);
        values.put("group_name", groupName);
        values.put("node_name", nodeName);
        values.put("test_url", testUrl);
        if (delayMs == null) {
            values.putNull("delay_ms");
        } else {
            values.put("delay_ms", delayMs);
        }
        values.put("success", success ? 1 : 0);
        values.put("error", emptyToNull(error));
        values.put("tested_at", testedAt);
        getWritableDatabase().insertOrThrow("probe_samples", null, values);
    }

    public synchronized List<ProbeScoringEngine.ProbeSample> getRecentProbeSamples(
            String profileId,
            String groupName,
            String nodeName,
            String testUrl,
            MobileBootstrap.GroupSettings settings,
            long now
    ) {
        requireProfileId(profileId);
        long windowStart = now - ProbeScoringEngine.sampleWindowMs(settings);
        List<ProbeScoringEngine.ProbeSample> descending = new ArrayList<>();
        try (Cursor cursor = getReadableDatabase().query(
                "probe_samples",
                new String[]{"delay_ms", "success", "error", "tested_at"},
                "profile_id = ? AND group_name = ? AND node_name = ?"
                        + " AND test_url = ? AND tested_at >= ?",
                new String[]{
                        profileId,
                        groupName,
                        nodeName,
                        testUrl,
                        String.valueOf(windowStart)
                },
                null,
                null,
                "tested_at DESC",
                String.valueOf(ProbeScoringEngine.MAX_SAMPLE_COUNT)
        )) {
            while (cursor.moveToNext()) {
                descending.add(new ProbeScoringEngine.ProbeSample(
                        cursor.isNull(0) ? null : cursor.getInt(0),
                        cursor.getInt(1) != 0,
                        cursor.isNull(2) ? null : cursor.getString(2),
                        cursor.getLong(3)
                ));
            }
        }
        Collections.reverse(descending);
        return descending;
    }

    public synchronized List<ProbeScoringEngine.NodeScore> getScores(
            String profileId,
            String groupName,
            Collection<String> nodes,
            long now
    ) {
        MobileBootstrap.GroupSettings settings = getGroupSettings(profileId, groupName);
        List<ProbeScoringEngine.NodeScore> scores = new ArrayList<>();
        for (String node : eligibleNodes(profileId, groupName, nodes)) {
            scores.add(ProbeScoringEngine.score(
                    node,
                    getRecentProbeSamples(
                            profileId,
                            groupName,
                            node,
                            settings.testUrl,
                            settings,
                            now
                    ),
                    settings,
                    now
            ));
        }
        scores.sort(ProbeScoringEngine.comparator(settings));
        return scores;
    }

    public synchronized void saveInspectionResult(
            String profileId,
            String groupName,
            String nodeName,
            String resultKind,
            String resultJson,
            long testedAt
    ) {
        requireProfileId(profileId);
        ContentValues values = new ContentValues();
        values.put("profile_id", profileId);
        values.put("group_name", groupName);
        values.put("node_name", nodeName);
        values.put("result_kind", resultKind);
        values.put("result_json", resultJson);
        values.put("tested_at", testedAt);
        getWritableDatabase().insertWithOnConflict(
                "inspection_results",
                null,
                values,
                SQLiteDatabase.CONFLICT_REPLACE
        );
    }

    public synchronized Map<String, String> getInspectionResults(
            String profileId,
            String groupName,
            String nodeName
    ) {
        requireProfileId(profileId);
        Map<String, String> results = new LinkedHashMap<>();
        try (Cursor cursor = getReadableDatabase().query(
                "inspection_results",
                new String[]{"result_kind", "result_json"},
                "profile_id = ? AND group_name = ? AND node_name = ?",
                new String[]{profileId, groupName, nodeName},
                null,
                null,
                "result_kind"
        )) {
            while (cursor.moveToNext()) {
                results.put(cursor.getString(0), cursor.getString(1));
            }
        }
        return results;
    }

    public synchronized boolean tryClaimAutoProbe(
            String profileId,
            String groupName,
            long now,
            long intervalMs
    ) {
        requireProfileId(profileId);
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            long previous = 0;
            try (Cursor cursor = db.query(
                    "scheduler_state",
                    new String[]{"last_probe_at"},
                    "profile_id = ? AND group_name = ?",
                    new String[]{profileId, groupName},
                    null,
                    null,
                    null
            )) {
                if (cursor.moveToFirst()) {
                    previous = cursor.getLong(0);
                }
            }
            if (previous > 0 && now >= previous && now - previous < Math.max(1, intervalMs)) {
                return false;
            }
            ContentValues values = new ContentValues();
            values.put("profile_id", profileId);
            values.put("group_name", groupName);
            values.put("last_probe_at", now);
            db.insertWithOnConflict(
                    "scheduler_state",
                    null,
                    values,
                    SQLiteDatabase.CONFLICT_REPLACE
            );
            db.setTransactionSuccessful();
            return true;
        } finally {
            db.endTransaction();
        }
    }

    public synchronized void reconcileSourceLinks(
            String profileId,
            Collection<String> currentNodes
    ) {
        requireProfileId(profileId);
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            ensureProfile(db, profileId);
            reconcileSourceLinks(db, profileId, currentNodes);
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    public synchronized void deleteProfile(String profileId) {
        if (profileId == null || profileId.trim().isEmpty()) {
            return;
        }
        getWritableDatabase().delete("profiles", "profile_id = ?", new String[]{profileId});
        getWritableDatabase().delete("probe_samples", "profile_id = ?", new String[]{profileId});
        getWritableDatabase().delete("inspection_results", "profile_id = ?", new String[]{profileId});
        getWritableDatabase().delete("scheduler_state", "profile_id = ?", new String[]{profileId});
    }

    private void replaceTestingSettings(
            SQLiteDatabase db,
            String profileId,
            MobileBootstrap.TestingSettings input
    ) {
        MobileBootstrap.TestingSettings settings = normalizeTestingSettings(input);
        ContentValues values = new ContentValues();
        values.put("profile_id", profileId);
        values.put("settings_json", gson.toJson(settings));
        values.put("updated_at", System.currentTimeMillis());
        db.insertWithOnConflict(
                "testing_settings",
                null,
                values,
                SQLiteDatabase.CONFLICT_REPLACE
        );
    }

    private void replaceGroupSettings(
            SQLiteDatabase db,
            String profileId,
            List<MobileBootstrap.Group> groups
    ) {
        db.delete("group_settings", "profile_id = ?", new String[]{profileId});
        if (groups == null) {
            return;
        }
        MobileBootstrap.TestingSettings testing = getTestingSettings(profileId);
        for (MobileBootstrap.Group group : groups) {
            if (group == null || group.name == null || group.name.trim().isEmpty()) {
                continue;
            }
            putGroupSettings(
                    db,
                    profileId,
                    group.name.trim(),
                    group.kind,
                    normalizeGroupSettings(group.config, testing)
            );
        }
    }

    private void putGroupSettings(
            SQLiteDatabase db,
            String profileId,
            String groupName,
            String groupKind,
            MobileBootstrap.GroupSettings settings
    ) {
        ContentValues values = new ContentValues();
        values.put("profile_id", profileId);
        values.put("group_name", groupName);
        values.put("group_kind", groupKind == null ? "" : groupKind.trim());
        values.put("config_json", gson.toJson(settings));
        values.put("updated_at", System.currentTimeMillis());
        db.insertWithOnConflict("group_settings", null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }

    private void replaceNodeSources(
            SQLiteDatabase db,
            String profileId,
            List<MobileBootstrap.NodeSource> sources
    ) {
        Map<String, Integer> existingColors = new HashMap<>();
        try (Cursor cursor = db.query(
                "node_sources",
                new String[]{"source_name", "color_index"},
                "profile_id = ?",
                new String[]{profileId},
                null,
                null,
                null
        )) {
            while (cursor.moveToNext()) {
                existingColors.put(cursor.getString(0), cursor.getInt(1));
            }
        }
        db.delete("source_links", "profile_id = ?", new String[]{profileId});
        db.delete("node_sources", "profile_id = ?", new String[]{profileId});
        if (sources == null) {
            return;
        }
        int order = 0;
        for (MobileBootstrap.NodeSource source : sources) {
            if (source == null || source.name == null || source.name.trim().isEmpty()) {
                continue;
            }
            String name = source.name.trim();
            List<String> configured = unique(source.configuredNodes);
            List<String> remote = unique(source.linkedNodes);
            remote.removeAll(configured);
            ContentValues values = new ContentValues();
            values.put("profile_id", profileId);
            values.put("source_name", name);
            values.put("source_url", emptyToNull(source.url));
            values.put("associate", source.associate ? 1 : 0);
            values.put("configured_nodes_json", gson.toJson(configured));
            values.put("remote_nodes_json", gson.toJson(remote));
            values.put("last_synced_at", emptyToNull(source.lastSyncedAt));
            values.put("last_error", emptyToNull(source.lastError));
            values.put("source_order", order);
            values.put("color_index", existingColors.getOrDefault(name, order));
            db.insertOrThrow("node_sources", null, values);
            order++;
        }
    }

    private void reconcileSourceLinks(
            SQLiteDatabase db,
            String profileId,
            Collection<String> currentNodes
    ) {
        List<NodeSourceAssociation.SourceCandidates> sources = new ArrayList<>();
        try (Cursor cursor = db.query(
                "node_sources",
                new String[]{"source_name", "configured_nodes_json", "remote_nodes_json"},
                "profile_id = ?",
                new String[]{profileId},
                null,
                null,
                "source_order, source_name"
        )) {
            while (cursor.moveToNext()) {
                sources.add(new NodeSourceAssociation.SourceCandidates(
                        cursor.getString(0),
                        decodeStringList(cursor.getString(1)),
                        decodeStringList(cursor.getString(2))
                ));
            }
        }
        Map<String, String> owners = NodeSourceAssociation.associate(sources, currentNodes);
        db.delete("source_links", "profile_id = ?", new String[]{profileId});
        for (Map.Entry<String, String> owner : owners.entrySet()) {
            ContentValues values = new ContentValues();
            values.put("profile_id", profileId);
            values.put("node_name", owner.getKey());
            values.put("source_name", owner.getValue());
            db.insertOrThrow("source_links", null, values);
        }
    }

    private void ensureProfile(SQLiteDatabase db, String profileId) {
        ContentValues values = new ContentValues();
        values.put("profile_id", profileId);
        db.insertWithOnConflict("profiles", null, values, SQLiteDatabase.CONFLICT_IGNORE);
    }

    private MobileBootstrap.TestingSettings normalizeTestingSettings(
            MobileBootstrap.TestingSettings input
    ) {
        MobileBootstrap.TestingSettings settings = input == null
                ? new MobileBootstrap.TestingSettings()
                : input;
        if (settings.defaultTestUrl == null || settings.defaultTestUrl.trim().isEmpty()) {
            settings.defaultTestUrl = "https://cp.cloudflare.com/generate_204";
        }
        if (settings.delayTestTimeoutMs < 500 || settings.delayTestTimeoutMs > 60_000) {
            settings.delayTestTimeoutMs = 5_000;
        }
        if (settings.minProbeIntervalSec < 60) {
            settings.minProbeIntervalSec = 60;
        }
        if (settings.probeConcurrency < 1 || settings.probeConcurrency > 64) {
            settings.probeConcurrency = 4;
        }
        if (settings.geminiLocationGroup == null) {
            settings.geminiLocationGroup = "";
        }
        return settings;
    }

    private MobileBootstrap.GroupSettings normalizeGroupSettings(
            MobileBootstrap.GroupSettings input,
            MobileBootstrap.TestingSettings testing
    ) {
        MobileBootstrap.GroupSettings settings = input == null
                ? new MobileBootstrap.GroupSettings()
                : input;
        if (settings.testUrl == null || settings.testUrl.trim().isEmpty()) {
            settings.testUrl = normalizeTestingSettings(testing).defaultTestUrl;
        }
        if (settings.mode == null || !("delay".equalsIgnoreCase(settings.mode)
                || "score".equalsIgnoreCase(settings.mode))) {
            settings.mode = "score";
        }
        if (settings.scheme == null || !("LatencyFirst".equalsIgnoreCase(settings.scheme)
                || "Balanced".equalsIgnoreCase(settings.scheme))) {
            settings.scheme = "Balanced";
        }
        if (settings.probeIntervalSec < 60) {
            settings.probeIntervalSec = 900;
        }
        if (settings.nodeRisk == null) {
            settings.nodeRisk = new MobileBootstrap.NodeRiskChecks();
        }
        settings.allowedNodeSources = unique(settings.allowedNodeSources);
        return settings;
    }

    private List<String> decodeStringList(String json) {
        try {
            List<String> values = gson.fromJson(json, STRING_LIST_TYPE);
            return unique(values);
        } catch (RuntimeException ignored) {
            return new ArrayList<>();
        }
    }

    private static List<String> unique(Collection<String> values) {
        Set<String> result = new LinkedHashSet<>();
        if (values != null) {
            for (String value : values) {
                if (value != null && !value.trim().isEmpty()) {
                    result.add(value.trim());
                }
            }
        }
        return new ArrayList<>(result);
    }

    private static String emptyToNull(String value) {
        return value == null || value.trim().isEmpty() ? null : value.trim();
    }

    private static void requireProfileId(String profileId) {
        if (profileId == null || profileId.trim().isEmpty()) {
            throw new IllegalArgumentException("Profile ID 为空");
        }
    }
}
