# -*- coding: utf-8 -*-
"""BIMBase 2025 -> 构件医生桥接器。仅依赖 Python 3.7 标准库。"""
from __future__ import print_function

import argparse
import ctypes
import hashlib
import json
import os
import re
import subprocess
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener, ProxyHandler


ALIASES = {
    "name": ("名称", "构件名称", "name", "Name"),
    "length": ("长度", "长", "length", "Length"),
    "width": ("宽度", "宽", "厚度", "墙厚", "width", "Width"),
    "height": ("高度", "高", "height", "Height"),
    "diameter": ("直径", "管径", "diameter", "Diameter"),
    "material": ("材料", "材质", "material", "Material"),
    "storey": ("楼层", "标高层", "storey", "Storey")
}


def scalar(value):
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return None


def safe_value(value, depth=0, seen=None):
    """把 SDK 自定义类型压缩成可传输 JSON；几何对象只保留浅层字段。"""
    direct = scalar(value)
    if direct is not None or value is None:
        return direct
    if depth >= 4:
        return repr(value)[:500]
    seen = seen or set()
    marker = id(value)
    if marker in seen:
        return "<cycle>"
    seen.add(marker)
    try:
        if isinstance(value, dict):
            return {str(key): safe_value(item, depth + 1, seen) for key, item in value.items()}
        if isinstance(value, (list, tuple, set)):
            return [safe_value(item, depth + 1, seen) for item in list(value)[:200]]
        if hasattr(value, "this"):
            return safe_value(value.this, depth + 1, seen)
        fields = {}
        for key, item in getattr(value, "__dict__", {}).items():
            if key.startswith("__") or callable(item):
                continue
            fields[key] = safe_value(item, depth + 1, seen)
        return fields or repr(value)[:500]
    finally:
        seen.discard(marker)


def object_token(value):
    if hasattr(value, "_ElementId"):
        return "%s:%s" % (getattr(value, "_ModelId", 0), value._ElementId)
    if hasattr(value, "_P3DInstanceId"):
        return "%s:%s" % (getattr(value, "_PClassId", 0), value._P3DInstanceId)
    if hasattr(value, "_ModelId"):
        return str(value._ModelId)
    return repr(value)[:200]


def noumenon_properties(noumenon):
    result = {}
    for key in getattr(noumenon, "_noumenon_order", []):
        try:
            result[str(key)] = safe_value(noumenon[key])
        except Exception as error:
            result[str(key)] = {"_readError": str(error)}
    return result


def first_value(properties, aliases):
    folded = {str(key).strip().lower(): value for key, value in properties.items()}
    for alias in aliases:
        value = folded.get(alias.lower())
        if value not in (None, ""):
            return value
    return None


def normalize_parameters(raw):
    result = {}
    for name, aliases in ALIASES.items():
        value = first_value(raw, aliases)
        if value is None:
            continue
        if name in ("length", "width", "height", "diameter"):
            match = re.search(r"[-+]?\d+(?:\.\d+)?", str(value))
            value = abs(float(match.group(0))) if match else value
        result[name] = value
    return result


def read_property_panel(script_path):
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    output = subprocess.check_output(
        ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script_path],
        startupinfo=startup,
        creationflags=0x08000000
    ).decode("utf-8-sig")
    return {row["name"]: row["value"] for row in json.loads(output)}


def detect_project_context(config):
    """Read the active .p3d identity; the file/project is compliance context, not the solid shape name."""
    title = ""
    try:
        hwnd = ctypes.windll.user32.GetForegroundWindow()
        size = ctypes.windll.user32.GetWindowTextLengthW(hwnd) + 1
        buffer = ctypes.create_unicode_buffer(max(size, 2))
        ctypes.windll.user32.GetWindowTextW(hwnd, buffer, len(buffer))
        title = buffer.value
    except Exception:
        pass
    match = re.search(r"\[([^\[\]]+\.p3d)\]", title, re.I)
    project_path = match.group(1) if match else ""
    detected_name = os.path.splitext(os.path.basename(project_path))[0] if project_path else ""
    return {
        "name": detected_name or config.get("projectName", "BIMBase 当前工程"),
        "fileName": os.path.basename(project_path) if project_path else None,
        "path": project_path or None,
        "type": config.get("projectType"),
        "discipline": config.get("discipline"),
        "stage": config.get("stage")
    }


def check_fingerprint(project, components, rules):
    payload = {
        "project": project,
        "components": components,
        "rules": rules
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def safe_call(function, *args):
    try:
        return safe_value(function(*args))
    except Exception as error:
        return {"_readError": str(error)}


def safe_token(function, *args):
    try:
        return object_token(function(*args))
    except Exception as error:
        return {"_readError": str(error)}


def safe_attr(value, name):
    try:
        return getattr(value, name, None)
    except Exception:
        return None


def load_sdk():
    try:
        import pyp3d
        return pyp3d
    except Exception as error:
        raise RuntimeError("无法连接 BIMBase pyp3d 运行时，请从 BIMBase 内启动本脚本：%s" % error)


def value_list(value):
    """Flatten SDK containers. Include dict keys too: BIMBase relation maps may store ids as keys."""
    if value is None:
        return []
    if isinstance(value, dict):
        items = []
        for key, child in value.items():
            items.extend(value_list(key))
            items.extend(value_list(child))
        return items
    if isinstance(value, (list, tuple, set)):
        items = []
        for child in value:
            items.extend(value_list(child))
        return items
    return [value]


def is_entity_id(value):
    return hasattr(value, "_ElementId") and hasattr(value, "_ModelId")


def is_model_id(value):
    return hasattr(value, "_ModelId") and not hasattr(value, "_ElementId")


def append_entities(target, values):
    for item in value_list(values):
        if is_entity_id(item):
            target.append(item)


def describe_values(values):
    flat = value_list(values)
    entity_count = len([item for item in flat if is_entity_id(item)])
    model_count = len([item for item in flat if is_model_id(item)])
    samples = [object_token(item) for item in flat[:8]]
    return "flat=%d entity=%d model=%d sample=%s" % (len(flat), entity_count, model_count, samples)


def project_entity_ids(sdk, scope):
    probes = []
    entity_ids = []

    def probe(label, func):
        try:
            values = func()
            probes.append("%s ok %s" % (label, describe_values(values)))
            return values
        except Exception as error:
            probes.append("%s error %s" % (label, error))
            return None

    if scope == "active-model":
        append_entities(entity_ids, probe("get_entityid_by_activemodel", sdk.get_entityid_by_activemodel))
    else:
        append_entities(entity_ids, probe("get_all_entityid", sdk.get_all_entityid))

    if not entity_ids and scope != "active-model":
        append_entities(entity_ids, probe("get_entityid_by_activemodel", sdk.get_entityid_by_activemodel))

    relation = None
    if not entity_ids:
        relation = probe("get_modelid_entityid_relation", sdk.get_modelid_entityid_relation)
        append_entities(entity_ids, relation)

    if not entity_ids and relation is not None:
        # Last cheap fallback: relation often exposes model ids even when entity lists are not direct.
        for item in value_list(relation):
            if is_model_id(item):
                append_entities(entity_ids, probe("get_entityid_by_modelid %s" % object_token(item),
                                                  lambda item=item: sdk.get_entityid_by_modelid(item)))

    unique = {}
    for entity_id in entity_ids:
        if is_entity_id(entity_id):
            unique[object_token(entity_id)] = entity_id

    probe_log = os.environ.get("BIM_DOCTOR_PROBE_LOG")
    if probe_log:
        try:
            with open(probe_log, "a", encoding="utf-8") as stream:
                stream.write("project_entity_ids scope=%s -> unique=%d\n" % (scope, len(unique)))
                for line in probes:
                    stream.write("  %s\n" % line)
        except Exception:
            pass

    return list(unique.values())


def extraction_log(message):
    probe_log = os.environ.get("BIM_DOCTOR_PROBE_LOG")
    if probe_log:
        try:
            with open(probe_log, "a", encoding="utf-8") as stream:
                stream.write(message + "\n")
        except Exception:
            pass


def base_component(entity_id):
    entity_token = object_token(entity_id)
    model_id = safe_attr(entity_id, "_ModelId")
    element_id = safe_attr(entity_id, "_ElementId")
    return {
        "entityId": entity_token,
        "dataKey": None,
        "modelId": model_id,
        "elementId": element_id,
        "name": "BIMBase构件 %s" % entity_token,
        "componentType": "BIMBase构件",
        "componentTypeRaw": None,
        "schemaName": None,
        "parameters": {},
        "geometry": {},
        "extendedProperties": None,
        "rawProperties": {},
        "extractionErrors": ["DETAIL_SKIPPED: 默认稳定模式仅读取 EntityId/ModelId，避免 BIMBase SDK 属性接口阻塞。设置环境变量 BIM_DOCTOR_READ_DETAILS=1 可启用详细属性读取。"]
    }


def enrich_component_details(sdk, entity_id, component):
    entity_token = component["entityId"]
    errors = component["extractionErrors"]

    extraction_log("detail %s: get_datakey_from_entity start" % entity_token)
    try:
        data_key = sdk.get_datakey_from_entity(entity_id)
        component["dataKey"] = object_token(data_key) if data_key is not None else None
        extraction_log("detail %s: get_datakey_from_entity done" % entity_token)
    except Exception as error:
        data_key = None
        errors.append("dataKey: %s" % error)
        extraction_log("detail %s: get_datakey_from_entity error %s" % (entity_token, error))

    extraction_log("detail %s: get_noumenon_on_entityid start" % entity_token)
    try:
        noumenon = sdk.get_noumenon_on_entityid(entity_id)
        raw = noumenon_properties(noumenon)
        component["rawProperties"] = raw
        component["parameters"] = normalize_parameters(raw)
        class_name = safe_attr(noumenon, "className")
        schema_name = safe_attr(noumenon, "schemaName")
        component_type = first_value(raw, ("Category", "类别", "类型", "构件类型"))
        component["name"] = first_value(raw, ALIASES["name"]) or class_name or component["name"]
        component["componentType"] = component_type or class_name or component["componentType"]
        component["componentTypeRaw"] = class_name
        component["schemaName"] = schema_name
        extraction_log("detail %s: get_noumenon_on_entityid done props=%d" % (entity_token, len(raw)))
    except Exception as error:
        errors.append("noumenon: %s" % error)
        extraction_log("detail %s: get_noumenon_on_entityid error %s" % (entity_token, error))

    # 实机验证：BIMBase 2025 对部分普通实体调用这两个接口会触发原生崩溃，
    # Python try/except 无法捕获。默认桥接必须跳过，后续改走安全的通用属性来源。
    component["geometry"] = {}
    errors.append("GEOMETRY_SKIPPED_UNSAFE: get_Entity_Area/get_Entity_Volume 已禁用")
    extraction_log("detail %s: geometry skipped unsafe" % entity_token)

    if data_key is not None:
        extraction_log("detail %s: extended properties start" % entity_token)
        component["extendedProperties"] = safe_call(sdk.get_extended_property_json, data_key)
        extraction_log("detail %s: extended properties done" % entity_token)

    component["extractionErrors"] = [e for e in errors if not str(e).startswith("DETAIL_SKIPPED")]
    return component


def extract_components(scope="all"):
    sdk = load_sdk()
    entity_ids = project_entity_ids(sdk, scope)

    read_details = os.environ.get("BIM_DOCTOR_READ_DETAILS") == "1"
    extraction_log("extract_components scope=%s ids=%d read_details=%s" % (scope, len(entity_ids), read_details))

    components = []
    runtime_ids = {}
    for entity_id in entity_ids:
        entity_token = object_token(entity_id)
        runtime_ids[entity_token] = entity_id
        component = base_component(entity_id)
        extraction_log("component %s: base captured" % entity_token)
        if read_details:
            component = enrich_component_details(sdk, entity_id, component)
        components.append(component)

    extraction_log("extract_components done components=%d" % len(components))
    return components, runtime_ids


def extract_selected_component(panel_script):
    sdk = load_sdk()
    selected = [value for value in value_list(sdk.get_entityid_from_boxselection()) if is_entity_id(value)]
    if not selected:
        raise RuntimeError("请先选中一个构件")
    entity_id = selected[0]
    component = base_component(entity_id)
    raw = read_property_panel(panel_script)
    component["rawProperties"] = raw
    component["parameters"] = normalize_parameters(raw)
    component["name"] = first_value(raw, ALIASES["name"]) or component["name"]
    component["shapeName"] = component["name"]
    component["componentType"] = None
    component["geometry"] = {
        key: value for key, aliases in {
            "volume": ("体积", "volume"),
            "area": ("表面积", "面积", "area")
        }.items() for value in [first_value(raw, aliases)] if value is not None
    }
    component["extractionErrors"] = []
    return component


class ApiClient(object):
    def __init__(self, server_url, token="", timeout=120):
        self.base = server_url.rstrip("/")
        self.token = token
        self.timeout = timeout
        # BIMBase inherits the desktop proxy configuration; local bridge traffic must not go through it.
        self.opener = build_opener(ProxyHandler({}))

    def request(self, method, path, payload=None):
        data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["X-BIM-Bridge-Token"] = self.token
        request = Request(self.base + path, data=data, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            detail = error.read().decode("utf-8", "replace")
            raise RuntimeError("桥接 API %s：%s" % (error.code, detail))
        except URLError as error:
            raise RuntimeError("无法连接知识库服务 %s：%s" % (self.base, error))


def send_job(config, components):
    client = ApiClient(config["serverUrl"], config.get("token", ""), config.get("timeout", 120))
    project = dict(detect_project_context(config), source="BIMBase", sourceVersion="2025")
    try:
        rules = client.request("GET", "/api/bim-doctor/rules").get("rules", [])
    except Exception:
        rules = []
    project["checkFingerprint"] = check_fingerprint(project, components, rules)
    if config.get("dedupeChecks", True):
        try:
            jobs = client.request("GET", "/api/bim-doctor/jobs?limit=100").get("jobs", [])
            for existing in jobs:
                if existing.get("project", {}).get("checkFingerprint") == project["checkFingerprint"]:
                    existing_id = existing.get("id")
                    if existing_id:
                        print("检测内容未变化，复用已有检查任务：%s" % existing_id)
                        return client.request("GET", "/api/bim-doctor/jobs/%s/results" % existing_id)
        except Exception:
            pass
    job = client.request("POST", "/api/bim-doctor/jobs", {
        "project": project
    })
    batch_size = max(1, int(config.get("batchSize", 200)))
    for start in range(0, len(components), batch_size):
        batch = components[start:start + batch_size]
        client.request("POST", "/api/bim-doctor/jobs/%s/components" % job["id"], {"components": batch})
        print("已上传构件 %d/%d" % (min(start + batch_size, len(components)), len(components)))
    return client.request("POST", "/api/bim-doctor/jobs/%s/run" % job["id"], {})


def load_config(path):
    with open(path, "r", encoding="utf-8-sig") as stream:
        return json.load(stream)


def demo_components():
    return [
        {"entityId": "demo:1", "name": "示例挡土墙", "componentType": "挡土墙", "parameters": {"width": 500}},
        {"entityId": "demo:2", "name": "示例闸门", "componentType": "闸门", "parameters": {"height": 3000}}
    ]


def main():
    base = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description="BIMBase 构件医生桥接器")
    parser.add_argument("--config", default=os.path.join(base, "config.json"))
    parser.add_argument("--scope", choices=("all", "active-model"), default="all")
    parser.add_argument("--demo", action="store_true", help="不连接 BIMBase，发送两个演示构件")
    parser.add_argument("--probe", metavar="PATH", help="只提取构件并写入 JSON，不发送")
    args = parser.parse_args()
    config = load_config(args.config)
    components = demo_components() if args.demo else extract_components(args.scope)[0]
    if args.probe:
        with open(args.probe, "w", encoding="utf-8") as stream:
            json.dump(components, stream, ensure_ascii=False, indent=2)
        print("已写入：%s" % args.probe)
        return 0
    result = send_job(config, components)
    summary = result.get("summary", {})
    print("构件医生完成：总数 %(total)s，通过 %(pass)s，不符合 %(fail)s，待规则 %(needRule)s，缺数据 %(needData)s，异常 %(error)s" % summary)
    print("任务 ID：%s" % result.get("id"))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print("构件医生桥接失败：%s" % error)
        sys.exit(1)
