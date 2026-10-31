@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==== context ====
echo integrity:
whoami /groups | findstr /i "Mandatory Label"
echo DSH_SESSION_ID=[%DSH_SESSION_ID%]
echo ELECTRON_RUN_AS_NODE=[%ELECTRON_RUN_AS_NODE%]
echo.
echo ==== 3D pet :: speech selftest ====
call npm.cmd run selftest:speech
echo.
echo ==== screenshots ====
if exist dist\selftest\window-idle.png (echo [ok] dist\selftest\window-idle.png) else (echo [missing] dist\selftest\window-idle.png)
if exist dist\selftest\window-speech.png (echo [ok] dist\selftest\window-speech.png) else (echo [missing] dist\selftest\window-speech.png)
echo.
echo ==== logs\pet.log (tail) ====
if exist logs\pet.log (powershell -NoProfile -Command "Get-Content logs\pet.log -Tail 80") else (echo [missing] logs\pet.log)
echo.
pause
