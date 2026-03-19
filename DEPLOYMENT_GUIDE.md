# Jambonz Platform Deployment Guide

This guide covers deploying Jambonz using Nixpacks/Dockply instead of Docker.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Local Development Setup](#local-development-setup)
3. [Nixpacks Deployment](#nixpacks-deployment)
4. [Dockply Deployment](#dockply-deployment)
5. [Environment Configuration](#environment-configuration)
6. [Database Setup](#database-setup)
7. [Service Verification](#service-verification)
8. [Troubleshooting](#troubleshooting)

## Prerequisites

### System Requirements

- Node.js 18.x or higher
- npm 8.x or higher
- MySQL 8.0 or PostgreSQL 12+
- Redis 6.0 or higher
- Nixpacks (for building OCI images)
- Dockply (for deployment)

### Installation

```bash
# Install Node.js dependencies for all services
cd /home/ubuntu/jambonz-deployment

for dir in jambonz-feature-server jambonz-api-server sbc-inbound sbc-outbound sbc-sip-sidecar jambonz-webapp; do
  cd "$dir"
  npm install --legacy-peer-deps 2>/dev/null || npm install
  cd ..
done
```

## Local Development Setup

### Using PM2

PM2 is a process manager for Node.js applications. It allows running multiple services locally.

#### Install PM2

```bash
npm install -g pm2
```

#### Webapp only (dev UI)

API must be running on port **3000** first.

```bash
./dev-webapp.sh
# → http://localhost:3001
```

#### Start All Services

```bash
cd /home/ubuntu/jambonz-deployment

# Start all services using ecosystem configuration (includes jambonz-webapp on :3001)
pm2 start ecosystem.config.js

# View status
pm2 status

# View logs
pm2 logs

# Stop all services
pm2 stop all

# Delete all services
pm2 delete all
```

#### Individual Service Management

```bash
# Start specific service
pm2 start ecosystem.config.js --only jambonz-api-server

# Restart service
pm2 restart jambonz-api-server

# View service logs
pm2 logs jambonz-api-server

# Monitor services
pm2 monit
```

### Prerequisites for Local Development

Before starting services, ensure the following are running:

#### 1. MySQL Database

```bash
# Using Docker (if available)
docker run -d \
  --name jambonz-mysql \
  -e MYSQL_ROOT_PASSWORD=root_password \
  -e MYSQL_DATABASE=jambones \
  -e MYSQL_USER=jambones \
  -e MYSQL_PASSWORD=jambones_password \
  -p 3306:3306 \
  mysql:8.0

# Or using local MySQL installation
mysql -u root -p < init-db.sql
```

#### 2. Redis

```bash
# Using Docker (if available)
docker run -d \
  --name jambonz-redis \
  -p 6379:6379 \
  redis:7-alpine

# Or using local Redis installation
redis-server
```

#### 3. Drachtio SIP Server

```bash
# Build from source or use pre-built image
# See: https://github.com/drachtio/drachtio-server
```

## Nixpacks Deployment

### Building OCI Images with Nixpacks

Nixpacks automatically detects Node.js projects and creates OCI-compliant images.

#### Build Individual Services

```bash
# Build API Server
cd jambonz-api-server
nixpacks build . -t jambonz-api-server:latest
cd ..

# Build Feature Server
cd jambonz-feature-server
nixpacks build . -t jambonz-feature-server:latest
cd ..

# Build SBC Inbound
cd sbc-inbound
nixpacks build . -t sbc-inbound:latest
cd ..

# Build SBC Outbound
cd sbc-outbound
nixpacks build . -t sbc-outbound:latest
cd ..

# Build SBC SIP Sidecar
cd sbc-sip-sidecar
nixpacks build . -t sbc-sip-sidecar:latest
cd ..
```

#### Build All Services Script

```bash
#!/bin/bash
# build-all.sh

for dir in jambonz-api-server jambonz-feature-server sbc-inbound sbc-outbound sbc-sip-sidecar; do
  echo "Building $dir..."
  cd "$dir"
  nixpacks build . -t "jambonz-${dir}:latest"
  cd ..
done

echo "All services built successfully!"
```

### Running with Nixpacks

```bash
# Run a single service
nixpacks run . --env-file .env

# Run with port mapping
nixpacks run . --port 3000:3000 --env-file .env
```

## Dockply Deployment

### Dockply Configuration

Dockply is a deployment platform that works with Nixpacks. Create a `dockply.yml` configuration:

```yaml
version: 1

services:
  api-server:
    build:
      context: ./jambonz-api-server
      builder: nixpacks
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - API_SERVER_PORT=3000
      - JAMBONES_MYSQL_HOST=mysql
      - JAMBONES_MYSQL_PORT=3306
      - JAMBONES_MYSQL_USER=jambones
      - JAMBONES_MYSQL_PASSWORD=jambones_password
      - JAMBONES_MYSQL_DATABASE=jambones
      - JAMBONES_REDIS_HOST=redis
      - JAMBONES_REDIS_PORT=6379
    depends_on:
      - mysql
      - redis

  feature-server:
    build:
      context: ./jambonz-feature-server
      builder: nixpacks
    ports:
      - "3100:3100"
    environment:
      - FEATURE_SERVER_PORT=3100
      - JAMBONES_MYSQL_HOST=mysql
      - JAMBONES_REDIS_HOST=redis
    depends_on:
      - mysql
      - redis

  sbc-inbound:
    build:
      context: ./sbc-inbound
      builder: nixpacks
    ports:
      - "5060:5060/udp"
      - "5060:5060/tcp"
      - "5061:5061/tcp"
    environment:
      - SBC_INBOUND_PORT=5060
      - JAMBONES_MYSQL_HOST=mysql
      - JAMBONES_REDIS_HOST=redis
    depends_on:
      - mysql
      - redis

  sbc-outbound:
    build:
      context: ./sbc-outbound
      builder: nixpacks
    ports:
      - "5062:5062/udp"
      - "5062:5062/tcp"
      - "5063:5063/tcp"
    environment:
      - SBC_OUTBOUND_PORT=5062
      - JAMBONES_MYSQL_HOST=mysql
      - JAMBONES_REDIS_HOST=redis
    depends_on:
      - mysql
      - redis

  sbc-sip-sidecar:
    build:
      context: ./sbc-sip-sidecar
      builder: nixpacks
    ports:
      - "5064:5064/tcp"
    environment:
      - SBC_SIP_SIDECAR_PORT=5064
      - JAMBONES_MYSQL_HOST=mysql
      - JAMBONES_REDIS_HOST=redis
    depends_on:
      - mysql
      - redis

  mysql:
    image: mysql:8.0
    environment:
      - MYSQL_ROOT_PASSWORD=root_password
      - MYSQL_DATABASE=jambones
      - MYSQL_USER=jambones
      - MYSQL_PASSWORD=jambones_password
    ports:
      - "3306:3306"
    volumes:
      - mysql_data:/var/lib/mysql

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data

volumes:
  mysql_data:
  redis_data:
```

### Deploy with Dockply

```bash
# Deploy services
dockply deploy

# View deployment status
dockply status

# View logs
dockply logs -f [service-name]

# Stop services
dockply stop

# Remove deployment
dockply remove
```

## Environment Configuration

### Create .env File

```bash
cp .env.example .env
```

### Edit .env with Your Configuration

```bash
# Database
JAMBONES_MYSQL_HOST=localhost
JAMBONES_MYSQL_PORT=3306
JAMBONES_MYSQL_USER=jambones
JAMBONES_MYSQL_PASSWORD=jambones_password
JAMBONES_MYSQL_DATABASE=jambones

# Redis
JAMBONES_REDIS_HOST=localhost
JAMBONES_REDIS_PORT=6379

# Plivo SIP Trunk
PLIVO_SIP_SERVER=sip.plivo.com
PLIVO_SIP_USERNAME=your-username
PLIVO_SIP_PASSWORD=your-password
```

## Database Setup

### Initialize Database

```bash
# Using the initialization script
./init-db.sh

# Or manually
mysql -u jambones -p jambones < jambonz-api-server/db/schema.sql
```

### Run Database Migrations

```bash
cd jambonz-api-server
node db/upgrade-jambonz-db.js
```

## Service Verification

### Check Service Health

```bash
# API Server
curl http://localhost:3000/health

# Feature Server
curl http://localhost:3100/health

# SBC Services (check logs)
pm2 logs sbc-inbound
```

### Verify Database Connection

```bash
mysql -h localhost -u jambones -p jambones -e "SHOW TABLES;"
```

### Verify Redis Connection

```bash
redis-cli ping
# Should return: PONG
```

## Troubleshooting

### Service Won't Start

1. Check logs: `pm2 logs [service-name]`
2. Verify environment variables: `pm2 show [service-name]`
3. Check database connectivity: `mysql -u jambones -p jambones`
4. Check Redis connectivity: `redis-cli ping`

### Database Connection Errors

```bash
# Test MySQL connection
mysql -h localhost -u jambones -p jambones -e "SELECT 1;"

# Check MySQL is running
ps aux | grep mysql
```

### Port Already in Use

```bash
# Find process using port
lsof -i :3000

# Kill process
kill -9 [PID]
```

### Memory Issues

```bash
# Increase Node.js memory limit
export NODE_OPTIONS="--max-old-space-size=4096"
pm2 start ecosystem.config.js
```

## Next Steps

1. Configure Plivo SIP trunk in Jambonz portal
2. Create applications and associate phone numbers
3. Build your call workflows using Jambonz verbs
4. Test inbound and outbound calls
5. Monitor metrics in Prometheus

## Support

For issues and support, refer to:
- Jambonz Documentation: https://docs.jambonz.org
- Jambonz GitHub: https://github.com/jambonz
- Nixpacks Documentation: https://nixpacks.com
