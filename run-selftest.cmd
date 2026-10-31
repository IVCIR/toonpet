@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==== context ====
echo integrity:
whoami /groups | findstr /i "Mandatory Label"
echo DSH_SESSION_ID=[%DSH_SESSION_ID%]
echo ELECTRON_RUN_AS_NODE=[%ELECTRON_RUN_AS_NODE%]
echo.
echo ==== 3D pet :: selftest ====
call npm.cmd run selftest
echo.
echo ==== logs\start.log ====
if exist logs\start.log (type logs\start.log) else (echo [missing] logs\start.log)
echo.
echo ==== logs\boot.log ====
if exist logs\boot.log (type logs\boot.log) else (echo [missing] logs\boot.log)
echo.
echo ==== logs\pet.log ====
if exist logs\pet.log (type logs\pet.log) else (echo [missing] logs\pet.log)
echo.
echo ==== selftest screenshot ====
if exist dist\selftest\window.png (echo [ok] dist\selftest\window.png) else (echo [missing] dist\selftest\window.png)
echo.
pause
