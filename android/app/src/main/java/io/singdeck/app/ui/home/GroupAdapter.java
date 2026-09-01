package io.singdeck.app.ui.home;

import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.RecyclerView;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import io.singdeck.app.R;
import io.singdeck.app.model.NodeItem;
import io.singdeck.app.model.OutboundGroup;

public class GroupAdapter extends RecyclerView.Adapter<GroupAdapter.ViewHolder> {
    private List<OutboundGroup> groups = new ArrayList<>();
    private Map<String, NodeItem> nodesMap;
    private final OnGroupClickListener listener;

    public interface OnGroupClickListener {
        void onGroupClick(OutboundGroup group);
    }

    public GroupAdapter(OnGroupClickListener listener) {
        this.listener = listener;
    }

    public void updateData(List<OutboundGroup> groups, Map<String, NodeItem> nodesMap) {
        this.groups = groups != null ? groups : new ArrayList<>();
        this.nodesMap = nodesMap;
        notifyDataSetChanged();
    }

    @NonNull
    @Override
    public ViewHolder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        View view = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_strategy_group, parent, false);
        return new ViewHolder(view);
    }

    @Override
    public void onBindViewHolder(@NonNull ViewHolder holder, int position) {
        OutboundGroup group = groups.get(position);
        holder.tvGroupName.setText(group.name);
        holder.tvGroupType.setText(group.type);
        holder.tvGroupNodeCount.setText(group.all.size() + " 个可选节点");
        String activeNode = group.now != null ? group.now : (!group.all.isEmpty() ? group.all.get(0) : "DIRECT");
        holder.tvActiveNodeName.setText(activeNode);
        holder.itemView.setContentDescription(
                "策略组 " + group.name + "，当前节点 " + activeNode
        );

        NodeItem node = nodesMap != null ? nodesMap.get(activeNode) : null;
        if (node != null) {
            holder.tvNodeProtocol.setText(node.type);
            if (node.delay != null) {
                holder.tvNodeLatency.setText(node.delay + " ms");
                holder.tvNodeLatency.setVisibility(View.VISIBLE);
            } else {
                holder.tvNodeLatency.setVisibility(View.GONE);
            }
        } else {
            holder.tvNodeProtocol.setText("OUTBOUND");
            holder.tvNodeLatency.setVisibility(View.GONE);
        }

        holder.itemView.setOnClickListener(v -> {
            if (listener != null) listener.onGroupClick(group);
        });
    }

    @Override
    public int getItemCount() {
        return groups.size();
    }

    static class ViewHolder extends RecyclerView.ViewHolder {
        TextView tvGroupName;
        TextView tvGroupType;
        TextView tvGroupNodeCount;
        TextView tvActiveNodeName;
        TextView tvNodeProtocol;
        TextView tvNodeLatency;

        ViewHolder(View itemView) {
            super(itemView);
            tvGroupName = itemView.findViewById(R.id.tv_group_name);
            tvGroupType = itemView.findViewById(R.id.tv_group_type);
            tvGroupNodeCount = itemView.findViewById(R.id.tv_group_node_count);
            tvActiveNodeName = itemView.findViewById(R.id.tv_active_node_name);
            tvNodeProtocol = itemView.findViewById(R.id.tv_node_protocol);
            tvNodeLatency = itemView.findViewById(R.id.tv_node_latency);
        }
    }
}
