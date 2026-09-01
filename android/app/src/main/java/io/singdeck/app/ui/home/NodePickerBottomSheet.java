package io.singdeck.app.ui.home;

import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import com.google.android.material.bottomsheet.BottomSheetDialogFragment;

import java.util.ArrayList;
import java.util.List;

import io.singdeck.app.R;
import io.singdeck.app.SingDeckVpnService;
import io.singdeck.app.model.CoreRuntimeSnapshot;
import io.singdeck.app.model.NodeItem;
import io.singdeck.app.model.OutboundGroup;
import io.singdeck.app.ui.proxies.NodeAdapter;

public class NodePickerBottomSheet extends BottomSheetDialogFragment {
    private static final String ARG_GROUP_NAME = "arg_group_name";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private String groupName;
    private NodeAdapter nodeAdapter;
    private TextView tvPickerNodeCount;
    private boolean viewActive;

    public static NodePickerBottomSheet newInstance(String groupName) {
        NodePickerBottomSheet fragment = new NodePickerBottomSheet();
        Bundle args = new Bundle();
        args.putString(ARG_GROUP_NAME, groupName);
        fragment.setArguments(args);
        return fragment;
    }

    @Override
    public void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (getArguments() != null) {
            groupName = getArguments().getString(ARG_GROUP_NAME);
        }
    }

    @Nullable
    @Override
    public View onCreateView(
            @NonNull LayoutInflater inflater,
            @Nullable ViewGroup container,
            @Nullable Bundle savedInstanceState
    ) {
        View view = inflater.inflate(R.layout.bottom_sheet_node_picker, container, false);
        viewActive = true;
        TextView tvPickerGroupName = view.findViewById(R.id.tv_picker_group_name);
        tvPickerNodeCount = view.findViewById(R.id.tv_picker_node_count);
        RecyclerView rvPickerNodes = view.findViewById(R.id.rv_picker_nodes);
        tvPickerGroupName.setText("选择运行节点: " + groupName);

        rvPickerNodes.setLayoutManager(new LinearLayoutManager(requireContext()));
        nodeAdapter = new NodeAdapter(new NodeAdapter.OnNodeClickListener() {
            @Override
            public void onNodeClick(NodeItem node) {
                sendCommand(SingDeckVpnService.ACTION_SELECT_OUTBOUND, node.name, "切换出站", true);
            }

            @Override
            public void onTestNode(NodeItem node) {
                node.isTesting = true;
                nodeAdapter.notifyDataSetChanged();
                sendCommand(SingDeckVpnService.ACTION_URL_TEST, node.name, "测速", false);
            }

            @Override
            public void onNodeLongClick(NodeItem node) {
            }
        });
        rvPickerNodes.setAdapter(nodeAdapter);
        updateData();
        handler.postDelayed(runtimePoller, 750);
        return view;
    }

    @Override
    public void onDestroyView() {
        viewActive = false;
        handler.removeCallbacksAndMessages(null);
        super.onDestroyView();
    }

    private final Runnable runtimePoller = new Runnable() {
        @Override
        public void run() {
            if (!isAdded() || !viewActive) {
                return;
            }
            updateData();
            handler.postDelayed(this, 750);
        }
    };

    private void updateData() {
        if (!isAdded() || !viewActive) {
            return;
        }
        CoreRuntimeSnapshot snapshot = SingDeckVpnService.getRuntimeSnapshot();
        OutboundGroup group = findGroup(snapshot.groups);
        if (group == null) {
            tvPickerNodeCount.setText("核心中没有此策略组");
            nodeAdapter.updateData(new ArrayList<>(), "");
            return;
        }

        List<NodeItem> nodes = new ArrayList<>();
        for (String tag : group.all) {
            NodeItem node = snapshot.nodes.get(tag);
            nodes.add(node == null ? new NodeItem(tag, "OUTBOUND") : new NodeItem(node));
        }
        tvPickerNodeCount.setText(group.all.size() + " 个核心可选节点");
        nodeAdapter.updateData(nodes, group.now);
    }

    private OutboundGroup findGroup(List<OutboundGroup> groups) {
        for (OutboundGroup group : groups) {
            if (group.name.equals(groupName)) {
                return group;
            }
        }
        return null;
    }

    private void sendCommand(String action, String outbound, String label, boolean closeOnSuccess) {
        if (!SingDeckVpnService.isVpnRunning()) {
            Toast.makeText(requireContext(), "sing-box 核心尚未运行", Toast.LENGTH_SHORT).show();
            return;
        }
        long operationId = SingDeckVpnService.newOperationId();
        Intent intent = new Intent(requireContext(), SingDeckVpnService.class)
                .setAction(action)
                .putExtra(SingDeckVpnService.EXTRA_OUTBOUND, outbound)
                .putExtra(SingDeckVpnService.EXTRA_OPERATION_ID, operationId);
        if (SingDeckVpnService.ACTION_SELECT_OUTBOUND.equals(action)) {
            intent.putExtra(SingDeckVpnService.EXTRA_GROUP, groupName);
        }
        requireContext().startService(intent);
        awaitOperation(operationId, label, outbound, closeOnSuccess);
    }

    private void awaitOperation(
            long operationId,
            String label,
            String outbound,
            boolean closeOnSuccess
    ) {
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
                        Toast.makeText(
                                requireContext(),
                                label + "命令已发送: " + outbound,
                                Toast.LENGTH_SHORT
                        ).show();
                        if (closeOnSuccess) {
                            dismiss();
                        } else {
                            updateData();
                        }
                    } else {
                        Toast.makeText(
                                requireContext(),
                                label + "失败: " + error,
                                Toast.LENGTH_LONG
                        ).show();
                    }
                    return;
                }
                if (System.currentTimeMillis() >= deadline) {
                    Toast.makeText(requireContext(), label + "命令超时", Toast.LENGTH_LONG).show();
                    return;
                }
                handler.postDelayed(this, 150);
            }
        };
        handler.post(poll);
    }
}
