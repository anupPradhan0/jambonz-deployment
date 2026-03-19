#!/bin/bash

# Jambonz Database Initialization Script
# This script initializes the MySQL database for Jambonz

set -e

# Configuration
MYSQL_HOST="${JAMBONES_MYSQL_HOST:-localhost}"
MYSQL_PORT="${JAMBONES_MYSQL_PORT:-3306}"
MYSQL_USER="${JAMBONES_MYSQL_USER:-jambones}"
MYSQL_PASSWORD="${JAMBONES_MYSQL_PASSWORD:-jambones_password}"
MYSQL_DATABASE="${JAMBONES_MYSQL_DATABASE:-jambones}"
MYSQL_ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD:-root_password}"

echo "=========================================="
echo "Jambonz Database Initialization"
echo "=========================================="
echo "Host: $MYSQL_HOST"
echo "Port: $MYSQL_PORT"
echo "Database: $MYSQL_DATABASE"
echo "User: $MYSQL_USER"
echo ""

# Wait for MySQL to be ready
echo "Waiting for MySQL to be ready..."
max_attempts=30
attempt=0
until mysql -h "$MYSQL_HOST" -P "$MYSQL_PORT" -u root -p"$MYSQL_ROOT_PASSWORD" -e "SELECT 1" > /dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ $attempt -ge $max_attempts ]; then
    echo "MySQL failed to start after $max_attempts attempts"
    exit 1
  fi
  echo "Attempt $attempt/$max_attempts: Waiting for MySQL..."
  sleep 2
done

echo "✓ MySQL is ready"
echo ""

# Create database if it doesn't exist
echo "Creating database if it doesn't exist..."
mysql -h "$MYSQL_HOST" -P "$MYSQL_PORT" -u root -p"$MYSQL_ROOT_PASSWORD" <<EOF
CREATE DATABASE IF NOT EXISTS $MYSQL_DATABASE CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON $MYSQL_DATABASE.* TO '$MYSQL_USER'@'%' IDENTIFIED BY '$MYSQL_PASSWORD';
FLUSH PRIVILEGES;
EOF

echo "✓ Database created/verified"
echo ""

# Run database migrations from api-server if available
if [ -f "/app/jambonz-api-server/db/upgrade-jambonz-db.js" ]; then
  echo "Running database migrations..."
  cd /app/jambonz-api-server
  node db/upgrade-jambonz-db.js
  echo "✓ Database migrations completed"
else
  echo "Note: Database migration script not found. Ensure migrations are run before starting services."
fi

echo ""
echo "=========================================="
echo "Database initialization complete!"
echo "=========================================="
