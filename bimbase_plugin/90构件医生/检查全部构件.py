# -*- coding: utf-8 -*-
import os
import sys
import traceback

plugin_dir = os.path.dirname(os.path.abspath(__file__))
if plugin_dir not in sys.path:
    sys.path.insert(0, plugin_dir)
try:
    with open(os.path.join(plugin_dir, "bridge-runtime.log"), "a", encoding="utf-8") as log:
        log.write("检查全部构件：脚本已启动\n")
    from 构件医生入口 import run
    run("all")
except Exception:
    with open(os.path.join(plugin_dir, "bridge-runtime.log"), "a", encoding="utf-8") as log:
        log.write(traceback.format_exc() + "\n")
    raise
