@echo off
title CI Project Dashboard
cd /d "%~dp0"

netstat -ano | findstr ":4870" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo The dashboard is already running. Opening your browser...
  start "" http://localhost:4870
  timeout /t 3 >nul
  exit
)

if not exist "datadashboard.db" (
  echo First run: building the project list...
  node srcseed.js
  echo.
)

echo Starting the CI Project Dashboard...
echo Keep this window open while you use it. Close it to stop the dashboard.
echo.
start "" http://localhost:4870
node server.js
echo.
echo The dashboard stopped. If this was unexpected, read the message above.
pause
