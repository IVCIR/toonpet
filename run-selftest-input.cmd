@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==== context ====
echo integrity:
whoami /groups | findstr /i "Mandatory Label"
echo DSH_SESSION_ID=[%DSH_SESSION_ID%]
echo ELECTRON_RUN_AS_NODE=[%ELECTRON_RUN_AS_NODE%]
echo.
echo ==== 3D pet :: input bar selftest ====
call npm.cmd run selftest:input
echo.
echo ==== screenshots ====
if exist dist\selftest\input-bar.png (echo [ok] dist\selftest\input-bar.png) else (echo [missing] dist\selftest\input-bar.png)
if exist dist\selftest\input-submitted.png (echo [ok] dist\selftest\input-submitted.png) else (echo [missing] dist\selftest\input-submitted.png)
echo.
echo ==== logs\pet.log (tail) ====
if exist logs\pet.log (powershell -NoProfile -Command "Get-Content logs\pet.log -Tail 60") else (echo [missing] logs\pet.log)
echo.
pause
