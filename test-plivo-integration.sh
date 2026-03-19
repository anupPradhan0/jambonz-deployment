#!/bin/bash

# Jambonz Plivo Integration Testing Script
# This script tests the connectivity and configuration of Plivo SIP trunk integration

set -e

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
API_URL="${API_URL:-http://localhost:3000}"
JWT_TOKEN="${JWT_TOKEN:-}"
PLIVO_SIP_SERVER="${PLIVO_SIP_SERVER:-sip.plivo.com}"
PLIVO_SIP_PORT="${PLIVO_SIP_PORT:-5060}"

echo -e "${BLUE}=========================================="
echo "Jambonz Plivo Integration Test"
echo "==========================================${NC}"
echo ""

# Test 1: API Server Connectivity
echo -e "${YELLOW}Test 1: API Server Connectivity${NC}"
if curl -s -f "$API_URL/health" > /dev/null 2>&1; then
  echo -e "${GREEN}✓ API Server is running${NC}"
else
  echo -e "${RED}✗ API Server is not responding${NC}"
  echo "  Make sure API server is running on $API_URL"
  exit 1
fi
echo ""

# Test 2: Feature Server Connectivity
echo -e "${YELLOW}Test 2: Feature Server Connectivity${NC}"
if curl -s -f "http://localhost:3100/health" > /dev/null 2>&1; then
  echo -e "${GREEN}✓ Feature Server is running${NC}"
else
  echo -e "${RED}✗ Feature Server is not responding${NC}"
  echo "  Make sure Feature Server is running on port 3100"
fi
echo ""

# Test 3: SBC Inbound Connectivity
echo -e "${YELLOW}Test 3: SBC Inbound Connectivity${NC}"
if nc -z -v localhost 5060 > /dev/null 2>&1; then
  echo -e "${GREEN}✓ SBC Inbound is listening on port 5060${NC}"
else
  echo -e "${RED}✗ SBC Inbound is not listening on port 5060${NC}"
  echo "  Make sure SBC Inbound service is running"
fi
echo ""

# Test 4: SBC Outbound Connectivity
echo -e "${YELLOW}Test 4: SBC Outbound Connectivity${NC}"
if nc -z -v localhost 5062 > /dev/null 2>&1; then
  echo -e "${GREEN}✓ SBC Outbound is listening on port 5062${NC}"
else
  echo -e "${RED}✗ SBC Outbound is not listening on port 5062${NC}"
  echo "  Make sure SBC Outbound service is running"
fi
echo ""

# Test 5: Database Connectivity
echo -e "${YELLOW}Test 5: Database Connectivity${NC}"
MYSQL_HOST="${JAMBONES_MYSQL_HOST:-localhost}"
MYSQL_PORT="${JAMBONES_MYSQL_PORT:-3306}"
MYSQL_USER="${JAMBONES_MYSQL_USER:-jambones}"
MYSQL_PASSWORD="${JAMBONES_MYSQL_PASSWORD:-jambones_password}"
MYSQL_DATABASE="${JAMBONES_MYSQL_DATABASE:-jambones}"

if mysql -h "$MYSQL_HOST" -P "$MYSQL_PORT" -u "$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" -e "SELECT 1;" > /dev/null 2>&1; then
  echo -e "${GREEN}✓ Database is accessible${NC}"
else
  echo -e "${RED}✗ Database is not accessible${NC}"
  echo "  Check MySQL configuration in .env"
fi
echo ""

# Test 6: Redis Connectivity
echo -e "${YELLOW}Test 6: Redis Connectivity${NC}"
REDIS_HOST="${JAMBONES_REDIS_HOST:-localhost}"
REDIS_PORT="${JAMBONES_REDIS_PORT:-6379}"

if redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" ping > /dev/null 2>&1; then
  echo -e "${GREEN}✓ Redis is accessible${NC}"
else
  echo -e "${RED}✗ Redis is not accessible${NC}"
  echo "  Check Redis configuration in .env"
fi
echo ""

# Test 7: Plivo SIP Server Connectivity
echo -e "${YELLOW}Test 7: Plivo SIP Server Connectivity${NC}"
if nc -z -v -w 5 "$PLIVO_SIP_SERVER" "$PLIVO_SIP_PORT" > /dev/null 2>&1; then
  echo -e "${GREEN}✓ Plivo SIP Server is reachable${NC}"
else
  echo -e "${RED}✗ Plivo SIP Server is not reachable${NC}"
  echo "  Check network connectivity to $PLIVO_SIP_SERVER:$PLIVO_SIP_PORT"
fi
echo ""

# Test 8: List Carriers (requires JWT token)
if [ -n "$JWT_TOKEN" ]; then
  echo -e "${YELLOW}Test 8: List Carriers${NC}"
  CARRIERS=$(curl -s -H "Authorization: Bearer $JWT_TOKEN" "$API_URL/api/v1/Carriers")
  if echo "$CARRIERS" | grep -q "data"; then
    echo -e "${GREEN}✓ Successfully retrieved carriers${NC}"
    echo "  Carriers: $(echo "$CARRIERS" | grep -o '"name":"[^"]*"' | head -3)"
  else
    echo -e "${RED}✗ Failed to retrieve carriers${NC}"
    echo "  Response: $CARRIERS"
  fi
  echo ""
fi

# Test 9: Check SBC Logs
echo -e "${YELLOW}Test 9: SBC Service Logs (last 5 lines)${NC}"
if command -v pm2 &> /dev/null; then
  echo -e "${BLUE}SBC Inbound:${NC}"
  pm2 logs sbc-inbound --lines 5 --nostream 2>/dev/null || echo "  (PM2 not running)"
  echo ""
  echo -e "${BLUE}SBC Outbound:${NC}"
  pm2 logs sbc-outbound --lines 5 --nostream 2>/dev/null || echo "  (PM2 not running)"
else
  echo -e "${YELLOW}PM2 not installed. Cannot check logs.${NC}"
fi
echo ""

# Test 10: Network Configuration
echo -e "${YELLOW}Test 10: Network Configuration${NC}"
echo -e "${BLUE}Local Network Interfaces:${NC}"
ip addr show | grep "inet " | awk '{print $2}' | head -5
echo ""

# Summary
echo -e "${GREEN}=========================================="
echo "Test Summary"
echo "==========================================${NC}"
echo ""
echo "Configuration:"
echo "  API URL: $API_URL"
echo "  Plivo SIP Server: $PLIVO_SIP_SERVER:$PLIVO_SIP_PORT"
echo "  MySQL: $MYSQL_HOST:$MYSQL_PORT"
echo "  Redis: $REDIS_HOST:$REDIS_PORT"
echo ""
echo "Next Steps:"
echo "  1. Verify all services are running (green checks)"
echo "  2. Configure Plivo SIP trunk in Jambonz portal"
echo "  3. Add phone numbers to the carrier"
echo "  4. Create an application"
echo "  5. Associate phone numbers with the application"
echo "  6. Test inbound and outbound calls"
echo ""
echo "For detailed configuration, see PLIVO_INTEGRATION.md"
echo ""
