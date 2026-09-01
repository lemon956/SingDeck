package io.singdeck.app.model;

public class ConnectionItem {
    public String id;
    public String host;
    public String outbound;
    public String chain;
    public String source;
    public String inbound;
    public String network;
    public String protocol;
    public String process;
    public long uploadSpeed;
    public long downloadSpeed;
    public long uploadBytes;
    public long downloadBytes;
    public long startedAt;

    public ConnectionItem(String id, String host, String outbound, String chain) {
        this.id = id;
        this.host = host;
        this.outbound = outbound;
        this.chain = chain;
        this.startedAt = System.currentTimeMillis();
    }

    public ConnectionItem(ConnectionItem source) {
        this.id = source.id;
        this.host = source.host;
        this.outbound = source.outbound;
        this.chain = source.chain;
        this.source = source.source;
        this.inbound = source.inbound;
        this.network = source.network;
        this.protocol = source.protocol;
        this.process = source.process;
        this.uploadSpeed = source.uploadSpeed;
        this.downloadSpeed = source.downloadSpeed;
        this.uploadBytes = source.uploadBytes;
        this.downloadBytes = source.downloadBytes;
        this.startedAt = source.startedAt;
    }
}
