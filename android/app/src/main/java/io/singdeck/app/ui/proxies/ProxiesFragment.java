package io.singdeck.app.ui.proxies;

import android.app.AlertDialog;
import android.app.Dialog;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ArrayAdapter;
import android.widget.AdapterView;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.fragment.app.Fragment;
import androidx.recyclerview.widget.GridLayoutManager;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import com.google.android.material.bottomsheet.BottomSheetBehavior;
import com.google.android.material.bottomsheet.BottomSheetDialog;
import com.google.android.material.materialswitch.MaterialSwitch;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonParser;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import io.singdeck.app.R;
import io.singdeck.app.SingDeckVpnService;
import io.singdeck.app.manager.InspectorRepository;
import io.singdeck.app.manager.GeminiLocationInspector;
import io.singdeck.app.manager.NativeInspectionEngine;
import io.singdeck.app.manager.NodeEligibilityPolicy;
import io.singdeck.app.manager.ProbeScoringEngine;
import io.singdeck.app.manager.ProfileManager;
import io.singdeck.app.manager.RuntimeConfigOverlay;
import io.singdeck.app.model.CoreRuntimeSnapshot;
import io.singdeck.app.model.MobileBootstrap;
import io.singdeck.app.model.NodeItem;
import io.singdeck.app.model.OutboundGroup;

public class ProxiesFragment extends Fragment {
    private RecyclerView rvGroupTabs;
    private TextView tvActiveGroupTitle;
    private TextView tvActiveGroupType;
    private TextView tvCurActiveNode;
    private Button btnTestAllNodes;
    private EditText etSearchNodes;
    private ImageButton btnToggleLayout;
    private ImageButton btnSortNodes;
    private ImageButton btnRefreshProxies;
    private ImageButton btnOpenInspector;
    private SwipeRefreshLayout swipeRefresh;
    private RecyclerView rvNodesGrid;
    private FrameLayout inspectorSideHost;

    private GroupTabAdapter groupTabAdapter;
    private NodeAdapter nodeAdapter;
    private ProfileManager profileManager;
    private InspectorRepository inspectorRepository;
    private ProfileManager.OnProfileChangeListener profileChangeListener;
    private final Handler runtimeHandler = new Handler(Looper.getMainLooper());
    private final Set<String> testingNodes = new HashSet<>();
    private final Map<String, Long> testStartedAt = new HashMap<>();

    private String selectedGroupName = "";
    private boolean isGridLayout = true;
    private int sortMode;
    private boolean viewActive;
    private ExecutorService inspectorExecutor;
    private View inspectorPanel;
    private BottomSheetDialog inspectorSheet;
    private String inspectedNodeName = "";
    private final Gson prettyGson = new GsonBuilder().setPrettyPrinting().create();

    private static final int[] SOURCE_COLORS = {
            Color.rgb(3, 105, 161),
            Color.rgb(5, 122, 85),
            Color.rgb(126, 34, 206),
            Color.rgb(180, 83, 9),
            Color.rgb(190, 24, 93),
            Color.rgb(13, 116, 144),
            Color.rgb(67, 56, 202),
            Color.rgb(71, 85, 105)
    };

    @Nullable
    @Override
    public View onCreateView(
            @NonNull LayoutInflater inflater,
            @Nullable ViewGroup container,
            @Nullable Bundle savedInstanceState
    ) {
        View view = inflater.inflate(R.layout.fragment_proxies, container, false);
        viewActive = true;
        rvGroupTabs = view.findViewById(R.id.rv_group_tabs);
        tvActiveGroupTitle = view.findViewById(R.id.tv_active_group_title);
        tvActiveGroupType = view.findViewById(R.id.tv_active_group_type);
        tvCurActiveNode = view.findViewById(R.id.tv_cur_active_node);
        btnTestAllNodes = view.findViewById(R.id.btn_test_all_nodes);
        etSearchNodes = view.findViewById(R.id.et_search_nodes);
        btnToggleLayout = view.findViewById(R.id.btn_toggle_layout);
        btnSortNodes = view.findViewById(R.id.btn_sort_nodes);
        btnRefreshProxies = view.findViewById(R.id.btn_refresh_proxies);
        btnOpenInspector = view.findViewById(R.id.btn_open_inspector);
        swipeRefresh = view.findViewById(R.id.swipe_refresh);
        rvNodesGrid = view.findViewById(R.id.rv_nodes_grid);
        inspectorSideHost = view.findViewById(R.id.inspector_side_host);

        profileManager = ProfileManager.getInstance(requireContext());
        inspectorRepository = InspectorRepository.getInstance(requireContext());
        inspectorExecutor = Executors.newSingleThreadExecutor(runnable -> {
            Thread thread = new Thread(runnable, "SingDeck-Inspector");
            thread.setDaemon(true);
            return thread;
        });
        rvGroupTabs.setLayoutManager(new LinearLayoutManager(
                requireContext(),
                LinearLayoutManager.HORIZONTAL,
                false
        ));
        groupTabAdapter = new GroupTabAdapter(group -> {
            selectedGroupName = group.name;
            inspectedNodeName = group.now == null || group.now.isEmpty()
                    ? (group.all.isEmpty() ? "" : group.all.get(0))
                    : group.now;
            updateGroupData();
            if (inspectorPanel != null) {
                bindInspectorPanel(inspectorPanel, inspectorSheet != null);
            }
        });
        rvGroupTabs.setAdapter(groupTabAdapter);

        updateLayoutManager();
        nodeAdapter = new NodeAdapter(new NodeAdapter.OnNodeClickListener() {
            @Override
            public void onNodeClick(NodeItem node) {
                requestSwitch(node);
            }

            @Override
            public void onTestNode(NodeItem node) {
                runConnectivityProbe(node.name);
            }

            @Override
            public void onNodeLongClick(NodeItem node) {
                inspectedNodeName = node.name;
                showInspector();
            }
        });
        rvNodesGrid.setAdapter(nodeAdapter);

        btnToggleLayout.setOnClickListener(view1 -> {
            isGridLayout = !isGridLayout;
            updateLayoutManager();
        });
        btnSortNodes.setOnClickListener(view12 -> {
            sortMode = (sortMode + 1) % 3;
            updateGroupData();
            String message = sortMode == 1
                    ? "按延迟最低排序"
                    : sortMode == 2 ? "按名称字母排序" : "默认配置顺序";
            Toast.makeText(requireContext(), message, Toast.LENGTH_SHORT).show();
        });
        btnRefreshProxies.setOnClickListener(view13 -> updateGroupData());
        btnOpenInspector.setOnClickListener(view13 -> showInspector());
        swipeRefresh.setOnRefreshListener(() -> {
            updateGroupData();
            swipeRefresh.setRefreshing(false);
        });
        btnTestAllNodes.setOnClickListener(view14 -> testAllCurrentNodes());
        etSearchNodes.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence value, int start, int count, int after) {
            }

            @Override
            public void onTextChanged(CharSequence value, int start, int before, int count) {
                updateGroupData();
            }

            @Override
            public void afterTextChanged(Editable value) {
            }
        });

        profileChangeListener = this::updateGroupData;
        profileManager.addListener(profileChangeListener);
        updateGroupData();
        if (getResources().getConfiguration().smallestScreenWidthDp >= 600) {
            inspectorSideHost.setVisibility(View.VISIBLE);
            inspectorPanel = inflater.inflate(
                    R.layout.panel_proxies_inspector,
                    inspectorSideHost,
                    false
            );
            inspectorSideHost.addView(inspectorPanel);
            inspectorPanel.findViewById(R.id.btn_close_inspector).setVisibility(View.GONE);
            bindInspectorPanel(inspectorPanel, false);
        }
        runtimeHandler.post(runtimePoller);
        return view;
    }

    @Override
    public void onResume() {
        super.onResume();
        updateGroupData();
    }

    @Override
    public void onDestroyView() {
        viewActive = false;
        if (profileManager != null && profileChangeListener != null) {
            profileManager.removeListener(profileChangeListener);
        }
        runtimeHandler.removeCallbacksAndMessages(null);
        if (inspectorSheet != null) {
            inspectorSheet.dismiss();
            inspectorSheet = null;
        }
        inspectorPanel = null;
        if (inspectorExecutor != null) {
            inspectorExecutor.shutdownNow();
            inspectorExecutor = null;
        }
        super.onDestroyView();
    }

    private final Runnable runtimePoller = new Runnable() {
        @Override
        public void run() {
            if (!isAdded() || !viewActive) {
                return;
            }
            updateGroupData();
            runtimeHandler.postDelayed(this, 750);
        }
    };

    private void updateLayoutManager() {
        if (isGridLayout) {
            rvNodesGrid.setLayoutManager(new GridLayoutManager(requireContext(), 2));
        } else {
            rvNodesGrid.setLayoutManager(new LinearLayoutManager(requireContext()));
        }
    }

    private void updateGroupData() {
        if (!isAdded() || !viewActive) {
            return;
        }
        CoreRuntimeSnapshot runtime = SingDeckVpnService.getRuntimeSnapshot();
        boolean running = SingDeckVpnService.STATE_RUNNING.equals(runtime.state);
        List<OutboundGroup> groups = running
                ? runtime.groups
                : profileManager.getCachedGroups();
        Map<String, NodeItem> nodes = running
                ? runtime.nodes
                : profileManager.getCachedNodes();

        if (groups.isEmpty()) {
            groupTabAdapter.updateData(new ArrayList<>(), "");
            nodeAdapter.updateData(new ArrayList<>(), "");
            tvActiveGroupTitle.setText(running ? "等待 libbox 策略组" : "无可用出站策略组");
            tvActiveGroupType.setText(running ? "Runtime" : "Preview");
            tvCurActiveNode.setText(running ? "正在同步核心状态…" : "请先添加并激活配置文件");
            btnTestAllNodes.setEnabled(false);
            return;
        }

        if (selectedGroupName.isEmpty() || !hasGroup(groups, selectedGroupName)) {
            selectedGroupName = groups.get(0).name;
        }
        groupTabAdapter.updateData(groups, selectedGroupName);

        OutboundGroup currentGroup = getGroup(groups, selectedGroupName);
        if (currentGroup == null) {
            return;
        }
        tvActiveGroupTitle.setText(currentGroup.name);
        tvActiveGroupType.setText(currentGroup.type);
        String activeNode = currentGroup.now != null && !currentGroup.now.isEmpty()
                ? currentGroup.now
                : (!currentGroup.all.isEmpty() ? currentGroup.all.get(0) : "DIRECT");
        if (inspectedNodeName.isEmpty() || !currentGroup.all.contains(inspectedNodeName)) {
            inspectedNodeName = activeNode;
        }
        tvCurActiveNode.setText(
                running ? "核心当前生效: " + activeNode : "配置预览: " + activeNode + "（未连接）"
        );

        String profileId = profileManager.getActiveProfileId();
        Map<String, String> sourceOwners = Collections.emptyMap();
        Map<String, Integer> sourceColors = Collections.emptyMap();
        MobileBootstrap.GroupSettings groupSettings = null;
        Map<String, ProbeScoringEngine.NodeScore> scoreByNode = new HashMap<>();
        if (profileId != null && !profileId.isEmpty()) {
            try {
                sourceOwners = inspectorRepository.getSourceOwners(profileId);
                sourceColors = new LinkedHashMap<>();
                for (InspectorRepository.SourceState source
                        : inspectorRepository.getNodeSources(profileId)) {
                    sourceColors.put(
                            source.name,
                            SOURCE_COLORS[Math.floorMod(source.colorIndex, SOURCE_COLORS.length)]
                    );
                }
                groupSettings = inspectorRepository.getGroupSettings(profileId, currentGroup.name);
                for (ProbeScoringEngine.NodeScore score : inspectorRepository.getScores(
                        profileId,
                        currentGroup.name,
                        currentGroup.all,
                        System.currentTimeMillis()
                )) {
                    scoreByNode.put(score.node, score);
                }
            } catch (RuntimeException ignored) {
                // A profile import can atomically replace Inspector rows while this screen polls.
            }
        }
        Set<String> groupNames = new HashSet<>();
        for (OutboundGroup group : groups) {
            groupNames.add(group.name);
        }

        String query = etSearchNodes.getText().toString().trim().toLowerCase(Locale.ROOT);
        List<NodeItem> memberNodes = new ArrayList<>();
        long now = System.currentTimeMillis();
        for (String nodeTag : currentGroup.all) {
            NodeItem source = nodes.get(nodeTag);
            NodeItem node = source == null
                    ? new NodeItem(nodeTag, "OUTBOUND")
                    : new NodeItem(source);
            String searchable = (node.name + " " + node.type + " "
                    + (node.server == null ? "" : node.server)).toLowerCase(Locale.ROOT);
            if (!query.isEmpty() && !searchable.contains(query)) {
                continue;
            }
            node.sourceName = sourceOwners.getOrDefault(nodeTag, "");
            node.sourceColor = sourceColors.getOrDefault(node.sourceName, SOURCE_COLORS[7]);
            node.sourceEligible = NodeEligibilityPolicy.isAllowed(
                    groupSettings,
                    nodeTag,
                    sourceOwners,
                    groupNames.contains(nodeTag)
            );
            ProbeScoringEngine.NodeScore score = scoreByNode.get(nodeTag);
            if (score != null) {
                node.score = score.score;
                if (node.delay == null) {
                    node.delay = score.delayMs;
                }
            }
            Long started = testStartedAt.get(nodeTag);
            if (started != null && node.lastTestedAt >= started) {
                testingNodes.remove(nodeTag);
                testStartedAt.remove(nodeTag);
            } else if (started != null && now - started > 20_000) {
                testingNodes.remove(nodeTag);
                testStartedAt.remove(nodeTag);
            }
            node.isTesting = testingNodes.contains(nodeTag);
            memberNodes.add(node);
        }

        if (sortMode == 1) {
            Collections.sort(memberNodes, (left, right) -> Integer.compare(
                    left.delay == null ? Integer.MAX_VALUE : left.delay,
                    right.delay == null ? Integer.MAX_VALUE : right.delay
            ));
        } else if (sortMode == 2) {
            Collections.sort(memberNodes, (left, right) ->
                    left.name.compareToIgnoreCase(right.name));
        }
        nodeAdapter.updateData(memberNodes, activeNode);
        btnTestAllNodes.setEnabled(running && testingNodes.isEmpty());
        btnTestAllNodes.setText(testingNodes.isEmpty() ? "⚡ 一键测速" : "测速中…");
    }

    private void requestSwitch(NodeItem node) {
        if (!SingDeckVpnService.isVpnRunning()) {
            Toast.makeText(requireContext(), "启动 VPN 后才能切换运行节点", Toast.LENGTH_SHORT).show();
            return;
        }
        if (selectedGroupName.isEmpty()) {
            Toast.makeText(requireContext(), "没有可切换的策略组", Toast.LENGTH_SHORT).show();
            return;
        }
        OutboundGroup runtimeGroup = getGroup(
                SingDeckVpnService.getRuntimeSnapshot().groups,
                selectedGroupName
        );
        if (runtimeGroup == null || !"selector".equalsIgnoreCase(runtimeGroup.type)) {
            Toast.makeText(
                    requireContext(),
                    "URLTest / Fallback 由 sing-box 原生管理",
                    Toast.LENGTH_SHORT
            ).show();
            return;
        }
        if (!runtimeGroup.all.contains(node.name)) {
            Toast.makeText(requireContext(), "节点不属于当前策略组", Toast.LENGTH_SHORT).show();
            return;
        }
        String profileId = profileManager.getActiveProfileId();
        if (profileId != null && !profileId.isEmpty()) {
            MobileBootstrap.GroupSettings settings = inspectorRepository.getGroupSettings(
                    profileId,
                    selectedGroupName
            );
            boolean nested = hasGroup(
                    SingDeckVpnService.getRuntimeSnapshot().groups,
                    node.name
            );
            if (!NodeEligibilityPolicy.isAllowed(
                    settings,
                    node.name,
                    inspectorRepository.getSourceOwners(profileId),
                    nested
            )) {
                Toast.makeText(
                        requireContext(),
                        "该节点不在当前策略组允许的来源范围内",
                        Toast.LENGTH_SHORT
                ).show();
                return;
            }
        }
        long operationId = SingDeckVpnService.newOperationId();
        Intent intent = new Intent(requireContext(), SingDeckVpnService.class)
                .setAction(SingDeckVpnService.ACTION_SELECT_OUTBOUND)
                .putExtra(SingDeckVpnService.EXTRA_GROUP, selectedGroupName)
                .putExtra(SingDeckVpnService.EXTRA_OUTBOUND, node.name)
                .putExtra(SingDeckVpnService.EXTRA_OPERATION_ID, operationId);
        requireContext().startService(intent);
        awaitOperation(operationId, "切换出站", () -> {
            updateGroupData();
            Toast.makeText(
                    requireContext(),
                    "已切换出站: " + node.name,
                    Toast.LENGTH_SHORT
            ).show();
        });
    }

    private void requestUrlTest(String target, List<String> affectedNodes) {
        if (!SingDeckVpnService.isVpnRunning()) {
            Toast.makeText(requireContext(), "启动 VPN 后才能执行真实测速", Toast.LENGTH_SHORT).show();
            return;
        }
        long started = System.currentTimeMillis();
        for (String node : affectedNodes) {
            testingNodes.add(node);
            testStartedAt.put(node, started);
        }
        updateGroupData();

        long operationId = SingDeckVpnService.newOperationId();
        Intent intent = new Intent(requireContext(), SingDeckVpnService.class)
                .setAction(SingDeckVpnService.ACTION_URL_TEST)
                .putExtra(SingDeckVpnService.EXTRA_OUTBOUND, target)
                .putExtra(SingDeckVpnService.EXTRA_OPERATION_ID, operationId);
        requireContext().startService(intent);
        awaitOperation(operationId, "测速", this::updateGroupData);
    }

    private void testAllCurrentNodes() {
        CoreRuntimeSnapshot runtime = SingDeckVpnService.getRuntimeSnapshot();
        OutboundGroup currentGroup = getGroup(runtime.groups, selectedGroupName);
        if (currentGroup == null || currentGroup.all.isEmpty()) {
            Toast.makeText(requireContext(), "当前没有可测速节点", Toast.LENGTH_SHORT).show();
            return;
        }
        String profileId = profileManager.getActiveProfileId();
        if (profileId == null || profileId.isEmpty() || !SingDeckVpnService.isVpnRunning()) {
            Toast.makeText(requireContext(), "请先激活配置并启动 VPN", Toast.LENGTH_SHORT).show();
            return;
        }
        Set<String> nestedGroups = new HashSet<>();
        for (OutboundGroup group : runtime.groups) {
            nestedGroups.add(group.name);
        }
        MobileBootstrap.GroupSettings settings = inspectorRepository.getGroupSettings(
                profileId,
                selectedGroupName
        );
        Map<String, String> owners = inspectorRepository.getSourceOwners(profileId);
        List<String> eligible = new ArrayList<>();
        for (String node : currentGroup.all) {
            if (NodeEligibilityPolicy.isAllowed(
                    settings,
                    node,
                    owners,
                    nestedGroups.contains(node)
            )) {
                eligible.add(node);
            }
        }
        if (eligible.isEmpty()) {
            Toast.makeText(requireContext(), "来源限制后没有可检测节点", Toast.LENGTH_SHORT).show();
            return;
        }
        runGroupConnectivityProbe(profileId, currentGroup, eligible, settings);
    }

    private void runConnectivityProbe(String nodeName) {
        if (!SingDeckVpnService.isVpnRunning()) {
            Toast.makeText(requireContext(), "启动 VPN 后才能执行真实测速", Toast.LENGTH_SHORT).show();
            return;
        }
        String profileId = profileManager.getActiveProfileId();
        if (profileId == null || profileId.isEmpty() || selectedGroupName.isEmpty()) {
            Toast.makeText(requireContext(), "没有已激活的策略组", Toast.LENGTH_SHORT).show();
            return;
        }
        testingNodes.add(nodeName);
        testStartedAt.put(nodeName, System.currentTimeMillis());
        updateGroupData();
        String groupName = selectedGroupName;
        android.content.Context appContext = requireContext().getApplicationContext();
        inspectorExecutor.execute(() -> {
            String error = null;
            try {
                NativeInspectionEngine.inspectNode(
                        appContext,
                        profileId,
                        groupName,
                        nodeName,
                        false,
                        false
                );
            } catch (Exception failure) {
                error = safeMessage(failure);
            }
            String finalError = error;
            runtimeHandler.post(() -> {
                testingNodes.remove(nodeName);
                testStartedAt.remove(nodeName);
                if (isAdded() && finalError != null) {
                    Toast.makeText(requireContext(), "测速失败: " + finalError, Toast.LENGTH_LONG).show();
                }
                updateGroupData();
            });
        });
    }

    private void runGroupConnectivityProbe(
            String profileId,
            OutboundGroup group,
            List<String> nodes,
            MobileBootstrap.GroupSettings settings
    ) {
        long started = System.currentTimeMillis();
        for (String node : nodes) {
            testingNodes.add(node);
            testStartedAt.put(node, started);
        }
        updateGroupData();
        android.content.Context appContext = requireContext().getApplicationContext();
        inspectorExecutor.execute(() -> {
            int failures = 0;
            for (String node : nodes) {
                if (Thread.currentThread().isInterrupted()) {
                    return;
                }
                try {
                    NativeInspectionEngine.inspectNode(
                            appContext,
                            profileId,
                            group.name,
                            node,
                            false,
                            false
                    );
                } catch (Exception ignored) {
                    failures++;
                }
            }
            int finalFailures = failures;
            runtimeHandler.post(() -> {
                testingNodes.removeAll(nodes);
                for (String node : nodes) {
                    testStartedAt.remove(node);
                }
                updateGroupData();
                if (!isAdded()) {
                    return;
                }
                Toast.makeText(
                        requireContext(),
                        finalFailures == 0
                                ? "已完成 " + nodes.size() + " 个节点的真实检测"
                                : "检测完成，" + finalFailures + " 个节点失败",
                        Toast.LENGTH_LONG
                ).show();
                if (settings.autoSwitch && "selector".equalsIgnoreCase(group.type)) {
                    List<ProbeScoringEngine.NodeScore> scores = inspectorRepository.getScores(
                            profileId,
                            group.name,
                            nodes,
                            System.currentTimeMillis()
                    );
                    for (ProbeScoringEngine.NodeScore score : scores) {
                        if (score.success) {
                            requestSwitch(new NodeItem(score.node, "OUTBOUND"));
                            break;
                        }
                    }
                }
            });
        });
    }

    private void showInspector() {
        if (!isAdded()) {
            return;
        }
        if (getResources().getConfiguration().smallestScreenWidthDp >= 600) {
            inspectorSideHost.setVisibility(View.VISIBLE);
            if (inspectorPanel != null) {
                bindInspectorPanel(inspectorPanel, false);
                inspectorPanel.requestFocus();
            }
            return;
        }
        if (inspectorSheet != null) {
            inspectorSheet.dismiss();
        }
        View panel = LayoutInflater.from(requireContext()).inflate(
                R.layout.panel_proxies_inspector,
                null,
                false
        );
        BottomSheetDialog sheet = new BottomSheetDialog(requireContext());
        inspectorSheet = sheet;
        inspectorPanel = panel;
        sheet.setContentView(panel);
        bindInspectorPanel(panel, true);
        sheet.setOnShowListener(dialogInterface -> {
            BottomSheetDialog d = (BottomSheetDialog) dialogInterface;
            FrameLayout bottomSheet = d.findViewById(com.google.android.material.R.id.design_bottom_sheet);
            if (bottomSheet != null) {
                BottomSheetBehavior<FrameLayout> behavior = BottomSheetBehavior.from(bottomSheet);
                behavior.setState(BottomSheetBehavior.STATE_EXPANDED);
                behavior.setSkipCollapsed(true);
            }
        });
        sheet.setOnDismissListener(ignored -> {
            if (inspectorSheet == sheet) {
                inspectorSheet = null;
                inspectorPanel = null;
            }
        });
        sheet.show();
    }

    private void bindInspectorPanel(View panel, boolean dismissible) {
        if (panel == null || !isAdded()) {
            return;
        }
        ImageButton close = panel.findViewById(R.id.btn_close_inspector);
        close.setVisibility(dismissible ? View.VISIBLE : View.GONE);
        close.setOnClickListener(view -> {
            if (inspectorSheet != null) {
                inspectorSheet.dismiss();
            }
        });

        TextView channel = panel.findViewById(R.id.tv_inspector_channel_status);
        RuntimeConfigOverlay.ProxyEndpoint endpoint = SingDeckVpnService.getInspectionProxy();
        if (!SingDeckVpnService.isVpnRunning()) {
            channel.setText("严格本地通道 · 等待 VPN");
            channel.setTextColor(requireContext().getColor(R.color.text_muted));
        } else if (endpoint == null) {
            channel.setText("严格本地通道 · 已降级");
            channel.setTextColor(requireContext().getColor(R.color.status_amber));
        } else {
            channel.setText("严格本地通道 · 127.0.0.1:" + endpoint.port);
            channel.setTextColor(requireContext().getColor(R.color.status_green));
        }

        String profileId = profileManager.getActiveProfileId();
        if (profileId == null || profileId.isEmpty() || selectedGroupName.isEmpty()) {
            panel.findViewById(R.id.btn_save_inspector_settings).setEnabled(false);
            panel.findViewById(R.id.btn_inspector_score).setEnabled(false);
            panel.findViewById(R.id.btn_inspector_risk).setEnabled(false);
            panel.findViewById(R.id.btn_inspector_gemini).setEnabled(false);
            ((TextView) panel.findViewById(R.id.tv_inspector_result))
                    .setText("请先导入并激活配置文件。");
            return;
        }

        MobileBootstrap.GroupSettings settings = inspectorRepository.getGroupSettings(
                profileId,
                selectedGroupName
        );
        MobileBootstrap.TestingSettings testing = inspectorRepository.getTestingSettings(profileId);
        OutboundGroup current = getGroup(
                SingDeckVpnService.isVpnRunning()
                        ? SingDeckVpnService.getRuntimeSnapshot().groups
                        : profileManager.getCachedGroups(),
                selectedGroupName
        );
        boolean selectorGroup = current != null && "selector".equalsIgnoreCase(current.type);
        EditText testUrl = panel.findViewById(R.id.et_inspector_test_url);
        EditText interval = panel.findViewById(R.id.et_inspector_interval);
        Spinner mode = panel.findViewById(R.id.spinner_inspector_mode);
        Spinner scheme = panel.findViewById(R.id.spinner_inspector_scheme);
        MaterialSwitch sourceRestriction = panel.findViewById(R.id.switch_source_restriction);
        MaterialSwitch allowUnlabeled = panel.findViewById(R.id.switch_allow_unlabeled);
        MaterialSwitch autoProbe = panel.findViewById(R.id.switch_auto_probe);
        MaterialSwitch autoSwitch = panel.findViewById(R.id.switch_auto_switch);
        MaterialSwitch geminiProbe = panel.findViewById(R.id.switch_gemini_probe);
        Button allowedSourcesButton = panel.findViewById(R.id.btn_allowed_sources);

        testUrl.setText(settings.testUrl);
        interval.setText(String.valueOf(Math.max(1, settings.probeIntervalSec / 60)));
        mode.setAdapter(spinnerAdapter(new String[]{"综合评分", "真实延迟"}));
        mode.setSelection("delay".equalsIgnoreCase(settings.mode) ? 1 : 0);
        scheme.setAdapter(spinnerAdapter(new String[]{"Balanced", "LatencyFirst"}));
        scheme.setSelection("LatencyFirst".equalsIgnoreCase(settings.scheme) ? 1 : 0);
        scheme.setEnabled(mode.getSelectedItemPosition() == 0);
        mode.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                scheme.setEnabled(position == 0);
            }

            @Override
            public void onNothingSelected(AdapterView<?> parent) {
            }
        });
        sourceRestriction.setChecked(selectorGroup && settings.sourceRestrictionEnabled);
        sourceRestriction.setEnabled(selectorGroup);
        sourceRestriction.setText(selectorGroup
                ? "仅允许指定来源的节点"
                : "来源限制仅支持 Selector");
        allowUnlabeled.setChecked(settings.allowUnlabeledNodes);
        autoProbe.setChecked(settings.autoProbe);
        autoSwitch.setChecked(selectorGroup && settings.autoSwitch);
        autoSwitch.setEnabled(selectorGroup);
        autoSwitch.setText(selectorGroup
                ? "检测后自动切换到推荐节点"
                : "URLTest / Fallback 由 sing-box 原生切换");
        geminiProbe.setChecked(settings.geminiLocationProbeEnabled
                && selectedGroupName.equals(testing.geminiLocationGroup));

        LinkedHashSet<String> allowedSources = new LinkedHashSet<>(
                settings.allowedNodeSources == null
                        ? Collections.emptyList()
                        : settings.allowedNodeSources
        );
        List<InspectorRepository.SourceState> sources = inspectorRepository.getNodeSources(profileId);
        updateAllowedSourcesLabel(allowedSourcesButton, allowedSources);
        allowedSourcesButton.setEnabled(selectorGroup && sourceRestriction.isChecked());
        allowUnlabeled.setEnabled(selectorGroup && sourceRestriction.isChecked());
        sourceRestriction.setOnCheckedChangeListener((button, checked) -> {
            allowedSourcesButton.setEnabled(selectorGroup && checked);
            allowUnlabeled.setEnabled(selectorGroup && checked);
        });
        allowedSourcesButton.setOnClickListener(view -> showSourcePicker(
                sources,
                allowedSources,
                allowedSourcesButton
        ));

        CheckBox riskExitIp = panel.findViewById(R.id.check_risk_exit_ip);
        CheckBox riskAddress = panel.findViewById(R.id.check_risk_address_scope);
        CheckBox riskIdentity = panel.findViewById(R.id.check_risk_network_identity);
        CheckBox riskClass = panel.findViewById(R.id.check_risk_network_class);
        CheckBox riskRoute = panel.findViewById(R.id.check_risk_route_security);
        CheckBox riskTor = panel.findViewById(R.id.check_risk_tor);
        CheckBox riskPrivacy = panel.findViewById(R.id.check_risk_privacy);
        CheckBox riskAbuse = panel.findViewById(R.id.check_risk_abuse);
        MobileBootstrap.NodeRiskChecks risk = settings.nodeRisk == null
                ? new MobileBootstrap.NodeRiskChecks() : settings.nodeRisk;
        riskExitIp.setChecked(risk.exitIp);
        riskAddress.setChecked(risk.addressScope);
        riskIdentity.setChecked(risk.networkIdentity);
        riskClass.setChecked(risk.networkClass);
        riskRoute.setChecked(risk.routeSecurity);
        riskTor.setChecked(risk.tor);
        riskPrivacy.setChecked(risk.privacy);
        riskAbuse.setChecked(risk.abuse);

        panel.findViewById(R.id.btn_save_inspector_settings).setOnClickListener(view -> {
            String normalizedUrl = testUrl.getText().toString().trim();
            if (!(normalizedUrl.startsWith("https://") || normalizedUrl.startsWith("http://"))) {
                testUrl.setError("请输入 http:// 或 https:// URL");
                return;
            }
            long intervalMinutes;
            try {
                intervalMinutes = Long.parseLong(interval.getText().toString().trim());
            } catch (NumberFormatException error) {
                interval.setError("请输入分钟数");
                return;
            }
            long minimumMinutes = Math.max(1, (testing.minProbeIntervalSec + 59) / 60);
            if (intervalMinutes < minimumMinutes || intervalMinutes > 24 * 60) {
                interval.setError("范围 " + minimumMinutes + " - 1440 分钟");
                return;
            }
            if (sourceRestriction.isChecked()
                    && allowedSources.isEmpty()
                    && !allowUnlabeled.isChecked()) {
                Toast.makeText(
                        requireContext(),
                        "来源限制至少选择一个来源，或允许未标记节点",
                        Toast.LENGTH_LONG
                ).show();
                return;
            }
            if (sourceRestriction.isChecked()
                    && current != null
                    && !"selector".equalsIgnoreCase(current.type)) {
                Toast.makeText(
                        requireContext(),
                        "来源限制只支持 Selector 策略组",
                        Toast.LENGTH_LONG
                ).show();
                return;
            }

            settings.testUrl = normalizedUrl;
            settings.testUrlOverridden = true;
            settings.mode = mode.getSelectedItemPosition() == 1 ? "delay" : "score";
            settings.scheme = scheme.getSelectedItemPosition() == 1
                    ? "LatencyFirst" : "Balanced";
            settings.probeIntervalSec = intervalMinutes * 60;
            settings.sourceRestrictionEnabled = selectorGroup && sourceRestriction.isChecked();
            settings.allowedNodeSources = new ArrayList<>(allowedSources);
            settings.allowUnlabeledNodes = allowUnlabeled.isChecked();
            settings.autoProbe = autoProbe.isChecked();
            settings.autoSwitch = selectorGroup && autoSwitch.isChecked();
            settings.geminiLocationProbeEnabled = geminiProbe.isChecked();
            MobileBootstrap.NodeRiskChecks nextRisk = new MobileBootstrap.NodeRiskChecks();
            nextRisk.exitIp = riskExitIp.isChecked();
            nextRisk.addressScope = riskAddress.isChecked();
            nextRisk.networkIdentity = riskIdentity.isChecked();
            nextRisk.networkClass = riskClass.isChecked();
            nextRisk.routeSecurity = riskRoute.isChecked();
            nextRisk.tor = riskTor.isChecked();
            nextRisk.privacy = riskPrivacy.isChecked();
            nextRisk.abuse = riskAbuse.isChecked();
            settings.nodeRisk = nextRisk;
            inspectorRepository.saveGroupSettings(
                    profileId,
                    selectedGroupName,
                    current == null ? "" : current.type,
                    settings
            );
            if (geminiProbe.isChecked()) {
                testing.geminiLocationGroup = selectedGroupName;
            } else if (selectedGroupName.equals(testing.geminiLocationGroup)) {
                testing.geminiLocationGroup = "";
            }
            inspectorRepository.saveTestingSettings(profileId, testing);
            Toast.makeText(requireContext(), "策略组 Inspector 配置已保存", Toast.LENGTH_SHORT).show();
            updateGroupData();
        });

        panel.findViewById(R.id.btn_inspector_score).setOnClickListener(view ->
                runInspectorAction(panel, false, false));
        panel.findViewById(R.id.btn_inspector_risk).setOnClickListener(view ->
                runInspectorAction(panel, true, false));
        panel.findViewById(R.id.btn_inspector_gemini).setOnClickListener(view ->
                runInspectorAction(panel, false, true));
        panel.findViewById(R.id.btn_gemini_login).setOnClickListener(view -> showGeminiLogin());
        refreshInspectorNode(panel);
    }

    private ArrayAdapter<String> spinnerAdapter(String[] values) {
        ArrayAdapter<String> adapter = new ArrayAdapter<>(
                requireContext(),
                R.layout.item_spinner_selected,
                values
        );
        adapter.setDropDownViewResource(R.layout.item_spinner_dropdown);
        return adapter;
    }

    private void showSourcePicker(
            List<InspectorRepository.SourceState> sources,
            Set<String> selected,
            Button label
    ) {
        String[] names = new String[sources.size()];
        boolean[] checked = new boolean[sources.size()];
        for (int index = 0; index < sources.size(); index++) {
            names[index] = sources.get(index).name;
            checked[index] = selected.contains(names[index]);
        }
        LinkedHashSet<String> draft = new LinkedHashSet<>(selected);
        new AlertDialog.Builder(requireContext())
                .setTitle("允许的节点来源")
                .setMultiChoiceItems(names, checked, (dialog, which, enabled) -> {
                    if (enabled) {
                        draft.add(names[which]);
                    } else {
                        draft.remove(names[which]);
                    }
                })
                .setPositiveButton("完成", (dialog, which) -> {
                    selected.clear();
                    selected.addAll(draft);
                    updateAllowedSourcesLabel(label, selected);
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private void updateAllowedSourcesLabel(Button button, Set<String> selected) {
        button.setText(selected.isEmpty()
                ? "选择允许来源"
                : "允许来源（" + selected.size() + "）: " + String.join("、", selected));
    }

    private void runInspectorAction(View panel, boolean includeRisk, boolean includeGemini) {
        String profileId = profileManager.getActiveProfileId();
        String groupName = selectedGroupName;
        String nodeName = inspectedNodeName;
        if (profileId == null || profileId.isEmpty() || groupName.isEmpty() || nodeName.isEmpty()) {
            Toast.makeText(requireContext(), "请先选择要检查的节点", Toast.LENGTH_SHORT).show();
            return;
        }
        Button score = panel.findViewById(R.id.btn_inspector_score);
        Button risk = panel.findViewById(R.id.btn_inspector_risk);
        Button gemini = panel.findViewById(R.id.btn_inspector_gemini);
        score.setEnabled(false);
        risk.setEnabled(false);
        gemini.setEnabled(false);
        ((TextView) panel.findViewById(R.id.tv_inspector_result)).setText("正在通过 "
                + nodeName + " 执行严格出站检测…");
        android.content.Context appContext = requireContext().getApplicationContext();
        inspectorExecutor.execute(() -> {
            String error = null;
            try {
                NativeInspectionEngine.inspectNode(
                        appContext,
                        profileId,
                        groupName,
                        nodeName,
                        includeRisk,
                        includeGemini
                );
            } catch (Exception failure) {
                error = safeMessage(failure);
            }
            String finalError = error;
            runtimeHandler.post(() -> {
                if (!isAdded() || panel != inspectorPanel) {
                    return;
                }
                score.setEnabled(true);
                risk.setEnabled(true);
                gemini.setEnabled(true);
                if (finalError != null) {
                    ((TextView) panel.findViewById(R.id.tv_inspector_result))
                            .setText("检测失败: " + finalError);
                } else {
                    refreshInspectorNode(panel);
                }
                updateGroupData();
            });
        });
    }

    private void refreshInspectorNode(View panel) {
        if (panel == null) {
            return;
        }
        TextView title = panel.findViewById(R.id.tv_inspector_node);
        TextView meta = panel.findViewById(R.id.tv_inspector_node_meta);
        TextView result = panel.findViewById(R.id.tv_inspector_result);
        String profileId = profileManager.getActiveProfileId();
        if (profileId == null || profileId.isEmpty() || inspectedNodeName.isEmpty()) {
            title.setText("选择一个节点");
            meta.setText("来源 -- · 评分 -- · 延迟 --");
            return;
        }
        title.setText(inspectedNodeName);
        String source = inspectorRepository.getSourceOwners(profileId)
                .getOrDefault(inspectedNodeName, "未标记");
        List<ProbeScoringEngine.NodeScore> scores = inspectorRepository.getScores(
                profileId,
                selectedGroupName,
                Collections.singletonList(inspectedNodeName),
                System.currentTimeMillis()
        );
        ProbeScoringEngine.NodeScore score = scores.isEmpty() ? null : scores.get(0);
        meta.setText("来源 " + source
                + " · 评分 " + (score == null ? "--" : Math.round(score.score))
                + " · 延迟 " + (score == null || score.delayMs == null
                ? "--" : score.delayMs + "ms"));
        Map<String, String> inspections = inspectorRepository.getInspectionResults(
                profileId,
                selectedGroupName,
                inspectedNodeName
        );
        StringBuilder summary = new StringBuilder();
        if (score != null) {
            summary.append("评分 ").append(score.score)
                    .append(" · latency ").append(score.components.latency)
                    .append(" · availability ").append(score.components.availability)
                    .append(" · jitter ").append(score.components.jitter)
                    .append("\n门禁: ").append(score.gateReason);
        }
        for (Map.Entry<String, String> entry : inspections.entrySet()) {
            if (summary.length() > 0) {
                summary.append("\n\n");
            }
            summary.append(entry.getKey()).append("\n");
            try {
                JsonElement json = JsonParser.parseString(entry.getValue());
                summary.append(prettyGson.toJson(json));
            } catch (RuntimeException error) {
                summary.append(entry.getValue());
            }
        }
        result.setText(summary.length() == 0 ? "尚未检测此节点。" : summary.toString());
    }

    private void showGeminiLogin() {
        Dialog dialog = new Dialog(requireContext());
        WebView webView = new WebView(requireContext());
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setSavePassword(false);
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, true);
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                cookies.flush();
            }
        });
        webView.loadUrl(GeminiLocationInspector.APP_URL);
        dialog.setTitle("SingDeck · Gemini 登录");
        dialog.setContentView(webView);
        dialog.setOnDismissListener(ignored -> {
            cookies.flush();
            webView.stopLoading();
            webView.destroy();
        });
        dialog.show();
        Window window = dialog.getWindow();
        if (window != null) {
            window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        }
    }

    private void awaitOperation(long operationId, String action, Runnable success) {
        long deadline = System.currentTimeMillis() + 15_000;
        Runnable poll = new Runnable() {
            @Override
            public void run() {
                if (!isAdded() || !viewActive) {
                    return;
                }
                if (SingDeckVpnService.isOperationComplete(operationId)) {
                    String error = SingDeckVpnService.consumeOperationError(operationId);
                    if (error == null || error.isEmpty()) {
                        success.run();
                    } else {
                        Toast.makeText(
                                requireContext(),
                                action + "失败: " + error,
                                Toast.LENGTH_LONG
                        ).show();
                        testingNodes.clear();
                        testStartedAt.clear();
                        updateGroupData();
                    }
                    return;
                }
                if (System.currentTimeMillis() >= deadline) {
                    Toast.makeText(requireContext(), action + "命令超时", Toast.LENGTH_LONG).show();
                    testingNodes.clear();
                    testStartedAt.clear();
                    updateGroupData();
                    return;
                }
                runtimeHandler.postDelayed(this, 150);
            }
        };
        runtimeHandler.post(poll);
    }

    private boolean hasGroup(List<OutboundGroup> groups, String name) {
        for (OutboundGroup group : groups) {
            if (group.name.equals(name)) {
                return true;
            }
        }
        return false;
    }

    private OutboundGroup getGroup(List<OutboundGroup> groups, String name) {
        for (OutboundGroup group : groups) {
            if (group.name.equals(name)) {
                return group;
            }
        }
        return groups.isEmpty() ? null : groups.get(0);
    }

    private static String safeMessage(Throwable error) {
        String message = error.getMessage();
        return message == null || message.trim().isEmpty()
                ? error.getClass().getSimpleName()
                : message;
    }
}
