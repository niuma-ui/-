# -*- coding: utf-8 -*-
from __future__ import print_function

import os

from pyp3d import messages

plugin_dir = os.path.dirname(os.path.abspath(__file__))
install_root = os.path.dirname(os.path.dirname(plugin_dir))
pid_path = os.path.join(install_root, "PythonScript", "python-3.7.9-embed-amd64", "Lib", "BPPythonP3DSDK", "BIMDoctor", "realtime-bridge.pid")
try:
    with open(pid_path) as stream:
        pid = int(stream.read().strip())
    os.kill(pid, 15)
    os.remove(pid_path)
    messages("实时桥接已停止")
except (IOError, OSError, ValueError):
    messages("实时桥接当前未运行")
