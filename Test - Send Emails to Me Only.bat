@echo off
echo Sending form + newsletter preview to just you (%SMTP_USER%)...
echo.
node "%~dp0scripts\send-to-me.js"
pause
