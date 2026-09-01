package io.singdeck.app;

import android.annotation.SuppressLint;
import android.app.PendingIntent;
import android.content.Intent;
import android.net.VpnService;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

import androidx.annotation.RequiresApi;
import androidx.core.content.ContextCompat;

import io.singdeck.app.manager.ProfileManager;

@RequiresApi(api = Build.VERSION_CODES.N)
public class SingDeckTileService extends TileService {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable refreshTile = this::updateTileState;

    @Override
    public void onStartListening() {
        super.onStartListening();
        updateTileState();
    }

    @Override
    public void onClick() {
        super.onClick();
        String state = SingDeckVpnService.getServiceState();
        boolean shouldStop = SingDeckVpnService.STATE_RUNNING.equals(state)
                || SingDeckVpnService.STATE_STARTING.equals(state);

        if (shouldStop) {
            Intent intent = new Intent(this, SingDeckVpnService.class);
            intent.setAction(SingDeckVpnService.ACTION_STOP);
            startService(intent);
        } else {
            Intent prepareIntent = VpnService.prepare(this);
            if (prepareIntent == null) {
                Intent intent = new Intent(this, SingDeckVpnService.class);
                intent.setAction(SingDeckVpnService.ACTION_START);
                String profileId = ProfileManager.getInstance(this).getActiveProfileId();
                if (profileId != null) {
                    intent.putExtra(SingDeckVpnService.EXTRA_PROFILE_ID, profileId);
                }
                ContextCompat.startForegroundService(this, intent);
            } else {
                // Requires UI permission dialog; launch main activity
                launchMainActivity();
            }
        }

        updateTileState();
        handler.removeCallbacks(refreshTile);
        handler.postDelayed(refreshTile, 500);
        handler.postDelayed(refreshTile, 2_000);
    }

    @Override
    public void onStopListening() {
        handler.removeCallbacks(refreshTile);
        super.onStopListening();
    }

    private void updateTileState() {
        Tile tile = getQsTile();
        if (tile == null) {
            return;
        }

        String state = SingDeckVpnService.getServiceState();
        if (SingDeckVpnService.STATE_RUNNING.equals(state)) {
            tile.setState(Tile.STATE_ACTIVE);
            tile.setLabel("SingDeck 开");
            setTileSubtitle(tile, SingDeckVpnService.getActiveOutbound());
        } else if (SingDeckVpnService.STATE_STARTING.equals(state)) {
            tile.setState(Tile.STATE_INACTIVE);
            tile.setLabel("SingDeck");
            setTileSubtitle(tile, "正在连接…");
        } else if (SingDeckVpnService.STATE_STOPPING.equals(state)) {
            tile.setState(Tile.STATE_INACTIVE);
            tile.setLabel("SingDeck");
            setTileSubtitle(tile, "正在断开…");
        } else if (SingDeckVpnService.STATE_ERROR.equals(state)) {
            tile.setState(Tile.STATE_INACTIVE);
            tile.setLabel("SingDeck 错误");
            setTileSubtitle(tile, SingDeckVpnService.getLastError());
        } else {
            tile.setState(Tile.STATE_INACTIVE);
            tile.setLabel("SingDeck 关");
            setTileSubtitle(tile, "未连接");
        }

        tile.updateTile();
    }

    private static void setTileSubtitle(Tile tile, String subtitle) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            tile.setSubtitle(subtitle == null ? "" : subtitle);
        }
    }

    @SuppressLint("StartActivityAndCollapseDeprecated")
    private void launchMainActivity() {
        Intent launchIntent = new Intent(this, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            PendingIntent pendingIntent = PendingIntent.getActivity(
                    this,
                    2,
                    launchIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
            startActivityAndCollapse(pendingIntent);
        } else {
            startActivityAndCollapse(launchIntent);
        }
    }
}
