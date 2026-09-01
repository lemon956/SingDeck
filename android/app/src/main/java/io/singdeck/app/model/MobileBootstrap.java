package io.singdeck.app.model;

import java.util.ArrayList;
import java.util.List;

/** Settings snapshot exported by a SingDeck Helper for native mobile import. */
public final class MobileBootstrap {
    public String schema;
    public String configSha256;
    public TestingSettings testingSettings;
    public List<Group> groups = new ArrayList<>();
    public List<NodeSource> nodeSources = new ArrayList<>();

    public static final class TestingSettings {
        public String defaultTestUrl;
        public long delayTestTimeoutMs;
        public long minProbeIntervalSec;
        public int probeConcurrency;
        public String geminiLocationGroup;
    }

    public static final class Group {
        public String name;
        public String kind;
        public GroupSettings config;
    }

    public static final class GroupSettings {
        public String testUrl;
        public boolean testUrlOverridden;
        public String mode;
        public String scheme;
        public boolean autoSwitch;
        public boolean autoProbe;
        public long probeIntervalSec;
        public boolean geminiLocationProbeEnabled;
        public NodeRiskChecks nodeRisk;
        public boolean sourceRestrictionEnabled;
        public List<String> allowedNodeSources = new ArrayList<>();
        public boolean allowUnlabeledNodes;
    }

    public static final class NodeRiskChecks {
        public boolean exitIp;
        public boolean addressScope;
        public boolean networkIdentity;
        public boolean networkClass;
        public boolean routeSecurity;
        public boolean tor;
        public boolean privacy;
        public boolean abuse;
    }

    public static final class NodeSource {
        public String name;
        public String url;
        public boolean associate;
        public List<String> configuredNodes = new ArrayList<>();
        public List<String> linkedNodes = new ArrayList<>();
        public String lastSyncedAt;
        public String lastError;
    }
}
