@echo off
if "%1"=="" (
  set /p ADDR="Send test to: "
) else (
  set ADDR=%1
)
echo.
node "%~dp0scripts\test-email.js" %ADDR%
pause
