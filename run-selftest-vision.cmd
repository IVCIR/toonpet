@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==== context ====
echo integrity:
whoami /groups | findstr /i "Mandatory Label"
echo DSH_SESSION_ID=[%DSH_SESSION_ID%]
echo ELECTRON_RUN_AS_NODE=[%ELECTRON_RUN_AS_NODE%]
echo.
echo ==== 3D pet :: vision / OCR selftest ====
call npm.cmd run selftest:vision
echo.
echo ==== evidence ====
if exist logs\evidence\vision-chain.json (echo [ok] logs\evidence\vision-chain.json) else (echo [missing] logs\evidence\vision-chain.json)
if exist dist\selftest\vision-capture.png (echo [ok] dist\selftest\vision-capture.png) else (echo [missing] dist\selftest\vision-capture.png)
if exist dist\selftest\vision-reply.png (echo [ok] dist\selftest\vision-reply.png) else (echo [missing] dist\selftest\vision-reply.png)
if exist dist\selftest\vision-desktop.png (echo [ok] dist\selftest\vision-desktop.png) else (echo [missing] dist\selftest\vision-desktop.png)
echo.
echo ==== logs\pet.log (tail) ====
if exist logs\pet.log (powershell -NoProfile -Command "Get-Content logs\pet.log -Tail 120") else (echo [missing] logs\pet.log)
echo.
pause
