package io.singdeck.app.manager;

import android.content.Context;
import android.util.AtomicFile;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/** 应用私有目录中的鸿蒙清单快照，不参与 VPN 包名配置或配置备份。 */
public final class HarmonyAppInventoryStore {
    private static final Object LOCK = new Object();
    private final AtomicFile file;

    public HarmonyAppInventoryStore(Context context) {
        this(context.getApplicationContext().getFilesDir());
    }

    HarmonyAppInventoryStore(File directory) {
        file = new AtomicFile(new File(directory, "harmony-app-inventory.json"));
    }

    /** 返回已保存的快照，尚未导入时返回 null；损坏文件抛出异常供界面提示。 */
    public HarmonyAppInventoryCodec.Inventory read() throws IOException {
        synchronized (LOCK) {
            try (FileInputStream input = file.openRead()) {
                return HarmonyAppInventoryCodec.read(input);
            } catch (FileNotFoundException error) {
                if (file.getBaseFile().exists()) {
                    throw error;
                }
                return null;
            }
        }
    }

    /** 完整读取、校验后原子替换；失败保留旧清单，不关闭调用方的输入流。 */
    public HarmonyAppInventoryCodec.Inventory importFrom(InputStream input) throws IOException {
        HarmonyAppInventoryCodec.Inventory inventory = HarmonyAppInventoryCodec.read(input);
        byte[] bytes = HarmonyAppInventoryCodec.encode(inventory).getBytes(StandardCharsets.UTF_8);
        if (bytes.length > HarmonyAppInventoryCodec.MAX_BYTES) {
            throw new IllegalArgumentException("应用清单超过 2 MiB 限制");
        }
        synchronized (LOCK) {
            FileOutputStream output = null;
            try {
                output = file.startWrite();
                output.write(bytes);
                output.flush();
                output.getFD().sync();
                file.finishWrite(output);
            } catch (IOException | RuntimeException error) {
                if (output != null) {
                    file.failWrite(output);
                }
                throw error;
            }
        }
        return inventory;
    }

    /** 仅清除本地导入快照，不卸载应用。 */
    public void clear() throws IOException {
        synchronized (LOCK) {
            file.delete();
            if (file.getBaseFile().exists()) {
                throw new IOException("无法清除导入清单");
            }
        }
    }
}
