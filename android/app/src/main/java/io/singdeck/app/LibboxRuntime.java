package io.singdeck.app;

import android.content.Context;
import android.os.Build;

import java.io.File;
import java.util.Locale;

import go.Seq;
import io.nekohasekai.libbox.Libbox;
import io.nekohasekai.libbox.SetupOptions;

public final class LibboxRuntime {
    private static final Object LOCK = new Object();

    private static volatile boolean initialized;
    private static volatile String initializationError;

    private LibboxRuntime() {}

    public static void initialize(Context context) throws Exception {
        if (initialized) {
            return;
        }

        synchronized (LOCK) {
            if (initialized) {
                return;
            }

            try {
                Context appContext = context.getApplicationContext();
                File baseDir = new File(appContext.getFilesDir(), "libbox");
                File workingDir = new File(appContext.getNoBackupFilesDir(), "libbox");
                File tempDir = new File(appContext.getCacheDir(), "libbox");
                ensureDirectory(baseDir);
                ensureDirectory(workingDir);
                ensureDirectory(tempDir);

                Seq.setContext(appContext);

                SetupOptions options = new SetupOptions();
                options.setBasePath(baseDir.getAbsolutePath());
                options.setWorkingPath(workingDir.getAbsolutePath());
                options.setTempPath(tempDir.getAbsolutePath());
                options.setFixAndroidStack(
                        BuildConfig.DEBUG
                                || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N
                                && Build.VERSION.SDK_INT <= Build.VERSION_CODES.N_MR1)
                                || Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                );
                options.setCommandServerListenPort(0);
                options.setCommandServerSecret("");
                options.setLogMaxLines(3000);
                options.setDebug(BuildConfig.DEBUG);
                options.setCrashReportSource("SingDeck");
                options.setAppVersion(String.valueOf(BuildConfig.VERSION_CODE));
                options.setAppMarketingVersion(BuildConfig.VERSION_NAME);
                options.setOomKillerEnabled(false);
                options.setOomKillerDisabled(true);
                options.setOomMemoryLimit(0);
                options.setPowerReportEnabled(false);

                Libbox.setup(options);
                try {
                    Libbox.setLocale(Locale.getDefault().toLanguageTag());
                } catch (Exception ignored) {
                    // Unsupported locales fall back to the core default.
                }

                initialized = true;
                initializationError = null;
            } catch (Exception exception) {
                initializationError = safeMessage(exception);
                throw exception;
            } catch (Throwable throwable) {
                initializationError = safeMessage(throwable);
                throw new Exception(initializationError, throwable);
            }
        }
    }

    public static boolean isInitialized() {
        return initialized;
    }

    public static String getInitializationError() {
        return initializationError;
    }

    public static String getCoreVersion() {
        if (!initialized) {
            return "";
        }
        try {
            return Libbox.version();
        } catch (Throwable ignored) {
            return "";
        }
    }

    private static void ensureDirectory(File directory) throws Exception {
        if (!directory.isDirectory() && !directory.mkdirs()) {
            throw new Exception("Unable to create libbox directory: " + directory.getAbsolutePath());
        }
    }

    private static String safeMessage(Throwable throwable) {
        String message = throwable.getMessage();
        return message == null || message.trim().isEmpty() ? throwable.getClass().getSimpleName() : message;
    }
}
