import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "export_harmony_apps", Path(__file__).with_name("export-harmony-apps.py"))
exporter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(exporter)

BUNDLE = "com.tencent.wechat"
LIST = f"ID: 100:\n\t{BUNDLE}\n"
INFO = BUNDLE + ":\n" + json.dumps({
    "name": BUNDLE, "versionName": "8.0.21",
    "applicationInfo": {"bundleName": BUNDLE, "isSystemApp": False},
})


class FakeHdc:
    def __init__(self, final_list=LIST):
        self.final_list = final_list
        self.list_reads = 0

    def select_target(self):
        pass

    def shell(self, *args):
        if args == ("bm", "dump", "-a"):
            self.list_reads += 1
            return LIST if self.list_reads == 1 else self.final_list
        if args == ("param", "get", "const.product.model"):
            return "Test phone"
        if args == ("param", "get", "const.ohos.fullname"):
            return "OpenHarmony-6.1.1.120"
        if args == ("bm", "dump", "-n", BUNDLE, "-u", "100"):
            return INFO
        if args == ("bm", "dump", "-n", BUNDLE, "-u", "100", "-l"):
            return "微信"
        raise AssertionError(args)


class ExportHarmonyAppsTest(unittest.TestCase):
    def test_collects_current_user_and_resolved_label_without_private_metadata(self):
        snapshot = exporter.collect(FakeHdc(), lambda _: None)
        self.assertEqual(snapshot["userId"], 100)
        self.assertEqual(snapshot["apps"], [{
            "bundleName": BUNDLE, "label": "微信", "versionName": "8.0.21", "systemApp": False,
        }])
        self.assertEqual(snapshot["format"], "singdeck.harmony-apps")

    def test_rejects_ambiguous_and_partial_lists(self):
        for value in ("", "[Fail] device lost", LIST + "ID: 0:\ncom.other\n",
                      LIST + BUNDLE, "ID: 100:\ncom.test;echo surprise"):
            with self.subTest(value=value), self.assertRaises(exporter.CollectionError):
                exporter.parse_bundle_list(value)

    def test_keeps_unlabelled_system_components(self):
        self.assertEqual(exporter.resolved_label("", BUNDLE), BUNDLE)
        self.assertEqual(exporter.resolved_label("$string:app_name", BUNDLE), BUNDLE)
        self.assertEqual(exporter.resolved_label("error: failed to get label", BUNDLE), BUNDLE)

    def test_rejects_wrong_bundle_and_missing_required_metadata(self):
        for info in (INFO.replace(BUNDLE, "com.other"), "{}", "error: bundle not found"):
            with self.subTest(info=info), self.assertRaises(exporter.CollectionError):
                exporter.parse_bundle_info(info, BUNDLE)

    def test_zero_exit_code_hdc_disconnect_is_an_error(self):
        with patch.object(subprocess, "run", return_value=subprocess.CompletedProcess(
                [], 0, "[Fail][E001005] Device not found or connected", "")):
            with self.assertRaises(exporter.CollectionError):
                exporter.Hdc("hdc").shell("bm", "dump", "-a")

    def test_timeout_is_reported(self):
        with patch.object(subprocess, "run", side_effect=subprocess.TimeoutExpired("hdc", 15)):
            with self.assertRaises(exporter.CollectionError):
                exporter.Hdc("hdc").shell("bm", "dump", "-a")

    def test_requires_an_explicit_target_for_multiple_devices(self):
        with patch.object(exporter.Hdc, "run", return_value="phone1\nphone2"):
            with self.assertRaises(exporter.CollectionError):
                exporter.Hdc("hdc").select_target()

    def test_aborts_when_user_or_installed_set_changes(self):
        for final in (LIST.replace("100", "101"), LIST + "com.example.new\n"):
            with self.subTest(final=final), self.assertRaises(exporter.CollectionError):
                exporter.collect(FakeHdc(final), lambda _: None)

    def test_file_replacement_preserves_previous_snapshot_on_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "inventory.json"
            path.write_text("previous snapshot")
            with patch.object(exporter.os, "replace", side_effect=OSError("disk error")):
                with self.assertRaises(OSError):
                    exporter.write_snapshot(path, {"apps": []})
            self.assertEqual(path.read_text(), "previous snapshot")
            self.assertEqual(len(list(Path(directory).iterdir())), 1)
            exporter.write_snapshot(path, {"label": "微信"})
            self.assertEqual(json.loads(path.read_text()), {"label": "微信"})


if __name__ == "__main__":
    unittest.main()
