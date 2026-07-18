# Serverless Todos Backend (Node.js) — Multi-user Registration + Login + Lambda Authorizer

A serverless microservice architecture: API Gateway as the entry point, a
custom **Lambda authorizer** guarding routes, and independent Lambda
functions each doing one job — now with real multi-user accounts instead
of a single hardcoded demo login.

## ⚠️ Upgrading from the single-user version

`TodosTable`'s primary key changed from just `id` to a composite
`userId` + `id` key, so todos can be scoped per account. DynamoDB tables
can't have their primary key changed in place, and since the table name
is fixed (`TodosTable`), CloudFormation can't replace it automatically
either — you'll get a naming conflict.

Before deploying this version over an old stack:
- **Easiest**: `sam delete` the old stack, then deploy fresh, **or**
- Manually delete the existing `TodosTable` in the DynamoDB console, then `sam deploy`

Either way, any todos stored under the old single-user schema will be lost.

## Architecture

```
  POST /register ──────► RegisterFunction (no auth) ─► creates user, issues JWT
  POST /login     ──────► LoginFunction (no auth)    ─► verifies user, issues JWT
  /todos, /todos/{id} ──► [Lambda Authorizer checks JWT] ──► TodoFunction ──► DynamoDB (scoped by userId)
```

| Function | File | Responsibility |
|---|---|---|
| `RegisterFunction` | `register.js` | Creates a new user (hashed password), auto-logs in |
| `LoginFunction` | `auth.js` | Verifies username/password against `UsersTable`, issues a JWT |
| `AuthorizerFunction` | `authorizer.js` | Runs in front of every `/todos` call — verifies the JWT, tells API Gateway allow/deny |
| `TodoFunction` | `todos.js` | Todos CRUD, scoped to the calling user's `userId` |
| — | `passwords.js` | Shared password hashing helper (Node's built-in `crypto.scrypt`), used by both `register.js` and `auth.js` |

## How registration & login work

1. `POST /register` with `{ username, password }`. The password is salted and hashed with `crypto.scryptSync` — never stored in plain text. The user record is written with a `ConditionExpression` so two people can't register the same username in a race. On success, a JWT is issued immediately (auto-login).
2. `POST /login` with the same credentials looks the user up by username, re-hashes the supplied password with the stored salt, and compares using a constant-time check (`crypto.timingSafeEqual`) to avoid timing attacks. Returns a JWT on success.
3. Every `/todos` call must include `Authorization: Bearer <token>`. Before `TodoFunction` runs, API Gateway invokes `AuthorizerFunction`, which verifies the JWT and — if valid — returns an IAM `Allow` policy plus `context: { userId }`. That `userId` is what `TodoFunction` uses to scope all reads/writes, so each user only ever sees their own todos.
4. If the JWT is missing or invalid, the authorizer throws and API Gateway returns `401` automatically — `TodoFunction` never runs at all.

**Note:** this is deliberately minimal for learning purposes — no email verification, password reset, rate limiting, or account lockout. Don't point real users at it as-is.

## Files

```
template.yaml       SAM template: API Gateway, 4 Lambdas, 2 DynamoDB tables
package.json          shared dependencies (jsonwebtoken, AWS SDK v3)
register.js            creates a user
auth.js                 logs a user in
authorizer.js            Lambda authorizer — validates JWT, returns IAM policy
todos.js                  CRUD, scoped by userId
passwords.js               shared password hashing helpers
frontend/index.html    static test page: register/login tabs + todo UI
```

## Prerequisites
- AWS account with credentials configured (`aws configure`)
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
- Node.js 20.x

## Deploy

```bash
sam build
sam deploy --guided
```

You'll be asked for a stack name, region, and the `JwtSecret` parameter — use a real random secret. Saved to `samconfig.toml`, so future deploys are just `sam build && sam deploy`.

After deploy, note the `ApiUrl` output.

## API Reference

| Method | Path          | Auth required | Body |
|--------|---------------|----------------|------|
| POST   | `/register`   | No             | `{ "username": "...", "password": "..." }` (username ≥3 chars, password ≥6 chars) → `{ token, expiresIn }` |
| POST   | `/login`      | No             | `{ "username": "...", "password": "..." }` → `{ token, expiresIn }` |
| GET    | `/todos`      | Yes (Bearer JWT) | — |
| POST   | `/todos`      | Yes            | `{ "title": "Buy milk" }` |
| GET    | `/todos/{id}` | Yes            | — |
| PUT    | `/todos/{id}` | Yes            | `{ "title": "...", "completed": true }` |
| DELETE | `/todos/{id}` | Yes            | — |

## Testing with curl

```bash
API=https://abc123xyz.execute-api.us-east-1.amazonaws.com/Prod

# 1. Register a new account (or log in if you already have one)
TOKEN=$(curl -s -X POST "$API/register" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"hunter22"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

# 2. Create a todo
curl -X POST "$API/todos" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"title":"Learn Lambda authorizers"}'

# 3. List todos (only Alice's)
curl "$API/todos" -H "Authorization: Bearer $TOKEN"

# 4. Registering the same username again should fail with 409
curl -i -X POST "$API/register" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"anything1"}'
```

## Testing with the frontend
1. Open `frontend/index.html` in a browser. The API URL is hardcoded at the top of the `<script>` (`API_BASE`) — update it there if you redeploy to a new stack.
2. Use the **Register** tab to create an account, or **Log in** if you already have one.
3. Add/complete/delete todos — each account only sees its own list.

## Cleaning up

```bash
sam delete
```

## Troubleshooting: OPTIONS request returns 502

If a browser preflight (`OPTIONS /register`, `OPTIONS /todos`, etc.) comes
back as `502 Bad Gateway`, it's caused by defining CORS two conflicting
ways at once: the API's `Cors:` property (which auto-generates an
`OPTIONS` mock method on every route) **and** a manual `OPTIONS` event
routed to the Lambda for the same path. Those two integrations collide.

This template only uses the `Cors:` property — don't add per-route
`OPTIONS` events back in. If you edit the template and see this error,
check that you haven't reintroduced a manual `OPTIONS` event alongside
the `Cors:` block.

If you deployed a version with the conflict, redeploy after removing the
`OPTIONS` events (`sam build && sam deploy`) — no table changes needed
this time, this is an API Gateway config fix only.

## Ideas to extend this for deeper learning
- Swap the JWT approach for Amazon Cognito to compare a managed auth service against rolling your own.
- Add password reset (e.g. via a one-time emailed token — needs SES).
- Add rate limiting on `/login` and `/register` (API Gateway usage plans, or a simple DynamoDB-backed counter) to slow down brute-force attempts.
- Add per-route scopes (e.g. an `admin` claim) and have the authorizer return `Deny` for routes a role doesn't permit.
