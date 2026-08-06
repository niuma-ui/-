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


def packed_entity_parts(value):
    try:
        packed = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    if packed <= 0xFFFFFFFF:
        return None
    return packed >> 32, packed & 0xFFFFFFFF


def panel_component(raw):
    entity = bridge.first_value(raw, ("构件ID", "实体ID", "EntityId", "entityId"))
    if entity in (None, ""):
        return None
    name = bridge.first_value(raw, bridge.ALIASES["name"]) or "BIMBase构件"
    parts = packed_entity_parts(entity)
    identity, evidence = bridge.identity_fields(raw, "BIMBase 属性面板")
    component = {
        "entityId": "%s:%s" % parts if parts else "ui:%s" % entity,
        "modelId": parts[0] if parts else None,
        "elementId": parts[1] if parts else str(entity),
        "name": name,
        "sourceName": name,
        "canonicalName": identity.get("canonicalName"),
        "shapeName": name,
        "componentType": identity.get("semanticType"),
        "semanticType": identity.get("semanticType"),
        "systemType": identity.get("systemType"),
        "assemblyType": identity.get("assemblyType"),
        "role": identity.get("role"),
        "material": identity.get("material"),
        "identityStatus": "observed" if identity else "unresolved",
        "identityEvidence": evidence,
        "parameters": bridge.normalize_parameters(raw),
        "geometry": {key: value for key, aliases in {
            "volume": ("体积", "volume"), "area": ("表面积", "面积", "area")
        }.items() for value in [bridge.first_value(raw, aliases)] if value is not None},
        "rawProperties": raw,
        "extractionErrors": []
    }
    return component


def log(base, message):
    try:
        with open(os.path.join(base, "realtime-bridge.log"), "a", encoding="utf-8") as stream:
            stream.write("%s %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%S"), message))
    except Exception:
        pass


def read_queue(path):
    try:
        with open(path, "r", encoding="utf-8") as stream:
            value = json.load(stream)
        return value if isinstance(value, list) else []
    except Exception:
        return []


def write_queue(path, queue):
    with open(path, "w", encoding="utf-8") as stream:
        json.dump(queue[-50:], stream, ensure_ascii=False, indent=2)


def queue_snapshot(path, project, component, fingerprint):
    queue = read_queue(path)
    item = {"project": project, "component": component, "fingerprint": fingerprint, "queuedAt": time.time()}
    queue = [old for old in queue if old.get("fingerprint") != fingerprint]
    queue.append(item)
    write_queue(path, queue)


def flush_queue(path, config, base):
    queue = read_queue(path)
    while queue:
        item = queue[0]
        try:
            bridge.send_job(config, [item["component"]], item.get("project") or {})
        except Exception as error:
            log(base, "queue flush failed: %s" % error)
            break
        queue.pop(0)
        write_queue(path, queue)
        log(base, "queued snapshot uploaded: %s" % item.get("fingerprint", ""))
    return queue


def main():
    base = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=os.path.join(base, "config.json"))
    parser.add_argument("--panel-script", required=True)
    parser.add_argument("--interval", type=float, default=3.0)
    args = parser.parse_args()
    config = bridge.load_config(args.config)
    pid_path = os.path.join(base, "realtime-bridge.pid")
    queue_path = os.path.join(base, "realtime-bridge-queue.json")
    with open(pid_path, "w") as stream:
        stream.write(str(os.getpid()))
    last_fingerprint = None
    log(base, "started pid=%s" % os.getpid())
    try:
        while True:
            flush_queue(queue_path, config, base)
            project = bridge.detect_project_context(config)
            try:
                raw = bridge.read_property_panel(args.panel_script)
                component = panel_component(raw)
            except Exception:
                raw, component = {}, None
            if component:
                project = dict(project)
                project["checkScope"] = "component"
                project["targetEntityId"] = component["entityId"]
            heartbeat = {
                "mode": "realtime",
                "pid": os.getpid(),
                "project": project,
                "entityId": component.get("entityId") if component else None,
                "shapeName": component.get("shapeName") if component else None
            }
            try:
                bridge.send_heartbeat(config, heartbeat)
            except Exception as error:
                log(base, "heartbeat failed: %s" % error)
            if component and project.get("path"):
                fingerprint = bridge.check_fingerprint(project, [component], [])
                if fingerprint != last_fingerprint:
                    try:
                        bridge.send_job(config, [component], project)
                        last_fingerprint = fingerprint
                        log(base, "snapshot uploaded: %s" % fingerprint)
                    except Exception as error:
                        queue_snapshot(queue_path, project, component, fingerprint)
                        log(base, "snapshot queued: %s (%s)" % (fingerprint, error))
            time.sleep(max(1.0, args.interval))
    finally:
        try:
            if os.path.exists(pid_path):
                os.remove(pid_path)
        except Exception:
            pass


if __name__ == "__main__":
    main()
