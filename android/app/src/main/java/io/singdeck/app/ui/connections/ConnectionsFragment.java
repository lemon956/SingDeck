package io.singdeck.app.ui.connections;

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
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.fragment.app.Fragment;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import io.singdeck.app.R;
import io.singdeck.app.SingDeckVpnService;
import io.singdeck.app.model.ConnectionItem;
import io.singdeck.app.model.CoreRuntimeSnapshot;

public class ConnectionsFragment extends Fragment {
    private TextView tvConnectionCount;
    private Button btnCloseAllConnections;
    private EditText etSearchConnections;
    private ConnectionAdapter connectionAdapter;
    private final Handler runtimeHandler = new Handler(Looper.getMainLooper());
    private boolean viewActive;

    @Nullable
    @Override
    public View onCreateView(
            @NonNull LayoutInflater inflater,
            @Nullable ViewGroup container,
            @Nullable Bundle savedInstanceState
    ) {
        View view = inflater.inflate(R.layout.fragment_connections, container, false);
        viewActive = true;
        tvConnectionCount = view.findViewById(R.id.tv_connection_count);
        btnCloseAllConnections = view.findViewById(R.id.btn_close_all_connections);
        etSearchConnections = view.findViewById(R.id.et_search_connections);
        RecyclerView rvConnections = view.findViewById(R.id.rv_connections);

        rvConnections.setLayoutManager(new LinearLayoutManager(requireContext()));
        connectionAdapter = new ConnectionAdapter(this::showConnectionDetail);
        rvConnections.setAdapter(connectionAdapter);
        btnCloseAllConnections.setOnClickListener(view1 -> closeAllConnections());
        etSearchConnections.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence value, int start, int count, int after) {
            }

            @Override
            public void onTextChanged(CharSequence value, int start, int before, int count) {
                updateList();
            }

            @Override
            public void afterTextChanged(Editable value) {
            }
        });

        updateList();
        runtimeHandler.postDelayed(runtimePoller, 500);
        return view;
    }

    @Override
    public void onDestroyView() {
        viewActive = false;
        runtimeHandler.removeCallbacksAndMessages(null);
        super.onDestroyView();
    }

    private final Runnable runtimePoller = new Runnable() {
        @Override
        public void run() {
            if (!isAdded() || !viewActive) {
                return;
            }
            updateList();
            runtimeHandler.postDelayed(this, 750);
        }
    };

    private void updateList() {
        if (!isAdded() || !viewActive) {
            return;
        }
        CoreRuntimeSnapshot snapshot = SingDeckVpnService.getRuntimeSnapshot();
        boolean running = SingDeckVpnService.STATE_RUNNING.equals(snapshot.state);
        String query = etSearchConnections.getText().toString().trim().toLowerCase(Locale.ROOT);
        List<ConnectionItem> filtered = new ArrayList<>();
        for (ConnectionItem item : snapshot.connections) {
            if (query.isEmpty() || matches(item, query)) {
                filtered.add(item);
            }
        }

        if (!running) {
            tvConnectionCount.setText("未连接 · 无核心连接");
        } else if (query.isEmpty()) {
            tvConnectionCount.setText("实时活跃连接 (" + snapshot.connections.size() + ")");
        } else {
            tvConnectionCount.setText(
                    "实时活跃连接 (" + snapshot.connections.size() + ") · 显示 " + filtered.size()
            );
        }
        btnCloseAllConnections.setEnabled(running && !snapshot.connections.isEmpty());
        connectionAdapter.updateData(filtered);
    }

    private boolean matches(ConnectionItem item, String query) {
        return contains(item.host, query)
                || contains(item.source, query)
                || contains(item.outbound, query)
                || contains(item.chain, query)
                || contains(item.process, query)
                || contains(item.protocol, query);
    }

    private boolean contains(String value, String query) {
        return value != null && value.toLowerCase(Locale.ROOT).contains(query);
    }

    private void showConnectionDetail(ConnectionItem item) {
        if (!isAdded() || !viewActive || item == null) return;
        ConnectionDetailBottomSheet sheet = ConnectionDetailBottomSheet.newInstance(item);
        sheet.setActionListener(this::closeConnection);
        sheet.show(getParentFragmentManager(), "connection_detail");
    }

    private void closeConnection(String connectionId, String host) {
        if (!SingDeckVpnService.isVpnRunning()) {
            Toast.makeText(requireContext(), "sing-box 核心尚未运行", Toast.LENGTH_SHORT).show();
            return;
        }
        sendCloseCommand(
                SingDeckVpnService.ACTION_CLOSE_CONNECTION,
                connectionId,
                "关闭连接 " + host
        );
    }

    private void closeAllConnections() {
        if (!SingDeckVpnService.isVpnRunning()) {
            Toast.makeText(requireContext(), "sing-box 核心尚未运行", Toast.LENGTH_SHORT).show();
            return;
        }
        sendCloseCommand(
                SingDeckVpnService.ACTION_CLOSE_CONNECTIONS,
                null,
                "关闭全部连接"
        );
    }

    private void sendCloseCommand(String action, String connectionId, String label) {
        long operationId = SingDeckVpnService.newOperationId();
        Intent intent = new Intent(requireContext(), SingDeckVpnService.class)
                .setAction(action)
                .putExtra(SingDeckVpnService.EXTRA_OPERATION_ID, operationId);
        if (connectionId != null) {
            intent.putExtra(SingDeckVpnService.EXTRA_CONNECTION_ID, connectionId);
        }
        requireContext().startService(intent);
        awaitOperation(operationId, label);
    }

    private void awaitOperation(long operationId, String label) {
        long deadline = System.currentTimeMillis() + 10_000;
        Runnable poll = new Runnable() {
            @Override
            public void run() {
                if (!isAdded() || !viewActive) {
                    return;
                }
                if (SingDeckVpnService.isOperationComplete(operationId)) {
                    String error = SingDeckVpnService.consumeOperationError(operationId);
                    Toast.makeText(
                            requireContext(),
                            error == null || error.isEmpty() ? label + "命令已执行" : label + "失败: " + error,
                            error == null || error.isEmpty() ? Toast.LENGTH_SHORT : Toast.LENGTH_LONG
                    ).show();
                    updateList();
                    return;
                }
                if (System.currentTimeMillis() >= deadline) {
                    Toast.makeText(requireContext(), label + "命令超时", Toast.LENGTH_LONG).show();
                    return;
                }
                runtimeHandler.postDelayed(this, 150);
            }
        };
        runtimeHandler.post(poll);
    }
}
