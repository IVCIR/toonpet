@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==== context ====
whoami /groups | findstr /i "Mandatory Label"
echo.
echo ==== 3D pet :: doctor (只读自检，不修改任何东西) ====
call npm.cmd run doctor
echo.
echo ==== 说明 ====
echo   - 红色 ✘ 为缺失项，修复步骤见 docs\guides\LOCAL-SERVICES.md
echo   - doctor 退出码恒为 0（只报告，不判定构建失败）
echo.
pause
