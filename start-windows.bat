@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install the LTS version from https://nodejs.cn or https://nodejs.org, then run this again.
  pause
  exit /b 1
)
chcp 65001 >nul
node server.js
pause
