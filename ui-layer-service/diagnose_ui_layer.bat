@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo DIAGNOSE_FAILED: run install_ui_layer.bat first.
  pause
  exit /b 1
)

".venv\Scripts\python.exe" -c "import json, urllib.request; data=json.load(urllib.request.urlopen('http://127.0.0.1:7862/health', timeout=5)); print('DIAGNOSE_OK' if data.get('ok') else 'DIAGNOSE_FAILED'); print(data.get('message', ''))"
pause
