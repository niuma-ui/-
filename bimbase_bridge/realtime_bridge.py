# -*- coding: utf-8 -*-
"""BIMBase 选中构件实时桥接：只读属性面板，变更时提交一次检查。"""
from __future__ import print_function

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bridge


def panel_component(raw):
    entity = bridge.first_value(raw, ("构件ID", "实体ID", "EntityId", "entityId"))
    if entity in (None, ""):
        return None
    name = bridge.first_value(raw, bridge.ALIASES["name"]) or "BIMBase构件"
    component = {
        "entityId": "ui:%s" % entity,
        "modelId": None,
        "elementId": str(entity),
        "name": name,
        "shapeName": name,
        "componentType": bridge.first_value(raw, ("构件类型", "类别", "分类", "ComponentType")),
        "semanticType": bridge.first_value(raw, ("语义类型", "专业类型", "SemanticType")),
        "systemType": bridge.first_value(raw, ("系统类型", "系统", "SystemType")),
        "assemblyType": bridge.first_value(raw, ("整体组件类型", "组件类型", "AssemblyType")),
        "parameters": bridge.normalize_parameters(raw),
        "geometry": {key: value for key, aliases in {
            "volume": ("体积", "volume"), "area": ("表面积", "面积", "area")
        }.items() for value in [bridge.first_value(raw, aliases)] if value is not None},
        "rawProperties": raw,
        "extractionErrors": []
    }
    return component


def main():
    base = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=os.path.join(base, "config.json"))
    parser.add_argument("--panel-script", required=True)
    parser.add_argument("--interval", type=float, default=3.0)
    args = parser.parse_args()
    config = bridge.load_config(args.config)
    pid_path = os.path.join(base, "realtime-bridge.pid")
    with open(pid_path, "w") as stream:
        stream.write(str(os.getpid()))
    last_fingerprint = None
    try:
        while True:
            project = bridge.detect_project_context(config)
            try:
                raw = bridge.read_property_panel(args.panel_script)
                component = panel_component(raw)
            except Exception:
                raw, component = {}, None
            heartbeat = {
                "mode": "realtime",
                "pid": os.getpid(),
                "project": project,
                "entityId": component.get("entityId") if component else None,
                "shapeName": component.get("shapeName") if component else None
            }
            try:
                bridge.send_heartbeat(config, heartbeat)
            except Exception:
                pass
            if component and project.get("path"):
                fingerprint = bridge.check_fingerprint(project, [component], [])
                if fingerprint != last_fingerprint:
                    try:
                        bridge.send_job(config, [component])
                        last_fingerprint = fingerprint
                    except Exception:
                        pass
            time.sleep(max(1.0, args.interval))
    finally:
        try:
            if os.path.exists(pid_path):
                os.remove(pid_path)
        except Exception:
            pass


if __name__ == "__main__":
    main()
