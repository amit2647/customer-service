const express = require("express");
const cors = require("cors");

const requestLogger = require("./middleware/requestLogger");
const customerRoutes = require("./routes/customerRoutes");
const profileRoutes = require("./routes/profileRoutes");

const app = express();

app.use(cors());
app.use(express.json());

app.use(requestLogger);

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "customer-service",
  });
});

// Fixed paths like /customers/identifiers/check must match before /customers/:id.
app.use(profileRoutes);
app.use(customerRoutes);

module.exports = app;
