@echo off
setlocal
title DeepAI Bridge removal
chcp 65001 >nul 2>&1

rem Runs a copy of the installer from TEMP, so this folder can be deleted while
rem the script is still going. Switches: -Yes skips the questions.

set "UNINSTALLER=%TEMP%\deepai-bridge-uninstall.ps1"
copy /y "%~dp0install.ps1" "%UNINSTALLER%" >nul
if errorlevel 1 (
  echo.
  echo   Could not read install.ps1 next to this file.
  echo.
  if "%~1"=="" pause
  exit /b 1
)

start "" /b powershell -NoProfile -ExecutionPolicy Bypass -File "%UNINSTALLER%" -Uninstall %*
exit /b 0
