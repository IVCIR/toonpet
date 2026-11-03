@echo off
rem ==========================================================================
rem run-capture.cmd - capture real-mouse pat / drag logs (ADR 0039 / ADR 0040)
rem
rem IMPORTANT: keep this file ASCII-only.
rem   cmd.exe parses .cmd files line by line with the *ANSI* code page; a UTF-8
rem   file containing CJK text is mis-decoded before `chcp 65001` takes effect,
rem   and a mis-decoded byte sequence can swallow the following newline. The
rem   visible symptom is `'...' is not recognized as an internal command`.
rem   Chinese log lines are therefore matched through ASCII anchors
rem   (`ADR 0024 D`, `ADR 0040 D3`, `squashMax`, `headBoneCss`, ...) instead of
rem   Chinese patterns.
rem
rem usage:
rem   run-capture.cmd            normal capture (starts the pet, waits for you)
rem   run-capture.cmd --check    parse self-test: prints OK, starts nothing
rem ==========================================================================
chcp 65001 >nul
cd /d "%~dp0"

if /i "%~1"=="--check" (
  echo OK: run-capture.cmd parsed without errors.
  echo OK: working dir = %~dp0
  exit /b 0
)

echo ==== 3D pet :: capture pat / drag logs ====
echo.
echo Press any key to start the pet in a new window. Then do two things:
echo   1) move the mouse onto her FACE and click once (press, release, no move)
echo   2) drag her some distance, release, let her land on the screen bottom
echo.
echo Then come back to this window and press any key.
echo Only electron processes whose command line contains "aa3dpet-app" are
echo stopped; other Electron apps are not touched.
echo.
pause >nul

if not exist logs mkdir logs
if exist logs\pet.log ren logs\pet.log pet.before-capture.log
start "3D pet (capture)" cmd /c "npm.cmd start"
echo Waiting 8s for startup ...
timeout /t 8 /nobreak >nul
echo.
echo Now do the two actions, then press any key here ...
pause >nul

powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.CommandLine -like '*aa3dpet-app*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
timeout /t 2 /nobreak >nul

set REPORT=logs\capture-report.txt
> "%REPORT%" echo ==== (1) gesture facts and head_patted chain ====
>> "%REPORT%" findstr /C:"[drag-gesture]" /C:"head_patted" logs\pet.log
>> "%REPORT%" echo.
>> "%REPORT%" echo ==== (2) landing / settle chain (ADR 0024 D2/D3, ADR 0040 D3) ====
>> "%REPORT%" findstr /C:"ADR 0024 D" /C:"ADR 0040 D3" /C:"squashMax" /C:"bounces" logs\pet.log
>> "%REPORT%" echo.
>> "%REPORT%" echo ==== (3) head region geometry ====
>> "%REPORT%" findstr /C:"[render] probe" /C:"headBoneCss" /C:"bandBottomY" logs\pet.log

echo.
echo ==== report written: %REPORT% ====
echo.
echo -- line counts --
echo gesture lines:
find /c "[drag-gesture]" logs\pet.log
echo emit-head_patted lines:
find /c "emit head_patted" logs\pet.log
echo landing lines:
find /c "ADR 0040 D3" logs\pet.log
echo emitted-events lines:
find /c "head_patted" logs\pet.log

echo.
echo -- head region geometry (one line) --
findstr /C:"headBoneCss" logs\pet.log

echo.
echo -- last 40 report lines --
powershell -NoProfile -Command "Get-Content -Encoding UTF8 'logs\capture-report.txt' -Tail 40"

echo.
echo Send logs\capture-report.txt (or the blocks above) to the maintainer.
echo Previous log kept as logs\pet.before-capture.log
pause
