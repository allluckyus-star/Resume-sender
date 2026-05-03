@echo off
setlocal

cd /d "%~dp0"

echo [1/3] Installing dependencies...
python -m pip install -r requirements.txt pyinstaller
if errorlevel 1 goto :fail

echo [2/3] Building ResumeSenderBackend.exe...
python -m PyInstaller ^
  --noconfirm ^
  --clean ^
  --onefile ^
  --name ResumeSenderBackend ^
  --hidden-import httpx ^
  --hidden-import httpcore ^
  --hidden-import h11 ^
  --add-data "resume-extension;resume-extension" ^
  --add-data "upload;upload" ^
  windows_backend_launcher.py
if errorlevel 1 goto :fail

echo [3/3] Build complete.
echo EXE: %cd%\dist\ResumeSenderBackend.exe
exit /b 0

:fail
echo Build failed.
exit /b 1
