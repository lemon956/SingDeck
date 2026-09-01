package io.singdeck.app.ui.settings;

import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.ImageButton;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.RecyclerView;

import java.util.ArrayList;
import java.util.List;

import io.singdeck.app.R;
import io.singdeck.app.SingDeckVpnService;
import io.singdeck.app.model.Profile;

public class ProfileAdapter extends RecyclerView.Adapter<ProfileAdapter.ViewHolder> {
    private List<Profile> profiles = new ArrayList<>();
    private final OnProfileActionListener listener;

    public interface OnProfileActionListener {
        void onActivate(Profile profile);
        void onEdit(Profile profile);
        void onExport(Profile profile);
        void onRefresh(Profile profile);
        void onDelete(Profile profile);
    }

    public ProfileAdapter(OnProfileActionListener listener) {
        this.listener = listener;
    }

    public void updateData(List<Profile> list) {
        this.profiles = list != null ? list : new ArrayList<>();
        notifyDataSetChanged();
    }

    @NonNull
    @Override
    public ViewHolder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        View view = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_profile, parent, false);
        return new ViewHolder(view);
    }

    @Override
    public void onBindViewHolder(@NonNull ViewHolder holder, int position) {
        Profile profile = profiles.get(position);
        holder.tvProfileName.setText(profile.name);
        holder.tvProfileType.setText(profile.type == null
                ? "RAW"
                : profile.type.toUpperCase(java.util.Locale.ROOT));
        boolean running = profile.id.equals(SingDeckVpnService.getRunningProfileId())
                && SingDeckVpnService.isVpnRunning();
        holder.tvProfileNodeCount.setText(profile.valid
                ? "代理节点: " + profile.nodeCount
                : "无效: " + (profile.validationError == null ? "校验失败" : profile.validationError));

        if (!profile.valid) {
            holder.tvProfileActiveTag.setVisibility(View.VISIBLE);
            holder.tvProfileActiveTag.setText("INVALID");
            holder.tvProfileActiveTag.setTextColor(
                    holder.itemView.getContext().getColor(R.color.status_red)
            );
            holder.btnActivateProfile.setVisibility(View.VISIBLE);
            holder.btnActivateProfile.setEnabled(false);
            holder.itemView.setBackgroundResource(R.drawable.bg_card_dark);
        } else if (profile.active || running) {
            holder.tvProfileActiveTag.setVisibility(View.VISIBLE);
            holder.tvProfileActiveTag.setText(
                    profile.active && running ? "ACTIVE · RUNNING" : profile.active ? "ACTIVE" : "RUNNING"
            );
            holder.tvProfileActiveTag.setTextColor(
                    holder.itemView.getContext().getColor(
                            running ? R.color.status_cyan : R.color.status_green
                    )
            );
            holder.btnActivateProfile.setVisibility(profile.active ? View.GONE : View.VISIBLE);
            holder.btnActivateProfile.setEnabled(true);
            holder.itemView.setBackgroundResource(R.drawable.bg_card_selected);
        } else {
            holder.tvProfileActiveTag.setVisibility(View.GONE);
            holder.btnActivateProfile.setVisibility(View.VISIBLE);
            holder.btnActivateProfile.setEnabled(true);
            holder.itemView.setBackgroundResource(R.drawable.bg_card_dark);
        }

        holder.btnRefreshProfile.setVisibility(
                profile.url == null || profile.url.trim().isEmpty() ? View.GONE : View.VISIBLE
        );
        holder.btnExportProfile.setContentDescription("导出配置 " + profile.name);
        holder.btnEditProfile.setContentDescription("编辑配置 " + profile.name);
        holder.btnRefreshProfile.setContentDescription("刷新订阅 " + profile.name);
        holder.btnDeleteProfile.setContentDescription("删除配置 " + profile.name);

        holder.btnActivateProfile.setOnClickListener(v -> {
            if (listener != null) listener.onActivate(profile);
        });

        holder.btnEditProfile.setOnClickListener(v -> {
            if (listener != null) listener.onEdit(profile);
        });

        holder.btnExportProfile.setOnClickListener(v -> {
            if (listener != null) listener.onExport(profile);
        });

        holder.btnRefreshProfile.setOnClickListener(v -> {
            if (listener != null) listener.onRefresh(profile);
        });

        holder.btnDeleteProfile.setOnClickListener(v -> {
            if (listener != null) listener.onDelete(profile);
        });
    }

    @Override
    public int getItemCount() {
        return profiles.size();
    }

    static class ViewHolder extends RecyclerView.ViewHolder {
        TextView tvProfileName;
        TextView tvProfileType;
        TextView tvProfileActiveTag;
        TextView tvProfileNodeCount;
        ImageButton btnExportProfile;
        ImageButton btnEditProfile;
        ImageButton btnRefreshProfile;
        ImageButton btnDeleteProfile;
        Button btnActivateProfile;

        ViewHolder(View itemView) {
            super(itemView);
            tvProfileName = itemView.findViewById(R.id.tv_profile_name);
            tvProfileType = itemView.findViewById(R.id.tv_profile_type);
            tvProfileActiveTag = itemView.findViewById(R.id.tv_profile_active_tag);
            tvProfileNodeCount = itemView.findViewById(R.id.tv_profile_node_count);
            btnExportProfile = itemView.findViewById(R.id.btn_export_profile);
            btnEditProfile = itemView.findViewById(R.id.btn_edit_profile);
            btnRefreshProfile = itemView.findViewById(R.id.btn_refresh_profile);
            btnDeleteProfile = itemView.findViewById(R.id.btn_delete_profile);
            btnActivateProfile = itemView.findViewById(R.id.btn_activate_profile);
        }
    }
}
