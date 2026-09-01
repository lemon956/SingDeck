package io.singdeck.app.ui.connections;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Bundle;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.google.android.material.bottomsheet.BottomSheetDialogFragment;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import java.util.Locale;

import io.singdeck.app.R;
import io.singdeck.app.model.ConnectionItem;

public class ConnectionDetailBottomSheet extends BottomSheetDialogFragment {
    private static final String ARG_JSON = "arg_connection_json";

    public interface OnConnectionActionListener {
        void onCloseConnection(String connectionId, String host);
    }

    private ConnectionItem item;
    private OnConnectionActionListener actionListener;

    public static ConnectionDetailBottomSheet newInstance(ConnectionItem item) {
        ConnectionDetailBottomSheet sheet = new ConnectionDetailBottomSheet();
        Bundle args = new Bundle();
        args.putString(ARG_JSON, new Gson().toJson(item));
        sheet.setArguments(args);
        return sheet;
    }

    public void setActionListener(OnConnectionActionListener listener) {
        this.actionListener = listener;
    }

    @Override
    public void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (getArguments() != null) {
            String json = getArguments().getString(ARG_JSON);
            if (json != null) {
                item = new Gson().fromJson(json, ConnectionItem.class);
            }
        }
    }

    @Nullable
    @Override
    public View onCreateView(@NonNull LayoutInflater inflater, @Nullable ViewGroup container, @Nullable Bundle savedInstanceState) {
        View view = inflater.inflate(R.layout.bottom_sheet_connection_detail, container, false);
        if (item == null) {
            dismiss();
            return view;
        }

        TextView tvHost = view.findViewById(R.id.tv_detail_host);
        TextView tvNetworkProto = view.findViewById(R.id.tv_detail_network_proto);
        TextView tvChain = view.findViewById(R.id.tv_detail_chain);
        TextView tvOutbound = view.findViewById(R.id.tv_detail_outbound);
        TextView tvProcess = view.findViewById(R.id.tv_detail_process);
        TextView tvDownload = view.findViewById(R.id.tv_detail_download);
        TextView tvUpload = view.findViewById(R.id.tv_detail_upload);
        TextView tvDuration = view.findViewById(R.id.tv_detail_duration);
        TextView tvSource = view.findViewById(R.id.tv_detail_source);

        Button btnCopy = view.findViewById(R.id.btn_detail_copy);
        Button btnClose = view.findViewById(R.id.btn_detail_close);

        tvHost.setText(item.host != null ? item.host : "未知主机");

        String protoStr = (item.network != null ? item.network.toUpperCase() : "TCP");
        if (item.protocol != null && !item.protocol.isEmpty()) {
            protoStr += " · " + item.protocol.toUpperCase();
        }
        if (item.inbound != null && !item.inbound.isEmpty()) {
            protoStr += " · " + item.inbound;
        }
        tvNetworkProto.setText(protoStr);

        tvChain.setText(item.chain != null && !item.chain.isEmpty() ? item.chain : (item.outbound != null ? item.outbound : "DIRECT"));
        tvOutbound.setText(item.outbound != null && !item.outbound.isEmpty() ? item.outbound : "DIRECT");
        tvProcess.setText(item.process != null && !item.process.isEmpty() ? item.process : "系统 / 未知应用");

        tvDownload.setText(formatBytes(item.downloadBytes));
        tvUpload.setText(formatBytes(item.uploadBytes));

        if (item.startedAt > 0) {
            long diffSec = Math.max(0, (System.currentTimeMillis() - item.startedAt) / 1000);
            long hrs = diffSec / 3600;
            long mins = (diffSec % 3600) / 60;
            long secs = diffSec % 60;
            tvDuration.setText(String.format(Locale.US, "%02d:%02d:%02d", hrs, mins, secs));
        } else {
            tvDuration.setText("刚刚建立");
        }

        tvSource.setText(item.source != null && !item.source.isEmpty() ? item.source : "172.19.0.1 (TUN)");

        btnCopy.setOnClickListener(v -> {
            ClipboardManager cm = (ClipboardManager) requireContext().getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) {
                String prettyJson = new GsonBuilder().setPrettyPrinting().create().toJson(item);
                cm.setPrimaryClip(ClipData.newPlainText("Connection Info", prettyJson));
                Toast.makeText(requireContext(), "连接完整详情已复制到剪贴板", Toast.LENGTH_SHORT).show();
            }
        });

        btnClose.setOnClickListener(v -> {
            if (actionListener != null && item != null) {
                actionListener.onCloseConnection(item.id, item.host);
            }
            dismiss();
        });

        return view;
    }

    private String formatBytes(long bytes) {
        if (bytes < 1024) {
            return bytes + " B";
        }
        if (bytes < 1024L * 1024L) {
            return String.format(Locale.US, "%.1f KiB", bytes / 1024.0);
        }
        if (bytes < 1024L * 1024L * 1024L) {
            return String.format(Locale.US, "%.2f MiB", bytes / (1024.0 * 1024.0));
        }
        return String.format(Locale.US, "%.2f GiB", bytes / (1024.0 * 1024.0 * 1024.0));
    }
}
