@echo off
cd /d "%~dp0"
title Bass Tabs helper
if not exist .venv\Scripts\python.exe (
  echo The helper isn't installed yet. Run install.bat first.
  pause
  exit /b 1
)
rem Open the app in the browser once the server is up.
start "" /b cmd /c "timeout /t 2 >nul & start http://localhost:7860/"
.venv\Scripts\python.exe server.py --port 7860 %*
pause
