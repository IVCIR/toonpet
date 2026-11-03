@echo off
rem ==========================================================================
rem run-doctor.cmd - read-only environment check (no files are modified).
rem Keep this file ASCII-only: cmd.exe parses .cmd with the ANSI code page and
rem mis-decodes UTF-8/CJK text (see run-capture.cmd header for the details).
rem ==========================================================================
chcp 65001 >nul
cd /d "%~dp0"

if /i "%~1"=="--check" (
  echo OK: run-doctor.cmd parsed without errors.
  exit /b 0
)

echo ==== context ====
whoami /groups | findstr /i "Mandatory Label"
echo.
echo ==== 3D pet :: doctor (read-only, modifies nothing) ====
call npm.cmd run doctor
echo.
echo ==== notes ====
echo   - items marked as missing are listed in docs\guides\LOCAL-SERVICES.md
echo   - doctor always exits 0 (report only, never fails the build)
echo.
pause
