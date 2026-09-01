package io.singdeck.app;

import android.app.Application;
import android.util.Log;

public final class SingDeckApplication extends Application {
    private static final String TAG = "SingDeckApplication";

    @Override
    public void onCreate() {
        super.onCreate();
        try {
            LibboxRuntime.initialize(this);
        } catch (Exception exception) {
            Log.e(TAG, "Unable to initialize libbox", exception);
        }
    }
}
