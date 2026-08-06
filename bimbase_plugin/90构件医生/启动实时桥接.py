# -*- coding: utf-8 -*-
from __future__ import print_function

import os
import subprocess
import sys

from pyp3d import messages

plugin_dir = os.path.dirname(os.path.abspath(__file__))
install_root = os.path.dirname(os.path.dirname(plugin_dir))
bridge_dir = os.path.join(install_root, "PythonScript", "python-3.7.9-embed-amd64", "Lib", "BPPythonP3DSDK", "BIMDoctor")
pid_path = os.path.join(bridge_dir, "realtime-bridge.pid")
if os.path.exists(pid_path):
    try:
        with open(pid_path) as stream:
            os.kill(int(stream.read().strip()), 0)
        messages("实时桥接已经在运行")
        raise SystemExit
    except (ValueError, OSError):
        pass
python_exe = sys.executable
script = os.path.join(bridge_dir, "realtime_bridge.py")
panel = os.path.join(plugin_dir, "读取属性面板.ps1")
subprocess.Popen([python_exe, script, "--config", os.path.join(bridge_dir, "config.json"), "--panel-script", panel],
                 cwd=bridge_dir, creationflags=0x08000000)
messages("实时桥接已启动：网页将自动接收当前构件变化")
