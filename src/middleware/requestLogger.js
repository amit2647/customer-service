function requestLogger(req, res, next) {
  const start = Date.now();

  console.log(`[REQUEST] ${req.method} ${req.originalUrl} started`);

  res.on("finish", () => {
    const duration = Date.now() - start;

    console.log(
      `[REQUEST] ${req.method} ${req.originalUrl} ${res.statusCode} - ${duration}ms`,
    );
  });

  next();
}

module.exports = requestLogger;
