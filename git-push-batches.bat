@echo off
setlocal enabledelayedexpansion
echo ========================================
echo   Git Push in 1500MB Batches
echo ========================================
echo.

set "BATCH_DIR=world-batches"
set "MAX_SIZE=1500"

:: Create batch directory
if exist "%BATCH_DIR%" rmdir /s /q "%BATCH_DIR%"
mkdir "%BATCH_DIR%"

:: Group region files into 1500MB batches
set "batch=0"
set "size=0"
for %%f in (world\region\*.mca) do (
    for %%s in (%%~zf) do set /a "size += (%%s / 1048576)"
    set /a "sizeMB = !size!"
    if !sizeMB! geq %MAX_SIZE% (
        set /a "batch += 1"
        set "size=0"
    )
    copy "%%f" "%BATCH_DIR%\batch-!batch!\" >nul 2>&1
)

echo Created !batch! batches in %BATCH_DIR%
echo.

set "fail=0"
for /l %%b in (0,1,!batch!) do (
    echo --- Pushing batch %%b/!batch! ---
    
    :: Copy batch files to world/region/
    if exist "%BATCH_DIR%\batch-%%b\*.mca" (
        copy "%BATCH_DIR%\batch-%%b\*.mca" world\region\ >nul 2>&1
        git add world\region\*.mca
        git add state\
        git commit -m "chore: world region batch %%b/!batch!"
        
        git push
        if !errorlevel! neq 0 (
            echo [FAIL] Batch %%b push failed
            set /a "fail += 1"
        )
    )
)

:: Cleanup
rmdir /s /q "%BATCH_DIR%"

if !fail! equ 0 (
    echo.
    echo All batches pushed successfully!
) else (
    echo.
    echo !fail! batches failed.
)
pause
