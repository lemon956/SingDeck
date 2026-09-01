package io.singdeck.app.manager;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

public class SplitTunnelManager {
    private static final String PREF_NAME = "singdeck_split_tunnel";
    private static final String KEY_MODE = "split_mode";
    private static final String KEY_PACKAGES = "split_packages";

    private static SplitTunnelManager instance;
    private final SharedPreferences prefs;

    private SplitTunnelManager(Context context) {
        prefs = context.getApplicationContext().getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
    }

    public static synchronized SplitTunnelManager getInstance(Context context) {
        if (instance == null) {
            instance = new SplitTunnelManager(context);
        }
        return instance;
    }

    public synchronized String getMode() {
        return prefs.getString(KEY_MODE, "global");
    }

    public synchronized void setMode(String mode) {
        setConfiguration(mode, getSelectedPackages());
    }

    public synchronized Set<String> getSelectedPackages() {
        return new HashSet<>(prefs.getStringSet(KEY_PACKAGES, new HashSet<>()));
    }

    public synchronized void setSelectedPackages(Set<String> packages) {
        setConfiguration(getMode(), packages);
    }

    public synchronized void setConfiguration(String mode, Set<String> packages) {
        String normalizedMode = mode == null ? "global" : mode.trim().toLowerCase(Locale.ROOT);
        if (!"global".equals(normalizedMode)
                && !"whitelist".equals(normalizedMode)
                && !"blacklist".equals(normalizedMode)) {
            throw new IllegalArgumentException("未知的分应用代理模式：" + mode);
        }
        Set<String> normalizedPackages = new HashSet<>();
        if (packages != null) {
            for (String packageName : packages) {
                if (packageName != null && !packageName.trim().isEmpty()) {
                    normalizedPackages.add(packageName.trim());
                }
            }
        }
        if ("whitelist".equals(normalizedMode) && normalizedPackages.isEmpty()) {
            throw new IllegalArgumentException("白名单模式至少需要选择一个应用");
        }
        if (!prefs.edit()
                .putString(KEY_MODE, normalizedMode)
                .putStringSet(KEY_PACKAGES, normalizedPackages)
                .commit()) {
            throw new IllegalStateException("分应用代理设置保存失败");
        }
    }

    public synchronized ArrayList<String> getSelectedPackagesList() {
        return new ArrayList<>(getSelectedPackages());
    }
}
