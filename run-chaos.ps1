docker compose up -d --build --scale worker=8
Start-Sleep -Seconds 5
node harness/chaos.js