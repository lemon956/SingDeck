package io.singdeck.app.ui.settings;

import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.fragment.app.Fragment;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanOptions;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import io.singdeck.app.R;
import io.singdeck.app.SingDeckVpnService;
import io.singdeck.app.manager.ProfileManager;
import io.singdeck.app.manager.QrCodeHelper;
import io.singdeck.app.manager.MobileImportLink;
import io.singdeck.app.manager.SplitTunnelManager;
import io.singdeck.app.model.Profile;

public class SettingsFragment extends Fragment {
    private static final int MAX_IMPORT_BYTES = 20 * 1024 * 1024;
    private static final String DIRECT_TEMPLATE = "{\n"
            + "  \"inbounds\": [\n"
            + "    {\n"
            + "      \"type\": \"tun\",\n"
            + "      \"tag\": \"tun-in\",\n"
            + "      \"address\": [\"172.19.0.1/30\", \"fdfe:dcba:9876::1/126\"],\n"
            + "      \"auto_route\": true,\n"
            + "      \"strict_route\": true,\n"
            + "      \"stack\": \"system\"\n"
            + "    }\n"
            + "  ],\n"
            + "  \"outbounds\": [\n"
            + "    {\"type\": \"direct\", \"tag\": \"DIRECT\"}\n"
            + "  ],\n"
            + "  \"route\": {\n"
            + "    \"rules\": [{\"action\": \"sniff\"}],\n"
            + "    \"auto_detect_interface\": true,\n"
            + "    \"final\": \"DIRECT\"\n"
            + "  }\n"
            + "}";

    private Button btnQuickImportClipboard;
    private Button btnAddProfile;
    private Button btnScanQr;
    private Button btnScanGallery;
    private Button btnImportLocalFile;
    private Button btnBackupAll;
    private Button btnRestoreBackup;
    private TextView tvRouteRulesSummary;
    private Button btnEditActiveRoute;
    private RadioGroup rgSplitMode;
    private RadioButton rbSplitAll;
    private RadioButton rbSplitWhitelist;
    private RadioButton rbSplitBlacklist;
    private Button btnPickApps;

    private ProfileAdapter profileAdapter;
    private ProfileManager profileManager;
    private SplitTunnelManager splitTunnelManager;
    private ProfileManager.OnProfileChangeListener profileChangeListener;
    private ExecutorService ioExecutor;
    private Context appContext;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private boolean viewActive;
    private boolean suppressSplitModeChange;
    private boolean pendingWhitelistSelection;

    private ActivityResultLauncher<String> configFilePickerLauncher;
    private ActivityResultLauncher<String> backupFilePickerLauncher;
    private ActivityResultLauncher<String> galleryQrLauncher;
    private ActivityResultLauncher<ScanOptions> barcodeLauncher;

    @Override
    public void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        appContext = requireContext().getApplicationContext();
        ioExecutor = Executors.newSingleThreadExecutor();
        configFilePickerLauncher = registerForActivityResult(
                new ActivityResultContracts.GetContent(),
                uri -> {
                    if (uri != null) {
                        readConfigFromUri(uri);
                    }
                }
        );
        backupFilePickerLauncher = registerForActivityResult(
                new ActivityResultContracts.GetContent(),
                uri -> {
                    if (uri != null) {
                        readBackupFromUri(uri);
                    }
                }
        );
        galleryQrLauncher = registerForActivityResult(
                new ActivityResultContracts.GetContent(),
                uri -> {
                    if (uri != null) {
                        decodeGalleryQr(uri);
                    }
                }
        );
        barcodeLauncher = registerForActivityResult(
                new ScanContract(),
                result -> {
                    String contents = result.getContents();
                    if (contents != null && !contents.trim().isEmpty()) {
                        handleRawImportText(contents, "相机扫码");
                    }
                }
        );
    }

    @Nullable
    @Override
    public View onCreateView(
            @NonNull LayoutInflater inflater,
            @Nullable ViewGroup container,
            @Nullable Bundle savedInstanceState
    ) {
        View view = inflater.inflate(R.layout.fragment_settings, container, false);
        viewActive = true;
        btnQuickImportClipboard = view.findViewById(R.id.btn_quick_import_clipboard);
        btnAddProfile = view.findViewById(R.id.btn_add_profile);
        btnScanQr = view.findViewById(R.id.btn_scan_qr);
        btnScanGallery = view.findViewById(R.id.btn_scan_gallery);
        btnImportLocalFile = view.findViewById(R.id.btn_import_local_file);
        btnBackupAll = view.findViewById(R.id.btn_backup_all);
        btnRestoreBackup = view.findViewById(R.id.btn_restore_backup);
        RecyclerView rvProfiles = view.findViewById(R.id.rv_profiles);
        tvRouteRulesSummary = view.findViewById(R.id.tv_route_rules_summary);
        btnEditActiveRoute = view.findViewById(R.id.btn_edit_active_route);
        rgSplitMode = view.findViewById(R.id.rg_split_mode);
        rbSplitAll = view.findViewById(R.id.rb_split_all);
        rbSplitWhitelist = view.findViewById(R.id.rb_split_whitelist);
        rbSplitBlacklist = view.findViewById(R.id.rb_split_blacklist);
        btnPickApps = view.findViewById(R.id.btn_pick_apps);

        profileManager = ProfileManager.getInstance(requireContext());
        splitTunnelManager = SplitTunnelManager.getInstance(requireContext());
        rvProfiles.setLayoutManager(new LinearLayoutManager(requireContext()));
        profileAdapter = new ProfileAdapter(new ProfileActions());
        rvProfiles.setAdapter(profileAdapter);

        btnQuickImportClipboard.setOnClickListener(clicked -> handleQuickClipboardImport());
        btnAddProfile.setOnClickListener(clicked -> showCreateProfileDialog());
        btnScanQr.setOnClickListener(clicked -> launchCameraScanner());
        btnScanGallery.setOnClickListener(clicked -> galleryQrLauncher.launch("image/*"));
        btnImportLocalFile.setOnClickListener(clicked -> configFilePickerLauncher.launch("*/*"));
        btnBackupAll.setOnClickListener(clicked -> handleBackupAll());
        btnRestoreBackup.setOnClickListener(clicked -> backupFilePickerLauncher.launch("application/json"));
        btnEditActiveRoute.setOnClickListener(clicked -> {
            Profile active = profileManager.getActiveProfile();
            if (active == null) {
                toast("当前没有已激活配置", false);
            } else {
                showEditProfileDialog(active);
            }
        });

        View btnIgnoreBattery = view.findViewById(R.id.btn_ignore_battery);
        if (btnIgnoreBattery != null) {
            btnIgnoreBattery.setOnClickListener(v -> requestIgnoreBatteryOptimizations());
        }
        View btnHuaweiLaunch = view.findViewById(R.id.btn_huawei_launch_settings);
        if (btnHuaweiLaunch != null) {
            btnHuaweiLaunch.setOnClickListener(v -> openHuaweiLaunchSettings());
        }

        initSplitTunneling();
        profileChangeListener = this::updateList;
        profileManager.addListener(profileChangeListener);
        updateList();
        return view;
    }

    @Override
    public void onDestroyView() {
        viewActive = false;
        if (profileManager != null && profileChangeListener != null) {
            profileManager.removeListener(profileChangeListener);
        }
        mainHandler.removeCallbacksAndMessages(null);
        super.onDestroyView();
    }

    @Override
    public void onDestroy() {
        if (ioExecutor != null) {
            ioExecutor.shutdownNow();
        }
        super.onDestroy();
    }

    @Override
    public void onResume() {
        super.onResume();
        updateList();
    }

    private final class ProfileActions implements ProfileAdapter.OnProfileActionListener {
        @Override
        public void onActivate(Profile profile) {
            try {
                profileManager.activateProfile(profile.id);
                toast("已激活配置: " + profile.name, false);
                offerReconnectIfRunning(profile.id, "切换配置");
            } catch (RuntimeException error) {
                toast(error.getMessage(), true);
            }
        }

        @Override
        public void onEdit(Profile profile) {
            showEditProfileDialog(profile);
        }

        @Override
        public void onExport(Profile profile) {
            exportProfileToFile(profile);
        }

        @Override
        public void onRefresh(Profile profile) {
            toast("正在刷新订阅…", false);
            profileManager.refreshProfile(profile.id, new ProfileManager.OnAsyncResultCallback() {
                @Override
                public void onSuccess(Profile refreshed) {
                    toast("订阅刷新完成，共 " + refreshed.nodeCount + " 个节点", false);
                    if (profile.id.equals(SingDeckVpnService.getRunningProfileId())) {
                        offerReconnectIfRunning(profile.id, "刷新运行中的订阅");
                    }
                }

                @Override
                public void onError(String message) {
                    toast(message, true);
                }
            });
        }

        @Override
        public void onDelete(Profile profile) {
            if (SingDeckVpnService.isVpnRunning()
                    && profile.id.equals(SingDeckVpnService.getRunningProfileId())) {
                toast("该配置正在运行，请先断开 VPN 再删除", true);
                return;
            }
            new AlertDialog.Builder(requireContext())
                    .setTitle("确认删除")
                    .setMessage("是否确定删除配置文件「" + profile.name + "」？")
                    .setPositiveButton("删除", (dialog, which) -> profileManager.deleteProfile(profile.id))
                    .setNegativeButton("取消", null)
                    .show();
        }
    }

    private void launchCameraScanner() {
        ScanOptions options = new ScanOptions();
        options.setCaptureActivity(io.singdeck.app.ui.scanner.PortraitCaptureActivity.class);
        options.setOrientationLocked(false);
        options.setPrompt("请将订阅或节点二维码对准正方形取景框");
        options.setBeepEnabled(true);
        options.setBarcodeImageEnabled(false);
        barcodeLauncher.launch(options);
    }

    private void requestIgnoreBatteryOptimizations() {
        android.os.PowerManager pm = (android.os.PowerManager) requireContext().getSystemService(Context.POWER_SERVICE);
        if (pm != null && pm.isIgnoringBatteryOptimizations(requireContext().getPackageName())) {
            toast("当前已加入电池优化白名单（已忽略优化）", false);
            return;
        }
        try {
            Intent intent = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + requireContext().getPackageName()));
            startActivity(intent);
        } catch (Exception e) {
            try {
                Intent intent = new Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                startActivity(intent);
            } catch (Exception e2) {
                toast("请前往系统设置 -> 应用与服务 -> 电池优化 中添加白名单", true);
            }
        }
    }

    private void openHuaweiLaunchSettings() {
        try {
            Intent intent = new Intent();
            intent.setComponent(new android.content.ComponentName(
                    "com.huawei.systemmanager",
                    "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"
            ));
            startActivity(intent);
        } catch (Exception e1) {
            try {
                Intent intent = new Intent();
                intent.setComponent(new android.content.ComponentName(
                        "com.huawei.systemmanager",
                        "com.huawei.systemmanager.optimize.bootstart.BootStartActivity"
                ));
                startActivity(intent);
            } catch (Exception e2) {
                try {
                    Intent intent = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                    intent.setData(Uri.parse("package:" + requireContext().getPackageName()));
                    startActivity(intent);
                } catch (Exception e3) {
                    toast("未能打开系统管理，请在系统设置中搜索“应用启动管理”", true);
                }
            }
        }
    }

    private void decodeGalleryQr(Uri uri) {
        setImportButtonsEnabled(false);
        ioExecutor.submit(() -> {
            String text = QrCodeHelper.decodeUri(appContext, uri);
            mainHandler.post(() -> {
                if (!isAdded() || !viewActive) {
                    return;
                }
                setImportButtonsEnabled(true);
                if (text == null || text.trim().isEmpty()) {
                    toast("未在该图片中识别出有效二维码", true);
                } else {
                    handleRawImportText(text, "相册扫码");
                }
            });
        });
    }

    private void handleRawImportText(String raw, String sourceName) {
        if (raw == null || raw.trim().isEmpty()) {
            toast("导入内容为空", true);
            return;
        }
        String trimmed = raw.trim();
        String name = sourceName + "-" + (System.currentTimeMillis() % 10000);
        setImportButtonsEnabled(false);
        if (MobileImportLink.isRemoteProfileLink(trimmed)) {
            final MobileImportLink link;
            try {
                link = MobileImportLink.parse(trimmed);
            } catch (IllegalArgumentException error) {
                setImportButtonsEnabled(true);
                toast(error.getMessage(), true);
                return;
            }
            importRemoteProfile(link);
            return;
        }
        if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
            if (trimmed.contains("singdeck_settings=1")) {
                try {
                    importRemoteProfile(MobileImportLink.fromConfigUrl(trimmed, name));
                } catch (IllegalArgumentException error) {
                    setImportButtonsEnabled(true);
                    toast(error.getMessage(), true);
                }
                return;
            }
            profileManager.fetchAndAddSubscriptionUrl(
                    trimmed,
                    name,
                    new ProfileManager.OnAsyncResultCallback() {
                        @Override
                        public void onSuccess(Profile profile) {
                            setImportButtonsEnabled(true);
                            toast(
                                    "订阅导入并激活，共 " + profile.nodeCount + " 个节点（未自动连接）",
                                    false
                            );
                            offerReconnectIfRunning(profile.id, "导入新订阅");
                        }

                        @Override
                        public void onError(String message) {
                            setImportButtonsEnabled(true);
                            toast(message, true);
                        }
                    }
            );
            return;
        }

        ioExecutor.submit(() -> {
            try {
                String type = trimmed.startsWith("{") ? "raw" : "share-link";
                Profile profile = profileManager.addProfile(name, type, null, raw);
                mainHandler.post(() -> {
                    if (!isAdded() || !viewActive) {
                        return;
                    }
                    setImportButtonsEnabled(true);
                    toast("配置导入并激活（未自动连接）", false);
                    offerReconnectIfRunning(profile.id, "导入新配置");
                });
            } catch (RuntimeException error) {
                postImportError(error);
            }
        });
    }

    private void importRemoteProfile(MobileImportLink link) {
        profileManager.importRemoteProfile(link, new ProfileManager.OnRemoteImportCallback() {
            @Override
            public void onSuccess(ProfileManager.RemoteImportResult result) {
                if (!isAdded() || !viewActive) {
                    return;
                }
                setImportButtonsEnabled(true);
                if (result.warning == null) {
                    toast(
                            result.bootstrap == null
                                    ? "Config 导入并激活（未自动连接）"
                                    : "Config 与设置导入并激活（未自动连接）",
                            false
                    );
                } else {
                    toast("Config 已导入；" + result.warning, true);
                }
                offerReconnectIfRunning(result.profile.id, "导入远程配置");
            }

            @Override
            public void onError(String message) {
                if (!isAdded() || !viewActive) {
                    return;
                }
                setImportButtonsEnabled(true);
                toast(message, true);
            }
        });
    }

    private void handleQuickClipboardImport() {
        ClipboardManager clipboard = (ClipboardManager) requireContext().getSystemService(
                Context.CLIPBOARD_SERVICE
        );
        if (clipboard != null
                && clipboard.hasPrimaryClip()
                && clipboard.getPrimaryClip().getItemCount() > 0) {
            CharSequence text = clipboard.getPrimaryClip().getItemAt(0).coerceToText(requireContext());
            if (text != null && !text.toString().trim().isEmpty()) {
                handleRawImportText(text.toString(), "剪贴板导入");
                return;
            }
        }
        toast("剪贴板为空，请先复制订阅链接、节点链接或 JSON", true);
    }

    private void readConfigFromUri(Uri uri) {
        setImportButtonsEnabled(false);
        ioExecutor.submit(() -> {
            try {
                String content = readUri(uri);
                Profile profile = profileManager.addProfile(
                        "文件导入-" + (System.currentTimeMillis() % 10000),
                        "file",
                        null,
                        content
                );
                mainHandler.post(() -> {
                    if (!isAdded() || !viewActive) {
                        return;
                    }
                    setImportButtonsEnabled(true);
                    toast("文件导入并激活，共 " + profile.nodeCount + " 个节点", false);
                    offerReconnectIfRunning(profile.id, "导入本地配置");
                });
            } catch (Exception error) {
                postImportError(error);
            }
        });
    }

    private void readBackupFromUri(Uri uri) {
        setImportButtonsEnabled(false);
        ioExecutor.submit(() -> {
            try {
                String backup = readUri(uri);
                mainHandler.post(() -> {
                    if (!isAdded() || !viewActive) {
                        return;
                    }
                    setImportButtonsEnabled(true);
                    showRestoreModeDialog(backup);
                });
            } catch (Exception error) {
                postImportError(error);
            }
        });
    }

    private String readUri(Uri uri) throws Exception {
        try (InputStream input = appContext.getContentResolver().openInputStream(uri)) {
            if (input == null) {
                throw new IllegalArgumentException("无法打开所选文件");
            }
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int total = 0;
            int read;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > MAX_IMPORT_BYTES) {
                    throw new IllegalArgumentException("导入文件超过 20 MiB 限制");
                }
                output.write(buffer, 0, read);
            }
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private void showRestoreModeDialog(String backup) {
        new AlertDialog.Builder(requireContext())
                .setTitle("恢复配置备份")
                .setMessage("默认合并导入并跳过内容完全相同的配置；也可以清空现有配置后替换。")
                .setPositiveButton("合并导入", (dialog, which) -> restoreBackup(backup, false))
                .setNeutralButton("替换现有", (dialog, which) -> confirmReplaceBackup(backup))
                .setNegativeButton("取消", null)
                .show();
    }

    private void confirmReplaceBackup(String backup) {
        if (SingDeckVpnService.isVpnRunning()) {
            toast("替换全部配置前请先断开 VPN", true);
            return;
        }
        new AlertDialog.Builder(requireContext())
                .setTitle("确认替换全部配置")
                .setMessage("现有配置将在新备份完整校验并保存成功后删除。")
                .setPositiveButton("确认替换", (dialog, which) -> restoreBackup(backup, true))
                .setNegativeButton("取消", null)
                .show();
    }

    private void restoreBackup(String backup, boolean replace) {
        setImportButtonsEnabled(false);
        ioExecutor.submit(() -> {
            try {
                ProfileManager.RestoreResult result = profileManager.restoreBackupJson(backup, replace);
                mainHandler.post(() -> {
                    if (!isAdded() || !viewActive) {
                        return;
                    }
                    setImportButtonsEnabled(true);
                    toast(
                            "恢复完成：导入 " + result.importedCount
                                    + " 个，跳过 " + result.skippedCount + " 个",
                            false
                    );
                });
            } catch (RuntimeException error) {
                postImportError(error);
            }
        });
    }

    private void showCreateProfileDialog() {
        View content = LayoutInflater.from(requireContext()).inflate(
                R.layout.dialog_edit_profile,
                null
        );
        TextView title = content.findViewById(R.id.tv_dialog_title);
        EditText nameInput = content.findViewById(R.id.et_profile_name);
        EditText configInput = content.findViewById(R.id.et_profile_content);
        Button cancel = content.findViewById(R.id.btn_dialog_cancel);
        Button save = content.findViewById(R.id.btn_dialog_save);
        title.setText("新建 / 导入 sing-box 配置");
        nameInput.setText("自定义方案 " + (profileManager.getProfiles().size() + 1));
        configInput.setText(DIRECT_TEMPLATE);

        AlertDialog dialog = new AlertDialog.Builder(requireContext()).setView(content).create();
        cancel.setOnClickListener(clicked -> dialog.dismiss());
        save.setOnClickListener(clicked -> {
            String name = nameInput.getText().toString().trim();
            String config = configInput.getText().toString();
            if (name.isEmpty() || config.trim().isEmpty()) {
                toast("名称和内容不能为空", true);
                return;
            }
            save.setEnabled(false);
            ioExecutor.submit(() -> {
                try {
                    Profile profile = profileManager.addProfile(name, "raw", null, config);
                    mainHandler.post(() -> {
                        if (!isAdded() || !viewActive) {
                            return;
                        }
                        dialog.dismiss();
                        toast("配置已保存并激活（未自动连接）", false);
                        offerReconnectIfRunning(profile.id, "新建配置");
                    });
                } catch (RuntimeException error) {
                    mainHandler.post(() -> {
                        if (isAdded() && viewActive) {
                            save.setEnabled(true);
                            toast(error.getMessage(), true);
                        }
                    });
                }
            });
        });
        dialog.show();
    }

    private void showEditProfileDialog(Profile profile) {
        View content = LayoutInflater.from(requireContext()).inflate(
                R.layout.dialog_edit_profile,
                null
        );
        TextView title = content.findViewById(R.id.tv_dialog_title);
        EditText nameInput = content.findViewById(R.id.et_profile_name);
        EditText configInput = content.findViewById(R.id.et_profile_content);
        Button cancel = content.findViewById(R.id.btn_dialog_cancel);
        Button save = content.findViewById(R.id.btn_dialog_save);
        title.setText("修改配置: " + profile.name);
        nameInput.setText(profile.name);
        configInput.setText(profile.content);

        AlertDialog dialog = new AlertDialog.Builder(requireContext()).setView(content).create();
        cancel.setOnClickListener(clicked -> dialog.dismiss());
        save.setOnClickListener(clicked -> {
            String name = nameInput.getText().toString().trim();
            String config = configInput.getText().toString();
            if (name.isEmpty() || config.trim().isEmpty()) {
                toast("名称和内容不能为空", true);
                return;
            }
            save.setEnabled(false);
            ioExecutor.submit(() -> {
                try {
                    profileManager.updateProfile(profile.id, name, config);
                    mainHandler.post(() -> {
                        if (!isAdded() || !viewActive) {
                            return;
                        }
                        dialog.dismiss();
                        toast("配置已保存；运行状态未自动改变", false);
                        if (profile.id.equals(SingDeckVpnService.getRunningProfileId())) {
                            offerReconnectIfRunning(profile.id, "修改运行中的配置");
                        }
                    });
                } catch (RuntimeException error) {
                    mainHandler.post(() -> {
                        if (isAdded() && viewActive) {
                            save.setEnabled(true);
                            toast(error.getMessage(), true);
                        }
                    });
                }
            });
        });
        dialog.show();
    }

    private void exportProfileToFile(Profile profile) {
        ioExecutor.submit(() -> {
            try {
                File directory = new File(appContext.getCacheDir(), "exports");
                if (!directory.exists() && !directory.mkdirs()) {
                    throw new IllegalStateException("无法创建导出目录");
                }
                String safeName = profile.name.replaceAll("[^a-zA-Z0-9_-]", "_");
                File file = new File(directory, "singbox_config_" + safeName + ".json");
                writeFile(file, profile.content);
                mainHandler.post(() -> shareJson(file, "导出 sing-box 配置文件"));
            } catch (Exception error) {
                mainHandler.post(() -> copyProfileFallback(profile, error));
            }
        });
    }

    private void handleBackupAll() {
        btnBackupAll.setEnabled(false);
        ioExecutor.submit(() -> {
            try {
                String backup = profileManager.createBackupJson();
                File directory = new File(appContext.getCacheDir(), "exports");
                if (!directory.exists() && !directory.mkdirs()) {
                    throw new IllegalStateException("无法创建备份目录");
                }
                File file = new File(
                        directory,
                        "singdeck_backup_" + System.currentTimeMillis() + ".json"
                );
                writeFile(file, backup);
                mainHandler.post(() -> {
                    if (!isAdded() || !viewActive) {
                        return;
                    }
                    btnBackupAll.setEnabled(true);
                    shareJson(file, "备份 SingDeck 全部配置");
                });
            } catch (Exception error) {
                mainHandler.post(() -> {
                    if (isAdded() && viewActive) {
                        btnBackupAll.setEnabled(true);
                        toast("备份失败: " + error.getMessage(), true);
                    }
                });
            }
        });
    }

    private void writeFile(File file, String content) throws Exception {
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write((content == null ? "" : content).getBytes(StandardCharsets.UTF_8));
            output.flush();
            output.getFD().sync();
        }
    }

    private void shareJson(File file, String title) {
        if (!isAdded() || !viewActive) {
            return;
        }
        Uri uri = FileProvider.getUriForFile(
                requireContext(),
                requireContext().getPackageName() + ".fileprovider",
                file
        );
        Intent shareIntent = new Intent(Intent.ACTION_SEND)
                .setType("application/json")
                .putExtra(Intent.EXTRA_STREAM, uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        startActivity(Intent.createChooser(shareIntent, title));
    }

    private void copyProfileFallback(Profile profile, Throwable error) {
        if (!isAdded() || !viewActive) {
            return;
        }
        ClipboardManager clipboard = (ClipboardManager) requireContext().getSystemService(
                Context.CLIPBOARD_SERVICE
        );
        if (clipboard == null) {
            toast("导出失败: " + error.getMessage(), true);
            return;
        }
        clipboard.setPrimaryClip(ClipData.newPlainText("sing-box config", profile.content));
        toast("文件导出失败，已将配置复制到剪贴板", true);
    }

    private void initSplitTunneling() {
        applySplitModeCheck(splitTunnelManager.getMode());
        updateAppPickerButtonLabel();
        getParentFragmentManager().setFragmentResultListener(
                AppPickerBottomSheet.RESULT_KEY,
                this,
                (requestKey, result) -> {
                    if (!viewActive) {
                        pendingWhitelistSelection = false;
                        return;
                    }
                    if (!result.getBoolean(AppPickerBottomSheet.RESULT_SAVED, false)) {
                        pendingWhitelistSelection = false;
                        return;
                    }
                    updateAppPickerButtonLabel();
                    if (pendingWhitelistSelection
                            && !splitTunnelManager.getSelectedPackages().isEmpty()) {
                        pendingWhitelistSelection = false;
                        splitTunnelManager.setMode("whitelist");
                        applySplitModeCheck("whitelist");
                        offerApplySplitIfRunning();
                    } else if (!"global".equals(splitTunnelManager.getMode())) {
                        offerApplySplitIfRunning();
                    }
                }
        );
        rgSplitMode.setOnCheckedChangeListener((group, checkedId) -> {
            if (suppressSplitModeChange) {
                return;
            }
            String requested = checkedId == R.id.rb_split_whitelist
                    ? "whitelist"
                    : checkedId == R.id.rb_split_blacklist ? "blacklist" : "global";
            if ("whitelist".equals(requested)
                    && splitTunnelManager.getSelectedPackages().isEmpty()) {
                pendingWhitelistSelection = true;
                applySplitModeCheck(splitTunnelManager.getMode());
                new AlertDialog.Builder(requireContext())
                        .setTitle("白名单不能为空")
                        .setMessage("请先选择至少一个进入 VPN 的应用。")
                        .setPositiveButton("选择应用", (dialog, which) -> showAppPicker())
                        .setNegativeButton("取消", (dialog, which) ->
                                pendingWhitelistSelection = false)
                        .show();
                return;
            }
            try {
                splitTunnelManager.setMode(requested);
                offerApplySplitIfRunning();
            } catch (RuntimeException error) {
                applySplitModeCheck(splitTunnelManager.getMode());
                toast(error.getMessage(), true);
            }
        });
        btnPickApps.setOnClickListener(clicked -> showAppPicker());
    }

    private void showAppPicker() {
        AppPickerBottomSheet.newInstance().show(getParentFragmentManager(), "app_picker");
    }

    private void applySplitModeCheck(String mode) {
        suppressSplitModeChange = true;
        if ("whitelist".equals(mode)) {
            rbSplitWhitelist.setChecked(true);
        } else if ("blacklist".equals(mode)) {
            rbSplitBlacklist.setChecked(true);
        } else {
            rbSplitAll.setChecked(true);
        }
        suppressSplitModeChange = false;
    }

    private void updateAppPickerButtonLabel() {
        Set<String> packages = splitTunnelManager.getSelectedPackages();
        btnPickApps.setText("选择分流应用清单 (" + packages.size() + " 个已选)");
    }

    private void offerApplySplitIfRunning() {
        if (!isAdded() || !viewActive || !SingDeckVpnService.isVpnRunning()) {
            return;
        }
        String profileId = SingDeckVpnService.getRunningProfileId();
        new AlertDialog.Builder(requireContext())
                .setTitle("应用分流设置已保存")
                .setMessage("当前连接仍使用旧设置。是否立即重连应用新设置？")
                .setPositiveButton("立即重连", (dialog, which) -> reloadVpn(profileId))
                .setNegativeButton("稍后", null)
                .show();
    }

    private void offerReconnectIfRunning(String profileId, String reason) {
        if (!isAdded() || !viewActive || !SingDeckVpnService.isVpnRunning()) {
            return;
        }
        new AlertDialog.Builder(requireContext())
                .setTitle(reason + "已保存")
                .setMessage("当前 VPN 不会自动切换。是否立即使用该配置重连？")
                .setPositiveButton("立即重连", (dialog, which) -> reloadVpn(profileId))
                .setNegativeButton("稍后", null)
                .show();
    }

    private void reloadVpn(String profileId) {
        long operationId = SingDeckVpnService.newOperationId();
        Intent intent = new Intent(requireContext(), SingDeckVpnService.class)
                .setAction(SingDeckVpnService.ACTION_RELOAD)
                .putExtra(SingDeckVpnService.EXTRA_PROFILE_ID, profileId)
                .putExtra(SingDeckVpnService.EXTRA_SPLIT_MODE, splitTunnelManager.getMode())
                .putStringArrayListExtra(
                        SingDeckVpnService.EXTRA_PACKAGES,
                        splitTunnelManager.getSelectedPackagesList()
                )
                .putExtra(SingDeckVpnService.EXTRA_OPERATION_ID, operationId);
        ContextCompat.startForegroundService(requireContext(), intent);
        awaitOperation(operationId, "重连");
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
                    toast(
                            error == null || error.isEmpty()
                                    ? action + "成功"
                                    : action + "失败: " + error,
                            error != null && !error.isEmpty()
                    );
                    updateList();
                    return;
                }
                if (System.currentTimeMillis() >= deadline) {
                    toast(action + "操作超时", true);
                    return;
                }
                mainHandler.postDelayed(this, 150);
            }
        };
        mainHandler.post(poll);
    }

    private void updateList() {
        if (!isAdded() || !viewActive) {
            return;
        }
        profileAdapter.updateData(profileManager.getProfiles());
        tvRouteRulesSummary.setText(profileManager.getRouteRulesSummary());
        btnEditActiveRoute.setEnabled(profileManager.getActiveProfile() != null);
    }

    private void setImportButtonsEnabled(boolean enabled) {
        if (!isAdded() || !viewActive) {
            return;
        }
        btnQuickImportClipboard.setEnabled(enabled);
        btnAddProfile.setEnabled(enabled);
        btnScanQr.setEnabled(enabled);
        btnScanGallery.setEnabled(enabled);
        btnImportLocalFile.setEnabled(enabled);
        btnRestoreBackup.setEnabled(enabled);
    }

    private void postImportError(Throwable error) {
        mainHandler.post(() -> {
            if (isAdded() && viewActive) {
                setImportButtonsEnabled(true);
                toast(error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage(), true);
            }
        });
    }

    private void toast(String message, boolean longDuration) {
        if (isAdded() && viewActive) {
            Toast.makeText(
                    requireContext(),
                    message == null ? "未知错误" : message,
                    longDuration ? Toast.LENGTH_LONG : Toast.LENGTH_SHORT
            ).show();
        }
    }
}
