package io.singdeck.app.manager;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import io.singdeck.app.model.OutboundGroup;

/** Reconciles confirmed selector RPCs with the asynchronously delivered libbox group stream. */
public final class RuntimeGroupSelectionReconciler {
    static final long CONFIRMATION_WINDOW_MS = 5_000L;

    private final Map<String, PendingSelection> pendingSelections = new LinkedHashMap<>();

    public List<OutboundGroup> recordSuccessfulSelection(
            List<OutboundGroup> currentGroups,
            String groupName,
            String outboundName,
            long now
    ) {
        List<OutboundGroup> updated = copyGroups(currentGroups);
        for (OutboundGroup group : updated) {
            if (!group.name.equals(groupName) || !group.all.contains(outboundName)) {
                continue;
            }
            group.now = outboundName;
            pendingSelections.put(
                    groupName,
                    new PendingSelection(outboundName, now + CONFIRMATION_WINDOW_MS)
            );
            break;
        }
        return updated;
    }

    public List<OutboundGroup> reconcileStream(List<OutboundGroup> streamedGroups, long now) {
        List<OutboundGroup> reconciled = copyGroups(streamedGroups);
        Set<String> streamedGroupNames = new LinkedHashSet<>();
        for (OutboundGroup group : reconciled) {
            streamedGroupNames.add(group.name);
            PendingSelection pending = pendingSelections.get(group.name);
            if (pending == null) {
                continue;
            }
            if (pending.outboundName.equals(group.now)) {
                pendingSelections.remove(group.name);
            } else if (now < pending.expiresAt && group.all.contains(pending.outboundName)) {
                group.now = pending.outboundName;
            } else {
                pendingSelections.remove(group.name);
            }
        }
        Iterator<String> pendingGroups = pendingSelections.keySet().iterator();
        while (pendingGroups.hasNext()) {
            if (!streamedGroupNames.contains(pendingGroups.next())) {
                pendingGroups.remove();
            }
        }
        return reconciled;
    }

    public void clear() {
        pendingSelections.clear();
    }

    int pendingCount() {
        return pendingSelections.size();
    }

    private static List<OutboundGroup> copyGroups(List<OutboundGroup> groups) {
        List<OutboundGroup> copies = new ArrayList<>();
        if (groups == null) {
            return copies;
        }
        for (OutboundGroup group : groups) {
            if (group != null) {
                copies.add(new OutboundGroup(group));
            }
        }
        return copies;
    }

    private static final class PendingSelection {
        final String outboundName;
        final long expiresAt;

        PendingSelection(String outboundName, long expiresAt) {
            this.outboundName = outboundName;
            this.expiresAt = expiresAt;
        }
    }
}
