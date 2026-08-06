@echo off
chcp 65001 >nul
setlocal
set "SOURCE=%~dp0bimbase_bridge"
set "TARGET=D:\BIMBase建模软件 2025\PythonScript\python-3.7.9-embed-amd64\Lib\BPPythonP3DSDK\BIMDoctor"
set "PLUGIN_SOURCE=%~dp0bimbase_plugin\90构件医生"
set "PLUGIN_TARGET=D:\BIMBase建模软件 2025\App\90构件医生"
if not exist "%TARGET%" mkdir "%TARGET%"
copy /Y "%SOURCE%\bridge.py" "%TARGET%\bridge.py" >nul
copy /Y "%SOURCE%\realtime_bridge.py" "%TARGET%\realtime_bridge.py" >nul
copy /Y "%SOURCE%\README.md" "%TARGET%\README.md" >nul
if not exist "%TARGET%\config.json" copy /Y "%SOURCE%\config.json" "%TARGET%\config.json" >nul
if not exist "%PLUGIN_TARGET%" mkdir "%PLUGIN_TARGET%"
xcopy "%PLUGIN_SOURCE%\*" "%PLUGIN_TARGET%\" /E /I /Y >nul
if errorlevel 1 (
  echo 安装失败，请检查 BIMBase 路径。
  exit /b 1
)
echo 已安装桥接器：%TARGET%
echo 已安装插件：%PLUGIN_TARGET%
echo 重启 BIMBase 后，在“工具 - 构件医生”中使用。
pause
