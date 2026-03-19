# Plivo SIP Trunk Integration with Jambonz

This guide explains how to configure Plivo as your SIP trunk provider for Jambonz.

## Prerequisites

- Jambonz platform running and accessible
- Plivo account with active SIP credentials
- Access to Jambonz portal/API
- Phone numbers provisioned in Plivo

## Step 1: Get Plivo SIP Credentials

### From Plivo Dashboard

1. Log in to your Plivo account at https://console.plivo.com
2. Navigate to **Connectivity** → **SIP Trunks**
3. Create a new SIP trunk or use existing one
4. Note the following details:
   - **SIP Server**: `sip.plivo.com` or your regional endpoint
   - **SIP Port**: `5060` (UDP/TCP) or `5061` (TLS)
   - **Username**: Your SIP trunk username
   - **Password**: Your SIP trunk password
   - **Domain**: Your SIP domain (usually `your-domain.sip.plivo.com`)

### Example Plivo SIP Configuration

```
SIP Server: sip.plivo.com
Port: 5060
Username: your-plivo-sip-username
Password: your-plivo-sip-password
Domain: your-domain.sip.plivo.com
```

## Step 2: Configure Jambonz to Connect to Plivo

### Via REST API

```bash
# Create a carrier (SIP trunk) in Jambonz
curl -X POST http://localhost:3000/api/v1/Carriers \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "name": "Plivo SIP Trunk",
    "carrier_type": "sip",
    "sip_server": "sip.plivo.com",
    "sip_port": 5060,
    "sip_username": "your-plivo-sip-username",
    "sip_password": "your-plivo-sip-password",
    "sip_domain": "your-domain.sip.plivo.com",
    "sip_protocol": "udp",
    "enabled": true
  }'
```

### Via Jambonz Portal

1. Access Jambonz portal at `http://localhost:3000`
2. Navigate to **Carriers** section
3. Click **Create New Carrier**
4. Fill in the following:
   - **Name**: Plivo SIP Trunk
   - **Carrier Type**: SIP
   - **SIP Server**: sip.plivo.com
   - **SIP Port**: 5060
   - **Username**: your-plivo-sip-username
   - **Password**: your-plivo-sip-password
   - **Domain**: your-domain.sip.plivo.com
   - **Protocol**: UDP (or TCP/TLS)
5. Click **Save**

## Step 3: Add Phone Numbers to Carrier

### Via REST API

```bash
# Associate a phone number with the carrier
curl -X POST http://localhost:3000/api/v1/PhoneNumbers \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "phone_number": "+1234567890",
    "carrier_id": "CARRIER_ID_FROM_STEP_2",
    "enabled": true
  }'
```

### Via Jambonz Portal

1. Navigate to **Phone Numbers**
2. Click **Add Phone Number**
3. Enter your Plivo phone number
4. Select the Plivo SIP Trunk carrier
5. Click **Save**

## Step 4: Create Application

### Via REST API

```bash
# Create an application
curl -X POST http://localhost:3000/api/v1/Applications \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "name": "My Voice AI App",
    "application_type": "voice",
    "webhook_url": "https://your-app.example.com/webhook",
    "webhook_method": "POST",
    "enabled": true
  }'
```

### Via Jambonz Portal

1. Navigate to **Applications**
2. Click **Create New Application**
3. Fill in:
   - **Name**: My Voice AI App
   - **Type**: Voice
   - **Webhook URL**: Your application endpoint
   - **Webhook Method**: POST
4. Click **Save**

## Step 5: Associate Phone Number with Application

### Via REST API

```bash
# Update phone number to associate with application
curl -X PUT http://localhost:3000/api/v1/PhoneNumbers/PHONE_NUMBER_ID \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "application_id": "APPLICATION_ID_FROM_STEP_4",
    "enabled": true
  }'
```

### Via Jambonz Portal

1. Go to **Phone Numbers**
2. Click on your phone number
3. Select the application from the dropdown
4. Click **Save**

## Step 6: Configure Plivo to Route to Jambonz

### In Plivo Console

1. Log in to Plivo console
2. Go to **Connectivity** → **SIP Trunks**
3. Select your SIP trunk
4. Configure **Inbound Rules**:
   - **Destination**: Your Jambonz SBC inbound address
   - **Port**: 5060
   - **Protocol**: UDP or TCP

### Example Plivo Inbound Configuration

```
Inbound Destination: your-jambonz-server.com:5060
Protocol: UDP
```

## Step 7: Test the Integration

### Test Inbound Call

```bash
# Call your Plivo phone number from any phone
# The call should route through Plivo → Jambonz → Your Application

# Monitor logs
pm2 logs sbc-inbound
pm2 logs jambonz-feature-server
```

### Test Outbound Call

```bash
# Via API - Initiate outbound call
curl -X POST http://localhost:3000/api/v1/Calls \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "from": "+1234567890",
    "to": "+9876543210",
    "carrier_id": "CARRIER_ID",
    "application_id": "APPLICATION_ID"
  }'
```

## Troubleshooting

### Calls Not Routing

1. **Check SBC logs**:
   ```bash
   pm2 logs sbc-inbound
   pm2 logs sbc-outbound
   ```

2. **Verify Plivo connectivity**:
   ```bash
   # Test SIP connectivity to Plivo
   sipp -sf uac_pcap.xml -s your-plivo-number sip.plivo.com
   ```

3. **Check carrier configuration**:
   ```bash
   curl http://localhost:3000/api/v1/Carriers \
     -H "Authorization: Bearer YOUR_JWT_TOKEN"
   ```

### Authentication Failures

1. Verify credentials in Plivo console
2. Check SIP username and password are correct
3. Ensure SIP domain matches Plivo configuration
4. Verify firewall rules allow SIP traffic (5060/UDP, 5060/TCP)

### Media Issues

1. Check RTP port range (16000-32000) is open
2. Verify firewall allows RTP traffic
3. Check network MTU size (should be 1500)
4. Monitor RTP flow in logs

### One-Way Audio

1. Check NAT configuration
2. Verify media anchor settings
3. Check RTP port forwarding
4. Review SBC configuration

## Advanced Configuration

### Enable TLS for Secure SIP

```bash
# Update carrier to use TLS
curl -X PUT http://localhost:3000/api/v1/Carriers/CARRIER_ID \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "sip_port": 5061,
    "sip_protocol": "tls",
    "tls_cert_path": "/path/to/cert.pem",
    "tls_key_path": "/path/to/key.pem"
  }'
```

### Configure Multiple Plivo Trunks

Create multiple carriers for load balancing:

```bash
# Carrier 1
curl -X POST http://localhost:3000/api/v1/Carriers \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "name": "Plivo Trunk 1",
    "sip_server": "sip1.plivo.com",
    ...
  }'

# Carrier 2
curl -X POST http://localhost:3000/api/v1/Carriers \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "name": "Plivo Trunk 2",
    "sip_server": "sip2.plivo.com",
    ...
  }'
```

## Performance Tuning

### Optimize SBC Settings

```bash
# In ecosystem.config.js or environment variables
JAMBONES_SBC_INBOUND_CONCURRENCY=1000
JAMBONES_SBC_OUTBOUND_CONCURRENCY=1000
RTP_PORT_MIN=16000
RTP_PORT_MAX=32000
```

### Monitor Call Metrics

Access Prometheus at `http://localhost:9090` to monitor:
- Active calls
- Call success rate
- SIP response times
- Media quality metrics

## Support and Resources

- **Plivo Documentation**: https://plivo.com/docs/
- **Jambonz Documentation**: https://docs.jambonz.org/
- **Jambonz API Reference**: https://docs.jambonz.org/api-reference/
- **SIP Protocol**: RFC 3261

## Next Steps

1. Build your call application using Jambonz verbs
2. Implement webhook handlers for call events
3. Integrate with AI/ML services (OpenAI, Deepgram, etc.)
4. Set up monitoring and alerting
5. Deploy to production environment
