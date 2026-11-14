@echo off
setlocal
cd /d "%~dp0"
if exist "dist\win-unpacked\DOConstruct.exe" (
  start "" "dist\win-unpacked\DOConstruct.exe" %*
  exit /b
)
if exist "node_modules\electron\dist\electron.exe" (
  set ELECTRON_RUN_AS_NODE=
  start "" "node_modules\electron\dist\electron.exe" "%~dp0" %*
  exit /b
)
echo Please install DOConstruct from dist or prepare its development dependencies.
pause
