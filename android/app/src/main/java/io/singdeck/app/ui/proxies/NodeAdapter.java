package io.singdeck.app.ui.proxies;

import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.RecyclerView;

import java.util.ArrayList;
import java.util.List;

import io.singdeck.app.R;
import io.singdeck.app.model.NodeItem;

public class NodeAdapter extends RecyclerView.Adapter<NodeAdapter.ViewHolder> {
    private List<NodeItem> nodes = new ArrayList<>();
    private String selectedNodeName = "";
    private final OnNodeClickListener listener;

    public interface OnNodeClickListener {
        void onNodeClick(NodeItem node);
        void onTestNode(NodeItem node);
        void onNodeLongClick(NodeItem node);
    }

    public NodeAdapter(OnNodeClickListener listener) {
        this.listener = listener;
    }

    public void updateData(List<NodeItem> nodes, String selectedNodeName) {
        this.nodes = nodes != null ? nodes : new ArrayList<>();
        this.selectedNodeName = selectedNodeName != null ? selectedNodeName : "";
        notifyDataSetChanged();
    }

    @NonNull
    @Override
    public ViewHolder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        View view = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_node_card, parent, false);
        return new ViewHolder(view);
    }

    @Override
    public void onBindViewHolder(@NonNull ViewHolder holder, int position) {
        NodeItem node = nodes.get(position);
        boolean isSelected = node.name.equals(selectedNodeName);
        Context context = holder.itemView.getContext();

        holder.tvNodeName.setText(node.name);
        holder.tvNodeProtocol.setText(node.type != null && !node.type.isEmpty() ? node.type.toUpperCase() : "PROXY");

        if (node.sourceName == null || node.sourceName.isEmpty()) {
            holder.tvNodeSource.setVisibility(View.GONE);
        } else {
            holder.tvNodeSource.setVisibility(View.VISIBLE);
            holder.tvNodeSource.setText(node.sourceName);
            GradientDrawable badge = new GradientDrawable();
            badge.setCornerRadius(6f);
            badge.setColor(node.sourceColor == 0 ? 0x2538bdf8 : node.sourceColor);
            holder.tvNodeSource.setBackground(badge);
        }

        if (node.score == null || node.score <= 0) {
            holder.tvNodeScore.setVisibility(View.GONE);
        } else {
            holder.tvNodeScore.setVisibility(View.VISIBLE);
            holder.tvNodeScore.setText(String.valueOf(Math.round(node.score)));
            holder.tvNodeScore.setContentDescription("综合评分 " + Math.round(node.score));
        }

        holder.itemView.setContentDescription(
                (isSelected ? "当前已选节点 " : "可选节点 ") + node.name + "，协议 " + node.type
        );
        holder.tvNodeDelay.setContentDescription("测试节点 " + node.name + " 的延迟");
        holder.itemView.setAlpha(node.sourceEligible ? 1f : 0.45f);

        if (isSelected) {
            holder.cardNode.setBackgroundResource(R.drawable.bg_card_selected);
            holder.viewStatusDot.setBackgroundResource(R.drawable.bg_dot_selected);
            holder.tvSelectionLabel.setVisibility(View.VISIBLE);
            holder.tvNodeName.setTextColor(context.getColor(R.color.status_cyan));
        } else {
            holder.cardNode.setBackgroundResource(R.drawable.bg_card_dark);
            holder.viewStatusDot.setBackgroundResource(R.drawable.bg_dot_unselected);
            holder.tvSelectionLabel.setVisibility(View.GONE);
            holder.tvNodeName.setTextColor(context.getColor(R.color.text_primary));
        }

        if (node.isTesting) {
            holder.tvNodeDelay.setText("测速中…");
            holder.tvNodeDelay.setTextColor(context.getColor(R.color.status_cyan));
            holder.tvNodeDelay.setBackgroundResource(R.drawable.bg_badge_engine);
        } else if (node.delay != null) {
            holder.tvNodeDelay.setText(node.delay + "ms");
            if (node.delay < 200) {
                holder.tvNodeDelay.setTextColor(context.getColor(R.color.status_green));
                holder.tvNodeDelay.setBackgroundResource(R.drawable.bg_badge_running);
            } else if (node.delay < 450) {
                holder.tvNodeDelay.setTextColor(context.getColor(R.color.status_amber));
                holder.tvNodeDelay.setBackgroundResource(R.drawable.bg_badge_idle);
            } else {
                holder.tvNodeDelay.setTextColor(context.getColor(R.color.status_red));
                holder.tvNodeDelay.setBackgroundResource(R.drawable.bg_badge_idle);
            }
        } else {
            holder.tvNodeDelay.setText("测延时");
            holder.tvNodeDelay.setTextColor(context.getColor(R.color.text_secondary));
            holder.tvNodeDelay.setBackgroundResource(R.drawable.bg_badge_idle);
        }

        holder.itemView.setOnClickListener(v -> {
            if (listener != null) listener.onNodeClick(node);
        });

        holder.itemView.setOnLongClickListener(v -> {
            if (listener != null) listener.onNodeLongClick(node);
            return true;
        });

        holder.tvNodeDelay.setOnClickListener(v -> {
            if (listener != null) listener.onTestNode(node);
        });
    }

    @Override
    public int getItemCount() {
        return nodes.size();
    }

    static class ViewHolder extends RecyclerView.ViewHolder {
        LinearLayout cardNode;
        View viewStatusDot;
        TextView tvSelectionLabel;
        TextView tvNodeName;
        TextView tvNodeProtocol;
        TextView tvNodeSource;
        TextView tvNodeScore;
        TextView tvNodeDelay;

        ViewHolder(View itemView) {
            super(itemView);
            cardNode = itemView.findViewById(R.id.card_node);
            viewStatusDot = itemView.findViewById(R.id.view_status_dot);
            tvSelectionLabel = itemView.findViewById(R.id.tv_selection_label);
            tvNodeName = itemView.findViewById(R.id.tv_node_name);
            tvNodeProtocol = itemView.findViewById(R.id.tv_node_protocol);
            tvNodeSource = itemView.findViewById(R.id.tv_node_source);
            tvNodeScore = itemView.findViewById(R.id.tv_node_score);
            tvNodeDelay = itemView.findViewById(R.id.tv_node_delay);
        }
    }
}
