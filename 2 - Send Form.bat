@echo off
echo Sending form emails to all subscribers...
echo (Run "1 - Start Server" first and keep it open)
echo.
node "%~dp0scripts\send-form.js"
pause
