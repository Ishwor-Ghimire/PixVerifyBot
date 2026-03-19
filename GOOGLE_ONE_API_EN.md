# Google One — User API Documentation

## Overview

This API provides automated Google One trial link acquisition. After submitting Google account credentials, the system automatically logs in on a real device and retrieves the Google One partner link.

**Base URL:** `https://iqless.icu`

---

## Authentication

All authenticated endpoints require an API Key in the request header:

```
X-API-Key: <your_api_key>
```

API Key format example: `ak_XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`

API Keys are created by administrators. Each key has an independent balance; 1 credit is deducted per successful job.

---

## Endpoints

| Method | Path                 | Auth | Description        |
| ------ | -------------------- | ---- | ------------------ |
| `GET`  | `/api/health`        | No   | Health check       |
| `POST` | `/api/jobs`          | Yes  | Submit a job       |
| `GET`  | `/api/jobs/{job_id}` | Yes  | Query job status   |
| `GET`  | `/api/queue`         | Yes  | Queue status       |
| `GET`  | `/api/balance`       | Yes  | Check balance      |
| `GET`  | `/api/history`       | Yes  | Success history    |

---

## 1. Health Check

Check if the server and devices are online.

```
GET /api/health
```

**No authentication required.**

### Response Example

```json
{
  "status": "ok",
  "device_count": 4,
  "devices_connected": 4,
  "pools": {
    "unified": {
      "device_count": 4,
      "devices": [
        {"serial": "85001c06", "connected": true, "ready": true, "busy": false},
        {"serial": "ce9f9d4c", "connected": true, "ready": false, "busy": true}
      ],
      "bot_devices": ["ce9f9d4c"]
    }
  },
  "hotplug": true
}
```

| Field              | Type     | Description                                          |
| ------------------ | -------- | ---------------------------------------------------- |
| `status`           | `string` | Service status                                       |
| `device_count`     | `int`    | Total number of devices                              |
| `devices_connected`| `int`    | Number of connected devices                          |
| `pools`            | `object` | Pool details (per-device connected/ready/busy state) |
| `hotplug`          | `bool`   | Whether hot-plug scanning is enabled                 |

---

## 2. Submit a Job

Submit Google account credentials. The system will automatically log in and retrieve the Google One partner link. Each submission deducts 1 credit.

```
POST /api/jobs
```

### Request Headers

```
Content-Type: application/json
X-API-Key: <your_api_key>
```

### Request Body

| Field         | Type     | Required | Description                                            |
| ------------- | -------- | -------- | ------------------------------------------------------ |
| `email`       | `string` | Yes      | Google email (5-320 characters)                        |
| `password`    | `string` | Yes      | Account password (1-256 characters)                    |
| `totp_secret` | `string` | Yes      | TOTP 2FA secret key (Base32 encoded, 1-64 characters)  |
| `priority`    | `int`    | No       | Priority: `0` (default, normal) or `1` (high priority) |
| `device`      | `string` | No       | Target device serial (max 64 characters). When specified, the job is routed to that device instead of the general queue |

### Request Example

```json
{
  "email": "user@gmail.com",
  "password": "your_password",
  "totp_secret": "JBSWY3DPEHPK3PXP",
  "priority": 0
}
```

### Request Example (with device targeting)

```json
{
  "email": "user@gmail.com",
  "password": "your_password",
  "totp_secret": "JBSWY3DPEHPK3PXP",
  "device": "ce9f9d4c"
}
```

### Response Example (success)

```json
{
  "job_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "queued",
  "queue_position": 1,
  "estimated_wait_seconds": 55
}
```

### Response Example (with device targeting)

```json
{
  "job_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "queued",
  "queue_position": 0,
  "estimated_wait_seconds": 0,
  "device": "ce9f9d4c"
}
```

### Duplicate Submission Protection

If the same email is already `queued` or `running`, a re-submission returns HTTP 409:

```json
{
  "detail": {
    "code": "already_queued",
    "message": "This email is already queued or being processed."
  }
}
```

If the email has already been successfully processed, re-submission also returns HTTP 409:

```json
{
  "detail": {
    "code": "already_processed",
    "message": "This email has already been successfully processed."
  }
}
```

### Service Paused

When the API is paused by an administrator, non-admin requests return HTTP 503:

```json
{
  "detail": {
    "code": "service_paused",
    "message": "API is currently paused. Try again later."
  }
}
```

### Insufficient Balance

When the API Key balance is insufficient, HTTP 402 is returned (no charge):

```json
{
  "detail": {
    "code": "insufficient_balance",
    "message": "Insufficient API key balance."
  }
}
```

> **Note:** Credits are only deducted upon successful job completion. Failed jobs are not charged.

---

## 3. Query Job Status

Poll job progress to get the final result (URL or error).

```
GET /api/jobs/{job_id}
```

### Response Fields

| Field                    | Type     | Description                                         |
| ------------------------ | -------- | --------------------------------------------------- |
| `job_id`                 | `string` | Job ID                                              |
| `status`                 | `string` | Status: `queued` / `running` / `success` / `failed` |
| `stage`                  | `int`    | Current stage number (0-8)                          |
| `total_stages`           | `int`    | Total number of stages (8)                          |
| `stage_label`            | `string` | Current stage name                                  |
| `url`                    | `string` | Google One link (on success)                        |
| `error`                  | `string` | Error code (on failure)                             |
| `created_at`             | `float`  | Job creation time (Unix timestamp)                  |
| `elapsed_seconds`        | `float`  | Job elapsed time (seconds)                          |
| `queue_position`         | `int`    | Queue position (`-1` when not queued)               |
| `estimated_wait_seconds` | `int`    | Estimated remaining wait (seconds, `0` when not queued) |

### Success Response Example

```json
{
  "job_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "success",
  "stage": 8,
  "total_stages": 8,
  "stage_label": "DONE",
  "url": "https://one.google.com/partner-eft-onboard/8GSA888AD9PPN2SER720",
  "error": "",
  "created_at": 1710000000.0,
  "elapsed_seconds": 62.3,
  "queue_position": -1,
  "estimated_wait_seconds": 0
}
```

### Failure Response Example

```json
{
  "job_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "failed",
  "stage": 5,
  "total_stages": 8,
  "stage_label": "ENTER_PASSWORD",
  "url": "",
  "error": "WRONG_PASSWORD",
  "created_at": 1710000000.0,
  "elapsed_seconds": 18.7,
  "queue_position": -1,
  "estimated_wait_seconds": 0
}
```

### Recommended Polling Strategy

- Poll every **3 seconds** after submission
- Check the `status` field until the value is `success` or `failed`
- Recommended **5-minute** timeout

---

## 4. Queue Status

View the current task queue and device readiness.

```
GET /api/queue
```

### Response Example

```json
{
  "current_job_ids": [null, null, null, null],
  "pending_count": 0,
  "pending_job_ids": [],
  "est_seconds_per_job": 55,
  "device_count": 4,
  "devices_connected": 4,
  "devices_ready": 3,
  "devices_preparing": 1,
  "pool": "unified"
}
```

### Field Descriptions

| Field                 | Description                                       |
| --------------------- | ------------------------------------------------- |
| `current_job_ids`     | Job IDs per device (`null` = idle)                |
| `pending_count`       | Number of queued jobs                             |
| `pending_job_ids`     | List of queued job IDs                            |
| `est_seconds_per_job` | Estimated time per job (seconds)                  |
| `device_count`        | Total number of devices                           |
| `devices_connected`   | Number of connected devices                       |
| `devices_ready`       | Number of ready devices                           |
| `devices_preparing`   | Number of devices in preparation                  |
| `pool`                | Pool name                                         |

---

## 5. Check Balance

Query the remaining balance and usage for the current API Key.

```
GET /api/balance
```

### Request Headers

```
X-API-Key: <your_api_key>
```

### Response Fields

| Field          | Type     | Description              |
| -------------- | -------- | ------------------------ |
| `key`          | `string` | API Key (masked)         |
| `name`         | `string` | API Key name             |
| `balance`      | `float`  | Remaining balance        |
| `total_used`   | `int`    | Total usage count        |
| `cost_per_job` | `float`  | Credits consumed per job |

### Response Example

```json
{
  "key": "ak_XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX",
  "name": "my-key",
  "balance": 50.0,
  "total_used": 12,
  "cost_per_job": 1
}
```

### cURL Example

```bash
curl https://iqless.icu/api/balance \
  -H "X-API-Key: ak_YOUR-API-KEY-HERE"
```

---

## 6. Success History

Query all successfully completed jobs (email and URL) for the current API Key, with pagination support.

```
GET /api/history?limit=50&offset=0
```

### Request Headers

```
X-API-Key: <your_api_key>
```

### Query Parameters

| Parameter | Type  | Required | Description                                 |
| --------- | ----- | -------- | ------------------------------------------- |
| `limit`   | `int` | No       | Records per page (default `50`, range `1`-`200`) |
| `offset`  | `int` | No       | Skip first N records (default `0`, for pagination) |

### Response Fields

| Field     | Type    | Description                  |
| --------- | ------- | ---------------------------- |
| `records` | `array` | List of success records      |
| `total`   | `int`   | Total success records for key |
| `limit`   | `int`   | Current page size            |
| `offset`  | `int`   | Current offset               |

Each record in `records`:

| Field        | Type     | Description                        |
| ------------ | -------- | ---------------------------------- |
| `email`      | `string` | Submitted email                    |
| `url`        | `string` | Retrieved Google One link          |
| `created_at` | `string` | Completion time (`YYYY-MM-DD HH:MM:SS`) |

### Response Example

```json
{
  "records": [
    {
      "email": "user@gmail.com",
      "url": "https://one.google.com/partner-eft-onboard/8GSA888AD9PPN2SER720",
      "created_at": "2026-03-17 14:30:00"
    },
    {
      "email": "another@gmail.com",
      "url": "https://one.google.com/partner-eft-onboard/XXXXXXXXX",
      "created_at": "2026-03-17 12:00:00"
    }
  ],
  "total": 15,
  "limit": 50,
  "offset": 0
}
```

### cURL Examples

```bash
# View the last 10 success records
curl "https://iqless.icu/api/history?limit=10" \
  -H "X-API-Key: ak_YOUR-API-KEY-HERE"

# Pagination: page 2
curl "https://iqless.icu/api/history?limit=10&offset=10" \
  -H "X-API-Key: ak_YOUR-API-KEY-HERE"
```

> **Note:** Each API Key can only view its own success history. Admin keys can view all API-submitted success history.

---

## Complete Workflow

```
1. GET  /api/health            — Check service status
2. GET  /api/balance           — Check remaining balance
3. GET  /api/queue             — Check if queue is idle
4. POST /api/jobs              — Submit job, get job_id
5. GET  /api/jobs/{job_id}     — Poll every 3s until success or failed
6. Extract the url field from the success response
7. GET  /api/history           — View all historical success records at any time
```

### Python Example

```python
import time
import requests

BASE_URL = "https://iqless.icu"
HEADERS = {"X-API-Key": "ak_YOUR-API-KEY-HERE"}

# 1. Submit a job
resp = requests.post(f"{BASE_URL}/api/jobs", headers=HEADERS, json={
    "email": "user@gmail.com",
    "password": "your_password",
    "totp_secret": "JBSWY3DPEHPK3PXP",
})
resp.raise_for_status()
job_id = resp.json()["job_id"]
print(f"Job submitted: {job_id}")

# 2. Poll for result
for _ in range(100):
    resp = requests.get(f"{BASE_URL}/api/jobs/{job_id}", headers=HEADERS)
    data = resp.json()

    if data["status"] == "success":
        print(f"Success! URL: {data['url']}")
        break
    elif data["status"] == "failed":
        print(f"Job failed: {data['error']}")
        break

    time.sleep(3)

# 3. View success history
resp = requests.get(f"{BASE_URL}/api/history?limit=10", headers=HEADERS)
for rec in resp.json()["records"]:
    print(f"  {rec['email']} → {rec['url']}")
```

### cURL Examples

```bash
# Submit a job
curl -X POST https://iqless.icu/api/jobs \
  -H "X-API-Key: ak_YOUR-API-KEY-HERE" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@gmail.com","password":"your_password","totp_secret":"JBSWY3DPEHPK3PXP"}'

# Query result
curl https://iqless.icu/api/jobs/{job_id} \
  -H "X-API-Key: ak_YOUR-API-KEY-HERE"

# View success history
curl "https://iqless.icu/api/history?limit=10" \
  -H "X-API-Key: ak_YOUR-API-KEY-HERE"
```

---

## Error Code Reference

### HTTP Errors

| HTTP Status | Error Code             | Description                          |
| ----------- | ---------------------- | ------------------------------------ |
| 401         | `invalid_api_key`      | API Key missing or invalid           |
| 402         | `insufficient_balance` | API Key balance insufficient         |
| 409         | `already_queued`       | Email is already in the queue        |
| 409         | `already_processed`    | Email has already been processed     |
| 400         | `sso_blocked`          | SSO domain emails not supported      |
| 400         | `no_devices`           | No devices available                 |
| 404         | `job_not_found`        | Job ID does not exist                |
| 404         | `device_not_found`     | Specified device serial not found    |
| 503         | `service_paused`       | API is paused, try again later       |
| 503         | `device_unavailable`   | Specified device unavailable (disconnected or paused) |

### Job Failure Error Codes

When a job fails, the `error` field contains one of the following:

| Error Code                     | Description                              |
| ------------------------------ | ---------------------------------------- |
| `INTERNAL_ERROR`               | Internal system error                    |
| `DEVICE_UNAVAILABLE`           | Device unavailable                       |
| `DEVICE_PREP_FAILED`           | Device preparation failed                |
| `PROXY_ERROR`                  | Proxy connection error                   |
| `PASSKEY_BLOCKED`              | Account requires Passkey verification    |
| `CAPTCHA`                      | CAPTCHA challenge encountered            |
| `ACCOUNT_DISABLED`             | Account is disabled/locked               |
| `INVALID_EMAIL`                | Email address is invalid or nonexistent  |
| `WRONG_PASSWORD`               | Incorrect password                       |
| `TOTP_ERROR`                   | TOTP verification code error             |
| `NO_AUTHENTICATOR`             | Account has no TOTP authenticator set up |
| `SIGNIN_PAGE_FAILED`           | Sign-in page failed to load             |
| `TWOFACTOR_PAGE_ERROR`         | Two-factor verification page error       |
| `GOOGLE_LOGIN_ERROR`           | Google login process error               |
| `GOOGLE_ONE_UNAVAILABLE`       | Account is ineligible for Google One trial |
| `URL_CAPTURE_FAILED`           | Link capture failed                      |
| `SIGNIN_FAILED`                | Sign-in failed (generic)                 |
| `ACCOUNT_NOT_DETECTED`         | Account not detected after login         |
| `BROWSER_LOGIN_FAILED`         | Browser login failed                     |
| `UNKNOWN_ERROR`                | Unknown error                            |

---

## Important Notes

1. **TOTP Secret**: Must be the raw Base32-encoded secret key (not the 6-digit verification code)
2. **SSO Emails**: Enterprise SSO domains (e.g., `@company.com`) are not supported; only personal Gmail is accepted
3. **Duplicate Submissions**: The same email cannot be resubmitted while still being processed
4. **Billing**: Credits are only deducted upon successful job completion; failed jobs are not charged
5. **Job Expiry**: Completed job statuses are cleaned up after a period; retrieve results promptly