@echo off
echo Starting server + public tunnel...
echo Keep this window open while people fill out the form.
echo.
start "Newsletter Server" node "%~dp0src\index.js"
timeout /t 2 /nobreak >nul
node "%~dp0scripts\start-public.js"
pause
