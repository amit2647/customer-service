const app = require("./app");

const PORT = process.env.PORT || 4002;

async function startServer() {
  try {
    console.log("[SERVER] Starting customer service...");

    app.listen(PORT, () => {
      console.log(`[SERVER] Customer service running on port ${PORT}`);
    });
  } catch (error) {
    console.error("[ERROR] Customer service startup failed");

    console.error(error);

    process.exit(1);
  }
}

startServer();
