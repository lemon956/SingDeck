package io.singdeck.app.ui.connections;

import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.RecyclerView;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import io.singdeck.app.R;
import io.singdeck.app.model.ConnectionItem;

public class ConnectionAdapter extends RecyclerView.Adapter<ConnectionAdapter.ViewHolder> {
    private List<ConnectionItem> connections = new ArrayList<>();
    private final OnConnectionClickListener listener;

    public interface OnConnectionClickListener {
        void onConnectionClick(ConnectionItem item);
        default void onCloseConnection(ConnectionItem item) {}
    }

    public ConnectionAdapter(OnConnectionClickListener listener) {
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

        holder.tvConnHost.setText(item.host != null ? item.host : "未知连接");

        String network = (item.network != null && !item.network.isEmpty()) ? item.network.toUpperCase() : "TCP";
        holder.tvConnNetwork.setText(network);

        String chain = item.chain != null && !item.chain.isEmpty() ? item.chain : (item.outbound != null ? item.outbound : "DIRECT");
        holder.tvConnChain.setText(chain);

        if (holder.tvConnSource != null) {
            String src = item.source != null && !item.source.isEmpty() ? item.source : "--";
            holder.tvConnSource.setText(src);
        }

        if (holder.tvConnOutbound != null) {
            String out = item.outbound != null && !item.outbound.isEmpty() ? item.outbound : "--";
            holder.tvConnOutbound.setText(out);
        }

        holder.tvConnTraffic.setText(
                "↓ " + formatBytes(item.downloadBytes) + "  ↑ " + formatBytes(item.uploadBytes)
        );

        holder.itemView.setContentDescription("查看连接详情 " + item.host);

        holder.itemView.setOnClickListener(v -> {
            if (listener != null) listener.onConnectionClick(item);
        });

        if (holder.btnConnCloseInline != null) {
            holder.btnConnCloseInline.setOnClickListener(v -> {
                if (listener != null) listener.onCloseConnection(item);
            });
        }
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
            return String.format(Locale.US, "%.1f KB", bytes / 1024.0);
        }
        if (bytes < 1024L * 1024L * 1024L) {
            return String.format(Locale.US, "%.1f MB", bytes / (1024.0 * 1024.0));
        }
        return String.format(Locale.US, "%.2f GB", bytes / (1024.0 * 1024.0 * 1024.0));
    }

    static class ViewHolder extends RecyclerView.ViewHolder {
        TextView tvConnHost;
        TextView tvConnNetwork;
        TextView tvConnChain;
        TextView tvConnTraffic;
        TextView tvConnSource;
        TextView tvConnOutbound;
        View btnConnCloseInline;

        ViewHolder(View itemView) {
            super(itemView);
            tvConnHost = itemView.findViewById(R.id.tv_conn_host);
            tvConnNetwork = itemView.findViewById(R.id.tv_conn_network);
            tvConnChain = itemView.findViewById(R.id.tv_conn_chain);
            tvConnTraffic = itemView.findViewById(R.id.tv_conn_traffic);
            tvConnSource = itemView.findViewById(R.id.tv_conn_source);
            tvConnOutbound = itemView.findViewById(R.id.tv_conn_outbound);
            btnConnCloseInline = itemView.findViewById(R.id.btn_conn_close_inline);
        }
    }
}
