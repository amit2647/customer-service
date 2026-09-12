const jwt = require("jsonwebtoken");

function authenticate(req, res, next) {
  try {
    const authorization = req.headers.authorization;

    if (!authorization) {
      return res.status(401).json({
        error: "Authentication required",
      });
    }

    const [scheme, token] = authorization.split(" ");

    if (scheme !== "Bearer" || !token) {
      return res.status(401).json({
        error: "Invalid authorization header",
      });
    }

    const secret = process.env.JWT_SECRET;

    if (!secret) {
      console.error("[AUTH] JWT_SECRET is not configured");

      return res.status(500).json({
        error: "Authentication configuration error",
      });
    }

    const decoded = jwt.verify(token, secret, {
      issuer: "omnicore-identity-service",
    });

    req.auth = {
      userId: Number(decoded.sub),
      organizationId: Number(decoded.organizationId),
      role: decoded.role,
      permissions: Array.isArray(decoded.permissions)
        ? decoded.permissions
        : [],
    };

    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        error: "Authentication token expired",
      });
    }

    if (error.name === "JsonWebTokenError" || error.name === "NotBeforeError") {
      return res.status(401).json({
        error: "Invalid authentication token",
      });
    }

    console.error("[AUTH] Authentication error:", error);

    return res.status(401).json({
      error: "Authentication failed",
    });
  }
}

module.exports = authenticate;
