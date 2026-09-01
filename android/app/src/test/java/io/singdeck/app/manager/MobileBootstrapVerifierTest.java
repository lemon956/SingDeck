package io.singdeck.app.manager;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

import io.singdeck.app.model.MobileBootstrap;

public class MobileBootstrapVerifierTest {
    @Test
    public void acceptsOnlyBootstrapMatchingExactRawConfigBytes() {
        String config = "{\n  \"outbounds\": []\n}\n";
        String bootstrapJson = "{"
                + "\"schema\":\"singdeck.mobile-bootstrap.v1\","
                + "\"configSha256\":\"" + MobileBootstrapVerifier.sha256(config) + "\","
                + "\"testingSettings\":{},\"groups\":[],\"nodeSources\":[]}";

        MobileBootstrap bootstrap = MobileBootstrapVerifier.parseAndVerify(config, bootstrapJson);

        assertEquals(MobileBootstrapVerifier.SCHEMA, bootstrap.schema);
        assertThrows(
                IllegalArgumentException.class,
                () -> MobileBootstrapVerifier.parseAndVerify(config.trim(), bootstrapJson)
        );
    }

    @Test
    public void rejectsUnknownBootstrapSchema() {
        String config = "{}";
        String json = "{\"schema\":\"future\",\"configSha256\":\""
                + MobileBootstrapVerifier.sha256(config)
                + "\"}";

        assertThrows(
                IllegalArgumentException.class,
                () -> MobileBootstrapVerifier.parseAndVerify(config, json)
        );
    }
}
