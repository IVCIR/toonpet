@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==== context ====
whoami /groups | findstr /i "Mandatory Label"
echo DSH_SESSION_ID=[%DSH_SESSION_ID%] ELECTRON_RUN_AS_NODE=[%ELECTRON_RUN_AS_NODE%]
echo.
echo ==== 3D pet :: start ====
call npm.cmd start
echo.
echo [exit code] %ERRORLEVEL%
pause
