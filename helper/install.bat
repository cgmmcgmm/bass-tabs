@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Bass Tabs helper - install

echo === Bass Tabs stem helper: one-time install ===
echo.

rem --- find Python 3.10-3.12 (PyTorch + Demucs don't support 3.13 well yet) ---
set PY=
for %%V in (3.12 3.11 3.10) do (
  if not defined PY (
    py -%%V -c "import sys" >nul 2>&1 && set PY=py -%%V
  )
)
if not defined PY (
  python -c "import sys; exit(0 if (3,10)<=sys.version_info[:2]<=(3,12) else 1)" >nul 2>&1 && set PY=python
)
if not defined PY (
  echo Python 3.10, 3.11 or 3.12 was not found.
  where winget >nul 2>&1
  if !errorlevel! == 0 (
    choice /M "Install Python 3.12 now with winget"
    if !errorlevel! == 1 (
      winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
      echo.
      echo Python installed. Close this window and run install.bat again.
      pause
      exit /b 0
    )
  )
  echo Please install Python 3.12 from https://www.python.org/downloads/ ^(tick "Add python.exe to PATH"^)
  echo and run install.bat again.
  pause
  exit /b 1
)
echo Using: %PY%
%PY% --version

rem --- virtual environment (keeps everything inside this folder) ---
if not exist .venv (
  echo Creating virtual environment...
  %PY% -m venv .venv || goto :fail
)
set VPY=.venv\Scripts\python.exe
%VPY% -m pip install --upgrade pip >nul

rem --- PyTorch: CUDA build if an NVIDIA GPU is present, else CPU ---
where nvidia-smi >nul 2>&1
if %errorlevel% == 0 (
  echo NVIDIA GPU found: installing PyTorch with CUDA ^(large download, ~2.5 GB^)...
  %VPY% -m pip install torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cu124 || goto :fail
) else (
  echo No NVIDIA GPU found: installing CPU PyTorch ^(separation will be slower^)...
  %VPY% -m pip install torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cpu || goto :fail
)

echo Installing Demucs...
%VPY% -m pip install -r requirements.txt || goto :fail

echo.
%VPY% -c "import torch, demucs; print('Demucs ready. Device:', 'cuda (' + torch.cuda.get_device_name(0) + ')' if torch.cuda.is_available() else 'cpu')" || goto :fail
echo.
echo === Install complete. Run start.bat to start the helper. ===
pause
exit /b 0

:fail
echo.
echo *** Install failed - see the messages above. ***
pause
exit /b 1
