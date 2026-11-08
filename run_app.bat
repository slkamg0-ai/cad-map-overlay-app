@echo off
chcp 65001 > nul
echo Starting CAD-Map Bidirectional Overlay Web App on http://localhost:8090 ...
start "" "http://localhost:8090"
python "%~dp0serve.py" 8090
pause
