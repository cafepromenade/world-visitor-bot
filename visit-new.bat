@echo off
echo Starting Overworld Visitor (new regions only)...
echo This runs the Minecraft server + bot for new/modified regions.
echo Press Ctrl+C to stop.
echo.
docker compose -f compose.new.yml up --abort-on-container-exit mc visitor-new
echo.
echo Done. Server stopped.
pause
