@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 ou plus recent est requis : https://nodejs.org/
  pause
  exit /b 1
)

echo MeshLab RF est disponible sur http://localhost:8765
echo Appuyez sur Ctrl+C pour arreter.
node server.js
pause
