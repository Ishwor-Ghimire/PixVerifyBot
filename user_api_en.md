# Google One — User API Documentation

## Authentication

All endpoints (except health check) require an API Key in the request header:

```
X-API-Key: <your_api_key>
```

API Key format: `ak_XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`

Each key has its own balance. 1 credit is deducted per successful job; failed jobs are not charged.

---

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/health` | No | Health check |
| `POST` | `/api/jobs` | Yes | Submit job |
| `GET` | `/api/jobs/{job_id}` | Yes | Job status |
| `GET` | `/api/queue` | Yes | Queue status |
| `GET` | `/api/balance` | Yes | Check balance |
| `GET` | `/api/history` | Yes | Success history |
| `GET` | `/api/result` | Yes | Email lookup |

---

## 1. Health Check

```
GET /api/health
```

No authentication required.

```json
{
  "status": "ok",
  "device_count": 4,
  "devices_connected": 4,
  "pools": { ... },
  "hotplug": true
}
```

---

## 2. Submit Job

```
POST /api/jobs
```

Submit a Google account for automated login and Google One link capture.

### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `email` | string | Yes | Google email (5-320 chars) |
| `password` | string | Yes | Password |
| `totp_secret` | string | Yes | TOTP secret key (Base32) |
| `priority` | int | No | `0`=normal (default), `1`=high |
| `device` | string | No | Target device serial |

### Request Example

```json
{
  "email": "user@gmail.com",
  "password": "your_password",
  "totp_secret": "JBSWY3DPEHPK3PXP"
}
```

### Success Response

```json
{
  "job_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "queued",
  "queue_position": 1,
  "estimated_wait_seconds": 55
}
```

### Duplicate Submission

If the email was already successfully processed, returns HTTP 409 **with the URL**:

```json
{
  "code": "already_processed",
  "message": "This email has already been successfully processed.",
  "url": "https://one.google.com/partner-eft-onboard/XXXXXXX",
  "created_at": "2026-03-22 14:30:00"
}
```

If the email is currently queued:

```json
{"code": "already_queued", "message": "This email is already queued or being processed."}
```

### Insufficient Balance

HTTP 402, no charge:

```json
{"code": "insufficient_balance", "message": "Insufficient API key balance."}
```

---

## 3. Job Status

```
GET /api/jobs/{job_id}
```

Poll job progress. Recommended: poll every **3 seconds**, timeout after **5 minutes**.

### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `job_id` | string | Job ID |
| `status` | string | `queued` / `running` / `success` / `failed` |
| `stage` | int | Current stage (0-8) |
| `total_stages` | int | Total stages (8) |
| `stage_label` | string | Stage name |
| `url` | string | Google One link (on success) |
| `error` | string | Error code (on failure) |
| `elapsed_seconds` | float | Duration in seconds |
| `queue_position` | int | Queue position (-1 = not in queue) |
| `estimated_wait_seconds` | int | Estimated wait time |

### Success Response

```json
{
  "job_id": "a1b2c3d4-...",
  "status": "success",
  "stage": 8,
  "total_stages": 8,
  "stage_label": "DONE",
  "url": "https://one.google.com/partner-eft-onboard/8GSA888AD9PPN2SER720",
  "error": "",
  "elapsed_seconds": 62.3,
  "queue_position": -1,
  "estimated_wait_seconds": 0
}
```

---

## 4. Queue Status

```
GET /api/queue
```

```json
{
  "current_job_ids": [null, null],
  "pending_count": 0,
  "pending_job_ids": [],
  "est_seconds_per_job": 55,
  "device_count": 4,
  "devices_connected": 4,
  "devices_ready": 3,
  "devices_preparing": 1,
  "pool": "shared"
}
```

---

## 5. Check Balance

```
GET /api/balance
```

```json
{
  "key": "ak_XXXX-...",
  "name": "my-key",
  "balance": 50.0,
  "total_used": 12,
  "cost_per_job": 1
}
```

---

## 6. Success History

```
GET /api/history?limit=50&offset=0
```

Each key can only see its own successful records.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | int | 50 | Records per page (1~200) |
| `offset` | int | 0 | Skip first N records |

```json
{
  "records": [
    {"email": "user@gmail.com", "url": "https://one.google.com/...", "created_at": "2026-03-22 14:30:00"}
  ],
  "total": 15,
  "limit": 50,
  "offset": 0
}
```

---

## 7. Email Lookup

```
GET /api/result?email=user@gmail.com
```

Look up a result by email. **Isolated**: you can only see results from your own key.

```json
{
  "email": "user@gmail.com",
  "status": "success",
  "url": "https://one.google.com/partner-eft-onboard/XXXXXXX",
  "created_at": "2026-03-22 14:30:00"
}
```

Returns HTTP 404 if not found.

---

## Typical Flow

```
1. GET  /api/health           — check service
2. GET  /api/balance          — check balance
3. GET  /api/queue            — check if queue is free
4. POST /api/jobs             — submit job → get job_id
5. GET  /api/jobs/{job_id}    — poll every 3s until success / failed
6. GET  /api/result?email=... — or look up result by email
```

---

## Error Codes

### HTTP Errors

| Status | Code | Description |
|--------|------|-------------|
| 401 | `invalid_api_key` | Missing or invalid key |
| 402 | `insufficient_balance` | Insufficient balance |
| 409 | `already_queued` | Email already queued |
| 409 | `already_processed` | Email already processed (includes URL) |
| 400 | `sso_blocked` | SSO domain not supported |
| 400 | `no_devices` | No available devices |
| 404 | `job_not_found` | Job not found |
| 404 | `not_found` | Record not found |
| 503 | `service_paused` | Service paused |

### Job Failure Codes

| Code | Description |
|------|-------------|
| `WRONG_PASSWORD` | Wrong password |
| `TOTP_ERROR` | TOTP code error |
| `NO_AUTHENTICATOR` | TOTP not enabled |
| `INVALID_EMAIL` | Invalid email |
| `ACCOUNT_DISABLED` | Account disabled/locked |
| `CAPTCHA` | CAPTCHA encountered |
| `PASSKEY_BLOCKED` | Passkey verification required |
| `GOOGLE_ONE_UNAVAILABLE` | Google One not available for this account |
| `URL_CAPTURE_FAILED` | Link capture failed |
| `SIGNIN_FAILED` | Sign-in failed |
| `PROXY_ERROR` | Proxy error |
| `DEVICE_UNAVAILABLE` | Device unavailable |
| `INTERNAL_ERROR` | Internal error |
| `UNKNOWN_ERROR` | Unknown error |

---

## Notes

1. **TOTP secret** must be the raw Base32-encoded key (not the 6-digit code)
2. **SSO emails** (e.g. @company.com) are not supported; only personal Gmail
3. The same email cannot be submitted again while a job is in progress
4. Credits are only deducted on **success**; failed jobs are free
5. Re-submitting an already processed email will return the previous URL
