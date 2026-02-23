#!/bin/bash
# Samvaad API – curl examples for all routes
# Usage: ./curl-routes.sh   or   BASE_URL=https://your-host npm run curl (if you add a script)
BASE_URL="${BASE_URL:-http://localhost:3000}"

# --- Public ---

# Health check
curl -s -X GET "$BASE_URL/api/health" | jq .

# Register
curl -s -X POST "$BASE_URL/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"secret123","name":"Demo User","role":"user"}' | jq .

# Login (save accessToken and refreshToken from response for next calls)
curl -s -X POST "$BASE_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"secret123"}' | jq .

# Refresh tokens (use body or cookie from login)
curl -s -X POST "$BASE_URL/api/auth/refresh" \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"YOUR_REFRESH_TOKEN_HERE"}' | jq .

# Logout (optional: send refreshToken to invalidate server-side)
curl -s -X POST "$BASE_URL/api/auth/logout" \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"YOUR_REFRESH_TOKEN_HERE"}' | jq .

# --- Protected (replace YOUR_ACCESS_TOKEN with token from login/refresh) ---

# Get current user
curl -s -X GET "$BASE_URL/api/auth/me" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" | jq .

# Logout all devices
curl -s -X POST "$BASE_URL/api/auth/logout-all" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" | jq .

# --- Admin only (admin role required) ---

# List all users
curl -s -X GET "$BASE_URL/api/admin/users" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" | jq .
