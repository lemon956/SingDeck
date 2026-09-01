package io.singdeck.app.model;

public class NodeItem {
    public String name;
    public String type; // VLESS, VMess, Shadowsocks, Trojan, Hysteria2, Direct
    public String server;
    public int port;
    public Integer delay; // null or latency in ms
    public long lastTestedAt;
    public boolean isTesting;

    public NodeItem(String name, String type) {
        this.name = name;
        this.type = type != null ? type : "OUTBOUND";
        this.delay = null;
        this.lastTestedAt = 0;
        this.isTesting = false;
    }

    public NodeItem(NodeItem source) {
        this.name = source.name;
        this.type = source.type;
        this.server = source.server;
        this.port = source.port;
        this.delay = source.delay;
        this.lastTestedAt = source.lastTestedAt;
        this.isTesting = source.isTesting;
    }
}
