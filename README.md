# 水利水电规范知识库与 BIMBase 构件医生

目标链路：

```text
BIMBase .p3d → 构件及属性提取 → 规范知识库检索 → 规则判定 → PASS / FAIL / NEED_DATA / NEED_RULE
```

## 当前进度

- 知识库服务及构件医生 API 已完成。
- BIMBase 2025 插件可枚举工程构件并上传检查任务。
- 已实机读取选中构件的名称、长宽高、体积、面积和材质。
- `get_Entity_Area/get_Entity_Volume` 会导致 BIMBase 原生崩溃，已永久禁用；当前选中构件属性通过 BIMBase 属性面板的 Windows 可访问性接口安全读取。
- 正式机器规则尚待录入，因此无适用规则时返回 `NEED_RULE`。

## 启动

```powershell
npm install
$env:PORT=4174
npm start
npm run test:bim-doctor
```

规范 PDF 放入本地 `水利水电规范库/` 后建立索引。该目录、缓存、运行日志和 BIMBase SDK 均不提交仓库。

## BIMBase 插件

运行 `安装构件医生桥接.cmd`，重启 BIMBase，在：

```text
工具 → 构件医生
```

使用“检查选中构件”“检查全部构件”“检查活动模型”及诊断工具。

桥接细节见 `bimbase_bridge/README.md`。

