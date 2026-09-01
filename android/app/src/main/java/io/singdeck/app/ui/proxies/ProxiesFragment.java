package io.singdeck.app.ui.proxies;

import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageButton;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.fragment.app.Fragment;
import androidx.recyclerview.widget.GridLayoutManager;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

import io.singdeck.app.R;
import io.singdeck.app.SingDeckVpnService;
import io.singdeck.app.manager.ProfileManager;
import io.singdeck.app.model.CoreRuntimeSnapshot;
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
    private SwipeRefreshLayout swipeRefresh;
    private RecyclerView rvNodesGrid;

    private GroupTabAdapter groupTabAdapter;
    private NodeAdapter nodeAdapter;
    private ProfileManager profileManager;
    private ProfileManager.OnProfileChangeListener profileChangeListener;
    private final Handler runtimeHandler = new Handler(Looper.getMainLooper());
    private final Set<String> testingNodes = new HashSet<>();
    private final Map<String, Long> testStartedAt = new HashMap<>();

    private String selectedGroupName = "";
    private boolean isGridLayout = true;
    private int sortMode;
    private boolean viewActive;

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
        swipeRefresh = view.findViewById(R.id.swipe_refresh);
        rvNodesGrid = view.findViewById(R.id.rv_nodes_grid);

        profileManager = ProfileManager.getInstance(requireContext());
        rvGroupTabs.setLayoutManager(new LinearLayoutManager(
                requireContext(),
                LinearLayoutManager.HORIZONTAL,
                false
        ));
        groupTabAdapter = new GroupTabAdapter(group -> {
            selectedGroupName = group.name;
            updateGroupData();
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
                requestUrlTest(node.name, Collections.singletonList(node.name));
            }

            @Override
            public void onNodeLongClick(NodeItem node) {
                NodeDetailDialog.show(
                        requireContext(),
                        node,
                        selectedGroupName,
                        ProxiesFragment.this::requestSwitch
                );
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
        tvCurActiveNode.setText(
                running ? "核心当前生效: " + activeNode : "配置预览: " + activeNode + "（未连接）"
        );

        String query = etSearchNodes.getText().toString().trim().toLowerCase(Locale.ROOT);
        List<NodeItem> memberNodes = new ArrayList<>();
        long now = System.currentTimeMillis();
        for (String nodeTag : currentGroup.all) {
            if (!query.isEmpty() && !nodeTag.toLowerCase(Locale.ROOT).contains(query)) {
                continue;
            }
            NodeItem source = nodes.get(nodeTag);
            NodeItem node = source == null
                    ? new NodeItem(nodeTag, "OUTBOUND")
                    : new NodeItem(source);
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
        long operationId = SingDeckVpnService.newOperationId();
        Intent intent = new Intent(requireContext(), SingDeckVpnService.class)
                .setAction(SingDeckVpnService.ACTION_SELECT_OUTBOUND)
                .putExtra(SingDeckVpnService.EXTRA_GROUP, selectedGroupName)
                .putExtra(SingDeckVpnService.EXTRA_OUTBOUND, node.name)
                .putExtra(SingDeckVpnService.EXTRA_OPERATION_ID, operationId);
        requireContext().startService(intent);
        awaitOperation(operationId, "切换出站", () -> Toast.makeText(
                requireContext(),
                "已切换出站: " + node.name,
                Toast.LENGTH_SHORT
        ).show());
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
        requestUrlTest(currentGroup.name, currentGroup.all);
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
}
