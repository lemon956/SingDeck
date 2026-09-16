package io.singdeck.app.ui.settings;

import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.Context;
import android.content.DialogInterface;
import android.graphics.drawable.Drawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import com.google.android.material.bottomsheet.BottomSheetDialogFragment;
import com.google.android.material.bottomsheet.BottomSheetDialog;
import com.google.android.material.bottomsheet.BottomSheetBehavior;

import java.io.InputStream;
import java.text.DateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import io.singdeck.app.R;
import io.singdeck.app.manager.HarmonyAppInventoryCodec;
import io.singdeck.app.manager.HarmonyAppInventoryStore;
import io.singdeck.app.manager.SplitTunnelManager;

public class AppPickerBottomSheet extends BottomSheetDialogFragment {
    public static final String RESULT_KEY = "split_apps_changed";
    public static final String RESULT_SAVED = "saved";
    private static final String ARG_INVENTORY = "inventory";

    public static final class AppEntry {
        final String label;
        final String packageName;
        final Drawable icon;
        final String source;

        AppEntry(String label, String packageName, Drawable icon, String source) {
            this.label = label;
            this.packageName = packageName;
            this.icon = icon;
            this.source = source;
        }
    }

    private final List<AppEntry> allApps = new ArrayList<>();
    private final List<AppEntry> filteredApps = new ArrayList<>();
    private final Set<String> currentSelected = new HashSet<>();
    private ExecutorService executor;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private EditText etSearchApps;
    private Button btnSaveApps;
    private TextView tvPickerTitle;
    private TextView tvInventoryStatus;
    private TextView tvEmptyApps;
    private Button btnImportInventory;
    private Button btnClearInventory;
    private Context appContext;
    private HarmonyAppInventoryStore inventoryStore;
    private ActivityResultLauncher<String> inventoryFilePicker;
    private boolean inventoryMode;
    private int viewGeneration;
    private AppAdapter adapter;
    private boolean saved;
    private boolean viewActive;

    public static AppPickerBottomSheet newInstance() {
        return new AppPickerBottomSheet();
    }

    public static AppPickerBottomSheet newInventoryInstance() {
        AppPickerBottomSheet sheet = new AppPickerBottomSheet();
        Bundle args = new Bundle();
        args.putBoolean(ARG_INVENTORY, true);
        sheet.setArguments(args);
        return sheet;
    }

    @Override
    public void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        inventoryMode = getArguments() != null && getArguments().getBoolean(ARG_INVENTORY);
        appContext = requireContext().getApplicationContext();
        inventoryStore = new HarmonyAppInventoryStore(appContext);
        executor = Executors.newSingleThreadExecutor();
        inventoryFilePicker = registerForActivityResult(new ActivityResultContracts.GetContent(),
                uri -> {
                    if (uri != null) {
                        importInventory(uri);
                    }
                });
    }

    @Nullable
    @Override
    public View onCreateView(
            @NonNull LayoutInflater inflater,
            @Nullable ViewGroup container,
            @Nullable Bundle savedInstanceState
    ) {
        View view = inflater.inflate(R.layout.bottom_sheet_app_picker, container, false);
        viewActive = true;
        viewGeneration++;
        RecyclerView rvAppList = view.findViewById(R.id.rv_app_list);
        etSearchApps = view.findViewById(R.id.et_search_apps);
        btnSaveApps = view.findViewById(R.id.btn_save_apps);
        tvPickerTitle = view.findViewById(R.id.tv_picker_title);
        tvInventoryStatus = view.findViewById(R.id.tv_inventory_status);
        tvEmptyApps = view.findViewById(R.id.tv_empty_apps);
        btnImportInventory = view.findViewById(R.id.btn_import_inventory);
        btnClearInventory = view.findViewById(R.id.btn_clear_inventory);
        view.findViewById(R.id.inventory_controls).setVisibility(
                inventoryMode ? View.VISIBLE : View.GONE);
        btnSaveApps.setVisibility(inventoryMode ? View.GONE : View.VISIBLE);
        if (inventoryMode) {
            LinearLayout.LayoutParams params = (LinearLayout.LayoutParams) rvAppList.getLayoutParams();
            params.height = 0;
            params.weight = 1;
            rvAppList.setLayoutParams(params);
        }

        currentSelected.clear();
        if (!inventoryMode) {
            currentSelected.addAll(SplitTunnelManager.getInstance(appContext).getSelectedPackages());
        }
        rvAppList.setLayoutManager(new LinearLayoutManager(requireContext()));
        adapter = new AppAdapter();
        rvAppList.setAdapter(adapter);
        btnSaveApps.setEnabled(false);
        tvPickerTitle.setText("正在读取已安装应用…");
        loadInstalledAppsAsync();

        etSearchApps.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence value, int start, int count, int after) {
            }

            @Override
            public void onTextChanged(CharSequence value, int start, int before, int count) {
                filterApps(value.toString());
            }

            @Override
            public void afterTextChanged(Editable value) {
            }
        });
        btnSaveApps.setOnClickListener(clicked -> {
            try {
                SplitTunnelManager.getInstance(appContext).setSelectedPackages(currentSelected);
                saved = true;
                Toast.makeText(
                        requireContext(),
                        "已保存分流应用 (" + currentSelected.size() + " 个)",
                        Toast.LENGTH_SHORT
                ).show();
                dismiss();
            } catch (RuntimeException error) {
                Toast.makeText(requireContext(), error.getMessage(), Toast.LENGTH_LONG).show();
            }
        });
        btnImportInventory.setOnClickListener(clicked -> {
            try {
                inventoryFilePicker.launch("*/*");
            } catch (RuntimeException error) {
                Toast.makeText(appContext, "无法打开文件选择器：" + error.getMessage(),
                        Toast.LENGTH_LONG).show();
            }
        });
        btnClearInventory.setOnClickListener(clicked -> clearInventory());
        return view;
    }

    @Override
    public void onStart() {
        super.onStart();
        if (inventoryMode && getDialog() instanceof BottomSheetDialog) {
            BottomSheetDialog dialog = (BottomSheetDialog) getDialog();
            View sheet = dialog.findViewById(com.google.android.material.R.id.design_bottom_sheet);
            if (sheet != null) {
                sheet.getLayoutParams().height = ViewGroup.LayoutParams.MATCH_PARENT;
                sheet.requestLayout();
                dialog.getBehavior().setState(BottomSheetBehavior.STATE_EXPANDED);
            }
        }
    }

    @Override
    public void onDismiss(@NonNull DialogInterface dialog) {
        if (!inventoryMode) {
            Bundle result = new Bundle();
            result.putBoolean(RESULT_SAVED, saved);
            getParentFragmentManager().setFragmentResult(RESULT_KEY, result);
        }
        super.onDismiss(dialog);
    }

    @Override
    public void onDestroyView() {
        viewActive = false;
        viewGeneration++;
        mainHandler.removeCallbacksAndMessages(null);
        super.onDestroyView();
    }

    @Override
    public void onDestroy() {
        if (executor != null) {
            executor.shutdownNow();
            executor = null;
        }
        super.onDestroy();
    }

    private void loadInstalledAppsAsync() {
        final PackageManager packageManager = appContext.getPackageManager();
        final int generation = viewGeneration;
        setInventoryButtonsEnabled(false);
        executor.submit(() -> {
            List<AppEntry> loaded = new ArrayList<>();
            String androidError = "";
            try {
                List<ApplicationInfo> installed = packageManager.getInstalledApplications(
                        PackageManager.GET_META_DATA
                );
                for (ApplicationInfo info : installed) {
                    boolean userApp = (info.flags & ApplicationInfo.FLAG_SYSTEM) == 0;
                    boolean browser = info.packageName.contains("chrome")
                            || info.packageName.contains("browser");
                    if (!inventoryMode && !userApp && !browser) {
                        continue;
                    }
                    loaded.add(new AppEntry(
                            packageManager.getApplicationLabel(info).toString(),
                            info.packageName,
                            packageManager.getApplicationIcon(info),
                            "Android" + (userApp ? "" : " · 系统应用")
                    ));
                }
            } catch (RuntimeException error) {
                loaded.clear();
                androidError = "读取 Android 应用失败：" + error.getMessage();
                if (!inventoryMode) {
                    String message = androidError;
                    postForView(generation, () -> {
                        tvPickerTitle.setText("读取应用失败");
                        Toast.makeText(appContext, message, Toast.LENGTH_LONG).show();
                    });
                    return;
                }
            }
            String status = "";
            boolean hasCache = false;
            if (inventoryMode) {
                int androidCount = loaded.size();
                try {
                    HarmonyAppInventoryCodec.Inventory inventory = inventoryStore.read();
                    hasCache = inventory != null;
                    if (inventory == null) {
                        status = "Android " + androidCount + " 个 · 尚未导入鸿蒙清单\n"
                                + "在电脑采集后导入；安装或卸载鸿蒙应用后需重新采集。";
                    } else {
                        Drawable icon = appContext.getDrawable(R.drawable.ic_inventory_app);
                        for (HarmonyAppInventoryCodec.App app : inventory.apps) {
                            // 来源不同的同名包保留两条记录，鸿蒙标识不能进入 Android 分流配置。
                            loaded.add(new AppEntry(app.label, app.bundleName, icon,
                                    "鸿蒙 · 已导入" + (app.systemApp ? " · 系统应用" : "")
                                            + (app.versionName.isEmpty() ? "" : " · " + app.versionName)));
                        }
                        status = "Android " + androidCount + " 个 · 鸿蒙 " + inventory.apps.size()
                                + " 个（含系统应用）\n来源：" + inventory.deviceModel
                                + " · 用户 " + inventory.userId + "\n采集："
                                + DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT)
                                .format(new Date(inventory.collectedAt)) + "（需手动更新）";
                    }
                } catch (Exception error) {
                    hasCache = true;
                    status = "鸿蒙清单读取失败，请重新导入：" + error.getMessage();
                }
                if (!androidError.isEmpty()) {
                    status = androidError + "\n" + status;
                }
            }
            Collections.sort(loaded, (left, right) -> {
                int labelOrder = left.label.compareToIgnoreCase(right.label);
                return labelOrder != 0 ? labelOrder : left.packageName.compareTo(right.packageName);
            });
            final String inventoryStatus = status;
            final boolean cacheAvailable = hasCache;
            postForView(generation, () -> {
                if (!inventoryMode) {
                    Set<String> visiblePackages = new HashSet<>();
                    for (AppEntry app : loaded) {
                        visiblePackages.add(app.packageName);
                    }
                    currentSelected.retainAll(visiblePackages);
                }
                allApps.clear();
                allApps.addAll(loaded);
                filterApps(etSearchApps.getText().toString());
                tvPickerTitle.setText(inventoryMode
                        ? "手机应用清单 (" + loaded.size() + ")" : "选择分流应用");
                tvInventoryStatus.setText(inventoryStatus);
                btnSaveApps.setEnabled(true);
                btnImportInventory.setEnabled(true);
                btnClearInventory.setEnabled(cacheAvailable);
            });
        });
    }

    private void importInventory(Uri uri) {
        final int generation = viewGeneration;
        setInventoryButtonsEnabled(false);
        executor.submit(() -> {
            try (InputStream input = appContext.getContentResolver().openInputStream(uri)) {
                if (input == null) {
                    throw new IllegalArgumentException("无法打开所选文件");
                }
                HarmonyAppInventoryCodec.Inventory inventory = inventoryStore.importFrom(input);
                postForView(generation, () -> {
                    Toast.makeText(appContext, "已导入 " + inventory.apps.size() + " 个鸿蒙应用",
                            Toast.LENGTH_SHORT).show();
                    loadInstalledAppsAsync();
                });
            } catch (Exception error) {
                postForView(generation, () -> {
                    Toast.makeText(appContext, "导入失败，原清单已保留：" + error.getMessage(),
                            Toast.LENGTH_LONG).show();
                    loadInstalledAppsAsync();
                });
            }
        });
    }

    private void clearInventory() {
        final int generation = viewGeneration;
        setInventoryButtonsEnabled(false);
        executor.submit(() -> {
            try {
                inventoryStore.clear();
                postForView(generation, this::loadInstalledAppsAsync);
            } catch (Exception error) {
                postForView(generation, () -> {
                    Toast.makeText(appContext, error.getMessage(), Toast.LENGTH_LONG).show();
                    loadInstalledAppsAsync();
                });
            }
        });
    }

    private void setInventoryButtonsEnabled(boolean enabled) {
        if (viewActive) {
            btnImportInventory.setEnabled(enabled);
            btnClearInventory.setEnabled(enabled);
        }
    }

    private void postForView(int generation, Runnable action) {
        mainHandler.post(() -> {
            // 文件选择器返回、关闭或重建视图后，旧任务不能覆盖新的列表状态。
            if (viewActive && isAdded() && generation == viewGeneration) {
                action.run();
            }
        });
    }

    private void filterApps(String query) {
        String normalized = query.trim().toLowerCase(Locale.ROOT);
        filteredApps.clear();
        for (AppEntry app : allApps) {
            if (normalized.isEmpty()
                    || app.label.toLowerCase(Locale.ROOT).contains(normalized)
                    || app.packageName.toLowerCase(Locale.ROOT).contains(normalized)) {
                filteredApps.add(app);
            }
        }
        if (adapter != null) {
            adapter.notifyDataSetChanged();
        }
        tvEmptyApps.setVisibility(filteredApps.isEmpty() ? View.VISIBLE : View.GONE);
    }

    private void toggleSelection(AppEntry app) {
        if (!currentSelected.remove(app.packageName)) {
            currentSelected.add(app.packageName);
        }
        adapter.notifyDataSetChanged();
    }

    private final class AppAdapter extends RecyclerView.Adapter<AppAdapter.ViewHolder> {
        @NonNull
        @Override
        public ViewHolder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
            View view = LayoutInflater.from(parent.getContext()).inflate(
                    R.layout.item_app_picker,
                    parent,
                    false
            );
            return new ViewHolder(view);
        }

        @Override
        public void onBindViewHolder(@NonNull ViewHolder holder, int position) {
            AppEntry app = filteredApps.get(position);
            holder.tvAppLabel.setText(app.label);
            holder.tvAppPackage.setText(app.packageName);
            holder.tvAppSource.setText(app.source);
            holder.tvAppSource.setVisibility(inventoryMode ? View.VISIBLE : View.GONE);
            holder.ivAppIcon.setImageDrawable(app.icon);
            holder.cbAppSelected.setVisibility(inventoryMode ? View.GONE : View.VISIBLE);
            if (inventoryMode) {
                holder.cbAppSelected.setOnClickListener(null);
                holder.itemView.setOnClickListener(null);
                holder.itemView.setClickable(false);
                holder.itemView.setContentDescription(app.label + "，" + app.packageName
                        + "，" + app.source);
                return;
            }
            holder.cbAppSelected.setOnCheckedChangeListener(null);
            holder.cbAppSelected.setChecked(currentSelected.contains(app.packageName));
            holder.cbAppSelected.setOnClickListener(view -> toggleSelection(app));
            holder.itemView.setOnClickListener(view -> toggleSelection(app));
            holder.itemView.setContentDescription(
                    (currentSelected.contains(app.packageName) ? "取消选择 " : "选择 ")
                            + app.label
            );
        }

        @Override
        public int getItemCount() {
            return filteredApps.size();
        }

        private final class ViewHolder extends RecyclerView.ViewHolder {
            final ImageView ivAppIcon;
            final TextView tvAppLabel;
            final TextView tvAppPackage;
            final TextView tvAppSource;
            final CheckBox cbAppSelected;

            ViewHolder(View itemView) {
                super(itemView);
                ivAppIcon = itemView.findViewById(R.id.iv_app_icon);
                tvAppLabel = itemView.findViewById(R.id.tv_app_label);
                tvAppPackage = itemView.findViewById(R.id.tv_app_package);
                tvAppSource = itemView.findViewById(R.id.tv_app_source);
                cbAppSelected = itemView.findViewById(R.id.cb_app_selected);
            }
        }
    }
}
