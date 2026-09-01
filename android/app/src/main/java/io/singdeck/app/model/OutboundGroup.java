package io.singdeck.app.model;

import java.util.ArrayList;
import java.util.List;

public class OutboundGroup {
    public String name;
    public String type; // "selector" | "urltest"
    public String now;  // selected node name
    public List<String> all = new ArrayList<>();

    public OutboundGroup(String name, String type, String now, List<String> all) {
        this.name = name;
        this.type = type != null ? type : "Selector";
        this.now = now;
        this.all = all != null ? all : new ArrayList<>();
    }

    public OutboundGroup(OutboundGroup source) {
        this(source.name, source.type, source.now, new ArrayList<>(source.all));
    }
}
