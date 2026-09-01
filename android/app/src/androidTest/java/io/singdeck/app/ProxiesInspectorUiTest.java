package io.singdeck.app;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import androidx.fragment.app.Fragment;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import com.google.android.material.bottomsheet.BottomSheetDialog;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.lang.reflect.Field;

import io.singdeck.app.ui.proxies.ProxiesFragment;

@RunWith(AndroidJUnit4.class)
public class ProxiesInspectorUiTest {
    @Test
    public void opensNativeInspectorFromProxiesTab() {
        ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class);
        scenario.onActivity(activity -> {
            activity.navigateToTab(1);
            ProxiesFragment proxies = null;
            for (Fragment fragment : activity.getSupportFragmentManager().getFragments()) {
                if (fragment instanceof ProxiesFragment) {
                    proxies = (ProxiesFragment) fragment;
                    break;
                }
            }
            assertNotNull(proxies);
            assertNotNull(proxies.getView());
            assertTrue(proxies.getView().findViewById(R.id.btn_open_inspector).performClick());
            try {
                Field field = ProxiesFragment.class.getDeclaredField("inspectorSheet");
                field.setAccessible(true);
                BottomSheetDialog sheet = (BottomSheetDialog) field.get(proxies);
                if (activity.getResources().getConfiguration().smallestScreenWidthDp >= 600) {
                    assertNull(sheet);
                    assertTrue(proxies.getView()
                            .findViewById(R.id.tv_inspector_channel_status)
                            .isShown());
                    return;
                }
                assertNotNull(sheet);
                assertTrue(sheet.isShowing());
                assertNotNull(sheet.findViewById(R.id.tv_inspector_channel_status));
                assertTrue(sheet.findViewById(R.id.tv_inspector_channel_status).isShown());
            } catch (ReflectiveOperationException error) {
                throw new AssertionError(error);
            }
        });
    }
}
