const app = require("./app");
const { initializeDatabase } = require("./db/initialize");

const PORT = process.env.PORT || 4002;

async function startServer() {
  try {
    console.log("[SERVER] Starting customer service...");

    await initializeDatabase();

    app.listen(PORT, () => {
      console.log(`[SERVER] Customer service running on port ${PORT}`);
    });
  } catch (error) {
    console.error("[ERROR] Database initialization failed");

    console.error(error);

    process.exit(1);
  }
}

startServer();
