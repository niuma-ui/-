# -*- coding: utf-8 -*-
from __future__ import print_function

import json
import os
import sys
import time
import traceback
import importlib
import subprocess

plugin_dir = os.path.dirname(os.path.abspath(__file__))
install_root = os.path.dirname(os.path.dirname(plugin_dir))
bridge_dir = os.path.join(
    install_root, "PythonScript", "python-3.7.9-embed-amd64", "Lib",
    "BPPythonP3DSDK", "BIMDoctor"
)
if bridge_dir not in sys.path:
    sys.path.insert(0, bridge_dir)

log_path = os.path.join(plugin_dir, "bridge-runtime.log")
out_path = os.path.join(plugin_dir, "selected-component-detail-latest.json")


def log(message):
    with open(log_path, "a", encoding="utf-8") as stream:
        stream.write("%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), message))


def notify(message):
    try:
        from pyp3d import messages
        messages(message)
    except Exception:
        print(message)


def flatten(value):
    if value is None:
        return []
    if isinstance(value, dict):
        result = []
        for key, child in value.items():
            result.extend(flatten(key))
            result.extend(flatten(child))
        return result
    if isinstance(value, (list, tuple, set)):
        result = []
        for child in value:
            result.extend(flatten(child))
        return result
    return [value]


def token(value):
    if hasattr(value, "_ElementId"):
        return {"kind": "entity", "model": getattr(value, "_ModelId", None),
                "element": getattr(value, "_ElementId", None)}
    if hasattr(value, "_P3DInstanceId"):
        return {"kind": "instance", "class": getattr(value, "_PClassId", None),
                "instance": getattr(value, "_P3DInstanceId", None)}
    return repr(value)[:500]


def simple(value, depth=0):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if depth >= 4:
        return repr(value)[:500]
    if hasattr(value, "_ElementId") or hasattr(value, "_P3DInstanceId"):
        return token(value)
    if isinstance(value, dict):
        return {str(key): simple(child, depth + 1) for key, child in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [simple(child, depth + 1) for child in list(value)[:200]]
    if hasattr(value, "_noumenon_order"):
        result = {"_keys": [str(key) for key in value._noumenon_order]}
        for key in value._noumenon_order:
            try:
                result[str(key)] = simple(value[key], depth + 1)
            except Exception as error:
                result[str(key)] = {"_readError": str(error)}
        return result
    known = {}
    for name in ("model_id", "entity_id", "entity_color", "entity_weight",
                 "entity_style", "levelname", "classname", "schemaname"):
        try:
            if hasattr(value, name):
                known[name] = simple(getattr(value, name), depth + 1)
        except Exception:
            pass
    if known:
        return known
    fields = getattr(value, "__dict__", None)
    if fields:
        return {str(key): simple(child, depth + 1)
                for key, child in fields.items() if not str(key).startswith("__")}
    return repr(value)[:500]


try:
    import bridge
    bridge = importlib.reload(bridge)
    sdk = bridge.load_sdk()
    log("selected detail: start")
    selected = sdk.get_entityid_from_boxselection()
    entities = [value for value in flatten(selected)
                if hasattr(value, "_ElementId") and hasattr(value, "_ModelId")]
    if not entities:
        notify("请先在三维视图中选中一个构件，再运行“诊断选中构件属性”。")
    else:
        entity = entities[0]
        result = {"entity": token(entity), "steps": []}
        log("selected detail: entity %s" % token(entity))

        started = time.time()
        log("selected detail: get_datakey_from_entity start")
        datakey = sdk.get_datakey_from_entity(entity)
        result["steps"].append({"name": "get_datakey_from_entity",
                                 "seconds": round(time.time() - started, 3),
                                 "value": token(datakey)})
        log("selected detail: get_datakey_from_entity done")

        started = time.time()
        log("selected detail: get_noumenon_from_datakey start")
        noumenon = sdk.get_noumenon_from_datakey(datakey)
        result["steps"].append({"name": "get_noumenon_from_datakey",
                                 "seconds": round(time.time() - started, 3),
                                 "value": simple(noumenon)})
        log("selected detail: get_noumenon_from_datakey done")

        # 实机验证：该版本对普通实体调用 get_Entity_Area/get_Entity_Volume
        # 会使 BIMBase 原生进程崩溃，不能用 try/except 捕获，因此明确禁用。
        result["steps"].append({
            "name": "geometry_area_volume",
            "status": "SKIPPED_UNSAFE",
            "reason": "BIMBase 2025 对普通实体调用面积/体积接口会触发原生崩溃"
        })

        # 官方包装函数只返回关系结果的前三项；底层结果还包含通用实体属性列表。
        started = time.time()
        log("selected detail: raw model/entity relation start")
        try:
            api_globals = sdk.get_modelid_entityid_relation.__globals__
            raw_relation = api_globals["UnifiedFunction"](
                api_globals["PARACMPT_PARAMETRIC_COMPONENT"],
                api_globals["PARACMPT_GET_MODELID_ENTITYID_RELATION"]
            )()
            parts = list(raw_relation) if isinstance(raw_relation, (list, tuple)) else [raw_relation]
            attribute_items = list(parts[6]) if len(parts) > 6 and isinstance(parts[6], (list, tuple)) else []
            model_id = getattr(entity, "_ModelId", None)
            element_id = getattr(entity, "_ElementId", None)
            matches = []
            for item in attribute_items:
                if getattr(item, "model_id", None) == model_id and getattr(item, "entity_id", None) == element_id:
                    matches.append(simple(item))
            result["steps"].append({
                "name": "raw_modelid_entityid_relation",
                "seconds": round(time.time() - started, 3),
                "partCount": len(parts),
                "partTypes": [type(part).__name__ for part in parts],
                "entityAttributeCount": len(attribute_items),
                "selectedMatches": matches,
                "attributeSamples": [simple(item) for item in attribute_items[:5]]
            })
            log("selected detail: raw model/entity relation done parts=%d attrs=%d matches=%d" %
                (len(parts), len(attribute_items), len(matches)))
        except Exception as error:
            result["steps"].append({"name": "raw_modelid_entityid_relation",
                                     "seconds": round(time.time() - started, 3),
                                     "error": str(error)})
            log("selected detail: raw model/entity relation error %s" % error)

        # 旧版官方 SDK 暴露过该只读接口；新版仅保留底层常量。
        started = time.time()
        log("selected detail: raw all entity property start")
        try:
            api_globals = sdk.get_modelid_entityid_relation.__globals__
            all_properties = api_globals["UnifiedFunction"](
                api_globals["PARACMPT_PARAMETRIC_COMPONENT"],
                api_globals["PARACMPT_GET_ALL_ENTITYPROPERTY"]
            )()
            result["steps"].append({
                "name": "raw_all_entity_property",
                "seconds": round(time.time() - started, 3),
                "value": simple(all_properties)
            })
            log("selected detail: raw all entity property done")
        except Exception as error:
            result["steps"].append({"name": "raw_all_entity_property",
                                     "seconds": round(time.time() - started, 3),
                                     "error": str(error)})
            log("selected detail: raw all entity property error %s" % error)

        started = time.time()
        try:
            panel_script = os.path.join(plugin_dir, "读取属性面板.ps1")
            startup = subprocess.STARTUPINFO()
            startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            output = subprocess.check_output(
                ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", panel_script],
                startupinfo=startup,
                creationflags=0x08000000
            ).decode("utf-8-sig")
            result["steps"].append({
                "name": "property_panel_accessibility",
                "seconds": round(time.time() - started, 3),
                "value": json.loads(output)
            })
        except Exception as error:
            result["steps"].append({"name": "property_panel_accessibility",
                                     "seconds": round(time.time() - started, 3),
                                     "error": str(error)})

        with open(out_path, "w", encoding="utf-8") as stream:
            json.dump(result, stream, ensure_ascii=False, indent=2)
        notify("选中构件属性诊断完成，结果已写入 selected-component-detail-latest.json。")
except Exception:
    log("selected detail: failed\n" + traceback.format_exc())
    notify("选中构件属性诊断失败，请查看 bridge-runtime.log。")
    raise
