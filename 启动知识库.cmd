@echo off
chcp 65001 >nul
title 设计规范知识库
cd /d "%~dp0"

set "NODE_EXE=%~dp0tools\node.exe"
if not exist "%NODE_EXE%" (
  where node >nul 2>&1
  if errorlevel 1 (
    echo 知识库运行程序缺失，无法启动服务。
    pause
    exit /b 1
  )
  set "NODE_EXE=node"
)

if not exist "node_modules\" (
  echo 正在准备知识库运行环境，请稍候...
  where npm >nul 2>&1
  if errorlevel 1 (
    echo 知识库依赖文件不完整，请重新复制完整的 wangye 文件夹。
    pause
    exit /b 1
  )
  call npm install --omit=dev
  if errorlevel 1 (
    echo 运行环境准备失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

echo.
echo 知识库正在启动。保持此窗口开启即可继续使用。
echo.
set "PORT=4174"
start "" "http://127.0.0.1:4174/index_20260725.html"
"%NODE_EXE%" server.mjs

echo.
echo 知识库服务已停止。
pause
