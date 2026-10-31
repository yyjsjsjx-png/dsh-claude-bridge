@echo off
if not exist "%~dp0scripts\start-update.ps1" (
    echo Missing updater files. Extract the complete ZIP first.
    pause
    exit /b 1
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-update.ps1" %*
exit /b %errorlevel%
