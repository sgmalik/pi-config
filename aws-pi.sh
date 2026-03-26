#!/bin/bash

# AWS MFA Credential Refresh Script for Pi Coding Agent
# Usage: source ~/scripts/./aws-pi.sh

# Configuration
MFA_SERIAL="arn:aws:iam::472598590798:mfa/Surya-MFA"
AWS_REGION="us-east-1"

# Prompt for MFA code
printf "Enter your MFA code: "
read MFA_CODE

if [ -z "$MFA_CODE" ]; then
    echo "Error: MFA code is required"
    return 1 2>/dev/null || exit 1
fi

echo "Getting session token from AWS STS..."

# Clear any existing session tokens to avoid conflicts
unset AWS_SESSION_TOKEN
unset AWS_ACCESS_KEY_ID
unset AWS_SECRET_ACCESS_KEY
unset AWS_SECURITY_TOKEN
unset AWS_PROFILE
unset AWS_BEARER_TOKEN_BEDROCK

# Get session token
SESSION_JSON=$(aws sts get-session-token \
    --serial-number "$MFA_SERIAL" \
    --token-code "$MFA_CODE" \
    2>&1)

if [ $? -ne 0 ]; then
    echo "Error getting session token:"
    echo "$SESSION_JSON"
    return 1 2>/dev/null || exit 1
fi

# Parse and export credentials
export AWS_ACCESS_KEY_ID=$(echo "$SESSION_JSON" | grep -o '"AccessKeyId": "[^"]*' | cut -d'"' -f4)
export AWS_SECRET_ACCESS_KEY=$(echo "$SESSION_JSON" | grep -o '"SecretAccessKey": "[^"]*' | cut -d'"' -f4)
export AWS_SESSION_TOKEN=$(echo "$SESSION_JSON" | grep -o '"SessionToken": "[^"]*' | cut -d'"' -f4)
export AWS_REGION="$AWS_REGION"

# Get expiration time
EXPIRATION=$(echo "$SESSION_JSON" | grep -o '"Expiration": "[^"]*' | cut -d'"' -f4)

echo "✓ AWS credentials refreshed successfully!"
echo "✓ Pi Coding Agent environment configured"
echo "✓ Credentials expire at: $EXPIRATION"
echo ""
echo "All environment variables have been set in your current shell."
echo ""
echo "Usage examples:"
echo "  # Haiku 4.5 (newest, fastest)"
echo "  pi --provider amazon-bedrock --model us.anthropic.claude-haiku-4-5-20251001-v1:0"
echo ""
echo "  # Sonnet 4.6 (newest, balanced)"
echo "  pi --provider amazon-bedrock --model us.anthropic.claude-sonnet-4-6"
echo ""
echo "  # Opus 4.6 (most capable)"
echo "  pi --provider amazon-bedrock --model us.anthropic.claude-opus-4-6-v1"
echo ""
echo "  # Pi Pi — meta-agent for editing Pi config (extensions, themes, agents)"
echo "  pi -e ~/.pi/agent/optional-extensions/pi-pi.ts"
