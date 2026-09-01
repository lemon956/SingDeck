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

public class MainActivity extends AppCompatActivity {
    private ViewPager2 viewPager;
    private BottomNavigationView bottomNavigationView;
    private TextView tvStatusBadge;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        viewPager = findViewById(R.id.view_pager);
        bottomNavigationView = findViewById(R.id.bottom_navigation);
        tvStatusBadge = findViewById(R.id.tv_status_badge);

        viewPager.setAdapter(new MainPagerAdapter(this));
        viewPager.setOffscreenPageLimit(3);

        // Sync ViewPager2 with BottomNavigationView
        viewPager.registerOnPageChangeCallback(new ViewPager2.OnPageChangeCallback() {
            @Override
            public void onPageSelected(int position) {
                switch (position) {
                    case 0:
                        bottomNavigationView.setSelectedItemId(R.id.nav_home);
                        break;
                    case 1:
                        bottomNavigationView.setSelectedItemId(R.id.nav_proxies);
                        break;
                    case 2:
                        bottomNavigationView.setSelectedItemId(R.id.nav_connections);
                        break;
                    case 3:
                        bottomNavigationView.setSelectedItemId(R.id.nav_settings);
                        break;
                }
            }
        });

        bottomNavigationView.setOnItemSelectedListener(item -> {
            int itemId = item.getItemId();
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
        });

        updateStatusBadge(SingDeckVpnService.isVpnRunning());
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
