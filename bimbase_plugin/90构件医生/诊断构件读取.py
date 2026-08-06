# -*- coding: utf-8 -*-
from __future__ import print_function

import json
import os
import sys
import traceback
import importlib
import time

plugin_dir = os.path.dirname(os.path.abspath(__file__))
install_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
bridge_dir = os.path.join(
    install_root,
    "PythonScript", "python-3.7.9-embed-amd64", "Lib", "BPPythonP3DSDK", "BIMDoctor"
)
if bridge_dir not in sys.path:
    sys.path.insert(0, bridge_dir)

log_path = os.path.join(plugin_dir, "bridge-runtime.log")
probe_path = os.path.join(plugin_dir, "sdk-runtime-probe-latest.json")

def notify(message):
    try:
        from pyp3d import messages
        messages(message)
    except Exception:
        print(message)

def token(value):
    if hasattr(value, "_ElementId"):
        return {"kind": "entity", "model": getattr(value, "_ModelId", None), "element": getattr(value, "_ElementId", None)}
    if hasattr(value, "_ModelId"):
        return {"kind": "model", "model": getattr(value, "_ModelId", None)}
    return repr(value)[:200]

def simplify(value, depth=0):
    if depth > 5:
        return repr(value)[:200]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if hasattr(value, "_ElementId") or hasattr(value, "_ModelId"):
        return token(value)
    if isinstance(value, dict):
        return {repr(k)[:200]: simplify(v, depth + 1) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [simplify(x, depth + 1) for x in list(value)[:500]]
    return repr(value)[:200]

def count_entities(value):
    if value is None:
        return 0
    if hasattr(value, "_ElementId") and hasattr(value, "_ModelId"):
        return 1
    if isinstance(value, dict):
        return sum(count_entities(k) + count_entities(v) for k, v in value.items())
    if isinstance(value, (list, tuple, set)):
        return sum(count_entities(x) for x in value)
    return 0

try:
    import bridge
    bridge = importlib.reload(bridge)
    sdk = bridge.load_sdk()
    result = {"started": time.time(), "steps": []}

    def probe(name, fn):
        started = time.time()
        try:
            value = fn()
            result["steps"].append({
                "name": name,
                "seconds": round(time.time() - started, 3),
                "type": type(value).__name__,
                "entityCount": count_entities(value),
                "value": simplify(value),
            })
            return value
        except Exception as error:
            result["steps"].append({
                "name": name,
                "seconds": round(time.time() - started, 3),
                "error": str(error),
            })
            return None

    probe("get_active_modelId", sdk.get_active_modelId)
    probe("get_all_entityid", sdk.get_all_entityid)
    probe("get_entityid_by_activemodel", sdk.get_entityid_by_activemodel)
    relation = probe("get_modelid_entityid_relation", sdk.get_modelid_entityid_relation)
    components, _ = bridge.extract_components("all")
    result["extractComponentsCount"] = len(components)
    result["componentSamples"] = components[:5]

    with open(probe_path, "w", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
    with open(log_path, "a", encoding="utf-8") as log:
        log.write("诊断构件读取：extractComponentsCount=%d，详情=%s\n" % (len(components), probe_path))
    notify("构件医生诊断完成：读取构件 %d 个，详情已写入 sdk-runtime-probe-latest.json" % len(components))
except Exception:
    with open(log_path, "a", encoding="utf-8") as log:
        log.write("诊断构件读取失败：\n" + traceback.format_exc() + "\n")
    raise