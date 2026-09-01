package io.singdeck.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.IpPrefix;
import android.net.ProxyInfo;
import android.net.VpnService;
import android.os.Build;
import android.os.IBinder;
import android.os.ParcelFileDescriptor;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.annotation.RequiresApi;

import java.io.IOException;
import java.net.InetAddress;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

import io.nekohasekai.libbox.CommandClient;
import io.nekohasekai.libbox.CommandClientHandler;
import io.nekohasekai.libbox.CommandClientOptions;
import io.nekohasekai.libbox.CommandServer;
import io.nekohasekai.libbox.CommandServerHandler;
import io.nekohasekai.libbox.Connection;
import io.nekohasekai.libbox.ConnectionEvents;
import io.nekohasekai.libbox.ConnectionIterator;
import io.nekohasekai.libbox.Connections;
import io.nekohasekai.libbox.Libbox;
import io.nekohasekai.libbox.LogIterator;
import io.nekohasekai.libbox.OverrideOptions;
import io.nekohasekai.libbox.OutboundGroup;
import io.nekohasekai.libbox.OutboundGroupItem;
import io.nekohasekai.libbox.OutboundGroupItemIterator;
import io.nekohasekai.libbox.OutboundGroupIterator;
import io.nekohasekai.libbox.RoutePrefix;
import io.nekohasekai.libbox.RoutePrefixIterator;
import io.nekohasekai.libbox.StringBox;
import io.nekohasekai.libbox.StringIterator;
import io.nekohasekai.libbox.StatusMessage;
import io.nekohasekai.libbox.SystemProxyStatus;
import io.nekohasekai.libbox.TunOptions;
import io.singdeck.app.manager.ProfileManager;
import io.singdeck.app.manager.InspectorRepository;
import io.singdeck.app.manager.NodeEligibilityPolicy;
import io.singdeck.app.manager.NativeInspectionEngine;
import io.singdeck.app.manager.ProbeScoringEngine;
import io.singdeck.app.manager.RuleSetHttpClientCompat;
import io.singdeck.app.manager.RuntimeConfigOverlay;
import io.singdeck.app.manager.RuntimeGroupSelectionReconciler;
import io.singdeck.app.manager.SingBoxConfigValidator;
import io.singdeck.app.manager.SplitTunnelManager;
import io.singdeck.app.model.ConnectionItem;
import io.singdeck.app.model.CoreRuntimeSnapshot;
import io.singdeck.app.model.NodeItem;
import io.singdeck.app.model.MobileBootstrap;

public class SingDeckVpnService extends VpnService
        implements AndroidPlatformInterface.VpnHost, CommandServerHandler {
    private static final String TAG = "SingDeckVpnService";
    private static final String CHANNEL_ID = "singdeck_vpn_channel";
    private static final int NOTIFICATION_ID = 1001;
    public static final String ACTION_START = "io.singdeck.app.START_VPN";
    public static final String ACTION_STOP = "io.singdeck.app.STOP_VPN";
    public static final String ACTION_RELOAD = "io.singdeck.app.RELOAD_VPN";
    public static final String ACTION_SELECT_OUTBOUND = "io.singdeck.app.SELECT_OUTBOUND";
    public static final String ACTION_URL_TEST = "io.singdeck.app.URL_TEST";
    public static final String ACTION_CLOSE_CONNECTION = "io.singdeck.app.CLOSE_CONNECTION";
    public static final String ACTION_CLOSE_CONNECTIONS = "io.singdeck.app.CLOSE_CONNECTIONS";
    public static final String EXTRA_PROFILE_ID = "profile_id";
    public static final String EXTRA_SPLIT_MODE = "split_mode";
    public static final String EXTRA_PACKAGES = "package_names";
    public static final String EXTRA_OPERATION_ID = "operation_id";
    public static final String EXTRA_GROUP = "group";
    public static final String EXTRA_OUTBOUND = "outbound";
    public static final String EXTRA_CONNECTION_ID = "connection_id";

    public static final String STATE_STOPPED = "stopped";
    public static final String STATE_STARTING = "starting";
    public static final String STATE_RUNNING = "running";
    public static final String STATE_STOPPING = "stopping";
    public static final String STATE_ERROR = "error";

    private static volatile String serviceState = STATE_STOPPED;
    private static volatile long startedAt;
    private static volatile String activeOutbound = "DIRECT";
    private static volatile String runningProfileId = "";
    private static volatile String lastError = "";
    private static volatile long uploadSpeed;
    private static volatile long downloadSpeed;
    private static volatile long totalUpload;
    private static volatile long totalDownload;
    private static final AtomicLong NEXT_OPERATION_ID = new AtomicLong(1);
    private static final ConcurrentHashMap<Long, String> OPERATION_RESULTS = new ConcurrentHashMap<>();
    private static final String OPERATION_OK = "\u0000";
    private static final Object RUNTIME_SNAPSHOT_LOCK = new Object();
    private static final RuntimeGroupSelectionReconciler GROUP_SELECTION_RECONCILER =
            new RuntimeGroupSelectionReconciler();
    private static List<io.singdeck.app.model.OutboundGroup> runtimeGroups = Collections.emptyList();
    private static Map<String, NodeItem> runtimeNodes = Collections.emptyMap();
    private static List<ConnectionItem> runtimeConnections = Collections.emptyList();
    private static long runtimeUpdatedAt;
    private static volatile RuntimeConfigOverlay.ProxyEndpoint inspectionProxy;
    private static volatile String inspectionDegradedReason = "";

    private final Object tunLock = new Object();
    private final ExecutorService coreExecutor = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "SingDeck-libbox");
        thread.setDaemon(true);
        return thread;
    });

    private AndroidPlatformInterface platformInterface;
    private CommandServer commandServer;
    private CommandClient statusClient;
    private ParcelFileDescriptor tunFileDescriptor;
    private long tunGeneration;
    private String currentProfileId = "";
    private String currentConfig = "";
    private String currentSplitMode = "global";
    private List<String> currentPackages = Collections.emptyList();
    private volatile boolean closing;
    private volatile boolean systemProxyAvailable;
    private volatile boolean systemProxyEnabled;
    private volatile boolean autoProbePaused;
    private ScheduledExecutorService autoProbeScheduler;

    public static boolean isVpnRunning() {
        return STATE_RUNNING.equals(serviceState);
    }

    public static String getServiceState() {
        return serviceState;
    }

    public static long getStartedAt() {
        return startedAt;
    }

    public static String getActiveOutbound() {
        return activeOutbound;
    }

    public static String getRunningProfileId() {
        return runningProfileId;
    }

    public static String getLastError() {
        return lastError;
    }

    public static long getUploadSpeed() {
        return uploadSpeed;
    }

    public static long getDownloadSpeed() {
        return downloadSpeed;
    }

    public static long getTotalUpload() {
        return totalUpload;
    }

    public static long getTotalDownload() {
        return totalDownload;
    }

    public static RuntimeConfigOverlay.ProxyEndpoint getInspectionProxy() {
        return inspectionProxy;
    }

    public static String getInspectionDegradedReason() {
        return inspectionDegradedReason;
    }

    public static CoreRuntimeSnapshot getRuntimeSnapshot() {
        synchronized (RUNTIME_SNAPSHOT_LOCK) {
            return new CoreRuntimeSnapshot(
                    serviceState,
                    runningProfileId,
                    activeOutbound,
                    lastError,
                    startedAt,
                    uploadSpeed,
                    downloadSpeed,
                    totalUpload,
                    totalDownload,
                    runtimeUpdatedAt,
                    runtimeGroups,
                    runtimeNodes,
                    runtimeConnections
            );
        }
    }

    public static long newOperationId() {
        return NEXT_OPERATION_ID.getAndIncrement();
    }

    public static boolean isOperationComplete(long operationId) {
        return OPERATION_RESULTS.containsKey(operationId);
    }

    public static String consumeOperationError(long operationId) {
        String result = OPERATION_RESULTS.remove(operationId);
        return OPERATION_OK.equals(result) ? "" : result;
    }

    private static void recordSelectedOutbound(String group, String outbound) {
        String selected = outbound == null || outbound.trim().isEmpty() ? "DIRECT" : outbound;
        synchronized (RUNTIME_SNAPSHOT_LOCK) {
            runtimeGroups = GROUP_SELECTION_RECONCILER.recordSuccessfulSelection(
                    runtimeGroups,
                    group,
                    selected,
                    System.currentTimeMillis()
            );
            activeOutbound = selected;
            runtimeUpdatedAt = System.currentTimeMillis();
        }
    }

    private static boolean isRuntimeGroupTag(String tag) {
        synchronized (RUNTIME_SNAPSHOT_LOCK) {
            for (io.singdeck.app.model.OutboundGroup group : runtimeGroups) {
                if (group.name.equals(tag)) {
                    return true;
                }
            }
        }
        return false;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        try {
            LibboxRuntime.initialize(this);
        } catch (Exception exception) {
            updateState(STATE_ERROR, safeMessage(exception));
            Log.e(TAG, "Unable to initialize libbox", exception);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || intent.getAction() == null) {
            return START_NOT_STICKY;
        }

        String action = intent.getAction();
        if (ACTION_STOP.equals(action)) {
            long operationId = intent.getLongExtra(EXTRA_OPERATION_ID, 0);
            updateState(STATE_STOPPING, "");
            coreExecutor.execute(() -> stopCore(true, operationId));
            return START_NOT_STICKY;
        }

        if (ACTION_SELECT_OUTBOUND.equals(action)) {
            long operationId = intent.getLongExtra(EXTRA_OPERATION_ID, 0);
            String group = intent.getStringExtra(EXTRA_GROUP);
            String outbound = intent.getStringExtra(EXTRA_OUTBOUND);
            coreExecutor.execute(() -> selectOutboundCore(group, outbound, operationId));
            return START_NOT_STICKY;
        }

        if (ACTION_URL_TEST.equals(action)) {
            long operationId = intent.getLongExtra(EXTRA_OPERATION_ID, 0);
            String outbound = intent.getStringExtra(EXTRA_OUTBOUND);
            coreExecutor.execute(() -> urlTestCore(outbound, operationId));
            return START_NOT_STICKY;
        }

        if (ACTION_CLOSE_CONNECTION.equals(action) || ACTION_CLOSE_CONNECTIONS.equals(action)) {
            long operationId = intent.getLongExtra(EXTRA_OPERATION_ID, 0);
            String connectionId = intent.getStringExtra(EXTRA_CONNECTION_ID);
            boolean closeAll = ACTION_CLOSE_CONNECTIONS.equals(action);
            coreExecutor.execute(() -> closeConnectionsCore(connectionId, closeAll, operationId));
            return START_NOT_STICKY;
        }

        if (ACTION_START.equals(action) || ACTION_RELOAD.equals(action)) {
            StartRequest request = readStartRequest(intent);
            updateState(STATE_STARTING, "");
            startForeground(
                    NOTIFICATION_ID,
                    buildServiceNotification("SingDeck VPN", "正在启动 sing-box 核心", true)
            );
            coreExecutor.execute(() -> startOrReloadCore(request));
            return START_NOT_STICKY;
        }

        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return super.onBind(intent);
    }

    @Override
    public void onRevoke() {
        updateState(STATE_STOPPING, "VPN 权限已被系统撤销");
        coreExecutor.execute(() -> stopCore(true, 0));
        super.onRevoke();
    }

    private void startOrReloadCore(StartRequest request) {
        autoProbePaused = true;
        boolean hadRunningCore = commandServer != null && !currentConfig.trim().isEmpty();
        String previousProfileId = currentProfileId;
        String previousConfig = currentConfig;
        String previousSplitMode = currentSplitMode;
        List<String> previousPackages = new ArrayList<>(currentPackages);
        RuntimeConfigOverlay.ProxyEndpoint previousInspectionProxy = inspectionProxy;
        String previousInspectionDegradedReason = inspectionDegradedReason;
        boolean mutationAttempted = false;

        try {
            LibboxRuntime.initialize(this);
            String profileId = request.profileId;
            String config = request.configOverride;
            if (config == null) {
                ProfileManager profileManager = ProfileManager.getInstance(this);
                if (profileId == null || profileId.trim().isEmpty()) {
                    profileId = profileManager.getActiveProfileId();
                }
                if (profileId == null || profileId.trim().isEmpty()) {
                    throw new Exception("没有已激活的配置");
                }
                config = profileManager.getProfileContent(profileId);
            }
            if (config == null || config.trim().isEmpty()) {
                throw new Exception("没有可用的 sing-box 配置");
            }

            SingBoxConfigValidator.validate(this, config);
            String baseRuntimeConfig = RuleSetHttpClientCompat.normalizeForRuntime(config);
            if (!baseRuntimeConfig.equals(config)) {
                SingBoxConfigValidator.validate(this, baseRuntimeConfig);
                Log.i(TAG, "Applied sing-box 1.14 rule-set HTTP client compatibility");
            }
            String runtimeConfig = baseRuntimeConfig;
            RuntimeConfigOverlay.ProxyEndpoint nextInspectionProxy = null;
            String nextInspectionDegradedReason = "";
            if (request.configAlreadyEnhanced) {
                nextInspectionProxy = inspectionProxy;
                nextInspectionDegradedReason = inspectionDegradedReason;
            } else {
                try {
                    RuntimeConfigOverlay.Result overlay = RuntimeConfigOverlay.create(baseRuntimeConfig);
                    SingBoxConfigValidator.validate(this, overlay.runtimeConfig);
                    runtimeConfig = overlay.runtimeConfig;
                    nextInspectionProxy = overlay.endpoint;
                } catch (Throwable overlayError) {
                    nextInspectionDegradedReason = safeMessage(overlayError);
                    Log.w(TAG, "Inspector runtime overlay is unavailable; continuing without it");
                }
            }
            closing = false;
            if (platformInterface == null) {
                platformInterface = new AndroidPlatformInterface(this, this);
            }
            if (commandServer == null) {
                commandServer = new CommandServer(this, platformInterface);
                commandServer.start();
            }

            OverrideOptions overrideOptions = createOverrideOptions(request.splitMode, request.packages);
            long previousTunGeneration;
            synchronized (tunLock) {
                previousTunGeneration = tunGeneration;
            }
            mutationAttempted = true;
            try {
                commandServer.startOrReloadService(runtimeConfig, overrideOptions);
                requireFreshTun(previousTunGeneration);
            } catch (Throwable enhancedStartError) {
                if (nextInspectionProxy == null || request.configAlreadyEnhanced) {
                    throw enhancedStartError;
                }
                Log.w(TAG, "Inspector-enhanced config failed; retrying the original profile");
                nextInspectionDegradedReason = safeMessage(enhancedStartError);
                nextInspectionProxy = null;
                synchronized (tunLock) {
                    previousTunGeneration = tunGeneration;
                }
                commandServer.startOrReloadService(baseRuntimeConfig, overrideOptions);
                requireFreshTun(previousTunGeneration);
                runtimeConfig = baseRuntimeConfig;
            }

            currentProfileId = profileId == null ? "" : profileId;
            currentConfig = runtimeConfig;
            currentSplitMode = request.splitMode;
            currentPackages = Collections.unmodifiableList(new ArrayList<>(request.packages));
            inspectionProxy = nextInspectionProxy;
            inspectionDegradedReason = nextInspectionDegradedReason;
            runningProfileId = currentProfileId;
            if (startedAt == 0) {
                startedAt = System.currentTimeMillis();
            }
            updateState(STATE_RUNNING, "");
            startStatusClient();
            startAutoProbeScheduler();
            completeOperation(request.operationId, "");
            notifyRunning("sing-box " + LibboxRuntime.getCoreVersion());
            Log.i(TAG, "sing-box service started with Android TUN");
        } catch (Throwable error) {
            Log.e(TAG, "Unable to start or reload sing-box service", error);
            String message = safeMessage(error);
            if (hadRunningCore) {
                if (!mutationAttempted) {
                    restoreRunningStateAfterRejectedReload(
                            previousProfileId,
                            request.operationId,
                            message
                    );
                    return;
                }
                try {
                    rollbackCore(
                            previousProfileId,
                            previousConfig,
                            previousSplitMode,
                            previousPackages,
                            previousInspectionProxy,
                            previousInspectionDegradedReason
                    );
                    completeOperation(request.operationId, message + "；已恢复之前运行的配置");
                    return;
                } catch (Throwable rollbackError) {
                    Log.e(TAG, "Unable to roll back sing-box reload", rollbackError);
                    message = message + "；回滚失败：" + safeMessage(rollbackError);
                }
            }
            failStart(message, request.operationId);
        } finally {
            autoProbePaused = false;
        }
    }

    private void restoreRunningStateAfterRejectedReload(
            String previousProfileId,
            long operationId,
            String error
    ) {
        currentProfileId = previousProfileId;
        runningProfileId = previousProfileId == null ? "" : previousProfileId;
        updateState(STATE_RUNNING, "");
        completeOperation(operationId, error);
        notifyRunning("配置重载被拒绝，原连接仍在运行");
    }

    private void rollbackCore(
            String profileId,
            String config,
            String splitMode,
            List<String> packages,
            RuntimeConfigOverlay.ProxyEndpoint previousInspectionProxy,
            String previousInspectionDegradedReason
    ) throws Exception {
        if (commandServer == null || config == null || config.trim().isEmpty()) {
            throw new Exception("没有可回滚的运行配置");
        }
        long previousTunGeneration;
        synchronized (tunLock) {
            previousTunGeneration = tunGeneration;
        }
        String rollbackConfig = RuleSetHttpClientCompat.normalizeForRuntime(config);
        commandServer.startOrReloadService(
                rollbackConfig,
                createOverrideOptions(splitMode, packages)
        );
        synchronized (tunLock) {
            if (tunFileDescriptor == null || tunGeneration <= previousTunGeneration) {
                throw new Exception("回滚配置没有重新建立 Android TUN 入站");
            }
        }
        currentProfileId = profileId == null ? "" : profileId;
        currentConfig = rollbackConfig;
        currentSplitMode = splitMode;
        currentPackages = Collections.unmodifiableList(new ArrayList<>(packages));
        inspectionProxy = previousInspectionProxy;
        inspectionDegradedReason = previousInspectionDegradedReason;
        runningProfileId = currentProfileId;
        updateState(STATE_RUNNING, "");
        startStatusClient();
        startAutoProbeScheduler();
        notifyRunning("重载失败，已恢复之前的配置");
    }

    private void requireFreshTun(long previousTunGeneration) throws Exception {
        synchronized (tunLock) {
            if (tunFileDescriptor == null || tunGeneration <= previousTunGeneration) {
                throw new Exception("sing-box 配置没有建立新的 Android TUN 入站");
            }
        }
    }

    private void notifyRunning(String content) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.notify(
                    NOTIFICATION_ID,
                    buildServiceNotification("SingDeck VPN 已连接", content, true)
            );
        }
    }

    private void startStatusClient() {
        if (statusClient != null) {
            return;
        }
        try {
            CommandClientOptions options = new CommandClientOptions();
            options.addCommand(Libbox.CommandStatus);
            options.addCommand(Libbox.CommandGroup);
            options.addCommand(Libbox.CommandConnections);
            options.addCommand(Libbox.CommandOutbounds);
            options.setStatusInterval(1_000_000_000L);
            CommandClient client = new CommandClient(new CoreStatusHandler(), options);
            client.connect();
            statusClient = client;
        } catch (Exception exception) {
            Log.w(TAG, "Unable to connect libbox status stream", exception);
        }
    }

    private void selectOutboundCore(String group, String outbound, long operationId) {
        if (!STATE_RUNNING.equals(serviceState)) {
            completeOperation(operationId, "sing-box 核心尚未运行");
            return;
        }
        if (group == null || group.trim().isEmpty() || outbound == null || outbound.trim().isEmpty()) {
            completeOperation(operationId, "策略组和节点名称不能为空");
            return;
        }
        try {
            io.singdeck.app.model.OutboundGroup runtimeGroup = null;
            for (io.singdeck.app.model.OutboundGroup candidate : getRuntimeSnapshot().groups) {
                if (group.equals(candidate.name)) {
                    runtimeGroup = candidate;
                    break;
                }
            }
            if (runtimeGroup == null || !"selector".equalsIgnoreCase(runtimeGroup.type)) {
                completeOperation(operationId, "只有 Selector 策略组支持手动切换");
                return;
            }
            if (!runtimeGroup.all.contains(outbound)) {
                completeOperation(operationId, "节点不属于当前策略组");
                return;
            }
            InspectorRepository inspector = InspectorRepository.getInstance(this);
            if (!NodeEligibilityPolicy.isAllowed(
                    inspector.getGroupSettings(runningProfileId, group),
                    outbound,
                    inspector.getSourceOwners(runningProfileId),
                    isRuntimeGroupTag(outbound)
            )) {
                completeOperation(operationId, "该节点不在当前策略组允许的来源范围内");
                return;
            }
            Libbox.newStandaloneCommandClient().selectOutbound(group, outbound);
            recordSelectedOutbound(group, outbound);
            completeOperation(operationId, "");
        } catch (Exception exception) {
            Log.e(TAG, "Unable to select outbound " + group + " -> " + outbound, exception);
            completeOperation(operationId, safeMessage(exception));
        }
    }

    private void urlTestCore(String outbound, long operationId) {
        if (!STATE_RUNNING.equals(serviceState)) {
            completeOperation(operationId, "sing-box 核心尚未运行");
            return;
        }
        if (outbound == null || outbound.trim().isEmpty()) {
            completeOperation(operationId, "测速目标不能为空");
            return;
        }
        try {
            Libbox.newStandaloneCommandClient().urlTest(outbound);
            completeOperation(operationId, "");
        } catch (Exception exception) {
            Log.e(TAG, "Unable to URL test outbound " + outbound, exception);
            completeOperation(operationId, safeMessage(exception));
        }
    }

    private void closeConnectionsCore(String connectionId, boolean closeAll, long operationId) {
        if (!STATE_RUNNING.equals(serviceState)) {
            completeOperation(operationId, "sing-box 核心尚未运行");
            return;
        }
        if (!closeAll && (connectionId == null || connectionId.trim().isEmpty())) {
            completeOperation(operationId, "连接 ID 不能为空");
            return;
        }
        try {
            CommandClient client = Libbox.newStandaloneCommandClient();
            if (closeAll) {
                client.closeConnections();
            } else {
                client.closeConnection(connectionId);
            }
            completeOperation(operationId, "");
        } catch (Exception exception) {
            Log.e(TAG, "Unable to close libbox connection", exception);
            completeOperation(operationId, safeMessage(exception));
        }
    }

    private OverrideOptions createOverrideOptions(String splitMode, List<String> packages) {
        OverrideOptions options = new OverrideOptions();
        options.setAutoRedirect(false);
        String normalizedMode = splitMode == null ? "global" : splitMode.trim().toLowerCase();
        if ("global".equals(normalizedMode) || "disabled".equals(normalizedMode)) {
            return options;
        }
        if (!"whitelist".equals(normalizedMode) && !"blacklist".equals(normalizedMode)) {
            throw new IllegalArgumentException("未知的分应用代理模式：" + splitMode);
        }
        Set<String> installedPackages = new LinkedHashSet<>();
        for (String packageName : packages) {
            if (packageName == null || packageName.trim().isEmpty()) {
                continue;
            }
            String normalizedPackage = packageName.trim();
            try {
                getPackageManager().getApplicationInfo(normalizedPackage, 0);
                installedPackages.add(normalizedPackage);
            } catch (PackageManager.NameNotFoundException exception) {
                Log.w(TAG, "Ignoring uninstalled split-tunnel package " + normalizedPackage);
            }
        }
        installedPackages.remove(getPackageName());
        if ("whitelist".equals(normalizedMode) && installedPackages.isEmpty()) {
            throw new IllegalArgumentException("白名单模式至少需要选择一个仍已安装的应用");
        }

        List<String> effectivePackages = new ArrayList<>(installedPackages);
        if ("whitelist".equals(normalizedMode)) {
            effectivePackages.add(getPackageName());
            options.setIncludePackage(LibboxIterators.strings(effectivePackages));
        } else {
            options.setExcludePackage(LibboxIterators.strings(effectivePackages));
        }
        return options;
    }

    @Override
    public int openTun(TunOptions options) throws Exception {
        if (VpnService.prepare(this) != null) {
            throw new Exception("Android VPN 权限尚未授予");
        }

        Builder builder = new Builder()
                .setSession("SingDeck · sing-box")
                .setMtu(options.getMTU() > 0 ? options.getMTU() : 1500);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            builder.setMetered(false);
        }

        boolean hasInet4Address = addAddresses(builder, options.getInet4Address());
        boolean hasInet6Address = addAddresses(builder, options.getInet6Address());

        if (options.getAutoRoute()) {
            StringBox dnsMode = options.getDNSMode();
            if (dnsMode == null || !Libbox.DNSModeDisabled.equals(dnsMode.getValue())) {
                StringIterator dnsServers = options.getDNSServerAddress();
                while (dnsServers != null && dnsServers.hasNext()) {
                    builder.addDnsServer(dnsServers.next());
                }
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                boolean hasInet4Routes = addExactRoutes(builder, options.getInet4RouteAddress(), false);
                boolean hasInet6Routes = addExactRoutes(builder, options.getInet6RouteAddress(), false);
                if (!hasInet4Routes && hasInet4Address) {
                    builder.addRoute("0.0.0.0", 0);
                }
                if (!hasInet6Routes && hasInet6Address) {
                    builder.addRoute("::", 0);
                }
                addExactRoutes(builder, options.getInet4RouteExcludeAddress(), true);
                addExactRoutes(builder, options.getInet6RouteExcludeAddress(), true);
            } else {
                addLegacyRoutes(builder, options.getInet4RouteRange());
                addLegacyRoutes(builder, options.getInet6RouteRange());
            }

            addApplications(builder, options.getIncludePackage(), true);
            addApplications(builder, options.getExcludePackage(), false);
        }

        systemProxyAvailable = options.isHTTPProxyEnabled() && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                && options.isHTTPProxyEnabled()
                && systemProxyEnabled) {
            applyHttpProxy(builder, options);
        }

        ParcelFileDescriptor newTun = builder.establish();
        if (newTun == null) {
            throw new Exception("Android 无法建立 VPN TUN 接口");
        }

        synchronized (tunLock) {
            ParcelFileDescriptor oldTun = tunFileDescriptor;
            tunFileDescriptor = newTun;
            tunGeneration++;
            if (oldTun != null) {
                try {
                    oldTun.close();
                } catch (IOException exception) {
                    Log.w(TAG, "Unable to close previous TUN descriptor", exception);
                }
            }
        }
        return newTun.getFd();
    }

    private static boolean addAddresses(Builder builder, RoutePrefixIterator addresses) throws Exception {
        boolean added = false;
        while (addresses != null && addresses.hasNext()) {
            RoutePrefix address = addresses.next();
            builder.addAddress(address.address(), address.prefix());
            added = true;
        }
        return added;
    }

    @RequiresApi(Build.VERSION_CODES.TIRAMISU)
    private static boolean addExactRoutes(Builder builder, RoutePrefixIterator routes, boolean exclude)
            throws Exception {
        boolean added = false;
        while (routes != null && routes.hasNext()) {
            RoutePrefix route = routes.next();
            IpPrefix prefix = new IpPrefix(InetAddress.getByName(route.address()), route.prefix());
            if (exclude) {
                builder.excludeRoute(prefix);
            } else {
                builder.addRoute(prefix);
            }
            added = true;
        }
        return added;
    }

    private static void addLegacyRoutes(Builder builder, RoutePrefixIterator routes) throws Exception {
        while (routes != null && routes.hasNext()) {
            RoutePrefix route = routes.next();
            builder.addRoute(route.address(), route.prefix());
        }
    }

    private void addApplications(Builder builder, StringIterator packages, boolean allowed) {
        while (packages != null && packages.hasNext()) {
            String packageName = packages.next();
            try {
                if (allowed) {
                    builder.addAllowedApplication(packageName);
                } else {
                    builder.addDisallowedApplication(packageName);
                }
            } catch (PackageManager.NameNotFoundException exception) {
                Log.w(TAG, "Ignoring missing split-tunnel package " + packageName);
            }
        }
    }

    private static List<String> collectStrings(StringIterator iterator) {
        List<String> values = new ArrayList<>();
        while (iterator != null && iterator.hasNext()) {
            values.add(iterator.next());
        }
        return values;
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    private static void applyHttpProxy(Builder builder, TunOptions options) {
        builder.setHttpProxy(ProxyInfo.buildDirectProxy(
                options.getHTTPProxyServer(),
                options.getHTTPProxyServerPort(),
                collectStrings(options.getHTTPProxyBypassDomain())
        ));
    }

    @Override
    public boolean protectSocket(int fileDescriptor) {
        return protect(fileDescriptor);
    }

    @Override
    public void sendCoreNotification(io.nekohasekai.libbox.Notification notification) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null || notification == null) {
            return;
        }
        manager.notify(
                coreNotificationId(notification.getIdentifier(), notification.getTypeID()),
                buildServiceNotification(
                        emptyFallback(notification.getTitle(), "SingDeck"),
                        emptyFallback(notification.getBody(), notification.getSubtitle()),
                        false
                )
        );
    }

    @Override
    public void cancelCoreNotification(String identifier, int typeId) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.cancel(coreNotificationId(identifier, typeId));
        }
    }

    @Override
    public int connectSSHAgent() throws Exception {
        throw new Exception("Android SSH agent is not supported by SingDeck");
    }

    @Override
    public SystemProxyStatus getSystemProxyStatus() {
        SystemProxyStatus status = new SystemProxyStatus();
        status.setAvailable(systemProxyAvailable);
        status.setEnabled(systemProxyEnabled);
        return status;
    }

    @Override
    public void serviceReload() {
        StartRequest request = new StartRequest(
                currentProfileId,
                currentConfig,
                currentSplitMode,
                currentPackages,
                0,
                true
        );
        coreExecutor.execute(() -> startOrReloadCore(request));
    }

    @Override
    public void serviceStop() {
        if (!closing) {
            coreExecutor.execute(() -> stopCore(true, 0));
        }
    }

    @Override
    public void setSystemProxyEnabled(boolean enabled) {
        systemProxyEnabled = enabled;
        serviceReload();
    }

    @Override
    public void triggerNativeCrash() throws Exception {
        throw new Exception("Native crash trigger is disabled");
    }

    @Override
    public void writeDebugMessage(String message) {
        Log.d(TAG, message == null ? "" : message);
    }

    private void stopCore(boolean clearError, long operationId) {
        closing = true;
        autoProbePaused = true;
        stopAutoProbeScheduler();
        updateState(STATE_STOPPING, clearError ? "" : lastError);
        closeCoreResources();
        startedAt = 0;
        uploadSpeed = 0;
        downloadSpeed = 0;
        totalUpload = 0;
        totalDownload = 0;
        currentProfileId = "";
        currentConfig = "";
        currentSplitMode = "global";
        currentPackages = Collections.emptyList();
        runningProfileId = "";
        activeOutbound = "DIRECT";
        clearRuntimeCollections();
        systemProxyAvailable = false;
        systemProxyEnabled = false;
        inspectionProxy = null;
        inspectionDegradedReason = "";
        updateState(STATE_STOPPED, clearError ? "" : lastError);
        completeOperation(operationId, "");
        stopForeground(true);
        stopSelf();
        Log.i(TAG, "sing-box service stopped");
    }

    private void failStart(String error, long operationId) {
        closing = true;
        autoProbePaused = true;
        stopAutoProbeScheduler();
        closeCoreResources();
        startedAt = 0;
        uploadSpeed = 0;
        downloadSpeed = 0;
        totalUpload = 0;
        totalDownload = 0;
        currentProfileId = "";
        currentConfig = "";
        currentSplitMode = "global";
        currentPackages = Collections.emptyList();
        runningProfileId = "";
        activeOutbound = "DIRECT";
        clearRuntimeCollections();
        systemProxyAvailable = false;
        systemProxyEnabled = false;
        inspectionProxy = null;
        inspectionDegradedReason = "";
        updateState(STATE_ERROR, emptyFallback(error, "sing-box 启动失败"));
        completeOperation(operationId, lastError);
        stopForeground(true);
        stopSelf();
    }

    private void closeCoreResources() {
        CommandClient client = statusClient;
        statusClient = null;
        if (client != null) {
            try {
                client.disconnect();
            } catch (Exception exception) {
                Log.w(TAG, "Unable to disconnect status client", exception);
            }
        }

        CommandServer server = commandServer;
        commandServer = null;
        if (server != null) {
            try {
                server.closeService();
            } catch (Exception exception) {
                Log.w(TAG, "Unable to close sing-box service", exception);
            }
            try {
                server.close();
            } catch (Throwable throwable) {
                Log.w(TAG, "Unable to close command server", throwable);
            }
        }

        synchronized (tunLock) {
            if (tunFileDescriptor != null) {
                try {
                    tunFileDescriptor.close();
                } catch (IOException exception) {
                    Log.w(TAG, "Unable to close TUN descriptor", exception);
                }
                tunFileDescriptor = null;
            }
        }

        if (platformInterface != null) {
            platformInterface.close();
            platformInterface = null;
        }
    }

    @Override
    public void onDestroy() {
        closing = true;
        autoProbePaused = true;
        stopAutoProbeScheduler();
        closeCoreResources();
        coreExecutor.shutdownNow();
        startedAt = 0;
        uploadSpeed = 0;
        downloadSpeed = 0;
        totalUpload = 0;
        totalDownload = 0;
        currentProfileId = "";
        currentConfig = "";
        currentSplitMode = "global";
        currentPackages = Collections.emptyList();
        runningProfileId = "";
        activeOutbound = "DIRECT";
        clearRuntimeCollections();
        systemProxyAvailable = false;
        systemProxyEnabled = false;
        inspectionProxy = null;
        inspectionDegradedReason = "";
        if (!STATE_ERROR.equals(serviceState)) {
            updateState(STATE_STOPPED, "");
        }
        super.onDestroy();
    }

    private StartRequest readStartRequest(Intent intent) {
        String profileId = intent.getStringExtra(EXTRA_PROFILE_ID);
        String splitMode = intent.getStringExtra(EXTRA_SPLIT_MODE);
        if (splitMode == null || splitMode.trim().isEmpty()) {
            splitMode = SplitTunnelManager.getInstance(this).getMode();
        }
        ArrayList<String> packages = intent.getStringArrayListExtra(EXTRA_PACKAGES);
        if (packages == null) {
            packages = SplitTunnelManager.getInstance(this).getSelectedPackagesList();
        }
        long operationId = intent.getLongExtra(EXTRA_OPERATION_ID, 0);
        return new StartRequest(profileId, null, splitMode, packages, operationId, false);
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "SingDeck VPN 运行状态",
                NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("显示 SingDeck 后台 sing-box VPN 状态");
        channel.setShowBadge(false);
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.createNotificationChannel(channel);
        }
    }

    private android.app.Notification buildServiceNotification(String title, String content, boolean ongoing) {
        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent launchPendingIntent = PendingIntent.getActivity(
                this,
                0,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_lock_lock)
                .setContentTitle(title)
                .setContentText(emptyFallback(content, "sing-box"))
                .setContentIntent(launchPendingIntent)
                .setOngoing(ongoing)
                .setOnlyAlertOnce(true)
                .setPriority(NotificationCompat.PRIORITY_LOW);

        if (ongoing) {
            Intent stopIntent = new Intent(this, SingDeckVpnService.class).setAction(ACTION_STOP);
            PendingIntent stopPendingIntent = PendingIntent.getService(
                    this,
                    1,
                    stopIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
            builder.addAction(
                    android.R.drawable.ic_menu_close_clear_cancel,
                    "断开连接",
                    stopPendingIntent
            );
        }
        return builder.build();
    }

    private static void updateState(String state, String error) {
        serviceState = state;
        lastError = error == null ? "" : error;
    }

    private static void clearRuntimeCollections() {
        synchronized (RUNTIME_SNAPSHOT_LOCK) {
            GROUP_SELECTION_RECONCILER.clear();
            runtimeGroups = Collections.emptyList();
            runtimeNodes = Collections.emptyMap();
            runtimeConnections = Collections.emptyList();
            runtimeUpdatedAt = System.currentTimeMillis();
        }
    }

    private static void completeOperation(long operationId, String error) {
        if (operationId <= 0) {
            return;
        }
        OPERATION_RESULTS.put(operationId, error == null || error.isEmpty() ? OPERATION_OK : error);
    }

    private static int coreNotificationId(String identifier, int typeId) {
        int identifierHash = identifier == null ? 0 : identifier.hashCode();
        return 2000 + Math.abs(31 * identifierHash + typeId) % 100000;
    }

    private static String emptyFallback(String value, String fallback) {
        return value == null || value.trim().isEmpty() ? fallback : value;
    }

    private static String safeMessage(Throwable throwable) {
        return emptyFallback(throwable.getMessage(), throwable.getClass().getSimpleName());
    }

    private synchronized void startAutoProbeScheduler() {
        if (autoProbeScheduler != null && !autoProbeScheduler.isShutdown()) {
            return;
        }
        autoProbeScheduler = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "SingDeck-AutoProbe");
            thread.setDaemon(true);
            return thread;
        });
        autoProbeScheduler.scheduleWithFixedDelay(
                this::runAutoProbeTick,
                10,
                30,
                TimeUnit.SECONDS
        );
    }

    private synchronized void stopAutoProbeScheduler() {
        ScheduledExecutorService scheduler = autoProbeScheduler;
        autoProbeScheduler = null;
        if (scheduler != null) {
            scheduler.shutdownNow();
        }
    }

    private void runAutoProbeTick() {
        if (autoProbePaused || closing || !STATE_RUNNING.equals(serviceState)) {
            return;
        }
        String profileId = runningProfileId;
        if (profileId == null || profileId.isEmpty()) {
            return;
        }
        try {
            InspectorRepository repository = InspectorRepository.getInstance(this);
            CoreRuntimeSnapshot snapshot = getRuntimeSnapshot();
            Set<String> nestedGroups = new LinkedHashSet<>();
            for (io.singdeck.app.model.OutboundGroup group : snapshot.groups) {
                nestedGroups.add(group.name);
            }
            Map<String, String> owners = repository.getSourceOwners(profileId);
            for (io.singdeck.app.model.OutboundGroup group : snapshot.groups) {
                if (autoProbePaused || Thread.currentThread().isInterrupted()) {
                    return;
                }
                MobileBootstrap.GroupSettings settings = repository.getGroupSettings(
                        profileId,
                        group.name
                );
                if (!settings.autoProbe) {
                    continue;
                }
                long now = System.currentTimeMillis();
                if (!repository.tryClaimAutoProbe(
                        profileId,
                        group.name,
                        now,
                        Math.max(60, settings.probeIntervalSec) * 1_000L
                )) {
                    continue;
                }
                List<String> eligible = new ArrayList<>();
                for (String node : group.all) {
                    if (NodeEligibilityPolicy.isAllowed(
                            settings,
                            node,
                            owners,
                            nestedGroups.contains(node)
                    )) {
                        eligible.add(node);
                    }
                }
                for (String node : eligible) {
                    if (autoProbePaused || Thread.currentThread().isInterrupted()) {
                        return;
                    }
                    try {
                        NativeInspectionEngine.inspectNode(
                                getApplicationContext(),
                                profileId,
                                group.name,
                                node,
                                false,
                                false
                        );
                    } catch (Exception error) {
                        Log.w(TAG, "Scheduled node probe failed for " + group.name);
                    }
                }
                if (settings.autoSwitch
                        && "selector".equalsIgnoreCase(group.type)
                        && !eligible.isEmpty()) {
                    List<ProbeScoringEngine.NodeScore> scores = repository.getScores(
                            profileId,
                            group.name,
                            eligible,
                            System.currentTimeMillis()
                    );
                    for (ProbeScoringEngine.NodeScore score : scores) {
                        if (score.success) {
                            Libbox.newStandaloneCommandClient().selectOutbound(group.name, score.node);
                            recordSelectedOutbound(group.name, score.node);
                            break;
                        }
                    }
                }
            }
        } catch (Throwable error) {
            Log.w(TAG, "Scheduled Inspector tick failed");
        }
    }

    private static final class StartRequest {
        private final String profileId;
        private final String configOverride;
        private final String splitMode;
        private final List<String> packages;
        private final long operationId;
        private final boolean configAlreadyEnhanced;

        private StartRequest(
                String profileId,
                String configOverride,
                String splitMode,
                List<String> packages,
                long operationId,
                boolean configAlreadyEnhanced
        ) {
            this.profileId = profileId == null ? "" : profileId;
            this.configOverride = configOverride;
            this.splitMode = splitMode == null ? "global" : splitMode;
            this.packages = packages == null ? Collections.emptyList() : new ArrayList<>(packages);
            this.operationId = operationId;
            this.configAlreadyEnhanced = configAlreadyEnhanced;
        }
    }

    private final class CoreStatusHandler implements CommandClientHandler {
        private final Object connectionLock = new Object();
        private final Connections connections = Libbox.newConnections();

        @Override
        public void clearLogs() {}

        @Override
        public void connected() {
            Log.d(TAG, "libbox status stream connected");
        }

        @Override
        public void disconnected(String message) {
            Log.d(TAG, "libbox status stream disconnected: " + message);
        }

        @Override
        public void initializeClashMode(StringIterator modes, String currentMode) {}

        @Override
        public void setDefaultLogLevel(int level) {}

        @Override
        public void updateClashMode(String newMode) {}

        @Override
        public void writeConnectionEvents(ConnectionEvents events) {
            if (events == null) {
                return;
            }
            List<ConnectionItem> snapshot = new ArrayList<>();
            synchronized (connectionLock) {
                connections.applyEvents(events);
                connections.filterState((int) Libbox.ConnectionStateActive);
                connections.sortByDate();
                ConnectionIterator iterator = connections.iterator();
                while (iterator != null && iterator.hasNext()) {
                    Connection connection = iterator.next();
                    if (connection == null) {
                        continue;
                    }
                    if (RuntimeConfigOverlay.isHiddenTag(connection.getInbound())) {
                        continue;
                    }
                    String host;
                    try {
                        host = connection.displayDestination();
                    } catch (Throwable ignored) {
                        host = emptyFallback(connection.getDomain(), connection.getDestination());
                    }
                    String outbound = emptyFallback(connection.getOutbound(), "DIRECT");
                    List<String> chainValues = collectStrings(connection.chain());
                    String chain = chainValues.isEmpty()
                            ? outbound
                            : joinStrings(chainValues, " ➔ ");
                    ConnectionItem item = new ConnectionItem(
                            connection.getID(),
                            host,
                            outbound,
                            chain
                    );
                    item.source = connection.getSource();
                    item.inbound = connection.getInbound();
                    item.network = connection.getNetwork();
                    item.protocol = connection.getProtocol();
                    item.uploadSpeed = connection.getUplink();
                    item.downloadSpeed = connection.getDownlink();
                    item.uploadBytes = connection.getUplinkTotal();
                    item.downloadBytes = connection.getDownlinkTotal();
                    item.startedAt = connection.getCreatedAt();
                    if (connection.getProcessInfo() != null) {
                        List<String> packageNames = collectStrings(
                                connection.getProcessInfo().packageNames()
                        );
                        item.process = !packageNames.isEmpty()
                                ? packageNames.get(0)
                                : connection.getProcessInfo().getProcessPath();
                    }
                    snapshot.add(item);
                }
            }
            synchronized (RUNTIME_SNAPSHOT_LOCK) {
                runtimeConnections = snapshot;
                runtimeUpdatedAt = System.currentTimeMillis();
            }
        }

        @Override
        public void writeGroups(OutboundGroupIterator groups) {
            List<io.singdeck.app.model.OutboundGroup> groupSnapshot = new ArrayList<>();
            Map<String, NodeItem> nodeSnapshot = new LinkedHashMap<>();
            while (groups != null && groups.hasNext()) {
                OutboundGroup group = groups.next();
                if (group == null) {
                    continue;
                }
                if (RuntimeConfigOverlay.isHiddenTag(group.getTag())) {
                    continue;
                }
                List<String> members = new ArrayList<>();
                OutboundGroupItemIterator items = group.getItems();
                while (items != null && items.hasNext()) {
                    OutboundGroupItem item = items.next();
                    if (item == null
                            || item.getTag() == null
                            || item.getTag().isEmpty()
                            || RuntimeConfigOverlay.isHiddenTag(item.getTag())) {
                        continue;
                    }
                    members.add(item.getTag());
                    nodeSnapshot.put(item.getTag(), nodeFromRuntime(item));
                }
                String selected = group.getSelected() == null ? "" : group.getSelected();
                groupSnapshot.add(new io.singdeck.app.model.OutboundGroup(
                        group.getTag(),
                        group.getType(),
                        selected,
                        members
                ));
            }
            synchronized (RUNTIME_SNAPSHOT_LOCK) {
                List<io.singdeck.app.model.OutboundGroup> reconciledGroups =
                        GROUP_SELECTION_RECONCILER.reconcileStream(
                                groupSnapshot,
                                System.currentTimeMillis()
                        );
                for (io.singdeck.app.model.OutboundGroup group : reconciledGroups) {
                    if ("selector".equalsIgnoreCase(group.type)
                            && group.now != null
                            && !group.now.isEmpty()) {
                        activeOutbound = group.now;
                        break;
                    }
                }
                runtimeGroups = reconciledGroups;
                runtimeNodes = nodeSnapshot;
                runtimeUpdatedAt = System.currentTimeMillis();
            }
        }

        @Override
        public void writeLogs(LogIterator logs) {}

        @Override
        public void writeOutbounds(OutboundGroupItemIterator outbounds) {
            Map<String, NodeItem> outboundSnapshot = new LinkedHashMap<>();
            while (outbounds != null && outbounds.hasNext()) {
                OutboundGroupItem item = outbounds.next();
                if (item != null
                        && item.getTag() != null
                        && !item.getTag().isEmpty()
                        && !RuntimeConfigOverlay.isHiddenTag(item.getTag())) {
                    outboundSnapshot.put(item.getTag(), nodeFromRuntime(item));
                }
            }
            synchronized (RUNTIME_SNAPSHOT_LOCK) {
                Map<String, NodeItem> merged = new LinkedHashMap<>(runtimeNodes);
                merged.putAll(outboundSnapshot);
                runtimeNodes = merged;
                runtimeUpdatedAt = System.currentTimeMillis();
            }
        }

        @Override
        public void writeStatus(StatusMessage message) {
            if (message == null || !message.getTrafficAvailable()) {
                return;
            }
            uploadSpeed = message.getUplink();
            downloadSpeed = message.getDownlink();
            totalUpload = message.getUplinkTotal();
            totalDownload = message.getDownlinkTotal();
            synchronized (RUNTIME_SNAPSHOT_LOCK) {
                runtimeUpdatedAt = System.currentTimeMillis();
            }
        }

        private NodeItem nodeFromRuntime(OutboundGroupItem item) {
            NodeItem node = new NodeItem(item.getTag(), item.getType());
            if (item.getURLTestTime() > 0) {
                node.lastTestedAt = item.getURLTestTime();
                if (item.getURLTestDelay() > 0) {
                    node.delay = item.getURLTestDelay();
                }
            }
            return node;
        }

        private String joinStrings(List<String> values, String separator) {
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
}
