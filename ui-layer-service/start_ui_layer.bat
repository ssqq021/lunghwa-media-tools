@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo UI layer service is not installed. Run install_ui_layer.bat first.
  pause
  exit /b 1
)

echo Starting local UI layer service at http://127.0.0.1:7862
echo Keep this window open while using the website.
".venv\Scripts\python.exe" server.py

echo.
echo UI layer service stopped.
pause
