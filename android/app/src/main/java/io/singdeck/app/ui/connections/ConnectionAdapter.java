package io.singdeck.app.ui.connections;

import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageButton;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.RecyclerView;

import java.util.ArrayList;
import java.util.List;

import io.singdeck.app.R;
import io.singdeck.app.model.ConnectionItem;

public class ConnectionAdapter extends RecyclerView.Adapter<ConnectionAdapter.ViewHolder> {
    private List<ConnectionItem> connections = new ArrayList<>();
    private final OnCloseConnectionListener listener;

    public interface OnCloseConnectionListener {
        void onClose(ConnectionItem item);
    }

    public ConnectionAdapter(OnCloseConnectionListener listener) {
        this.listener = listener;
    }

    public void updateData(List<ConnectionItem> list) {
        this.connections = list != null ? list : new ArrayList<>();
        notifyDataSetChanged();
    }

    @NonNull
    @Override
    public ViewHolder onCreateViewHolder(@NonNull ViewGroup parent, int viewType) {
        View view = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_connection, parent, false);
        return new ViewHolder(view);
    }

    @Override
    public void onBindViewHolder(@NonNull ViewHolder holder, int position) {
        ConnectionItem item = connections.get(position);
        holder.tvConnHost.setText(item.host);
        String detail = item.chain == null ? item.outbound : item.chain;
        if (item.process != null && !item.process.isEmpty()) {
            detail = item.process + " · " + detail;
        }
        holder.tvConnChain.setText(detail);
        holder.tvConnTraffic.setText(
                "↓ " + formatBytes(item.downloadBytes) + "  ↑ " + formatBytes(item.uploadBytes)
        );
        holder.btnKillConn.setContentDescription("关闭连接 " + item.host);

        holder.btnKillConn.setOnClickListener(v -> {
            if (listener != null) listener.onClose(item);
        });
    }

    @Override
    public int getItemCount() {
        return connections.size();
    }

    private String formatBytes(long bytes) {
        if (bytes < 1024) {
            return bytes + " B";
        }
        if (bytes < 1024L * 1024L) {
            return (bytes / 1024) + " KiB";
        }
        return String.format(java.util.Locale.US, "%.1f MiB", bytes / (1024.0 * 1024.0));
    }

    static class ViewHolder extends RecyclerView.ViewHolder {
        TextView tvConnHost;
        TextView tvConnChain;
        TextView tvConnTraffic;
        ImageButton btnKillConn;

        ViewHolder(View itemView) {
            super(itemView);
            tvConnHost = itemView.findViewById(R.id.tv_conn_host);
            tvConnChain = itemView.findViewById(R.id.tv_conn_chain);
            tvConnTraffic = itemView.findViewById(R.id.tv_conn_traffic);
            btnKillConn = itemView.findViewById(R.id.btn_kill_conn);
        }
    }
}
