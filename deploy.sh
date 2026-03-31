#!/bin/bash
# Deploy Curiothymia to Digital Ocean droplet
set -e

SERVER="root@192.241.144.238"
APP_DIR="/var/www/curiothymia"

echo "Pushing to GitHub..."
git push origin main

echo "Deploying to droplet..."
ssh $SERVER "cd $APP_DIR && git pull && npm install --omit=dev && pm2 restart curiothymia"

echo ""
echo "Live at http://192.241.144.238"
