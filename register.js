const { randomUUID } = require("crypto");
const jwt = require("jsonwebtoken");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { hashPassword } = require("./passwords");

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
  if (event.httpMethod === "OPTIONS") return response(200);

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return response(400, { error: "invalid JSON body" });
  }

  const username = (body.username || "").trim();
  const password = body.password || "";

  if (username.length < 3) {
    return response(400, { error: "username must be at least 3 characters" });
  }
  if (password.length < 6) {
    return response(400, { error: "password must be at least 6 characters" });
  }

  const userId = randomUUID();
  const passwordHash = hashPassword(password);

  try {
    await ddb.send(
      new PutCommand({
        TableName: USERS_TABLE,
        Item: { username, passwordHash, userId, createdAt: Date.now() },
        // Prevents a race where two requests register the same username
        // at the same time - the write fails instead of overwriting.
        ConditionExpression: "attribute_not_exists(username)",
      })
    );
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return response(409, { error: "username already taken" });
    }
    return response(500, { error: err.message });
  }

  // Auto-login on successful registration for a smoother UX.
  const token = jwt.sign({ sub: userId }, process.env.JWT_SECRET, {
    expiresIn: "1h",
  });

  return response(201, { token, expiresIn: 3600 });
};
