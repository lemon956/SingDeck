package io.singdeck.app;

import android.os.Bundle;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.fragment.app.Fragment;
import androidx.viewpager2.adapter.FragmentStateAdapter;
import androidx.viewpager2.widget.ViewPager2;

import com.google.android.material.bottomnavigation.BottomNavigationView;

import io.singdeck.app.ui.connections.ConnectionsFragment;
import io.singdeck.app.ui.home.HomeFragment;
import io.singdeck.app.ui.proxies.ProxiesFragment;
import io.singdeck.app.ui.settings.SettingsFragment;

import android.content.res.Configuration;
import android.view.KeyEvent;
import com.google.android.material.navigationrail.NavigationRailView;

public class MainActivity extends AppCompatActivity {
    private static final String KEY_SELECTED_TAB = "selected_tab";

    private ViewPager2 viewPager;
    private BottomNavigationView bottomNavigationView;
    private NavigationRailView navigationRailView;
    private TextView tvStatusBadge;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        int initialTab = savedInstanceState != null ? savedInstanceState.getInt(KEY_SELECTED_TAB, 0) : 0;
        setupViews(initialTab);
        updateStatusBadge(SingDeckVpnService.isVpnRunning());
    }

    private void setupViews(int selectedTab) {
        viewPager = findViewById(R.id.view_pager);
        bottomNavigationView = findViewById(R.id.bottom_navigation);
        navigationRailView = findViewById(R.id.navigation_rail);
        tvStatusBadge = findViewById(R.id.tv_status_badge);

        viewPager.setAdapter(new MainPagerAdapter(this));
        viewPager.setOffscreenPageLimit(3);
        viewPager.setUserInputEnabled(false); // Disable swipe between tabs to protect inner horizontal scrolling

        // Sync ViewPager2 with whichever navigation widget is active
        viewPager.registerOnPageChangeCallback(new ViewPager2.OnPageChangeCallback() {
            @Override
            public void onPageSelected(int position) {
                int itemId;
                switch (position) {
                    case 1:
                        itemId = R.id.nav_proxies;
                        break;
                    case 2:
                        itemId = R.id.nav_connections;
                        break;
                    case 3:
                        itemId = R.id.nav_settings;
                        break;
                    default:
                        itemId = R.id.nav_home;
                        break;
                }
                if (bottomNavigationView != null && bottomNavigationView.getSelectedItemId() != itemId) {
                    bottomNavigationView.setSelectedItemId(itemId);
                }
                if (navigationRailView != null && navigationRailView.getSelectedItemId() != itemId) {
                    navigationRailView.setSelectedItemId(itemId);
                }
            }
        });

        if (bottomNavigationView != null) {
            bottomNavigationView.setOnItemSelectedListener(item -> handleNavSelection(item.getItemId()));
        }

        if (navigationRailView != null) {
            navigationRailView.setOnItemSelectedListener(item -> handleNavSelection(item.getItemId()));
        }

        viewPager.setCurrentItem(selectedTab, false);
    }

    private boolean handleNavSelection(int itemId) {
        if (itemId == R.id.nav_home) {
            viewPager.setCurrentItem(0, true);
            return true;
        } else if (itemId == R.id.nav_proxies) {
            viewPager.setCurrentItem(1, true);
            return true;
        } else if (itemId == R.id.nav_connections) {
            viewPager.setCurrentItem(2, true);
            return true;
        } else if (itemId == R.id.nav_settings) {
            viewPager.setCurrentItem(3, true);
            return true;
        }
        return false;
    }

    @Override
    protected void onSaveInstanceState(@NonNull Bundle outState) {
        super.onSaveInstanceState(outState);
        if (viewPager != null) {
            outState.putInt(KEY_SELECTED_TAB, viewPager.getCurrentItem());
        }
    }

    @Override
    public void onConfigurationChanged(@NonNull Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        int currentTab = viewPager != null ? viewPager.getCurrentItem() : 0;
        setContentView(R.layout.activity_main);
        setupViews(currentTab);
        updateStatusBadge(SingDeckVpnService.isVpnRunning());
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getAction() == KeyEvent.ACTION_DOWN && event.isCtrlPressed()) {
            int keyCode = event.getKeyCode();
            if (keyCode == KeyEvent.KEYCODE_1) {
                navigateToTab(0);
                return true;
            } else if (keyCode == KeyEvent.KEYCODE_2) {
                navigateToTab(1);
                return true;
            } else if (keyCode == KeyEvent.KEYCODE_3) {
                navigateToTab(2);
                return true;
            } else if (keyCode == KeyEvent.KEYCODE_4) {
                navigateToTab(3);
                return true;
            }
        }
        return super.dispatchKeyEvent(event);
    }

    public void navigateToTab(int position) {
        if (viewPager != null) {
            viewPager.setCurrentItem(position, true);
        }
    }

    public void updateStatusBadge(boolean isRunning) {
        if (tvStatusBadge != null) {
            if (isRunning) {
                tvStatusBadge.setText("RUNNING");
                tvStatusBadge.setTextColor(getColor(R.color.status_green));
                tvStatusBadge.setBackgroundResource(R.drawable.bg_badge_running);
            } else {
                tvStatusBadge.setText("IDLE");
                tvStatusBadge.setTextColor(getColor(R.color.text_muted));
                tvStatusBadge.setBackgroundResource(R.drawable.bg_badge_idle);
            }
        }
    }

    private static class MainPagerAdapter extends FragmentStateAdapter {
        MainPagerAdapter(@NonNull AppCompatActivity activity) {
            super(activity);
        }

        @NonNull
        @Override
        public Fragment createFragment(int position) {
            switch (position) {
                case 1:
                    return new ProxiesFragment();
                case 2:
                    return new ConnectionsFragment();
                case 3:
                    return new SettingsFragment();
                default:
                    return new HomeFragment();
            }
        }

        @Override
        public int getItemCount() {
            return 4;
        }
    }
}
