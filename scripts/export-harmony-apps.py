#!/usr/bin/env python3
"""通过已授权的 HDC 连接导出当前用户的鸿蒙应用清单；仅使用 Python 标准库。"""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

FORMAT = "singdeck.harmony-apps"
VERSION = 1
MAX_APPS = 5000
MAX_BYTES = 2 * 1024 * 1024
BUNDLE_NAME = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.]{0,254}\Z")


class CollectionError(RuntimeError):
    pass


class Hdc:
    def __init__(self, executable, target=None, timeout=15):
        self.executable = executable
        self.target = target
        self.timeout = timeout

    def run(self, *args):
        command = [self.executable]
        if self.target:
            command += ["-t", self.target]
        try:
            result = subprocess.run(
                command + list(args), capture_output=True, text=True,
                encoding="utf-8", timeout=self.timeout, check=False,
            )
        except (OSError, subprocess.TimeoutExpired, UnicodeError) as error:
            raise CollectionError(f"HDC 执行失败：{error}") from error
        output = result.stdout.strip()
        # HDC 在设备断开时可能仍返回退出码 0，不能仅检查 returncode。
        if result.returncode or re.search(r"(?m)^\s*\[Fail\]|\[E\d{6}\]",
                                          output + "\n" + result.stderr):
            raise CollectionError(f"HDC 未完成命令 {' '.join(args[:4])}："
                                  f"{(output or result.stderr).strip()[:300]}")
        return output

    def shell(self, *args):
        return self.run("shell", *args)

    def select_target(self):
        targets = [line.strip() for line in self.run("list", "targets").splitlines()
                   if line.strip() and not line.startswith("[")]
        if self.target:
            if self.target not in targets:
                raise CollectionError("指定设备未连接，请先用 hdc list targets 检查连接")
        elif len(targets) == 1:
            self.target = targets[0]
        else:
            raise CollectionError("请连接一台手机；连接多台时必须用 --target 指定设备")


def parse_bundle_list(output):
    """保留 bm 列出的所有包；未知格式或多用户输出必须明确报错。"""
    user_id = None
    bundles = set()
    for line in output.splitlines():
        line = line.strip()
        if not line:
            continue
        header = re.fullmatch(r"ID:\s*(\d+):", line)
        if header and user_id is None:
            user_id = int(header.group(1))
        elif user_id is not None and BUNDLE_NAME.fullmatch(line) and line not in bundles:
            bundles.add(line)
        else:
            raise CollectionError(f"无法识别 bm 应用列表：{line[:160]}")
    if user_id is None or user_id > 2147483647 or not 0 < len(bundles) <= MAX_APPS:
        raise CollectionError("bm 未返回有效的当前用户应用列表")
    return user_id, sorted(bundles)


def checked_text(value, name, limit, allow_empty=False):
    if not isinstance(value, str):
        raise CollectionError(f"{name} 不是字符串")
    value = value.strip()
    # 与 Android UTF-16 字符长度限制保持一致。
    if ((not value and not allow_empty) or len(value.encode("utf-16-le")) // 2 > limit
            or any(ord(char) < 32 or ord(char) == 127 for char in value)):
        raise CollectionError(f"{name} 为空、含控制字符或过长")
    return value


def parse_bundle_info(output, bundle):
    if output.startswith(bundle + ":"):
        output = output[len(bundle) + 1:].strip()
    try:
        info = json.loads(output)
        app = info["applicationInfo"]
        if info["name"] != bundle or app["bundleName"] != bundle:
            raise ValueError("返回包名不匹配")
        if not isinstance(app["isSystemApp"], bool):
            raise ValueError("缺少系统应用标志")
        return {
            "bundleName": bundle,
            "versionName": checked_text(info["versionName"], "versionName", 128, True),
            "systemApp": app["isSystemApp"],
        }
    except (ValueError, KeyError, TypeError) as error:
        raise CollectionError(f"无法读取 {bundle} 的完整信息：{error}") from error


def resolved_label(output, bundle):
    # 系统服务可能没有展示名称；保留其包名，不能因此丢掉条目。
    if not output or output.startswith(("$", "[", "error:", "usage:")):
        return bundle
    try:
        return checked_text(output, "label", 256)
    except CollectionError:
        return bundle


def collect(hdc, progress=lambda message: print(message, file=sys.stderr)):
    hdc.select_target()
    user_id, bundles = parse_bundle_list(hdc.shell("bm", "dump", "-a"))
    model = checked_text(hdc.shell("param", "get", "const.product.model"), "deviceModel", 256)
    os_version = checked_text(hdc.shell("param", "get", "const.ohos.fullname"), "osVersion", 256)
    apps = []
    for index, bundle in enumerate(bundles, 1):
        args = ("bm", "dump", "-n", bundle, "-u", str(user_id))
        app = parse_bundle_info(hdc.shell(*args), bundle)
        app["label"] = resolved_label(hdc.shell(*args, "-l"), bundle)
        apps.append(app)
        if index % 25 == 0 or index == len(bundles):
            progress(f"已采集 {index}/{len(bundles)} 个鸿蒙应用")
    # 防止采集中切换手机用户或安装/卸载应用后产生不完整快照。
    if parse_bundle_list(hdc.shell("bm", "dump", "-a")) != (user_id, bundles):
        raise CollectionError("采集期间应用列表或用户发生变化，请重新执行；旧文件已保留")
    return {
        "format": FORMAT, "version": VERSION,
        "collectedAt": time.time_ns() // 1_000_000,
        "deviceModel": model, "osVersion": os_version, "userId": user_id, "apps": apps,
    }


def write_snapshot(path, snapshot):
    """所有采集成功后原子替换文件；断线或写入失败不会破坏上次快照。"""
    data = (json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    if len(data) > MAX_BYTES:
        raise CollectionError("清单超过手机端的 2 MiB 限制")
    path = Path(path).expanduser().absolute()
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".singdeck-apps-",
                                         suffix=".tmp", delete=False) as output:
            temporary = Path(output.name)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hdc", default="hdc", help="HDC 可执行文件路径（默认从 PATH 查找）")
    parser.add_argument("--target", help="hdc list targets 中的 USB 序列号或无线 IP:端口")
    parser.add_argument("--output", default="singdeck-harmony-apps.json", help="输出清单路径")
    args = parser.parse_args(argv)
    try:
        snapshot = collect(Hdc(args.hdc, args.target))
        write_snapshot(args.output, snapshot)
    except (CollectionError, OSError) as error:
        print(f"采集失败：{error}", file=sys.stderr)
        return 1
    fallback = sum(app["label"] == app["bundleName"] for app in snapshot["apps"])
    print(f"已保存 {len(snapshot['apps'])} 个鸿蒙应用：{Path(args.output).expanduser().absolute()}")
    if fallback:
        print(f"其中 {fallback} 个条目未提供展示名称，已用包名显示。")
    print("把此 JSON 文件传到手机，在 SingDeck 设置 → 手机应用清单 → 导入鸿蒙清单中选择。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
