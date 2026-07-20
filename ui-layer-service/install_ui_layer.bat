@echo off
setlocal
cd /d "%~dp0"

set "PYTHON_CMD="
where py >nul 2>nul && set "PYTHON_CMD=py -3"
if not defined PYTHON_CMD where python >nul 2>nul && set "PYTHON_CMD=python"
if not defined PYTHON_CMD goto :no_python

%PYTHON_CMD% -c "import sys; raise SystemExit(0 if sys.version_info[:2] in ((3,10),(3,11)) else 1)"
if errorlevel 1 goto :bad_python

if not exist ".venv\Scripts\python.exe" (
  echo Creating local UI layer environment...
  %PYTHON_CMD% -m venv .venv || goto :fail
)

call ".venv\Scripts\activate.bat" || goto :fail
python -m pip install --upgrade pip || goto :fail

echo Installing NVIDIA PyTorch...
python -m pip install torch==2.6.0 torchvision==0.21.0 --index-url https://download.pytorch.org/whl/cu126 || goto :fail

echo Installing UI layer service...
python -m pip install -r requirements.txt || goto :fail

echo.
echo Installation complete. Run start_ui_layer.bat next.
pause
exit /b 0

:no_python
echo Python was not found. Install 64-bit Python 3.10 or 3.11 first.
pause
exit /b 1

:bad_python
echo This package requires 64-bit Python 3.10 or 3.11.
pause
exit /b 1

:fail
echo.
echo Installation failed. Keep this window open and review the error above.
pause
exit /b 1
