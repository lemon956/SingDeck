package io.singdeck.app.ui.settings;

import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.DialogInterface;
import android.graphics.drawable.Drawable;
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
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import com.google.android.material.bottomsheet.BottomSheetDialogFragment;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import io.singdeck.app.R;
import io.singdeck.app.manager.SplitTunnelManager;

public class AppPickerBottomSheet extends BottomSheetDialogFragment {
    public static final String RESULT_KEY = "split_apps_changed";
    public static final String RESULT_SAVED = "saved";

    public static final class AppEntry {
        final String label;
        final String packageName;
        final Drawable icon;

        AppEntry(String label, String packageName, Drawable icon) {
            this.label = label;
            this.packageName = packageName;
            this.icon = icon;
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
    private AppAdapter adapter;
    private boolean saved;
    private boolean viewActive;

    public static AppPickerBottomSheet newInstance() {
        return new AppPickerBottomSheet();
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
        executor = Executors.newSingleThreadExecutor();
        RecyclerView rvAppList = view.findViewById(R.id.rv_app_list);
        etSearchApps = view.findViewById(R.id.et_search_apps);
        btnSaveApps = view.findViewById(R.id.btn_save_apps);
        tvPickerTitle = view.findViewById(R.id.tv_picker_title);

        SplitTunnelManager manager = SplitTunnelManager.getInstance(requireContext());
        currentSelected.addAll(manager.getSelectedPackages());
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
                manager.setSelectedPackages(currentSelected);
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
        return view;
    }

    @Override
    public void onDismiss(@NonNull DialogInterface dialog) {
        Bundle result = new Bundle();
        result.putBoolean(RESULT_SAVED, saved);
        getParentFragmentManager().setFragmentResult(RESULT_KEY, result);
        super.onDismiss(dialog);
    }

    @Override
    public void onDestroyView() {
        viewActive = false;
        mainHandler.removeCallbacksAndMessages(null);
        if (executor != null) {
            executor.shutdownNow();
            executor = null;
        }
        super.onDestroyView();
    }

    private void loadInstalledAppsAsync() {
        final PackageManager packageManager = requireContext().getPackageManager();
        executor.submit(() -> {
            List<AppEntry> loaded = new ArrayList<>();
            try {
                List<ApplicationInfo> installed = packageManager.getInstalledApplications(
                        PackageManager.GET_META_DATA
                );
                for (ApplicationInfo info : installed) {
                    boolean userApp = (info.flags & ApplicationInfo.FLAG_SYSTEM) == 0;
                    boolean browser = info.packageName.contains("chrome")
                            || info.packageName.contains("browser");
                    if (!userApp && !browser) {
                        continue;
                    }
                    loaded.add(new AppEntry(
                            packageManager.getApplicationLabel(info).toString(),
                            info.packageName,
                            packageManager.getApplicationIcon(info)
                    ));
                }
                Collections.sort(loaded, (left, right) ->
                        left.label.compareToIgnoreCase(right.label));
                mainHandler.post(() -> {
                    if (!viewActive || !isAdded()) {
                        return;
                    }
                    Set<String> visiblePackages = new HashSet<>();
                    for (AppEntry app : loaded) {
                        visiblePackages.add(app.packageName);
                    }
                    currentSelected.retainAll(visiblePackages);
                    allApps.clear();
                    allApps.addAll(loaded);
                    filterApps(etSearchApps.getText().toString());
                    tvPickerTitle.setText("选择分流应用");
                    btnSaveApps.setEnabled(true);
                });
            } catch (RuntimeException error) {
                mainHandler.post(() -> {
                    if (!viewActive || !isAdded()) {
                        return;
                    }
                    tvPickerTitle.setText("读取应用失败");
                    Toast.makeText(
                            requireContext(),
                            "读取已安装应用失败: " + error.getMessage(),
                            Toast.LENGTH_LONG
                    ).show();
                });
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
            holder.ivAppIcon.setImageDrawable(app.icon);
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
            final CheckBox cbAppSelected;

            ViewHolder(View itemView) {
                super(itemView);
                ivAppIcon = itemView.findViewById(R.id.iv_app_icon);
                tvAppLabel = itemView.findViewById(R.id.tv_app_label);
                tvAppPackage = itemView.findViewById(R.id.tv_app_package);
                cbAppSelected = itemView.findViewById(R.id.cb_app_selected);
            }
        }
    }
}
