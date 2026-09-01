package io.singdeck.app.ui.proxies;

import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.RadioButton;
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

        holder.tvNodeName.setText(node.name);
        holder.tvNodeProtocol.setText(node.type);
        holder.rbSelected.setChecked(isSelected);
        holder.itemView.setContentDescription(
                (isSelected ? "当前节点 " : "选择节点 ") + node.name + "，协议 " + node.type
        );
        holder.tvNodeDelay.setContentDescription("测试节点 " + node.name + " 的真实延迟");

        if (isSelected) {
            holder.cardNode.setBackgroundResource(R.drawable.bg_card_selected);
            holder.tvNodeName.setTextColor(holder.itemView.getContext().getColor(R.color.status_cyan));
        } else {
            holder.cardNode.setBackgroundResource(R.drawable.bg_card_dark);
            holder.tvNodeName.setTextColor(holder.itemView.getContext().getColor(R.color.text_primary));
        }

        if (node.isTesting) {
            holder.tvNodeDelay.setText("测速中...");
            holder.tvNodeDelay.setTextColor(holder.itemView.getContext().getColor(R.color.status_cyan));
            holder.tvNodeDelay.setBackgroundResource(R.drawable.bg_badge_idle);
        } else if (node.delay != null) {
            holder.tvNodeDelay.setText(node.delay + "ms");
            if (node.delay < 180) {
                holder.tvNodeDelay.setTextColor(holder.itemView.getContext().getColor(R.color.status_green));
                holder.tvNodeDelay.setBackgroundResource(R.drawable.bg_badge_running);
            } else if (node.delay < 350) {
                holder.tvNodeDelay.setTextColor(holder.itemView.getContext().getColor(R.color.status_amber));
                holder.tvNodeDelay.setBackgroundResource(R.drawable.bg_badge_idle);
            } else {
                holder.tvNodeDelay.setTextColor(holder.itemView.getContext().getColor(R.color.status_red));
                holder.tvNodeDelay.setBackgroundResource(R.drawable.bg_badge_idle);
            }
        } else {
            holder.tvNodeDelay.setText("测延时");
            holder.tvNodeDelay.setTextColor(holder.itemView.getContext().getColor(R.color.text_muted));
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
        RadioButton rbSelected;
        TextView tvNodeName;
        TextView tvNodeProtocol;
        TextView tvNodeDelay;

        ViewHolder(View itemView) {
            super(itemView);
            cardNode = itemView.findViewById(R.id.card_node);
            rbSelected = itemView.findViewById(R.id.rb_selected);
            tvNodeName = itemView.findViewById(R.id.tv_node_name);
            tvNodeProtocol = itemView.findViewById(R.id.tv_node_protocol);
            tvNodeDelay = itemView.findViewById(R.id.tv_node_delay);
        }
    }
}
