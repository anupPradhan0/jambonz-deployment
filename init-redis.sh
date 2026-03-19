#!/bin/bash

# Jambonz Redis Initialization Script
# This script initializes Redis for Jambonz caching and session management

set -e

# Configuration
REDIS_HOST="${JAMBONES_REDIS_HOST:-localhost}"
REDIS_PORT="${JAMBONES_REDIS_PORT:-6379}"
REDIS_PASSWORD="${JAMBONES_REDIS_PASSWORD:-}"

echo "=========================================="
echo "Jambonz Redis Initialization"
echo "=========================================="
echo "Host: $REDIS_HOST"
echo "Port: $REDIS_PORT"
echo ""

# Wait for Redis to be ready
echo "Waiting for Redis to be ready..."
max_attempts=30
attempt=0

if [ -z "$REDIS_PASSWORD" ]; then
  until redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping > /dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ $attempt -ge $max_attempts ]; then
      echo "Redis failed to start after $max_attempts attempts"
      exit 1
    fi
    echo "Attempt $attempt/$max_attempts: Waiting for Redis..."
    sleep 2
  done
else
  until redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" -a "$REDIS_PASSWORD" ping > /dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ $attempt -ge $max_attempts ]; then
      echo "Redis failed to start after $max_attempts attempts"
      exit 1
    fi
    echo "Attempt $attempt/$max_attempts: Waiting for Redis..."
    sleep 2
  done
fi

echo "✓ Redis is ready"
echo ""

# Initialize Redis configuration
echo "Initializing Redis configuration..."

if [ -z "$REDIS_PASSWORD" ]; then
  redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" <<EOF
CONFIG SET maxmemory 512mb
CONFIG SET maxmemory-policy allkeys-lru
CONFIG SET timeout 300
CONFIG SET tcp-keepalive 60
SAVE
EOF
else
  redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" -a "$REDIS_PASSWORD" <<EOF
CONFIG SET maxmemory 512mb
CONFIG SET maxmemory-policy allkeys-lru
CONFIG SET timeout 300
CONFIG SET tcp-keepalive 60
SAVE
EOF
fi

echo "✓ Redis configuration completed"
echo ""

# Verify Redis is working
if [ -z "$REDIS_PASSWORD" ]; then
  redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" INFO server | head -5
else
  redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" -a "$REDIS_PASSWORD" INFO server | head -5
fi

echo ""
echo "=========================================="
echo "Redis initialization complete!"
echo "=========================================="
