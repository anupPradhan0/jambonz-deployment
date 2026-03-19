#!/bin/bash

# Jambonz Complete Startup Script
# This script starts all Jambonz services in the correct order

set -e

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
DEPLOYMENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DEPLOYMENT_DIR"

echo -e "${GREEN}=========================================="
echo "Jambonz Platform Startup"
echo "==========================================${NC}"
echo ""

# Load environment variables
if [ -f .env ]; then
  echo -e "${YELLOW}Loading environment configuration...${NC}"
  export $(cat .env | grep -v '^#' | xargs)
else
  echo -e "${RED}Error: .env file not found${NC}"
  exit 1
fi

# Check if Docker is available
if ! command -v docker &> /dev/null; then
  echo -e "${RED}Error: Docker is not installed or not in PATH${NC}"
  exit 1
fi

# Check if Docker daemon is running
if ! docker info > /dev/null 2>&1; then
  echo -e "${RED}Error: Docker daemon is not running${NC}"
  exit 1
fi

echo -e "${GREEN}✓ Docker is available${NC}"
echo ""

# Start services
echo -e "${YELLOW}Starting Jambonz services...${NC}"
echo ""

# Check if docker-compose or docker compose is available
if command -v docker-compose &> /dev/null; then
  COMPOSE_CMD="docker-compose"
elif docker compose version > /dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
else
  echo -e "${RED}Error: docker-compose is not installed${NC}"
  exit 1
fi

echo "Using: $COMPOSE_CMD"
echo ""

# Start services in the background
echo -e "${YELLOW}Building and starting services...${NC}"
$COMPOSE_CMD up -d

echo ""
echo -e "${YELLOW}Waiting for services to be healthy...${NC}"
sleep 10

# Check service status
echo ""
echo -e "${GREEN}Service Status:${NC}"
echo ""

services=("jambonz-mysql" "jambonz-redis" "jambonz-drachtio" "jambonz-prometheus" "jambonz-influxdb" "jambonz-freeswitch" "jambonz-api-server" "jambonz-webapp" "jambonz-feature-server" "jambonz-sbc-inbound" "jambonz-sbc-outbound" "jambonz-sbc-sip-sidecar")

for service in "${services[@]}"; do
  if docker ps --filter "name=$service" --filter "status=running" | grep -q "$service"; then
    echo -e "${GREEN}✓${NC} $service: Running"
  else
    echo -e "${RED}✗${NC} $service: Not running"
  fi
done

echo ""
echo -e "${GREEN}=========================================="
echo "Startup Complete!"
echo "==========================================${NC}"
echo ""
echo "Service Endpoints:"
echo "  Webapp (portal):   http://localhost:3001"
echo "  API Server:        http://localhost:3000"
echo "  Feature Server:    http://localhost:3100"
echo "  SBC Inbound:       sip://localhost:5060"
echo "  SBC Outbound:      sip://localhost:5062"
echo "  Prometheus:        http://localhost:9090"
echo "  MySQL:             localhost:3306"
echo "  Redis:             localhost:6379"
echo ""
echo "Next steps:"
echo "  1. Open the portal at http://localhost:3001 (login / provision)"
echo "  2. API health: http://localhost:3000/health"
echo "  3. Configure your Plivo SIP trunk in the Jambonz portal"
echo "  4. Create applications and associate phone numbers"
echo ""
echo "To view logs:"
echo "  $COMPOSE_CMD logs -f [service-name]"
echo ""
echo "To stop services:"
echo "  $COMPOSE_CMD down"
echo ""
