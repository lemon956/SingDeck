package io.singdeck.app.ui.home;

import android.app.Activity;
import android.content.Intent;
import android.net.VpnService;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.Fragment;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import java.util.Locale;

import io.singdeck.app.R;
import io.singdeck.app.SingDeckVpnService;
import io.singdeck.app.manager.ProfileManager;
import io.singdeck.app.model.CoreRuntimeSnapshot;
import io.singdeck.app.model.Profile;
import io.singdeck.app.MainActivity;

public class HomeFragment extends Fragment {
    private FrameLayout btnPower;
    private ImageView ivPowerIcon;
    private TextView tvVpnState;
    private TextView tvActiveNodeInfo;
    private TextView tvDownloadSpeed;
    private TextView tvUploadSpeed;
    private TextView tvDuration;
    private TextView btnViewAllNodes;
    private RecyclerView rvStrategyGroups;
    private io.singdeck.app.ui.widget.SpeedWaveformView waveformSpeed;

    private GroupAdapter groupAdapter;
    private ProfileManager profileManager;
    private ProfileManager.OnProfileChangeListener profileChangeListener;
    private final Handler timerHandler = new Handler(Looper.getMainLooper());
    private ActivityResultLauncher<Intent> vpnPermissionLauncher;
    private boolean viewActive;

    @Override
    public void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        vpnPermissionLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> {
                    if (result.getResultCode() == Activity.RESULT_OK) {
                        startVpnService();
                    } else {
                        Toast.makeText(requireContext(), "未获得 VPN 连接权限", Toast.LENGTH_SHORT).show();
                    }
                }
        );
    }

    @Nullable
    @Override
    public View onCreateView(@NonNull LayoutInflater inflater, @Nullable ViewGroup container, @Nullable Bundle savedInstanceState) {
        View view = inflater.inflate(R.layout.fragment_home, container, false);
        viewActive = true;

        btnPower = view.findViewById(R.id.btn_power);
        ivPowerIcon = view.findViewById(R.id.iv_power_icon);
        tvVpnState = view.findViewById(R.id.tv_vpn_state);
        tvActiveNodeInfo = view.findViewById(R.id.tv_active_node_info);
        tvDownloadSpeed = view.findViewById(R.id.tv_download_speed);
        tvUploadSpeed = view.findViewById(R.id.tv_upload_speed);
        tvDuration = view.findViewById(R.id.tv_duration);
        btnViewAllNodes = view.findViewById(R.id.btn_view_all_nodes);
        rvStrategyGroups = view.findViewById(R.id.rv_strategy_groups);
        waveformSpeed = view.findViewById(R.id.waveform_speed);

        profileManager = ProfileManager.getInstance(requireContext());

        rvStrategyGroups.setLayoutManager(new LinearLayoutManager(requireContext()));
        groupAdapter = new GroupAdapter(group -> {
            if (!SingDeckVpnService.isVpnRunning()) {
                Toast.makeText(requireContext(), "启动 VPN 后才能切换运行节点", Toast.LENGTH_SHORT).show();
                return;
            }
            NodePickerBottomSheet.newInstance(group.name).show(getParentFragmentManager(), "node_picker");
        });
        rvStrategyGroups.setAdapter(groupAdapter);

        btnPower.setOnClickListener(v -> toggleVpn());
        btnViewAllNodes.setOnClickListener(v -> {
            if (getActivity() instanceof MainActivity) {
                ((MainActivity) getActivity()).navigateToTab(1);
            }
        });

        profileChangeListener = this::refreshData;
        profileManager.addListener(profileChangeListener);
        refreshData();
        startStatusTimer();

        return view;
    }

    @Override
    public void onResume() {
        super.onResume();
        refreshData();
    }

    private void refreshData() {
        if (!isAdded() || !viewActive) return;
        CoreRuntimeSnapshot snapshot = SingDeckVpnService.getRuntimeSnapshot();
        if (SingDeckVpnService.STATE_RUNNING.equals(snapshot.state)) {
            groupAdapter.updateData(snapshot.groups, snapshot.nodes);
        } else {
            groupAdapter.updateData(profileManager.getCachedGroups(), profileManager.getCachedNodes());
        }
        Profile active = profileManager.getActiveProfile();
        Profile running = findProfile(snapshot.runningProfileId);
        if (SingDeckVpnService.STATE_RUNNING.equals(snapshot.state) && running != null) {
            if (active != null && !active.id.equals(running.id)) {
                tvActiveNodeInfo.setText(
                        "运行: " + running.name + " · 已激活: " + active.name + "（待重连）"
                );
            } else {
                tvActiveNodeInfo.setText(
                        "运行配置: " + running.name + " · " + snapshot.activeOutbound
                );
            }
        } else if (active != null) {
            tvActiveNodeInfo.setText("已激活: " + active.name + "（未连接）");
        } else {
            tvActiveNodeInfo.setText("请先添加配置方案");
        }
    }

    private Profile findProfile(String id) {
        if (id == null || id.isEmpty()) {
            return null;
        }
        for (Profile profile : profileManager.getProfiles()) {
            if (id.equals(profile.id)) {
                return profile;
            }
        }
        return null;
    }

    private void toggleVpn() {
        String state = SingDeckVpnService.getServiceState();
        if (SingDeckVpnService.STATE_STARTING.equals(state)
                || SingDeckVpnService.STATE_STOPPING.equals(state)) {
            Toast.makeText(requireContext(), "VPN 状态切换中，请稍候", Toast.LENGTH_SHORT).show();
        } else if (SingDeckVpnService.STATE_RUNNING.equals(state)) {
            stopVpnService();
        } else {
            Intent vpnIntent = VpnService.prepare(requireContext());
            if (vpnIntent != null) {
                vpnPermissionLauncher.launch(vpnIntent);
            } else {
                startVpnService();
            }
        }
    }

    private void startVpnService() {
        Profile active = profileManager.getActiveProfile();
        if (active == null) {
            Toast.makeText(requireContext(), "请先添加并激活配置文件", Toast.LENGTH_SHORT).show();
            return;
        }

        Intent intent = new Intent(requireContext(), SingDeckVpnService.class);
        intent.setAction(SingDeckVpnService.ACTION_START);
        intent.putExtra(SingDeckVpnService.EXTRA_PROFILE_ID, active.id);
        long operationId = SingDeckVpnService.newOperationId();
        intent.putExtra(SingDeckVpnService.EXTRA_OPERATION_ID, operationId);
        io.singdeck.app.manager.SplitTunnelManager stm = io.singdeck.app.manager.SplitTunnelManager.getInstance(requireContext());
        intent.putExtra(SingDeckVpnService.EXTRA_SPLIT_MODE, stm.getMode());
        intent.putStringArrayListExtra(SingDeckVpnService.EXTRA_PACKAGES, stm.getSelectedPackagesList());
        ContextCompat.startForegroundService(requireContext(), intent);
        awaitOperation(operationId, "启动");
    }

    private void stopVpnService() {
        Intent intent = new Intent(requireContext(), SingDeckVpnService.class);
        intent.setAction(SingDeckVpnService.ACTION_STOP);
        long operationId = SingDeckVpnService.newOperationId();
        intent.putExtra(SingDeckVpnService.EXTRA_OPERATION_ID, operationId);
        requireContext().startService(intent);
        awaitOperation(operationId, "停止");
    }

    private void updateUiState(CoreRuntimeSnapshot snapshot) {
        if (!isAdded() || !viewActive) return;
        boolean isRunning = SingDeckVpnService.STATE_RUNNING.equals(snapshot.state);
        if (isRunning) {
            btnPower.setBackgroundResource(R.drawable.bg_circle_power_on);
            ivPowerIcon.setColorFilter(requireContext().getColor(R.color.status_green));
            tvVpnState.setText("代理加速运行中");
            tvVpnState.setTextColor(requireContext().getColor(R.color.status_green));
        } else if (SingDeckVpnService.STATE_STARTING.equals(snapshot.state)) {
            btnPower.setBackgroundResource(R.drawable.bg_circle_power);
            ivPowerIcon.setColorFilter(requireContext().getColor(R.color.status_amber));
            tvVpnState.setText("正在启动 sing-box…");
            tvVpnState.setTextColor(requireContext().getColor(R.color.status_amber));
        } else if (SingDeckVpnService.STATE_STOPPING.equals(snapshot.state)) {
            btnPower.setBackgroundResource(R.drawable.bg_circle_power);
            ivPowerIcon.setColorFilter(requireContext().getColor(R.color.status_amber));
            tvVpnState.setText("正在断开…");
            tvVpnState.setTextColor(requireContext().getColor(R.color.status_amber));
        } else if (SingDeckVpnService.STATE_ERROR.equals(snapshot.state)) {
            btnPower.setBackgroundResource(R.drawable.bg_circle_power);
            ivPowerIcon.setColorFilter(requireContext().getColor(R.color.status_red));
            tvVpnState.setText("连接失败: " + snapshot.error);
            tvVpnState.setTextColor(requireContext().getColor(R.color.status_red));
        } else {
            btnPower.setBackgroundResource(R.drawable.bg_circle_power);
            ivPowerIcon.setColorFilter(requireContext().getColor(R.color.text_muted));
            tvVpnState.setText("点击开启代理加速");
            tvVpnState.setTextColor(requireContext().getColor(R.color.text_primary));
            tvDownloadSpeed.setText("0.0 B/s");
            tvUploadSpeed.setText("0.0 B/s");
            tvDuration.setText("00:00:00");
        }

        if (getActivity() instanceof MainActivity) {
            ((MainActivity) getActivity()).updateStatusBadge(isRunning);
        }
    }

    private void awaitOperation(long operationId, String action) {
        long deadline = System.currentTimeMillis() + 20_000;
        Runnable poll = new Runnable() {
            @Override
            public void run() {
                if (!isAdded() || !viewActive) {
                    return;
                }
                if (SingDeckVpnService.isOperationComplete(operationId)) {
                    String error = SingDeckVpnService.consumeOperationError(operationId);
                    if (error != null && !error.isEmpty()) {
                        Toast.makeText(
                                requireContext(),
                                action + "失败: " + error,
                                Toast.LENGTH_LONG
                        ).show();
                    }
                    refreshData();
                    return;
                }
                if (System.currentTimeMillis() >= deadline) {
                    Toast.makeText(requireContext(), action + "操作超时", Toast.LENGTH_LONG).show();
                    return;
                }
                timerHandler.postDelayed(this, 150);
            }
        };
        timerHandler.post(poll);
    }

    private void startStatusTimer() {
        timerHandler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (!isAdded() || !viewActive) return;
                CoreRuntimeSnapshot snapshot = SingDeckVpnService.getRuntimeSnapshot();
                boolean running = SingDeckVpnService.STATE_RUNNING.equals(snapshot.state);
                updateUiState(snapshot);
                refreshData();

                if (running) {
                    long startedAt = snapshot.startedAt;
                    if (startedAt > 0) {
                        long diff = (System.currentTimeMillis() - startedAt) / 1000;
                        long hrs = diff / 3600;
                        long mins = (diff % 3600) / 60;
                        long secs = diff % 60;
                        tvDuration.setText(String.format(Locale.US, "%02d:%02d:%02d", hrs, mins, secs));
                    }

                    double down = snapshot.downloadSpeed / 1024.0;
                    double up = snapshot.uploadSpeed / 1024.0;
                    tvDownloadSpeed.setText(formatRate(snapshot.downloadSpeed));
                    tvUploadSpeed.setText(formatRate(snapshot.uploadSpeed));
                    if (waveformSpeed != null) {
                        waveformSpeed.addSample(down, up);
                    }
                } else {
                    if (waveformSpeed != null) {
                        waveformSpeed.addSample(0.0, 0.0);
                    }
                }

                timerHandler.postDelayed(this, 1000);
            }
        }, 1000);
    }

    private String formatRate(long bytesPerSecond) {
        if (bytesPerSecond < 1024) {
            return bytesPerSecond + " B/s";
        }
        if (bytesPerSecond < 1024L * 1024L) {
            return String.format(Locale.US, "%.1f KiB/s", bytesPerSecond / 1024.0);
        }
        return String.format(Locale.US, "%.1f MiB/s", bytesPerSecond / (1024.0 * 1024.0));
    }

    @Override
    public void onDestroyView() {
        viewActive = false;
        if (profileManager != null && profileChangeListener != null) {
            profileManager.removeListener(profileChangeListener);
        }
        timerHandler.removeCallbacksAndMessages(null);
        super.onDestroyView();
    }
}
