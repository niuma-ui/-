# -*- coding: utf-8 -*-
import importlib
import os
import sys
import traceback

plugin_dir = os.path.dirname(os.path.abspath(__file__))
if plugin_dir not in sys.path:
    sys.path.insert(0, plugin_dir)
try:
    with open(os.path.join(plugin_dir, "bridge-runtime.log"), "a", encoding="utf-8") as log:
        log.write("深度识别真实组件：脚本已启动\n")
    import 构件医生入口
    importlib.reload(构件医生入口).run("all", True)
except Exception:
    with open(os.path.join(plugin_dir, "bridge-runtime.log"), "a", encoding="utf-8") as log:
        log.write(traceback.format_exc() + "\n")
    raise
