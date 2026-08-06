@echo off
chcp 65001 >nul
title 设计规范知识库 - 远程共享
cd /d "%~dp0"

if not exist "tools\cloudflared.exe" (
  where cloudflared >nul 2>&1
  if errorlevel 1 (
    echo 未找到 cloudflared，无法建立无需登录的远程访问地址。
    pause
    exit /b 1
  )
)

if not exist "tools\node.exe" (
  where node >nul 2>&1
  if errorlevel 1 (
    echo 知识库运行程序缺失，请重新复制完整的 wangye 文件夹。
    pause
    exit /b 1
  )
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

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\share.ps1"
pause
