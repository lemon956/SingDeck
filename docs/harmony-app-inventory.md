# 鸿蒙手机应用清单

Android 版 SingDeck 在卓易通中只能直接查询其 Android 环境可见的应用。鸿蒙原生微信等应用由鸿蒙系统管理，需要电脑通过 HDC 采集，再导入 SingDeck。

“设置 → 手机应用清单”合并展示两种来源：

- **Android**：打开清单时读取的 Android 应用，包含系统应用。
- **鸿蒙 · 已导入**：电脑采集的当前手机用户的鸿蒙应用快照，包含系统组件。

支持按名称或包名搜索；两个来源存在相同包名时分别显示。此功能用于查看应用清单，导入的鸿蒙包名不会写入 Android VPN 分流设置。

## 鸿蒙兼容版安装包

推送 `vMAJOR.MINOR.PATCH-android` 格式的 tag（例如 `v0.3.10-android`）会触发 Release workflow，单独生成 Android ARM64 鸿蒙兼容版，并使用仓库配置的正式 Android 签名。Release 同时提供采集脚本、本文档和 `SHA256SUMS`。

- 应用名：**SingDeck 鸿蒙兼容版**。
- 包名：`io.singdeck.app.harmony`，可与普通版和“SingDeck 清单测试”共存。
- 独立安装使用独立数据，配置和鸿蒙清单需要重新导入。
- 该版本仍是通过卓易通运行的 Android APK；鸿蒙应用清单采用电脑采集后手动导入的方式。

若此前安装过使用本地调试签名、相同包名的“鸿蒙兼容版”，请先保留配置备份和原清单文件，再卸载本地包并安装远程签名版。不同签名的 APK 不能直接覆盖安装。

普通 `vMAJOR.MINOR.PATCH` tag 继续生成原有完整发行包。鸿蒙兼容版使用独立 Release，并且不会成为普通发行渠道的 Latest 版本。

构建时使用已有 Gradle 参数机制，增加 `-PsingdeckHarmonyCompat=true` 即可启用独立包名及名称；版本仍由 `singdeckVersionName` 和 `singdeckVersionCode` 指定。

## 1. 连接手机

电脑需要 Python 3.8+ 和华为 SDK 的 HDC 工具。手机打开开发者选项与调试，并完成电脑连接授权。USB 和无线连接均可。

```bash
hdc list targets
```

无线调试时，先按手机当前显示的地址建立连接：

```bash
hdc tconn 手机IP:端口
hdc list targets
```

端口变化、手机重启或断开后，需要重新连接。采集期间避免切换手机用户、安装或卸载鸿蒙应用。

## 2. 一键采集

在 SingDeck 仓库目录执行：

```bash
python3 scripts/export-harmony-apps.py \
  --output /tmp/singdeck-harmony-apps.json
```

HDC 不在 PATH 或存在多个连接时显式指定：

```bash
python3 scripts/export-harmony-apps.py \
  --hdc /path/to/sdk/toolchains/hdc \
  --target 手机IP:端口 \
  --output /tmp/singdeck-harmony-apps.json
```

`--target` 也可使用 `hdc list targets` 中的 USB 序列号。脚本读取 `bm dump -a`、逐包信息及中文展示名称。系统组件没有展示名称时保留包名，不跳过条目。

只有完整采集并复核应用集合后才替换输出文件。设备断线、命令超时、未知输出格式、应用集合变化或写入失败都会报错，已有文件保留。脚本不会修改手机应用或路由配置。

## 3. 导入手机

1. 把生成的 `singdeck-harmony-apps.json` 传到手机文件选择器可访问的位置。
2. 打开 SingDeck **设置 → 手机应用清单 · 导入鸿蒙应用**。
3. 点击 **导入鸿蒙清单**，选择 JSON 文件。
4. 搜索“微信”或 `com.tencent.wechat`，确认显示“鸿蒙 · 已导入”。

### 鸿蒙浏览器下载后，文件在哪里？

在本次 HarmonyOS 6.1 / 卓易通真机验证中，系统文件选择器的路径为：

**左上角菜单 → ALN-AL80（手机内部存储）→ 我的设备(鸿蒙) → Download → com.huawei.hmos.browser → singdeck-harmony-apps.json**。

该目录在文件管理器中对应：

```text
/storage/emulated/0/MyHarmonyOSDevice/Download/com.huawei.hmos.browser/
```

这是鸿蒙共享文件的位置；Android 内部存储直接进入 `Download` 是另一个目录。使用系统文件选择器即可导入，无需额外安装文件管理器。其他机型或版本以文件选择器实际显示为准。

清单顶部显示 Android / 鸿蒙数量、来源机型、手机用户及采集时间。请使用这台手机采集的文件；本版本不会自动匹配设备身份。

导入结果保存在 SingDeck 私有目录中，关闭应用或断开电脑后仍可查看。新清单会整体替换旧的鸿蒙快照；无效文件不会覆盖旧清单。**清除导入清单**仅删除这份本地快照，不卸载手机应用。

## 更新与范围

- 安装或卸载鸿蒙应用后，重新采集并导入即可更新。当前版本没有后台自动同步。
- 覆盖范围为当前用户下 HDC 列出的鸿蒙应用，以及当前兼容环境对 SingDeck 可见的 Android 应用。其他用户、隐私空间、其他兼容容器和应用分身的独立实例不承诺覆盖。
- 系统组件也在清单中，因此数量可能多于桌面图标数。鸿蒙条目使用通用图标。
- 不申请鸿蒙系统应用权限，不使用 root，不采集账号、权限明细、签名或设备序列号。
- JSON 包含已安装应用信息，请自行保管；工具不向任何服务器上传清单。

## 文件格式 v1

```json
{
  "format": "singdeck.harmony-apps",
  "version": 1,
  "collectedAt": 1789516800000,
  "deviceModel": "Test phone",
  "osVersion": "OpenHarmony-6.1.1.120",
  "userId": 100,
  "apps": [
    {
      "bundleName": "com.tencent.wechat",
      "label": "微信",
      "versionName": "8.0.21",
      "systemApp": false
    }
  ]
}
```

`collectedAt` 为电脑采集完成时的 Unix 毫秒时间。`osVersion` 为系统参数返回的底层版本，可能与设置页中的商业版本号不同。全部字段必填，`versionName` 可为空。最大 2 MiB、5000 个应用；拒绝不支持的版本、非法字段和重复鸿蒙包名。

## 开发验证

```bash
python3 -B -m unittest discover -s scripts -p 'test_export_harmony_apps.py' -v
pnpm android:check
```

Android 检查使用 JDK 17。缓存持久化测试位于 `HarmonyAppInventoryStoreTest`，需另在 Android 设备或模拟器上执行 instrumented test；`android:check` 只构建该测试 APK。

真机验收应覆盖：导入后按中文及包名搜索、重启后缓存仍在、错误文件不覆盖缓存、清除后仅剩 Android 条目，以及原分流选择不受影响。
