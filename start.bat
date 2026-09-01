@echo off
REM UTF-8 Chinese breaks default CMD (GBK); keep this file ASCII-only.
set "ROOT=%~dp0"
cd /d "%ROOT%"

if not exist "bbq-generator\bbq-generator\node_modules" (
  echo [start] First run: installing dependencies...
  call npm install --prefix bbq-generator\bbq-generator
  if errorlevel 1 (
    echo [start] npm install failed.
    pause
    exit /b 1
  )
)

echo [start] Starting Vite dev server...
echo [start] Open http://localhost:5173/ or the URL shown below.
call npm run dev
if errorlevel 1 (
  echo [start] Dev server failed to start.
  pause
  exit /b 1
)
pause
