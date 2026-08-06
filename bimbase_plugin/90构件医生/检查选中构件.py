# -*- coding: utf-8 -*-
from __future__ import print_function

import importlib
import os
import sys

plugin_dir = os.path.dirname(os.path.abspath(__file__))
install_root = os.path.dirname(os.path.dirname(plugin_dir))
bridge_dir = os.path.join(
    install_root, "PythonScript", "python-3.7.9-embed-amd64", "Lib",
    "BPPythonP3DSDK", "BIMDoctor"
)
if bridge_dir not in sys.path:
    sys.path.insert(0, bridge_dir)

from pyp3d import messages
import bridge
bridge = importlib.reload(bridge)

component = bridge.extract_selected_component(os.path.join(plugin_dir, "读取属性面板.ps1"))
result = bridge.send_job(
    bridge.load_config(os.path.join(bridge_dir, "config.json")),
    [component]
)
summary = result.get("summary", {})
messages("选中构件检查完成：通过 %(pass)s，不符合 %(fail)s，待规则 %(needRule)s，缺数据 %(needData)s" % summary)
