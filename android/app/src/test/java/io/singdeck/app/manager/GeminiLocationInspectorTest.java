package io.singdeck.app.manager;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

public class GeminiLocationInspectorTest {
    @Test
    public void parsesAuthenticatedSessionWithoutEvaluatingHtml() {
        String html = "<script>window.WIZ_global_data = {"
                + "\"SNlM0e\":\"at-token\",\"FdrFJe\":\"sid-token\","
                + "\"cfb2h\":\"boq_assistant-bard-web-server_20260901.00_p0\"};</script>";
        GeminiLocationInspector.Session session = GeminiLocationInspector.parseSession(html);
        assertEquals("at-token", session.at);
        assertEquals("sid-token", session.sid);
    }

    @Test
    public void parsesOnlyTheExpectedLocationRpcAndSource() {
        String nested = "[[\"United States\",\""
                + GeminiLocationInspector.LOCATION_SOURCE + "\"]]";
        String body = ")]}'\n123\n[[[\"wrb.fr\",\"K4WWud\",\""
                + nested.replace("\\", "\\\\").replace("\"", "\\\"")
                + "\",null,null,null,\"generic\"]]]";
        GeminiLocationInspector.Result result = GeminiLocationInspector.parseBatch(body);
        assertEquals("success", result.status);
        assertEquals("United States", result.label);
    }

    @Test
    public void rejectsUnexpectedSource() {
        String body = "[[[\"wrb.fr\",\"K4WWud\","
                + "\"[[\\\"US\\\",\\\"unknown-source\\\"]]\"]]]";
        assertThrows(IllegalArgumentException.class,
                () -> GeminiLocationInspector.parseBatch(body));
    }
}
