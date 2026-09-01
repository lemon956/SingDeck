package io.singdeck.app;

import static org.junit.Assert.assertTrue;

import android.content.Context;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;

import io.singdeck.app.manager.NodeLinkParser;
import io.singdeck.app.manager.SingBoxConfigValidator;

@RunWith(AndroidJUnit4.class)
public class LibboxConfigInstrumentedTest {
    @Test
    public void bundledLibboxAcceptsGeneratedAnyTlsConfiguration() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertTrue(context.getPackageName().startsWith("io.singdeck.app"));
        String config = NodeLinkParser.parseToSingBoxConfig(
                "anytls://password@example.com:443/?insecure=0&sni=example.com#AnyTLS",
                "AnyTLS"
        );
        SingBoxConfigValidator.validate(context, config);
    }
}
