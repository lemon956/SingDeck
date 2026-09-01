package io.singdeck.app.manager;

import java.util.Collections;
import java.util.Map;

import io.nekohasekai.libbox.HTTPClient;
import io.nekohasekai.libbox.HTTPRequest;
import io.nekohasekai.libbox.HTTPResponse;
import io.nekohasekai.libbox.Libbox;

/** HTTP transport that fails closed when the local sing-box SOCKS path is unavailable. */
public final class StrictOutboundHttpClient {
    private final RuntimeConfigOverlay.ProxyEndpoint endpoint;

    public StrictOutboundHttpClient(RuntimeConfigOverlay.ProxyEndpoint endpoint) {
        if (endpoint == null) {
            throw new IllegalArgumentException("Inspector 本地代理尚未就绪");
        }
        this.endpoint = endpoint;
    }

    public static final class Response {
        public final int statusCode;
        public final String body;
        public final String location;
        public final String contentType;
        public final String finalUrl;

        Response(
                int statusCode,
                String body,
                String location,
                String contentType,
                String finalUrl
        ) {
            this.statusCode = statusCode;
            this.body = body;
            this.location = location;
            this.contentType = contentType;
            this.finalUrl = finalUrl;
        }

        public boolean isSuccess() {
            return statusCode >= 200 && statusCode < 300;
        }
    }

    public Response get(String url, long timeoutMs) throws Exception {
        return execute("GET", url, null, Collections.emptyMap(), timeoutMs, true);
    }

    public Response execute(
            String method,
            String url,
            String content,
            Map<String, String> headers,
            long timeoutMs,
            boolean followRedirects
    ) throws Exception {
        HTTPClient client = Libbox.newHTTPClient();
        try {
            client.useSocks5(endpoint.port, endpoint.username, endpoint.password);
            client.setTimeout(Math.max(1, timeoutMs));
            client.setFollowRedirects(followRedirects);
            HTTPRequest request = client.newRequest();
            request.setURL(url);
            request.setMethod(method == null ? "GET" : method);
            if (headers != null) {
                for (Map.Entry<String, String> header : headers.entrySet()) {
                    request.setHeader(header.getKey(), header.getValue());
                }
            }
            if (content != null) {
                request.setContentString(content);
            }
            HTTPResponse response = request.executeRaw();
            String body = response.getContent().getValue();
            return new Response(
                    response.getStatusCode(),
                    body == null ? "" : body,
                    response.getHeader("Location"),
                    response.getHeader("Content-Type"),
                    response.getFinalURL()
            );
        } finally {
            client.close();
        }
    }
}
