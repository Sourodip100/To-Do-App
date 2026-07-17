const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  QueryCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
} = require("@aws-sdk/lib-dynamodb");
const { randomUUID } = require("crypto");

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.TABLE_NAME;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
};

function response(statusCode, body) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : "",
  };
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf-8")
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function listTodos(userId) {
  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: { ":userId": userId },
    })
  );
  const items = (result.Items || []).sort(
    (a, b) => (a.createdAt || 0) - (b.createdAt || 0)
  );
  return response(200, items);
}

async function createTodo(userId, event) {
  const body = parseBody(event);
  const title = (body.title || "").trim();
  if (!title) {
    return response(400, { error: "title is required" });
  }

  const item = {
    userId,
    id: randomUUID(),
    title,
    completed: false,
    createdAt: Date.now(),
  };

  await ddb.send(new PutCommand({ TableName: TABLE_NAME, Item: item }));
  return response(201, item);
}

async function getTodo(userId, id) {
  const result = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { userId, id } })
  );
  if (!result.Item) return response(404, { error: "todo not found" });
  return response(200, result.Item);
}

async function updateTodo(userId, id, event) {
  const body = parseBody(event);
  const existing = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { userId, id } })
  );
  if (!existing.Item) return response(404, { error: "todo not found" });

  const updateParts = [];
  const exprValues = {};
  const exprNames = {};

  if (typeof body.title === "string") {
    updateParts.push("#t = :title");
    exprNames["#t"] = "title";
    exprValues[":title"] = body.title;
  }
  if (typeof body.completed === "boolean") {
    updateParts.push("completed = :completed");
    exprValues[":completed"] = body.completed;
  }

  if (updateParts.length === 0) {
    return response(400, { error: "nothing to update" });
  }

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { userId, id },
      UpdateExpression: "SET " + updateParts.join(", "),
      ExpressionAttributeValues: exprValues,
      ExpressionAttributeNames: Object.keys(exprNames).length
        ? exprNames
        : undefined,
    })
  );

  const updated = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { userId, id } })
  );
  return response(200, updated.Item);
}

async function deleteTodo(userId, id) {
  const existing = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { userId, id } })
  );
  if (!existing.Item) return response(404, { error: "todo not found" });

  await ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { userId, id } }));
  return response(204);
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return response(200);

  // Injected by the Lambda authorizer's context - see authorizer.js
  const userId = event.requestContext?.authorizer?.userId;
  if (!userId) return response(401, { error: "unauthorized" });

  const method = event.httpMethod;
  const id = event.pathParameters && event.pathParameters.id;

  try {
    if (method === "GET" && !id) return await listTodos(userId);
    if (method === "GET" && id) return await getTodo(userId, id);
    if (method === "POST") return await createTodo(userId, event);
    if (method === "PUT" && id) return await updateTodo(userId, id, event);
    if (method === "DELETE" && id) return await deleteTodo(userId, id);

    return response(404, { error: "route not found" });
  } catch (err) {
    console.error(err);
    return response(500, { error: err.message });
  }
};
