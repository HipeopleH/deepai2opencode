@echo off
setlocal
title DeepAI Bridge setup
chcp 65001 >nul 2>&1

rem Double-click this file. It runs install.ps1 with a friendly console.
rem Optional switches: -Uninstall, -Yes, -NoOpen, -NoAutostart.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if errorlevel 1 (
  echo.
  echo   Setup did not finish. The messages above say why.
  echo.
  if "%~1"=="" pause
  exit /b 1
)

if "%~1"=="" pause
exit /b 0
