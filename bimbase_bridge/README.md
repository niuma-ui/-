# BIMBase 构件医生桥接器

## 当前闭环

1. BIMBase 通过 `pyp3d` 遍历当前工程构件。
2. 稳定提取 `EntityId/ModelId`；选中构件通过属性面板桥接读取名称、尺寸、面积、体积和材质。
3. 分批发送到知识库 `/api/bim-doctor/jobs`。
4. 知识库检索候选规范，并使用 `bim-doctor-rules.json` 中经审核的规则判定。
5. 没有机器规则时返回 `NEED_RULE`，不会把“检索到规范”误报为“符合规范”。

构件名称仅作为几何形状展示（如“长方体”），不参与规范归类。规范归类优先使用当前 `.p3d` 工程身份，以及规则中的 `projectTypes`、`disciplines`、`systemTypes`、`assemblyTypes` 和语义 `componentTypes`。

## 运行

先双击项目根目录的 `启动知识库.cmd`，或执行：

```powershell
$env:PORT=4174
node server.mjs
```

不连接 BIMBase 的链路测试：

```powershell
python bimbase_bridge/bridge.py --demo
```

运行 `安装构件医生桥接.cmd` 并重启 BIMBase 后，可直接使用“工具 - 构件医生 - 检查选中构件/检查全部构件/检查活动模型”。也可以在 BIMBase Python 环境中执行：

```text
bridge.py --scope all
bridge.py --scope active-model
bridge.py --scope all --probe D:\bim-components.json
```

远程桥接时，服务端设置 `BIM_BRIDGE_TOKEN`，并把相同值写入 `config.json`。未设置令牌时接口只接受本机回环连接。

## 规则

规则文件是项目根目录的 `bim-doctor-rules.json`。格式参考 `bim-doctor-rules.example.json`。

支持操作符：`exists`、`==`、`!=`、`>`、`>=`、`<`、`<=`、`between`、`contains`。

规则投入使用前必须补齐并复核：规范编号、条文号、适用构件、字段、单位、条件和限值。

## SDK 安全说明

BIMBase 2025 普通几何实体调用 `get_Entity_Area/get_Entity_Volume` 会触发原生进程崩溃，Python 异常无法捕获，因此桥接中禁止调用这两个接口。
