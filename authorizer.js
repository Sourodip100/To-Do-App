const jwt = require("jsonwebtoken");

/**
 * TOKEN-type Lambda authorizer.
 *
 * API Gateway calls this function before invoking the Todos function.
 * It receives the raw "Authorization" header value in event.authorizationToken
 * and the ARN of the route being called in event.methodArn.
 *
 * If the token is valid, we return an IAM policy that allows the call and
 * attach a `context` object (here, the userId) that API Gateway forwards
 * to the downstream Lambda as event.requestContext.authorizer.*
 *
 * If the token is invalid, throwing "Unauthorized" makes API Gateway
 * return a 401 automatically.
 */
exports.handler = async (event) => {
  const rawToken = event.authorizationToken || "";
  const token = rawToken.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    throw new Error("Unauthorized");
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Authorizer decisions are cached per-token for ReauthorizeEvery
    // seconds (see template.yaml). If the returned policy only allowed
    // the *specific* route being called right now, a later call to a
    // different route/method with the same still-cached token would be
    // wrongly denied. Scoping the Resource to the whole API+stage avoids
    // that: one Allow decision covers every route until the cache expires.
    const stageIndex = event.methodArn.indexOf("/");
    const apiArn = event.methodArn.substring(0, stageIndex);
    const resourceArn = `${apiArn}/*`;

    return generatePolicy(decoded.sub, "Allow", resourceArn, {
      userId: decoded.sub,
    });
  } catch (err) {
    // Logged for CloudWatch debugging - API Gateway only sees
    // "Unauthorized" either way, since throwing is what makes it return 401.
    console.error("JWT verification failed:", err.message);
    throw new Error("Unauthorized");
  }
};

function generatePolicy(principalId, effect, resource, context) {
  return {
    principalId,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Action: "execute-api:Invoke",
          Effect: effect,
          Resource: resource,
        },
      ],
    },
    // Values here must be strings/numbers/booleans - they show up as
    // event.requestContext.authorizer.userId in the downstream Lambda.
    context,
  };
}
