package io.singdeck.app.ui.proxies;

import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.view.LayoutInflater;
import android.view.View;
import android.widget.Button;
import android.widget.TextView;
import android.widget.Toast;

import com.google.gson.Gson;

import io.singdeck.app.R;
import io.singdeck.app.model.NodeItem;

public class NodeDetailDialog {
    public interface OnNodeSelectedListener {
        void onSelect(NodeItem node);
    }

    public static void show(Context context, NodeItem node, String groupName, OnNodeSelectedListener listener) {
        if (node == null || context == null) return;

        View view = LayoutInflater.from(context).inflate(R.layout.dialog_node_detail, null);
        TextView tvDetailNodeName = view.findViewById(R.id.tv_detail_node_name);
        TextView tvDetailProtocol = view.findViewById(R.id.tv_detail_protocol);
        TextView tvDetailServer = view.findViewById(R.id.tv_detail_server);
        TextView tvDetailLatency = view.findViewById(R.id.tv_detail_latency);
        Button btnCopyNodeJson = view.findViewById(R.id.btn_copy_node_json);
        Button btnSelectThisNode = view.findViewById(R.id.btn_select_this_node);

        tvDetailNodeName.setText(node.name);
        tvDetailProtocol.setText(node.type);
        tvDetailServer.setText(node.server != null ? (node.server + ":" + node.port) : "本地配置 / 内置直连");
        tvDetailLatency.setText(node.delay != null ? (node.delay + " ms") : "未测试");

        AlertDialog dialog = new AlertDialog.Builder(context)
                .setView(view)
                .create();

        btnCopyNodeJson.setOnClickListener(v -> {
            ClipboardManager cm = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) {
                cm.setPrimaryClip(ClipData.newPlainText("Node JSON", new Gson().toJson(node)));
                Toast.makeText(context, "已复制节点 JSON 到剪贴板", Toast.LENGTH_SHORT).show();
            }
        });

        btnSelectThisNode.setOnClickListener(v -> {
            if (listener != null) listener.onSelect(node);
            dialog.dismiss();
        });

        dialog.show();
    }
}
