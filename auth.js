const jwt = require("jsonwebtoken");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand } = require("@aws-sdk/lib-dynamodb");
const { verifyPassword } = require("./passwords");

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);
const USERS_TABLE = process.env.USERS_TABLE;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
};

function response(statusCode, body) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    body: body === undefined ? "" : JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return response(200);

    if (!process.env.JWT_SECRET) {
      console.error("JWT_SECRET environment variable is not set");
      return response(500, { error: "server misconfigured: missing JWT secret" });
    }

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return response(400, { error: "invalid JSON body" });
    }

    const { username, password } = body;
    if (!username || !password) {
      return response(400, { error: "username and password are required" });
    }

    const result = await ddb.send(
      new GetCommand({ TableName: USERS_TABLE, Key: { username } })
    );
    const user = result.Item;

    if (!user || !verifyPassword(password, user.passwordHash)) {
      return response(401, { error: "invalid credentials" });
    }

    const token = jwt.sign({ sub: user.userId }, process.env.JWT_SECRET, {
      expiresIn: "1h",
    });

    return response(200, { token, expiresIn: 3600 });
  } catch (err) {
    console.error("Unhandled error in login handler:", err);
    return response(500, { error: "internal server error" });
  }
};
