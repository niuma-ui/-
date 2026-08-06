# -*- coding: utf-8 -*-
from __future__ import print_function

import os
import sys
import importlib


def notify(message):
    try:
        from pyp3d import messages
        messages(message)
    except Exception:
        print(message)


def run(scope):
    install_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    bridge_dir = os.path.join(
        install_root,
        "PythonScript", "python-3.7.9-embed-amd64", "Lib", "BPPythonP3DSDK", "BIMDoctor"
    )
    if bridge_dir not in sys.path:
        sys.path.insert(0, bridge_dir)
    import bridge
    bridge = importlib.reload(bridge)

    config_path = os.path.join(bridge_dir, "config.json")
    log_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bridge-runtime.log")
    os.environ["BIM_DOCTOR_PROBE_LOG"] = log_path
    try:
        notify("构件医生正在读取 BIMBase 构件，请稍候……")
        with open(log_path, "a", encoding="utf-8") as log:
            log.write("开始读取 scope=%s\n" % scope)
        components, _ = bridge.extract_components(scope)
        with open(log_path, "a", encoding="utf-8") as log:
            log.write("已读取构件：%d\n" % len(components))
        if not components:
            message = "未读取到构件：请确认已进入 .p3d 工程建模编辑界面，不是 BIMBase 首页/最近项目页；然后再点 工具-构件医生-检查全部构件。"
            with open(log_path, "a", encoding="utf-8") as log:
                log.write(message + "\n")
            notify(message)
            return {"summary": {"total": 0, "pass": 0, "fail": 0, "needRule": 0, "needData": 0, "error": 0}}
        config = bridge.load_config(config_path)
        project = bridge.detect_project_context(config)
        project["checkScope"] = "project"
        project["modelScope"] = scope
        result = bridge.send_job(config, components, project)
        summary = result.get("summary", {})
        notify(
            "构件医生完成：总数 %(total)s，通过 %(pass)s，不符合 %(fail)s，"
            "待规则 %(needRule)s，缺数据 %(needData)s，异常 %(error)s" % summary
        )
    except Exception as error:
        notify("构件医生失败：%s" % error)
        raise
