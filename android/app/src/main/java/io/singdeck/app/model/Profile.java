package io.singdeck.app.model;

public class Profile {
    public String id;
    public String name;
    public String type; // "url" | "file" | "clipboard" | "raw"
    public String url;
    public String content;
    public boolean active;
    public boolean valid = true;
    public String validationError;
    public int nodeCount;
    public long lastUpdatedAt;

    public Profile() {
    }

    public Profile(String id, String name, String type, String url, String content, boolean active) {
        this.id = id;
        this.name = name;
        this.type = type;
        this.url = url;
        this.content = content;
        this.active = active;
        this.valid = true;
        this.lastUpdatedAt = System.currentTimeMillis();
    }
}
