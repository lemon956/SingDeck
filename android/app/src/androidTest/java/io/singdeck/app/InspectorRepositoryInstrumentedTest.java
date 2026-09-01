package io.singdeck.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.Arrays;
import java.util.Collections;

import io.singdeck.app.manager.InspectorRepository;
import io.singdeck.app.model.MobileBootstrap;

@RunWith(AndroidJUnit4.class)
public class InspectorRepositoryInstrumentedTest {
    @Test
    public void bootstrapPersistsGroupSettingsAndReconcilesCurrentNodes() {
        Context context = ApplicationProvider.getApplicationContext();
        InspectorRepository repository = InspectorRepository.getInstance(context);
        String profileId = "instrumented-profile-" + System.nanoTime();
        repository.deleteProfile(profileId);

        MobileBootstrap bootstrap = new MobileBootstrap();
        bootstrap.testingSettings = new MobileBootstrap.TestingSettings();
        MobileBootstrap.Group group = new MobileBootstrap.Group();
        group.name = "Proxy";
        group.kind = "selector";
        group.config = new MobileBootstrap.GroupSettings();
        group.config.allowedNodeSources = Collections.singletonList("Self");
        bootstrap.groups = Collections.singletonList(group);
        MobileBootstrap.NodeSource source = new MobileBootstrap.NodeSource();
        source.name = "Self";
        source.associate = true;
        source.configuredNodes = Collections.singletonList("Reality-1");
        source.linkedNodes = Arrays.asList("Reality-1", "Remote-1");
        bootstrap.nodeSources = Collections.singletonList(source);

        repository.importBootstrap(
                profileId,
                bootstrap,
                Arrays.asList("Reality-1", "Other")
        );

        assertEquals(
                Collections.singletonList("Self"),
                repository.getGroupSettings(profileId, "Proxy").allowedNodeSources
        );
        assertEquals("Self", repository.getSourceOwners(profileId).get("Reality-1"));
        assertTrue(repository.getNodeSources(profileId).get(0).linkedNodes.contains("Reality-1"));

        MobileBootstrap exported = repository.exportBootstrap(profileId);
        assertEquals("singdeck-mobile-v1", exported.schema);
        assertEquals("Proxy", exported.groups.get(0).name);
        assertTrue(exported.nodeSources.get(0).linkedNodes.contains("Remote-1"));

        long claimedAt = 10_000L;
        assertTrue(repository.tryClaimAutoProbe(profileId, "Proxy", claimedAt, 60_000L));
        assertFalse(repository.tryClaimAutoProbe(profileId, "Proxy", claimedAt + 1, 60_000L));
        assertTrue(repository.tryClaimAutoProbe(profileId, "Proxy", claimedAt + 60_000L, 60_000L));

        repository.saveInspectionResult(
                profileId,
                "Proxy",
                "Reality-1",
                "egress",
                "{\"ip\":\"203.0.113.1\"}",
                claimedAt
        );
        assertEquals(
                "{\"ip\":\"203.0.113.1\"}",
                repository.getInspectionResults(profileId, "Proxy", "Reality-1").get("egress")
        );
        repository.deleteProfile(profileId);
    }
}
