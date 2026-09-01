package io.singdeck.app.ui.proxies;

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
import io.singdeck.app.model.OutboundGroup;

public class GroupTabAdapter extends RecyclerView.Adapter<GroupTabAdapter.ViewHolder> {
    private List<OutboundGroup> groups = new ArrayList<>();
    private String selectedGroupName = "";
    private final OnTabClickListener listener;

    public interface OnTabClickListener {
        void onTabClick(OutboundGroup group);
    }

    public GroupTabAdapter(OnTabClickListener listener) {
        this.listener = listener;
    }

    public void updateData(List<OutboundGroup> groups, String selectedGroupName) {
        this.groups = groups != null ? groups : new ArrayList<>();
        this.selectedGroupName = selectedGroupName != null ? selectedGroupName : "";
        notifyDataSetChanged();
    }

    @NonNull
    @Override
    public ViewHolder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        View view = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_group_tab, parent, false);
        return new ViewHolder(view);
    }

    @Override
    public void onBindViewHolder(@NonNull ViewHolder holder, int position) {
        OutboundGroup group = groups.get(position);
        boolean isSelected = group.name.equals(selectedGroupName);

        holder.tvTabTitle.setText(group.name);
        holder.tvTabCount.setText(String.valueOf(group.all.size()));
        holder.itemView.setContentDescription(
                "策略组 " + group.name + "，" + group.all.size() + " 个节点"
        );

        if (isSelected) {
            holder.container.setBackgroundResource(R.drawable.bg_btn_primary);
            holder.tvTabTitle.setTextColor(holder.itemView.getContext().getColor(R.color.text_primary));
            holder.tvTabCount.setTextColor(holder.itemView.getContext().getColor(R.color.text_primary));
        } else {
            holder.container.setBackgroundResource(R.drawable.bg_badge_idle);
            holder.tvTabTitle.setTextColor(holder.itemView.getContext().getColor(R.color.text_secondary));
            holder.tvTabCount.setTextColor(holder.itemView.getContext().getColor(R.color.text_muted));
        }

        holder.itemView.setOnClickListener(v -> {
            if (listener != null) listener.onTabClick(group);
        });
    }

    @Override
    public int getItemCount() {
        return groups.size();
    }

    static class ViewHolder extends RecyclerView.ViewHolder {
        LinearLayout container;
        TextView tvTabTitle;
        TextView tvTabCount;

        ViewHolder(View itemView) {
            super(itemView);
            container = itemView.findViewById(R.id.tab_container);
            tvTabTitle = itemView.findViewById(R.id.tv_tab_title);
            tvTabCount = itemView.findViewById(R.id.tv_tab_count);
        }
    }
}
