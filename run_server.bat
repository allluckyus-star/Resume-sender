@echo off
setlocal EnableExtensions

REM Resume API server launcher (main.py / uvicorn)
set "SCRIPT_DIR=%~dp0"
set "APP_FILE=%SCRIPT_DIR%main.py"
set "HOST=0.0.0.0"
if not defined PORT set "PORT=8000"

if not exist "%APP_FILE%" (
  echo [ERROR] main.py not found at "%APP_FILE%"
  pause
  exit /b 1
)

set "PYEXE="
if exist "%SCRIPT_DIR%.venv\Scripts\python.exe" (
  set "PYEXE=%SCRIPT_DIR%.venv\Scripts\python.exe"
)

if defined PYEXE goto :run

where python >nul 2>nul
if not errorlevel 1 (
  python -V >nul 2>nul
  if not errorlevel 1 (
    set "PYEXE=python"
    goto :run
  )
)

where py >nul 2>nul
if not errorlevel 1 (
  py -3 -V >nul 2>nul
  if not errorlevel 1 (
    set "PYEXE=py"
    set "PYVER=-3"
    goto :run
  )
)

echo [ERROR] Python not found. Install Python 3.11+ or create .venv first.
pause
exit /b 1

:run
echo [Resume] Starting API server on http://%HOST%:%PORT%
echo [Resume] Working dir: %SCRIPT_DIR%
echo [Resume] Another port: set PORT=8001 before running this script.
echo.

pushd "%SCRIPT_DIR%"
if defined PYVER (
  "%PYEXE%" %PYVER% -m uvicorn main:app --host %HOST% --port %PORT%
) else (
  "%PYEXE%" -m uvicorn main:app --host %HOST% --port %PORT%
)
set "EXITCODE=%ERRORLEVEL%"
popd

if not "%EXITCODE%"=="0" (
  echo.
  echo [ERROR] Server exited with code %EXITCODE%.
  echo [HINT] Install deps: pip install -r requirements.txt
  echo [HINT] If bind failed ^(address already in use^), close the other server or run: set PORT=8001
  pause
)

exit /b %EXITCODE%
